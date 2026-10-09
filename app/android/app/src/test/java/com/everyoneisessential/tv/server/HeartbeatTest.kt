package com.everyoneisessential.tv.server

import com.everyoneisessential.tv.protocol.PROTOCOL_VERSION
import com.everyoneisessential.tv.protocol.Relay
import com.everyoneisessential.tv.protocol.RelayOptions
import com.everyoneisessential.tv.protocol.Socket
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The dead-peer check, driven by hand.
 *
 * The check exists because a TV that drops off Wi-Fi without a TCP FIN leaves
 * its socket registered on the Stick: the WebView saw the close, the embedded
 * server did not. The room then still has a TV, so the real TV coming back is
 * refused with `room_has_tv` and the phones sit in a room nobody serves.
 * Nothing in the WebSocket protocol closes that socket for the server -- the OS
 * can keep a dead TCP connection open indefinitely -- so the server asks.
 *
 * A real scheduler would make this a wall-clock test of nothing. The check is
 * therefore given its ticks rather than waiting for them.
 */
class ManualSchedule {
    private var task: (() -> Unit)? = null

    /** What [watchForDeadPeers] gets instead of a timer in these tests. */
    val schedule: (Long, () -> Unit) -> () -> Unit = { _, run ->
        task = run
        { task = null }
    }

    fun tick() {
        task?.invoke()
    }
}

private class FakePeer : HeartbeatPeer {
    var pings = 0
    var cutOff = false
    private var answered: (() -> Unit)? = null

    override fun ping() {
        pings += 1
    }

    override fun cutOff() {
        cutOff = true
    }

    override fun onPong(answer: () -> Unit) {
        answered = answer
    }

    /** The far end answers the ping it was sent. */
    fun answers() {
        answered?.invoke()
    }
}

private class FakeRelaySocket : Socket {
    val sent = mutableListOf<JSONObject>()
    override fun send(data: String) {
        sent.add(JSONObject(data))
    }

    fun types(): List<String> = sent.map { it.getString("t") }
}

private fun tvWelcome(socket: FakeRelaySocket): JSONObject {
    val welcome = socket.sent.firstOrNull() ?: error("the TV's hello was not welcomed")
    assertEquals("welcome", welcome.getString("t"))
    return welcome
}

class HeartbeatTest {
    @Test
    fun `pings once a tick, and never cuts off a peer that answers`() {
        val peer = FakePeer()
        val clock = ManualSchedule()
        watchForDeadPeers(peer, {}, HEARTBEAT_INTERVAL_MS, clock.schedule)

        clock.tick()
        assertEquals(1, peer.pings)
        peer.answers()

        repeat(20) {
            clock.tick()
            peer.answers()
        }
        // Every tick is answered, so every tick is only a ping.
        assertEquals(21, peer.pings)
        assertFalse(peer.cutOff)
    }

    @Test
    fun `gives up on a peer that misses a tick, and says so once`() {
        val peer = FakePeer()
        val clock = ManualSchedule()
        var deaths = 0
        watchForDeadPeers(peer, { deaths += 1 }, HEARTBEAT_INTERVAL_MS, clock.schedule)

        // One tick goes by with no answer: the next one is the deadline.
        clock.tick()
        assertFalse(peer.cutOff)
        clock.tick()
        assertTrue(peer.cutOff)
        assertEquals(1, deaths)

        // And it is over: a peer already given up on is not cut off again.
        repeat(10) { clock.tick() }
        assertEquals(1, deaths)
    }

    @Test
    fun `frees the room of a TV whose socket went silent, so the real TV can come back`() {
        val relay = Relay(RelayOptions(random = { 0.0 }))
        val tvSocket = FakeRelaySocket()
        val tv = relay.add(tvSocket)
        relay.receive(tv.id, JSONObject().put("t", "hello").put("v", PROTOCOL_VERSION).put("kind", "tv").toString())
        val welcome = tvWelcome(tvSocket)
        val room = welcome.getString("room")
        val credential = welcome.getString("hostToken")

        // The TV drops off the network. The server sees nothing: no close, no
        // exception, just a socket that never answers again.
        val peer = FakePeer()
        val clock = ManualSchedule()
        watchForDeadPeers(peer, { relay.remove(tv.id) }, HEARTBEAT_INTERVAL_MS, clock.schedule)
        clock.tick()
        clock.tick()
        assertTrue(peer.cutOff)

        // The real TV comes back with the credential it was given. Before the
        // dead socket was cut off this hello was refused with `room_has_tv`;
        // now the room is free and it lands.
        val back = FakeRelaySocket()
        val returning = relay.add(back)
        relay.receive(
            returning.id,
            JSONObject()
                .put("t", "hello")
                .put("v", PROTOCOL_VERSION)
                .put("kind", "tv")
                .put("room", room)
                .put("hostToken", credential)
                .toString(),
        )
        assertTrue(back.types().contains("welcome"))
    }

    @Test
    fun `gives a silent socket far longer than it gives a phone to reconnect`() {
        // The point of the check is a socket the OS still believes in, not a
        // Stick that stalled for a second while it painted the room.
        assertTrue(HEARTBEAT_INTERVAL_MS >= 5_000L)
    }
}
