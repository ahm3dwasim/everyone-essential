package com.everyoneisessential.tv.protocol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Kotlin port of `test/relay.test.ts`'s cases -- room codes, join/leave,
 * stamping and fan-out -- against [Relay], driven through an injected
 * [Socket] exactly as the TypeScript tests drive it through an injected
 * `Socket`, so nothing here opens a port either.
 */
class FakeSocket : Socket {
    val sent = mutableListOf<JSONObject>()

    /**
     * The frames exactly as they went out. Parsing into a JSONObject is the
     * mirror of the TypeScript side's decoder: a field the relay leaks but
     * this protocol has no name for would still be in here, and a leak is the
     * thing some of these cases are looking for.
     */
    val raw = mutableListOf<String>()
    override fun send(data: String) {
        raw.add(data)
        sent.add(JSONObject(data))
    }
    fun last(): JSONObject? = sent.lastOrNull()
    fun types(): List<String> = sent.map { it.getString("t") }
}

/** Room codes are predictable only at `random() == 0`, which names every room AAAA. */
private fun fixedCodes(): () -> Double = { 0.0 }

private fun hello(relay: Relay, socket: FakeSocket, body: Map<String, Any?>): String {
    val client = relay.add(socket)
    val payload = JSONObject().put("t", "hello").put("v", body["v"] ?: PROTOCOL_VERSION)
    body["kind"]?.let { payload.put("kind", it) }
    body["room"]?.let { payload.put("room", it) }
    body["name"]?.let { payload.put("name", it) }
    body["hostToken"]?.let { payload.put("hostToken", it) }
    relay.receive(client.id, payload.toString())
    return client.id
}

private fun roomOf(tv: FakeSocket): String =
    tv.sent.first().let { if (it.getString("t") == "welcome") it.getString("room") else "" }

class RelayJoiningTest {
    @Test
    fun `gives a TV that names no room a fresh code, and tells it who is there`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val socket = FakeSocket()
        hello(relay, socket, mapOf("kind" to "tv"))
        val welcome = socket.sent[0]
        assertEquals("welcome", welcome.getString("t"))
        assertEquals("AAAA", welcome.getString("room"))
        assertEquals(1, welcome.getJSONArray("peers").length())
        assertEquals(welcome.getString("peerId"), welcome.getJSONArray("peers").getJSONObject(0).getString("peerId"))
    }

    @Test
    fun `tells the TV when a phone arrives, and the phone who else is there`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val tv = FakeSocket()
        hello(relay, tv, mapOf("kind" to "tv"))
        val room = roomOf(tv)

        val phone = FakeSocket()
        val phoneId = hello(relay, phone, mapOf("kind" to "phone", "room" to room, "name" to "Sam"))
        assertEquals(2, phone.sent[0].getJSONArray("peers").length())
        assertEquals(listOf("welcome", "peer_joined"), tv.types())
        val joined = tv.last()!!.getJSONObject("peer")
        assertEquals(phoneId, joined.getString("peerId"))
        assertEquals("phone", joined.getString("kind"))
        assertEquals("Sam", joined.getString("name"))
    }

    @Test
    fun `refuses a second TV in the same room`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val tv = FakeSocket()
        hello(relay, tv, mapOf("kind" to "tv"))
        val room = roomOf(tv)

        val other = FakeSocket()
        hello(relay, other, mapOf("kind" to "tv", "room" to room))
        assertEquals("relay_error", other.last()!!.getString("t"))
        assertEquals("room_has_tv", other.last()!!.getString("code"))
    }

    @Test
    fun `sends a phone to a room that does not exist back to the TV to read the code again`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val phone = FakeSocket()
        hello(relay, phone, mapOf("kind" to "phone", "room" to "ZZZZ"))
        assertEquals("unknown_room", phone.last()!!.getString("code"))
    }

    @Test
    fun `refuses a code that is not four letters`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val phone = FakeSocket()
        hello(relay, phone, mapOf("kind" to "phone", "room" to "AB"))
        assertEquals("bad_room", phone.last()!!.getString("code"))
    }

    @Test
    fun `refuses a client that speaks a different version`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val socket = FakeSocket()
        hello(relay, socket, mapOf("kind" to "tv", "v" to PROTOCOL_VERSION + 1))
        assertEquals("relay_error", socket.last()!!.getString("t"))
        assertEquals("version", socket.last()!!.getString("code"))
    }

    @Test
    fun `refuses a hello from the version this protocol has left behind`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val socket = FakeSocket()
        // Version 1 is the one where a hello's credential was not read at all:
        // a relay that answers it would be handing a room to whoever named it.
        hello(relay, socket, mapOf("kind" to "tv", "v" to PROTOCOL_VERSION - 1))
        assertEquals("relay_error", socket.last()!!.getString("t"))
        assertEquals("version", socket.last()!!.getString("code"))
        assertTrue(!socket.types().contains("welcome"))
        assertTrue(relay.rooms_().isEmpty())
    }

    @Test
    fun `refuses a second hello from the same connection`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val socket = FakeSocket()
        val id = hello(relay, socket, mapOf("kind" to "tv"))
        relay.receive(id, JSONObject().put("t", "hello").put("v", PROTOCOL_VERSION).put("kind", "phone").put("room", "AAAA").toString())
        assertEquals("malformed", socket.last()!!.getString("code"))
    }

    @Test
    fun `refuses to route for a client that has not said hello yet`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val socket = FakeSocket()
        val client = relay.add(socket)
        val frame = JSONObject().put("t", "relay").put("to", "tv").put("payload", JSONObject().put("t", "join"))
        relay.receive(client.id, frame.toString())
        assertEquals("malformed", socket.last()!!.getString("code"))
    }
}

private class TestRoom(val relay: Relay, val tv: FakeSocket, val tvId: String, val a: FakeSocket, val aId: String, val b: FakeSocket, val bId: String)

private fun room(): TestRoom {
    val relay = Relay(RelayOptions(random = fixedCodes()))
    val tv = FakeSocket()
    val tvId = hello(relay, tv, mapOf("kind" to "tv"))
    val code = roomOf(tv)
    val a = FakeSocket()
    val aId = hello(relay, a, mapOf("kind" to "phone", "room" to code))
    val b = FakeSocket()
    val bId = hello(relay, b, mapOf("kind" to "phone", "room" to code))
    return TestRoom(relay, tv, tvId, a, aId, b, bId)
}

class RelayRoutingTest {
    @Test
    fun `forwards to the TV and stamps the real sender`() {
        val r = room()
        val payload = JSONObject().put("t", "intent").put("intent", JSONObject().put("k", "choose").put("choiceId", "act:x"))
        r.relay.receive(r.aId, JSONObject().put("t", "relay").put("to", "tv").put("payload", payload).toString())
        val envelope = r.tv.last()!!
        assertEquals("relay", envelope.getString("t"))
        assertEquals(r.aId, envelope.getString("from"))
        assertEquals("choose", envelope.getJSONObject("payload").getJSONObject("intent").getString("k"))
        assertEquals(listOf("welcome", "peer_joined"), r.a.types())
    }

    @Test
    fun `ignores a sender the frame claims, and uses the connection's own id`() {
        val r = room()
        val raw = JSONObject().put("t", "relay").put("from", "somebody-else").put("to", "tv").put("payload", JSONObject().put("t", "join"))
        r.relay.receive(r.aId, raw.toString())
        assertEquals(r.aId, r.tv.last()!!.getString("from"))
    }

    @Test
    fun `broadcasts the TV's message to everyone but itself`() {
        val r = room()
        r.relay.receive(r.tvId, JSONObject().put("t", "relay").put("to", "all").put("payload", JSONObject().put("t", "join")).toString())
        assertEquals(r.tvId, r.a.last()!!.getString("from"))
        assertEquals(r.tvId, r.b.last()!!.getString("from"))
    }

    @Test
    fun `delivers the TV's direct message to one peer in the room, and to nobody else`() {
        val r = room()
        val before = r.a.sent.size
        r.relay.receive(r.tvId, JSONObject().put("t", "relay").put("to", r.bId).put("payload", JSONObject().put("t", "join")).toString())
        assertEquals(before, r.a.sent.size)
        assertEquals(r.tvId, r.b.last()!!.getString("from"))
        assertEquals(r.bId, r.b.last()!!.getString("to"))
    }

    @Test
    fun `refuses a phone that addresses another phone directly -- a forged superseded included`() {
        val r = room()
        val before = r.b.sent.size
        r.relay.receive(r.aId, JSONObject().put("t", "relay").put("to", r.bId).put("payload", JSONObject().put("t", "superseded")).toString())
        assertEquals(before, r.b.sent.size)
        assertEquals("malformed", r.a.last()!!.getString("code"))
    }

    @Test
    fun `refuses a phone that broadcasts to the room`() {
        val r = room()
        val beforeB = r.b.sent.size
        val beforeTv = r.tv.sent.size
        r.relay.receive(r.aId, JSONObject().put("t", "relay").put("to", "all").put("payload", JSONObject().put("t", "join")).toString())
        assertEquals(beforeB, r.b.sent.size)
        assertEquals(beforeTv, r.tv.sent.size)
        assertEquals("malformed", r.a.last()!!.getString("code"))
    }

    @Test
    fun `refuses a TV that addresses itself, and a peer that addresses itself`() {
        val r = room()
        r.relay.receive(r.tvId, JSONObject().put("t", "relay").put("to", "tv").put("payload", JSONObject().put("t", "join")).toString())
        assertEquals("malformed", r.tv.last()!!.getString("code"))
        r.relay.receive(r.aId, JSONObject().put("t", "relay").put("to", r.aId).put("payload", JSONObject().put("t", "join")).toString())
        assertEquals("malformed", r.a.last()!!.getString("code"))
    }

    @Test
    fun `refuses an address that is not in this room`() {
        val r = room()
        r.relay.receive(r.aId, JSONObject().put("t", "relay").put("to", "p99-nobody").put("payload", JSONObject().put("t", "join")).toString())
        assertEquals("malformed", r.a.last()!!.getString("code"))
    }

    @Test
    fun `tells a phone there is no TV yet rather than dropping the message, under a code of its own`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val tv = FakeSocket()
        hello(relay, tv, mapOf("kind" to "tv"))
        val code = roomOf(tv)
        val phone = FakeSocket()
        val phoneId = hello(relay, phone, mapOf("kind" to "phone", "room" to code))
        relay.remove(tv.sent[0].getString("peerId"))
        relay.receive(phoneId, JSONObject().put("t", "relay").put("to", "tv").put("payload", JSONObject().put("t", "join")).toString())
        // Not `unknown_room`: the room is live and this phone is in it. The
        // code is what lets a phone tell the TV stepping out from the room
        // being gone. Mirrors relay.test.ts's test of the same name.
        assertEquals("no_tv_yet", phone.last()!!.getString("code"))
    }

    @Test
    fun `tells a phone in a room with no TV a different code than one naming no room`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val tv = FakeSocket()
        hello(relay, tv, mapOf("kind" to "tv"))
        val code = roomOf(tv)
        val phone = FakeSocket()
        val phoneId = hello(relay, phone, mapOf("kind" to "phone", "room" to code))
        relay.remove(tv.sent[0].getString("peerId"))
        relay.receive(phoneId, JSONObject().put("t", "relay").put("to", "tv").put("payload", JSONObject().put("t", "join")).toString())
        assertEquals("no_tv_yet", phone.last()!!.getString("code"))

        // The other state, one code away: a code that names no room at all.
        val stranger = FakeSocket()
        hello(relay, stranger, mapOf("kind" to "phone", "room" to "ZZZZ"))
        assertEquals("unknown_room", stranger.last()!!.getString("code"))
    }
}

class RelayLeavingTest {
    @Test
    fun `tells the room, and forgets a room once it is empty`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val tv = FakeSocket()
        val tvId = hello(relay, tv, mapOf("kind" to "tv"))
        val code = roomOf(tv)
        val phone = FakeSocket()
        val phoneId = hello(relay, phone, mapOf("kind" to "phone", "room" to code))

        relay.remove(phoneId)
        assertEquals("peer_left", tv.last()!!.getString("t"))
        assertEquals(phoneId, tv.last()!!.getString("peerId"))
        assertEquals(listOf(code), relay.rooms_())

        relay.remove(tvId)
        assertTrue(relay.rooms_().isEmpty())
    }

    @Test
    fun `does nothing for a client that was never there`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        assertTrue(relay.remove("p0-ghost").isEmpty())
    }
}

class RelayCapacityTest {
    @Test
    fun `refuses the peer after the cap`() {
        val relay = Relay(RelayOptions(random = fixedCodes(), maxPeersPerRoom = 2))
        val tv = FakeSocket()
        hello(relay, tv, mapOf("kind" to "tv"))
        val code = roomOf(tv)
        val first = FakeSocket()
        hello(relay, first, mapOf("kind" to "phone", "room" to code))
        val second = FakeSocket()
        hello(relay, second, mapOf("kind" to "phone", "room" to code))
        assertEquals("too_many_peers", second.last()!!.getString("code"))
    }

    @Test
    fun `gives up honestly when every code it tries is taken`() {
        val relay = Relay(RelayOptions(random = { 0.0 }, roomCodeAttempts = 2))
        val first = FakeSocket()
        hello(relay, first, mapOf("kind" to "tv"))
        val second = FakeSocket()
        hello(relay, second, mapOf("kind" to "tv"))
        assertEquals("bad_room", second.last()!!.getString("code"))
    }
}

/**
 * A Kotlin port of `test/relay.test.ts`'s host-custody cases: a room belongs
 * to the connection that made it, not to whoever can read the four letters
 * off the TV screen. The room code is public by design, so knowing it can
 * never be what makes a socket the TV; the relay mints a credential for the
 * room and puts it in that TV's own `welcome`, and a later `kind: "tv"` hello
 * naming an existing room is accepted only from a connection that presents
 * it. This is the relay the Fire TV Stick actually runs, so a gap here is a
 * gap on the device every phone in the room is talking to.
 */
private class Hosted(
    val relay: Relay,
    val tv: FakeSocket,
    val tvId: String,
    val welcome: JSONObject,
    val phone: FakeSocket,
    val phoneId: String,
)

/** A room with a live TV and one phone in it, and the TV's own welcome. */
private fun hosted(): Hosted {
    val relay = Relay(RelayOptions(random = fixedCodes()))
    val tv = FakeSocket()
    val tvId = hello(relay, tv, mapOf("kind" to "tv"))
    val welcome = tv.sent[0]
    val phone = FakeSocket()
    val phoneId = hello(relay, phone, mapOf("kind" to "phone", "room" to welcome.getString("room")))
    return Hosted(relay, tv, tvId, welcome, phone, phoneId)
}

private fun frame(to: String, payload: JSONObject): String =
    JSONObject().put("t", "relay").put("to", to).put("payload", payload).toString()

class RelayHostCustodyTest {
    @Test
    fun `refuses a replacement TV that presents no credential, and the phones hear nothing from it`() {
        val h = hosted()
        // The real TV's connection goes away, and the room stays behind with no TV.
        h.relay.remove(h.tvId)

        val attacker = FakeSocket()
        val attackerId = hello(h.relay, attacker, mapOf("kind" to "tv", "room" to h.welcome.getString("room")))
        assertEquals("relay_error", attacker.last()!!.getString("t"))
        assertTrue(!attacker.types().contains("welcome"))

        // Refused a welcome means no room, so the forged TV-only control has no
        // standing to travel on either.
        val before = h.phone.sent.size
        h.relay.receive(attackerId, frame(h.phoneId, JSONObject().put("t", "superseded")))
        assertEquals(before, h.phone.sent.size)
    }

    @Test
    fun `refuses a replacement TV that presents a credential the room never issued`() {
        val h = hosted()
        h.relay.remove(h.tvId)

        val attacker = FakeSocket()
        val attackerId = hello(
            h.relay,
            attacker,
            mapOf("kind" to "tv", "room" to h.welcome.getString("room"), "hostToken" to "0".repeat(64)),
        )
        assertEquals("relay_error", attacker.last()!!.getString("t"))
        assertTrue(!attacker.types().contains("welcome"))

        val before = h.phone.sent.size
        h.relay.receive(attackerId, frame(h.phoneId, JSONObject().put("t", "superseded")))
        assertEquals(before, h.phone.sent.size)
    }

    @Test
    fun `lets the room's own TV come back with the credential it was given, and the phones take it back`() {
        val h = hosted()
        val token = h.welcome.getString("hostToken")
        assertTrue(Regex("^[0-9a-f]{64}$").matches(token))
        val room = h.welcome.getString("room")

        h.relay.remove(h.tvId)
        assertEquals("peer_left", h.phone.last()!!.getString("t"))
        assertEquals(h.tvId, h.phone.last()!!.getString("peerId"))

        val again = FakeSocket()
        val againId = hello(h.relay, again, mapOf("kind" to "tv", "room" to room, "hostToken" to token))
        val back = again.sent[0]
        assertEquals("welcome", back.getString("t"))
        // The same room, so the phones that stayed are the TV's own again.
        assertEquals(room, back.getString("room"))
        // The return spends what it presented: the welcome for a TV always
        // carries a fresh credential, so what the room is known by from here
        // on is not what was on the wire a moment ago.
        val next = back.getString("hostToken")
        assertTrue(Regex("^[0-9a-f]{64}$").matches(next))
        assertTrue("the credential was not rotated", next != token)
        // And the phones are told, in the one field a phone cannot forge.
        assertEquals("peer_joined", h.phone.last()!!.getString("t"))
        assertEquals("tv", h.phone.last()!!.getJSONObject("peer").getString("kind"))
        assertEquals(againId, h.phone.last()!!.getJSONObject("peer").getString("peerId"))

        val before = h.phone.sent.size
        h.relay.receive(againId, frame(h.phoneId, JSONObject().put("t", "superseded")))
        assertEquals(before + 1, h.phone.sent.size)
        assertEquals(againId, h.phone.last()!!.getString("from"))
        assertEquals("superseded", h.phone.last()!!.getJSONObject("payload").getString("t"))
    }

    @Test
    fun `never shows the room's credential in any message a phone receives`() {
        val h = hosted()
        val token = h.welcome.getString("hostToken")

        // Every path a phone can be on the receiving end of: the TV arriving,
        // leaving, coming back, and addressing the room.
        h.relay.remove(h.tvId)
        val again = FakeSocket()
        val againId = hello(h.relay, again, mapOf("kind" to "tv", "room" to h.welcome.getString("room"), "hostToken" to token))
        h.relay.receive(againId, frame("all", JSONObject().put("t", "superseded")))

        assertTrue(h.phone.raw.isNotEmpty())
        for (raw in h.phone.raw) assertTrue("the credential reached a phone: $raw", !raw.contains(token))
        // The other direction too: the room's own peers list never carries it.
        val peers = h.welcome.getJSONArray("peers")
        for (i in 0 until peers.length()) {
            assertTrue(!peers.getJSONObject(i).toString().contains(token))
        }
    }
}

/** A relay whose clock this test owns, so the reconnect window can be spent. */
private class Clocked {
    var now = 1_000_000L
    val relay = Relay(RelayOptions(random = fixedCodes(), now = { now }))
    fun spend(ms: Long) {
        now += ms
    }
}

private class Occupied(
    val relay: Relay,
    val tvId: String,
    val welcome: JSONObject,
    val hostToken: String,
    val phoneId: String,
)

/** A room with a live TV and one phone in it, and the credential the TV was handed. */
private fun occupied(clocked: Clocked): Occupied {
    val tv = FakeSocket()
    val tvId = hello(clocked.relay, tv, mapOf("kind" to "tv"))
    val welcome = tv.sent[0]
    val phone = FakeSocket()
    val phoneId = hello(clocked.relay, phone, mapOf("kind" to "phone", "room" to welcome.getString("room")))
    return Occupied(clocked.relay, tvId, welcome, welcome.getString("hostToken"), phoneId)
}

/**
 * A room that empties is not a room that is gone.
 *
 * Deleting it outright deleted the only copy of its credential with it, so the
 * four letters off the screen were enough to make the room again and be
 * welcomed as its TV -- which is the host-custody fix undone by a network blip
 * rather than by a mistake in it. What an emptied room leaves behind is a
 * tombstone: the code, the digest of the credential that was live when the
 * last peer left, and a deadline. Mirrors the same cases in relay.test.ts.
 */
class RelayEmptiedRoomTest {
    @Test
    fun `refuses a code-only impostor after the last peer drops, and reaches nobody in the room`() {
        val c = Clocked()
        val o = occupied(c)
        // One network loss closes every socket in the room.
        c.relay.remove(o.tvId)
        c.relay.remove(o.phoneId)
        assertTrue(c.relay.rooms_().isEmpty())

        val impostor = FakeSocket()
        val impostorId = hello(c.relay, impostor, mapOf("kind" to "tv", "room" to o.welcome.getString("room")))
        assertEquals("relay_error", impostor.last()!!.getString("t"))
        assertEquals("not_the_tv", impostor.last()!!.getString("code"))
        assertTrue(!impostor.types().contains("welcome"))

        // The room's own TV comes back first, and is told about nobody else --
        // there is no impostor in the room to be told about.
        val returning = FakeSocket()
        hello(
            c.relay,
            returning,
            mapOf("kind" to "tv", "room" to o.welcome.getString("room"), "hostToken" to o.hostToken),
        )
        assertEquals(listOf("welcome"), returning.types())

        // And the impostor, refused a welcome, has no room to speak from, so
        // nothing it sends reaches the phones that come back.
        val returningPhone = FakeSocket()
        val returningPhoneId = hello(c.relay, returningPhone, mapOf("kind" to "phone", "room" to o.welcome.getString("room")))
        val before = returningPhone.sent.size
        c.relay.receive(impostorId, frame(returningPhoneId, JSONObject().put("t", "superseded")))
        assertEquals(before, returningPhone.sent.size)
    }

    @Test
    fun `refuses a returning phone while the room waits for its TV`() {
        val c = Clocked()
        val o = occupied(c)
        c.relay.remove(o.tvId)
        c.relay.remove(o.phoneId)

        val phone = FakeSocket()
        hello(c.relay, phone, mapOf("kind" to "phone", "room" to o.welcome.getString("room")))
        // Still not seated -- a welcome here would put the phone in a room
        // whose only other occupant would be whoever asks next, which is the
        // thing being refused. But the room is not gone: it is resting, and its
        // own TV can still come back to it. So the phone is told what a phone is
        // told when a room has no TV in it, which is what it is: wait.
        assertEquals("relay_error", phone.last()!!.getString("t"))
        assertEquals("no_tv_yet", phone.last()!!.getString("code"))
        assertTrue(!phone.types().contains("welcome"))
    }

    @Test
    fun `lets the room's own TV come back with its credential after the last peer drops`() {
        val c = Clocked()
        val o = occupied(c)
        c.relay.remove(o.tvId)
        c.relay.remove(o.phoneId)

        val again = FakeSocket()
        hello(c.relay, again, mapOf("kind" to "tv", "room" to o.welcome.getString("room"), "hostToken" to o.hostToken))
        val back = again.sent[0]
        assertEquals("welcome", back.getString("t"))
        assertEquals(o.welcome.getString("room"), back.getString("room"))

        // The room is a room again: a phone that had the code all along lands
        // in the one its TV is in, rather than being told there is no such room.
        val phone = FakeSocket()
        hello(c.relay, phone, mapOf("kind" to "phone", "room" to o.welcome.getString("room")))
        assertEquals("welcome", phone.last()!!.getString("t"))
        assertEquals(o.welcome.getString("room"), phone.last()!!.getString("room"))
    }

    @Test
    fun `forgets the room once the reconnect window has passed`() {
        val c = Clocked()
        val o = occupied(c)
        c.relay.remove(o.tvId)
        c.relay.remove(o.phoneId)
        assertEquals(listOf(o.welcome.getString("room")), c.relay.tombstones_())

        c.spend(ROOM_TOMBSTONE_MS + 1)

        assertTrue(c.relay.tombstones_().isEmpty())
        val phone = FakeSocket()
        hello(c.relay, phone, mapOf("kind" to "phone", "room" to o.welcome.getString("room")))
        assertEquals("relay_error", phone.last()!!.getString("t"))
        assertEquals("unknown_room", phone.last()!!.getString("code"))

        // And the credential stands for nothing any more: the code is a free
        // code again, and the room a TV is given at it is a new room with a new
        // credential rather than the room this TV left behind.
        val fresh = FakeSocket()
        hello(c.relay, fresh, mapOf("kind" to "tv", "room" to o.welcome.getString("room"), "hostToken" to o.hostToken))
        val made = fresh.sent[0]
        assertEquals("welcome", made.getString("t"))
        assertTrue(made.getString("hostToken") != o.hostToken)
    }

    @Test
    fun `does not give a remembered code to a new room`() {
        val c = Clocked()
        val o = occupied(c)
        assertEquals("AAAA", o.welcome.getString("room"))
        c.relay.remove(o.tvId)
        c.relay.remove(o.phoneId)

        // Every code this relay generates is `AAAA` (see `fixedCodes`), so a TV
        // asking to be given a room and getting one would mean the remembered
        // code had been handed to a room that is not the one it belongs to.
        val other = FakeSocket()
        hello(c.relay, other, mapOf("kind" to "tv"))
        assertEquals("relay_error", other.last()!!.getString("t"))
        assertEquals("bad_room", other.last()!!.getString("code"))
        assertTrue(c.relay.rooms_().isEmpty())
    }
}

/**
 * One credential, one use.
 *
 * A room's credential is the only thing that makes a connection its TV, and a
 * welcome for a TV is the one place it travels. If the same one came back every
 * time, a credential read off the wire would keep working for as long as the
 * room lived. Instead every welcome a TV gets carries a new one and the relay
 * keeps only the digest of the newest, so the one that was just spent stops
 * opening the room at the moment the room's own TV resumes with it. Mirrors the
 * same cases in relay.test.ts.
 */
class RelaySingleUseCredentialTest {
    @Test
    fun `hands a returning TV a fresh credential every time, and retires the one it presented`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val tv = FakeSocket()
        val tvId = hello(relay, tv, mapOf("kind" to "tv"))
        val first = tv.sent[0]
        val retired = first.getString("hostToken")
        val room = first.getString("room")
        val phone = FakeSocket()
        hello(relay, phone, mapOf("kind" to "phone", "room" to room))
        relay.remove(tvId)

        val again = FakeSocket()
        val againId = hello(relay, again, mapOf("kind" to "tv", "room" to room, "hostToken" to retired))
        val second = again.sent[0]
        assertEquals("welcome", second.getString("t"))
        assertTrue("the credential was not rotated", second.getString("hostToken") != retired)

        // That TV goes away, and the room lives on with its phone in it, so the
        // next claim to be its TV is answered on the credential alone.
        relay.remove(againId)

        // The one that opened this room a moment ago is spent.
        val spent = FakeSocket()
        hello(relay, spent, mapOf("kind" to "tv", "room" to room, "hostToken" to retired))
        assertEquals("relay_error", spent.last()!!.getString("t"))
        assertEquals("not_the_tv", spent.last()!!.getString("code"))
        assertTrue(!spent.types().contains("welcome"))

        // And the newest is live, and is itself spent by being used.
        val third = FakeSocket()
        hello(relay, third, mapOf("kind" to "tv", "room" to room, "hostToken" to second.getString("hostToken")))
        val back = third.sent[0]
        assertEquals("welcome", back.getString("t"))
        assertTrue(back.getString("hostToken") != second.getString("hostToken"))
    }

    @Test
    fun `never shows either credential to a phone`() {
        val relay = Relay(RelayOptions(random = fixedCodes()))
        val tv = FakeSocket()
        val tvId = hello(relay, tv, mapOf("kind" to "tv"))
        val first = tv.sent[0]
        val retired = first.getString("hostToken")
        val room = first.getString("room")
        val phone = FakeSocket()
        val phoneId = hello(relay, phone, mapOf("kind" to "phone", "room" to room))
        relay.remove(tvId)

        val again = FakeSocket()
        val againId = hello(relay, again, mapOf("kind" to "tv", "room" to room, "hostToken" to retired))
        val live = again.sent[0].getString("hostToken")
        relay.receive(againId, frame("all", JSONObject().put("t", "superseded")))
        relay.receive(againId, frame(phoneId, JSONObject().put("t", "superseded")))

        // Every frame a phone is on the receiving end of, as it went out: the
        // welcome that seated it, the room's news that its TV came back, and
        // the TV's own messages. Neither credential is in any of them.
        assertTrue(phone.raw.size > 2)
        for (raw in phone.raw) {
            assertTrue("the retired credential reached a phone: $raw", !raw.contains(retired))
            assertTrue("the live credential reached a phone: $raw", !raw.contains(live))
        }
    }
}
