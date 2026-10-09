package com.everyoneisessential.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.everyoneisessential.tv.net.LanAddress
import com.everyoneisessential.tv.server.EmbeddedServer
import java.net.URLEncoder

/**
 * The whole app: a full-screen WebView over the TV bundle in
 * `file:///android_asset/tv/`, an embedded server for the phone page and the
 * relay, and the one piece of glue a WebView does not do for free on a
 * Fire TV -- Back.
 *
 * Back, in detail: a hardware remote's Back key reaches Android as
 * `KEYCODE_BACK`, and the platform's default answer -- `WebView.goBack()` if
 * there is history, else finish the Activity -- is exactly the bug this class
 * exists to fix (Amazon Web App Tester does the same thing and kills the
 * WebView). This Activity intercepts
 * `onBackPressed` and, instead of acting on it, hands it to the page as the
 * same `keydown` event a Fire TV remote already sends (`keyCode: 4`, which
 * `app/tv/src/remote.ts`'s `keyIntent` already maps to `"back"`) -- so the
 * page's own leave-confirmation flow runs, unchanged from the web build. The
 * app only actually closes when that flow finishes and the page calls
 * `Android.leave()` through [WebAppBridge], which is the other half of this
 * contract.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var server: EmbeddedServer? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // A party game that is on screen the whole time it is running; there is
        // no separate "idle" state where the screen should be allowed to sleep.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.addJavascriptInterface(WebAppBridge(this), "Android")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // The app never navigates anywhere else; keep every load inside this WebView.
                return false
            }
        }

        val port = 8080
        val ip = LanAddress.find()
        if (ip != null) {
            val embedded = EmbeddedServer(applicationContext, port)
            try {
                embedded.start(fi.iki.elonen.NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                server = embedded
            } catch (e: java.io.IOException) {
                // No embedded server means no phones can join; the lobby still
                // renders (there is simply nothing to connect to), and this is
                // logged rather than crashing the demo over it.
                android.util.Log.e("EveryoneEssential", "embedded server failed to start on port $port", e)
            }
        }

        webView.loadUrl(launchUrl(ip, port))
        webView.requestFocus(View.FOCUS_DOWN)
    }

    private fun launchUrl(ip: String?, port: Int): String {
        // Always over HTTP from our own embedded server, never file://: a file://
        // origin cannot execute the built ES module and the page comes up blank.
        if (ip == null) return "http://127.0.0.1:$port/tv/index.html?nolan=1"
        val relay = URLEncoder.encode("ws://$ip:$port/relay", "UTF-8")
        val base = URLEncoder.encode("http://$ip:$port/phone/", "UTF-8")
        return "http://127.0.0.1:$port/tv/index.html?relay=$relay&base=$base"
    }

    override fun onDestroy() {
        server?.stop()
        super.onDestroy()
    }

    override fun onBackPressed() {
        // Never act on Back directly -- see the class doc. The page decides.
        val js =
            "(function(){" +
                "var opts={key:'Back',keyCode:4,which:4,bubbles:true,cancelable:true};" +
                "window.dispatchEvent(new KeyboardEvent('keydown', opts));" +
                "window.dispatchEvent(new KeyboardEvent('keyup', opts));" +
                "})();"
        webView.evaluateJavascript(js, null)
    }

    /**
     * The bridge between the page and the app: the page calls
     * `Android.leave()` exactly once, after its own confirmation flow decides
     * the player really is leaving, and only then does the app close.
     */
    private class WebAppBridge(private val activity: Activity) {
        @JavascriptInterface
        fun leave() {
            activity.runOnUiThread { activity.finish() }
        }
    }
}
