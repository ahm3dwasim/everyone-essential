package com.everyoneisessential.tv.protocol

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * A room's host credential: [HOST_TOKEN_BYTES] bytes from the platform's
 * cryptographic source, as lowercase hex. Mirrors `mintHostToken` in relay.ts,
 * where the same bytes come from `crypto.randomBytes`. Deliberately not
 * `RelayOptions.random` -- that one is injected so room codes are predictable
 * under test, and a room code is public anyway (it is on the TV screen and in
 * the join link). This is the only secret a room has.
 */
private fun mintHostToken(random: SecureRandom = SecureRandom()): String {
    val bytes = ByteArray(HOST_TOKEN_BYTES)
    random.nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

/**
 * What the relay keeps of a credential: its digest, and never the credential
 * itself. A mint is written once -- into the welcome of the one connection it
 * was minted for -- and what stays behind is the digest, which is all a later
 * hello is ever compared against. Mirrors `credentialDigest` in relay.ts.
 */
private fun credentialDigest(credential: String): ByteArray {
    return MessageDigest.getInstance("SHA-256").digest(credential.toByteArray(Charsets.UTF_8))
}

/**
 * Whether a connection presented the credential a room is currently known by,
 * without the time taken saying where the two first differ. Both sides are
 * hashed first, so the comparison is over a fixed number of bytes whatever was
 * presented -- including nothing at all, which is every hello from a
 * connection that is not this room's TV. Mirrors `sameCredential` in relay.ts.
 */
private fun sameCredential(presented: String?, known: ByteArray): Boolean {
    return MessageDigest.isEqual(credentialDigest(presented ?: ""), known)
}

/**
 * The relay: rooms, and routing between the TV and the phones in them.
 *
 * A Kotlin port of `app/relay/src/relay.ts`. It is deliberately stupid, same
 * as there: it does not read a game message to decide anything, it only
 * checks that a sender may address a target and forwards the payload
 * untouched. The TV is the authority; this is the wire.
 *
 * The socket is injected, so this class never opens a port and is testable
 * without a network -- `EmbeddedServer` is the only part of this app that
 * knows NanoWSD exists.
 */
interface Socket {
    fun send(data: String)
}

class Client(
    val id: String,
    val socket: Socket,
) {
    var kind: String? = null
    var room: String? = null
    var name: String? = null
}

data class RelayOptions(
    val random: () -> Double = Math::random,
    val maxPeersPerRoom: Int = 8,
    /** How many times to retry a colliding room code before giving up. */
    val roomCodeAttempts: Int = 50,
    /** Injected so the reconnect window can be spent without waiting it out. */
    val now: () -> Long = System::currentTimeMillis,
)

private class Room(val code: String) {
    /**
     * The digest of the one credential that currently makes a connection this
     * room's TV. It is minted with the room, put in the welcome of the
     * connection that made it, and minted again for every welcome a TV gets
     * after that -- so the credential a TV holds is always the newest one, and
     * the one it presented a moment ago is spent.
     */
    var credential: ByteArray = ByteArray(0)

    var tv: String? = null
    val peers = LinkedHashMap<String, Client>()
}

/**
 * What an emptied room leaves behind. The room stops routing the moment its
 * last peer goes, but deleting it would delete the only record of what its TV
 * holds -- and a room code is public, so a room that can be made again by
 * anyone who read four letters off a screen is a room anyone can be the TV of.
 * Until [until], the code belongs to this room: only the credential whose
 * digest is here opens it, and it is not a code a new room can be given.
 */
private class Tombstone(val code: String, val credential: ByteArray, val until: Long)

data class Delivery(val to: String, val message: JSONObject)

/**
 * One relay, reached from many threads at once.
 *
 * NanoHTTPD gives every connection its own thread, and every connection also
 * carries its own timer that gives the socket up when it stops answering --
 * so an add, a remove and a receive can be in here together, and a remove can
 * land in the middle of a receive that is walking a room's peer list. The
 * state is plain `LinkedHashMap`s, and a structural change during an iteration
 * over one of them throws: on a phone's thread that exception goes to
 * `onException`, which removes that phone, so a race here reads on screen as a
 * player being thrown out of a room for no reason.
 *
 * So the whole public surface is one critical section. It is deliberately
 * coarse: the relay does no work of its own beyond the maps (it forwards
 * payloads untouched), so there is nothing to gain from finer locking and a
 * whole class of "which fields does this method touch" questions to lose. What
 * it does mean is that a socket write happens under the lock, which is what
 * the Node relay gets for free by being single-threaded.
 *
 * `deliver` is private and only ever called from a method that already holds
 * the lock, so it needs none of its own.
 */
class Relay(private val options: RelayOptions = RelayOptions()) {
    private val clients = LinkedHashMap<String, Client>()
    private val rooms = LinkedHashMap<String, Room>()
    /** Rooms that have emptied, and stop being rooms this relay knows about. */
    private val tombstones = LinkedHashMap<String, Tombstone>()
    private var counter = 0

    @Synchronized
    fun add(socket: Socket): Client {
        counter += 1
        val id = "p$counter-${(options.random() * 1e9).toLong().toString(36)}"
        val client = Client(id, socket)
        clients[id] = client
        return client
    }

    @Synchronized
    fun remove(clientId: String): List<Delivery> {
        val client = clients[clientId] ?: return emptyList()
        clients.remove(clientId)
        val roomCode = client.room ?: return emptyList()
        val room = rooms[roomCode] ?: return emptyList()
        room.peers.remove(clientId)
        if (room.tv == clientId) room.tv = null
        val deliveries = deliver(broadcast(room, clientId, JSONObject().put("t", "peer_left").put("peerId", clientId)))
        if (room.peers.isEmpty()) {
            rooms.remove(room.code)
            // Not forgotten, just no longer live: the room's own TV can still
            // come back to it, and until the window closes nobody else can
            // make it.
            tombstones[room.code] = Tombstone(room.code, room.credential, options.now() + ROOM_TOMBSTONE_MS)
        }
        return deliveries
    }

    /** Handle one raw frame. Returns what was delivered, for tests and logging. */
    @Synchronized
    fun receive(clientId: String, raw: String): List<Delivery> {
        val client = clients[clientId] ?: return emptyList()
        forgetExpired()
        return when (val decoded = decodeClientMessage(raw)) {
            is Decoded.Refused -> fail(client, "malformed", decoded.reason)
            is Decoded.Ok -> when (val message = decoded.message) {
                is ClientToRelay.Hello -> hello(client, message)
                is ClientToRelay.RelayRequest -> route(client, message.to, message.payload)
            }
        }
    }

    /** The rooms that are live right now. An emptied one is not one of these. */
    @Synchronized
    fun rooms_(): List<String> {
        forgetExpired()
        return rooms.keys.toList()
    }

    /** The emptied rooms still inside their window. */
    @Synchronized
    fun tombstones_(): List<String> {
        forgetExpired()
        return tombstones.keys.toList()
    }

    /**
     * Forget the emptied rooms whose window has closed. Checked where the
     * answer can change rather than on a timer: the relay has no scheduler of
     * its own, and a room nobody ever asks about costs nothing to keep.
     */
    private fun forgetExpired() {
        val at = options.now()
        tombstones.entries.removeAll { it.value.until <= at }
    }

    private fun hello(client: Client, helloMessage: ClientToRelay.Hello): List<Delivery> {
        if (client.room != null) return fail(client, "malformed", "already joined a room")
        if (helloMessage.v != PROTOCOL_VERSION) {
            return fail(client, "version", "this relay speaks version $PROTOCOL_VERSION")
        }
        val name = helloMessage.name?.take(24)

        val room: Room
        /** The credential this connection is being handed, when it is a TV's. */
        var issued: String? = null
        if (helloMessage.kind == "tv") {
            // A TV that names a room is either claiming one that exists or
            // making a new one at a code it chose; one that names nothing is
            // handed a fresh code. Only the first is a claim about who is asking.
            val named = helloMessage.room?.let { normalizeRoomCode(it) }
            if (helloMessage.room != null && named == null) {
                return fail(client, "bad_room", "a room code is four letters")
            }
            val existing = named?.let { rooms[it] }
            val emptied = named?.let { tombstones[it] }
            if (existing != null) {
                if (existing.tv != null) {
                    return fail(client, "room_has_tv", "room ${existing.code} already has a TV")
                }
                // The one gate a room code cannot open. A code is public by
                // design -- it is on the TV screen and in the join link -- so
                // knowing it can never be what makes a connection the TV. Only
                // the room's own credential can, and a room whose TV has gone
                // leaves that room, and the phones in it, waiting for the one
                // connection that holds it.
                if (!sameCredential(helloMessage.hostToken, existing.credential)) {
                    return fail(client, "not_the_tv", "room ${existing.code} is not taking a new TV")
                }
                room = existing
            } else {
                // A room whose last peer left a moment ago is still its own
                // TV's room until the window closes: the credential that was
                // live when it emptied is the only thing that opens it, and the
                // code is not a code a claim can be made at. Coming back through
                // here is coming back to the room the phones in it knew, not
                // making a room that looks like it.
                if (emptied != null) {
                    if (!sameCredential(helloMessage.hostToken, emptied.credential)) {
                        return fail(client, "not_the_tv", "room ${emptied.code} is not taking a new TV")
                    }
                    tombstones.remove(emptied.code)
                }
                val code = emptied?.code ?: named ?: freeCode()
                    ?: return fail(client, "bad_room", "could not allocate a room code")
                val credential = mintHostToken()
                val made = Room(code)
                made.credential = credentialDigest(credential)
                rooms[code] = made
                room = made
                issued = credential
            }
            if (room.peers.size >= options.maxPeersPerRoom) {
                return fail(client, "too_many_peers", "room ${room.code} is full")
            }
            // A room that was already live keeps routing on the credential it
            // has until here: the next one is minted only once this hello is
            // known to be accepted, so a connection that is refused spends
            // nothing -- a refused TV that had spent the room's credential
            // without being handed the new one would have locked the room's own
            // TV out of it.
            if (issued == null) issued = rotate(room)
            client.kind = "tv"
            client.room = room.code
            client.name = name
            room.tv = client.id
            room.peers[client.id] = client
        } else {
            val wanted = helloMessage.room?.let { normalizeRoomCode(it) }
                ?: return fail(client, "bad_room", "a room code is four letters")
            // An emptied room is not a room a phone can be SEATED in: nobody
            // is there to answer it, and seating it would be seating it next
            // to whoever makes the room again. But it is not a room that is
            // GONE, not while its tombstone is still here -- its own TV can
            // come back to it inside that window, and a phone reconnecting in
            // the same window is the ordinary case, because one network loss
            // closes every socket in the room.
            //
            // So it is told what a phone is told about a room that is there
            // and has no TV in it: wait. The two are the same wait from a
            // phone's side, and one word for both is what keeps the phone from
            // having to guess which it is looking at. Mirrors relay.ts.
            val found = rooms[wanted]
            if (found == null) {
                if (tombstones.containsKey(wanted)) {
                    return fail(client, "no_tv_yet", "room $wanted is waiting for its TV")
                }
                return fail(client, "unknown_room", "no room $wanted — check the code on the TV")
            }
            room = found
            if (room.peers.size >= options.maxPeersPerRoom) {
                return fail(client, "too_many_peers", "room ${room.code} is full")
            }
            client.kind = "phone"
            client.room = room.code
            client.name = name
            room.peers[client.id] = client
        }

        val summary = summary(client)
        val peers = JSONArray()
        for (peer in room.peers.values) peers.put(summary(peer))
        val welcome = JSONObject()
            .put("t", "welcome")
            .put("v", PROTOCOL_VERSION)
            .put("room", room.code)
            .put("peerId", client.id)
            .put("kind", helloMessage.kind)
        // The credential this TV is to hold from here on, to the connection
        // that is this room's TV and to no one else. Whatever it presented to
        // get here is spent by this welcome. It is not in `peers` below and not
        // in any broadcast: the summary a room is told about another peer is
        // built by `summary`, which has nowhere to put it.
        if (issued != null) welcome.put("hostToken", issued)
        welcome.put("peers", peers)
        val deliveries = mutableListOf(Delivery(client.id, welcome))
        deliveries.addAll(broadcast(room, client.id, JSONObject().put("t", "peer_joined").put("peer", summary)))
        return deliver(deliveries)
    }

    private fun route(client: Client, to: String, payload: JSONObject): List<Delivery> {
        val roomCode = client.room ?: return fail(client, "malformed", "join a room first")
        val room = rooms[roomCode] ?: return fail(client, "unknown_room", "the room is gone")

        // A phone speaks with the TV's authority, never its own: every game
        // message a phone is allowed to send is addressed to the TV, so a phone
        // that names any other target -- a peer id, or "all" -- is dropped here
        // rather than forwarded. Mirrors relay.ts's route().
        if (client.kind == "phone" && to != "tv") {
            return fail(client, "malformed", "a phone may only address the TV")
        }

        // The sender is stamped here, from the connection, never from the frame.
        val message = JSONObject().put("t", "relay").put("from", client.id).put("to", to).put("payload", payload)
        if (to == "all") return deliver(broadcast(room, client.id, message))
        if (to == "tv") {
            // Not `unknown_room`: this room exists and this phone is in it. The
            // code is what lets a phone tell the TV stepping out from the room
            // being gone, which are a wait and a departure respectively.
            // Mirrors relay.ts's route().
            val tv = room.tv ?: return fail(client, "no_tv_yet", "no TV in this room yet")
            // A phone addressing the TV is the normal path; a TV addressing itself is not.
            if (tv == client.id) return fail(client, "malformed", "the TV cannot address itself")
            return deliver(listOf(Delivery(tv, message)))
        }
        // A direct peer id: only within this room, and never to yourself.
        val target = room.peers[to] ?: return fail(client, "malformed", "no peer $to in this room")
        if (target.id == client.id) return fail(client, "malformed", "cannot address yourself")
        return deliver(listOf(Delivery(target.id, message)))
    }

    /**
     * A code no room is live at and no emptied room is still remembered by:
     * a code the relay is remembering is the code that room's own TV will come
     * back to, so it is not a code a new room can be given.
     */
    private fun freeCode(): String? {
        repeat(options.roomCodeAttempts) {
            val code = generateRoomCode(options.random)
            if (!rooms.containsKey(code) && !tombstones.containsKey(code)) return code
        }
        return null
    }

    /** Mint the next credential for a live room, and remember only its digest. */
    private fun rotate(room: Room): String {
        val credential = mintHostToken()
        room.credential = credentialDigest(credential)
        return credential
    }

    private fun summary(client: Client): JSONObject {
        val out = JSONObject().put("peerId", client.id).put("kind", client.kind ?: "phone")
        client.name?.let { out.put("name", it) }
        return out
    }

    private fun broadcast(room: Room, exceptId: String, message: JSONObject): List<Delivery> {
        val deliveries = mutableListOf<Delivery>()
        for (peer in room.peers.values) {
            if (peer.id == exceptId) continue
            deliveries.add(Delivery(peer.id, message))
        }
        return deliveries
    }

    private fun fail(client: Client, code: String, detail: String): List<Delivery> {
        val message = JSONObject().put("t", "relay_error").put("code", code).put("detail", detail)
        return deliver(listOf(Delivery(client.id, message)))
    }

    private fun deliver(deliveries: List<Delivery>): List<Delivery> {
        for (delivery in deliveries) {
            val target = clients[delivery.to] ?: continue
            target.socket.send(delivery.message.toString())
        }
        return deliveries
    }
}
