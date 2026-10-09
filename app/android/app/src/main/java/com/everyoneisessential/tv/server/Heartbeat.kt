package com.everyoneisessential.tv.server

import java.util.Timer
import java.util.TimerTask

/**
 * How often every connection on the room's wire is asked to prove it is still
 * there. Ten seconds, and the deadline for an answer is the next tick -- so a
 * connection that has really gone is given up on between ten and twenty
 * seconds after it went.
 *
 * Why those numbers, and not something tighter or looser:
 *
 *   - What is being caught is a socket the OS still believes in, not a phone
 *     that stalled. A Stick busy painting the room, or a phone that was just
 *     backgrounded and handed back, both answer well inside ten seconds -- and
 *     a check that gave up on either of those would be a check that invented
 *     disconnects.
 *   - Twenty seconds is well inside the room's own seat grace (`SEAT_GRACE_MS`,
 *     three minutes), so a phone given up on here finds its seat still held
 *     when it reconnects. That is what makes giving up on a dead socket safe
 *     rather than merely tidy.
 *   - It is short enough that a room whose TV went silent is usable again
 *     while the family is still sitting in front of it -- which is the same
 *     check's other job, on the TV's own connection.
 *
 * Mirrors `HEARTBEAT_INTERVAL_MS` in `app/relay/src/main.ts`.
 */
const val HEARTBEAT_INTERVAL_MS = 10_000L

/** One connection as the dead-peer check sees it. */
interface HeartbeatPeer {
    /** Ask the far end to answer. */
    fun ping()

    /** Give the connection up, without waiting for it to agree. */
    fun cutOff()

    /** Called every time the far end answers a ping. */
    fun onPong(answer: () -> Unit)
}

/** Where the check gets its ticks. Returns the way to stop them. */
typealias HeartbeatSchedule = (Long, () -> Unit) -> () -> Unit

/** A daemon timer: a check that outlived the server would hold the process open. */
private fun scheduleWithTimer(intervalMs: Long, tick: () -> Unit): () -> Unit {
    val timer = Timer("relay-heartbeat", true)
    timer.scheduleAtFixedRate(
        object : TimerTask() {
            override fun run() = tick()
        },
        intervalMs,
        intervalMs,
    )
    return { timer.cancel() }
}

/**
 * Watch one connection, and give up on it when it stops answering.
 *
 * A server cannot tell a quiet connection from a gone one by waiting: a dead
 * socket can stay open for as long as the OS keeps its TCP connection, which
 * can be forever. So the server asks, every [HEARTBEAT_INTERVAL_MS], and a
 * connection that did not answer the previous ask is given up on: [onDead]
 * first -- which is what takes it out of the relay and frees whatever it was
 * holding -- and then [cutOff].
 *
 * That order matters here. NanoWSD's read loop only notices a close when it
 * next comes round, and a socket that has gone silent never sends the frame
 * that would bring it round; so the room has to be freed by [onDead] rather
 * than by waiting for the close to be observed.
 *
 * The returned function stops the check -- what the server calls when a
 * connection closes properly, since a socket that closed is not one to watch.
 */
fun watchForDeadPeers(
    peer: HeartbeatPeer,
    onDead: () -> Unit,
    intervalMs: Long = HEARTBEAT_INTERVAL_MS,
    schedule: HeartbeatSchedule = ::scheduleWithTimer,
): () -> Unit {
    val answered = Answered()
    peer.onPong { answered.alive = true }

    var stop: (() -> Unit)? = null
    stop =
        schedule(intervalMs) {
            if (!answered.alive) {
                // Two intervals with no answer: nothing on the other end can
                // answer, and the room should stop counting this connection.
                stop?.invoke()
                onDead()
                peer.cutOff()
                return@schedule
            }
            answered.alive = false
            peer.ping()
        }
    return { stop?.invoke() }
}

/**
 * The one word the check and the connection share: whether the last ask was
 * answered. It is written by the read thread when a pong arrives and read by
 * the tick thread a moment later, so it has to be a field with `@Volatile` on
 * it rather than a local -- a local captured by two threads is a value each of
 * them may keep reading out of its own register, which is how a peer that
 * answered every ping gets given up on anyway.
 */
private class Answered {
    @Volatile var alive = true
}
