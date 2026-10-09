package com.everyoneisessential.tv.protocol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The relay on the Stick is reached from more than one thread at once.
 *
 * NanoHTTPD runs a thread per connection, and every connection also carries
 * its own heartbeat timer, so `add`, `remove` and `receive` genuinely overlap
 * -- and a heartbeat's `remove` can land in the middle of a `receive` that is
 * walking a room's peer list. The state is plain `LinkedHashMap`s, so without
 * one lock around the lot a structural change during an iteration throws, and
 * on a phone's thread that exception reaches `onException`, which removes that
 * phone: a race here reads on screen as a player thrown out of a room for no
 * reason.
 *
 * The storm below is what that looks like when it happens: several threads
 * joining, speaking and dropping at once, with the double `remove` a real
 * connection gets when the read loop sees the close at the same moment the
 * timer gives the socket up.
 */
class RelayConcurrencyTest {

    /** A socket that only records, so a thread here never blocks on a peer. */
    private class RecordingSocket : Socket {
        val sent: MutableList<String> = Collections.synchronizedList(mutableListOf<String>())
        override fun send(data: String) {
            sent.add(data)
        }
        fun first(): JSONObject = JSONObject(sent.first())
    }

    private fun hello(relay: Relay, socket: RecordingSocket, kind: String, room: String?): String {
        val client = relay.add(socket)
        val payload = JSONObject().put("t", "hello").put("v", PROTOCOL_VERSION).put("kind", kind)
        if (room != null) payload.put("room", room)
        relay.receive(client.id, payload.toString())
        return client.id
    }

    @Test
    fun `joins, drops and heartbeat removals can overlap without breaking the room`() {
        // The default cap of eight peers is a room limit, not a thread limit:
        // every thread here holds a seat for a moment, so the storm needs a
        // room nothing in it is refused for being full.
        val relay = Relay(RelayOptions(maxPeersPerRoom = 64))
        val tvSocket = RecordingSocket()
        val tv = hello(relay, tvSocket, "tv", null)
        val room = tvSocket.first().getString("room")

        val threads = 8
        val rounds = 40
        val failures = Collections.synchronizedList(mutableListOf<String>())
        val start = CountDownLatch(1)
        val done = CountDownLatch(threads)

        val racers = (0 until threads).map { racer ->
            Thread {
                try {
                    start.await()
                    repeat(rounds) {
                        val socket = RecordingSocket()
                        val phone = hello(relay, socket, "phone", room)
                        // A phone speaking to the TV -- the ordinary path, and
                        // the one that stamps and forwards under the lock.
                        relay.receive(
                            phone,
                            JSONObject()
                                .put("t", "relay")
                                .put("to", "tv")
                                .put(
                                    "payload",
                                    JSONObject().put("t", "join").put("seat", "0123456789abcdef0123456789abcdef"),
                                )
                                .toString(),
                        )
                        // Two removals at once, which is what a connection that
                        // closed and stopped answering at the same moment gets.
                        val second = Thread { relay.remove(phone) }
                        second.start()
                        relay.remove(phone)
                        second.join()
                    }
                } catch (t: Throwable) {
                    failures.add("racer $racer: $t")
                } finally {
                    done.countDown()
                }
            }
        }
        racers.forEach { it.start() }
        start.countDown()
        assertTrue("the storm did not finish", done.await(60, TimeUnit.SECONDS))
        racers.forEach { it.join() }

        assertEquals("a thread threw while the storm ran", emptyList<String>(), failures.toList())

        // And the room still knows exactly who is in it: the TV, and nobody
        // else -- every phone the storm made has been dropped, twice over.
        val late = RecordingSocket()
        hello(relay, late, "phone", room)
        assertEquals(2, late.first().getJSONArray("peers").length())
        assertEquals(listOf(room), relay.rooms_())
        assertEquals(emptyList<String>(), relay.tombstones_())
    }

    @Test
    fun `a phone that is dropped while the room empties leaves a room its TV can still come back to`() {
        // The same overlap, at the boundary the relay actually reasons about:
        // the last peer leaving is the moment the room becomes a tombstone,
        // and a heartbeat firing at that instant must not leave a half-emptied
        // room behind.
        val relay = Relay(RelayOptions(maxPeersPerRoom = 64))
        val tvSocket = RecordingSocket()
        val tv = hello(relay, tvSocket, "tv", null)
        val room = tvSocket.first().getString("room")

        val phones = (0 until 6).map { hello(relay, RecordingSocket(), "phone", room) }
        val leaving = phones + tv
        val start = CountDownLatch(1)
        val done = CountDownLatch(leaving.size)
        leaving.forEach { id ->
            Thread {
                start.await()
                relay.remove(id)
                relay.remove(id)
                done.countDown()
            }.start()
        }
        start.countDown()
        assertTrue("the drops did not finish", done.await(30, TimeUnit.SECONDS))

        // A room with no peers in it is remembered, not live: the code is not
        // one a new room can be given, and the TV that holds its credential is
        // the only thing that can open it again.
        assertEquals(emptyList<String>(), relay.rooms_())
        assertEquals(listOf(room), relay.tombstones_())
    }
}
