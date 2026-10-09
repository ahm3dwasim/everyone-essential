package com.everyoneisessential.tv.server

import android.content.Context
import com.everyoneisessential.tv.protocol.Client
import com.everyoneisessential.tv.protocol.Relay
import com.everyoneisessential.tv.protocol.Socket
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import java.io.IOException

/**
 * The whole server side of the demo, embedded in the app and running on the
 * Stick: static files for the phone controller page (from `assets/phone/`,
 * under `/phone/`) and the WebSocket relay (any path -- NanoWSD does not
 * route on it), on one port. Nothing on a laptop is needed.
 *
 * NanoHTTPD + its NanoWSD extension were picked over a hand-rolled
 * `ServerSocket` or a heavier server (ktor-server, ...) because it is one
 * small, dependency-free jar that already builds a WebSocket server on top of
 * an HTTP server -- one embedded port does both jobs.
 */
class EmbeddedServer(private val context: Context, port: Int) : NanoWSD(port) {

    private val relay = Relay()

    // NanoWSD's own `serve()` already branches on the WebSocket upgrade headers and calls
    // `openWebSocket()` for one, `serveHttp()` (this) for everything else -- there is nothing to
    // override at the `serve()` level.
    override fun serveHttp(session: IHTTPSession): Response {
        val uri = session.uri
        if (uri == "/") {
            val redirect = newFixedLengthResponse(Response.Status.REDIRECT, NanoHTTPD.MIME_PLAINTEXT, "")
            redirect.addHeader("Location", "/phone/")
            return redirect
        }
        // The TV page is served over HTTP too, not read from file:///android_asset:
        // Chromium refuses to execute an ES module from a file:// origin, which
        // would leave the WebView showing an empty <div id="root"> and nothing else.
        if (!uri.startsWith("/phone/") && !uri.startsWith("/tv/")) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, NanoHTTPD.MIME_PLAINTEXT, "not found: $uri")
        }
        var assetPath = uri.removePrefix("/")
        if (assetPath.endsWith("/")) assetPath += "index.html"
        return try {
            val stream = context.assets.open(assetPath)
            newChunkedResponse(Response.Status.OK, mimeTypeFor(assetPath), stream)
        } catch (e: IOException) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, NanoHTTPD.MIME_PLAINTEXT, "not found: $assetPath")
        }
    }

    private fun mimeTypeFor(path: String): String = when {
        path.endsWith(".html") -> "text/html"
        path.endsWith(".js") -> "application/javascript"
        path.endsWith(".css") -> "text/css"
        path.endsWith(".json") || path.endsWith(".map") -> "application/json"
        path.endsWith(".svg") -> "image/svg+xml"
        path.endsWith(".png") -> "image/png"
        else -> "application/octet-stream"
    }

    override fun openWebSocket(handshake: IHTTPSession): NanoWSD.WebSocket = RelayWebSocket(handshake)

    private inner class RelayWebSocket(handshake: IHTTPSession) : NanoWSD.WebSocket(handshake), HeartbeatPeer {
        private var client: Client? = null
        private var answered: (() -> Unit)? = null
        private var stopWatching: (() -> Unit)? = null

        override fun onOpen() {
            val opened = relay.add(object : Socket {
                override fun send(data: String) {
                    try {
                        this@RelayWebSocket.send(data)
                    } catch (e: IOException) {
                        // The peer is already gone; onClose/onException below clean up the relay's side.
                    }
                }
            })
            client = opened
            // A connection the OS still believes in but nothing is behind is
            // what leaves a room holding a TV that is not there, so every
            // connection is watched from the moment it arrives.
            stopWatching = watchForDeadPeers(this, { relay.remove(opened.id) })
        }

        override fun onClose(code: NanoWSD.WebSocketFrame.CloseCode?, reason: String?, initiatedByRemote: Boolean) {
            stopWatching?.invoke()
            client?.let { relay.remove(it.id) }
        }

        override fun onMessage(message: NanoWSD.WebSocketFrame) {
            val id = client?.id ?: return
            relay.receive(id, message.textPayload)
        }

        override fun onPong(pong: NanoWSD.WebSocketFrame?) {
            // No client sends a ping of its own, so the only pongs here are
            // the answers to this server's own checks.
            answered?.invoke()
        }

        override fun onException(exception: IOException?) {
            stopWatching?.invoke()
            client?.let { relay.remove(it.id) }
        }

        override fun ping() {
            try {
                super.ping(ByteArray(0))
            } catch (e: IOException) {
                // A ping that cannot be written is the answer in itself: the
                // next tick finds no pong and gives the connection up.
            }
        }

        /**
         * NanoWSD has no force-terminate: `close` is a close *handshake*, and a
         * peer that has gone will never complete one. What this does do is end
         * the read loop, which is otherwise blocked on a socket nothing will
         * ever arrive on -- and the room has already been freed by the watch's
         * own `onDead` by the time this runs, so nothing here is load-bearing
         * for the relay's state.
         */
        override fun cutOff() {
            try {
                close(NanoWSD.WebSocketFrame.CloseCode.GoingAway, "no answer to a ping", false)
            } catch (e: IOException) {
                // Already gone; there is nothing left to cut off.
            }
        }

        override fun onPong(answer: () -> Unit) {
            answered = answer
        }
    }
}
