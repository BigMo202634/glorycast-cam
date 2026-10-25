package com.glorycast.switcher

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.concurrent.thread

/**
 * The Switch page (assets/web, a copy of GloryCast Switch's app folder) in a full-screen WebView.
 * The page is served from inside the app at a fixed address, so its settings stay put, and it links to
 * OBS directly: the app finds OBS on the Wi-Fi and tells the page where it is.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("switch", Context.MODE_PRIVATE) }
    @Volatile private var searching = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Finder.watch(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this)
        web.setBackgroundColor(0xFF0F1E3D.toInt())
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            allowFileAccess = false
        }
        web.addJavascriptInterface(Bridge(), "GCAndroid")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.host != HOST) return null
                var path = (u.path ?: "/").trimStart('/')
                if (path.isEmpty()) path = "index.html"
                if (path.contains("..")) return missing()
                return try {
                    WebResourceResponse(mime(path), if (mime(path).startsWith("text") || path.endsWith(".js") || path.endsWith(".json")) "utf-8" else null,
                        assets.open("web/$path"))
                } catch (e: Exception) {
                    missing()
                }
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = !url.startsWith("http://$HOST/")

            override fun onPageFinished(view: WebView, url: String) {
                search(prefs.getString("port", "4455") ?: "4455", true)
            }
        }
        setContentView(web)
        immersive()
        web.loadUrl("http://$HOST/")
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() { web.destroy(); super.onDestroy() }

    /** Look for OBS. auto: the app's own search when the page opens (the page ignores it when OBS is already set). */
    private fun search(port: String, auto: Boolean) {
        if (searching) return
        searching = true
        thread(name = "find-obs") {
            val p = port.trim().toIntOrNull() ?: 4455
            val ip = try { Finder.find(this, p, prefs.getString("obs", null)) } catch (e: Exception) { null }
            if (ip != null) prefs.edit().putString("obs", ip).putString("port", p.toString()).apply()
            searching = false
            runOnUiThread {
                if (!isDestroyed) web.evaluateJavascript("window.GCSwitch && GCSwitch.foundObs(${JSONObject.quote(ip ?: "")}, $auto)", null)
            }
        }
    }

    inner class Bridge {
        /** the OBS address found last time, so the page can link at once while the app checks again */
        @JavascriptInterface fun obsHost(): String = prefs.getString("obs", "") ?: ""

        @JavascriptInterface fun findObs(port: String) { runOnUiThread { search(port, false) } }
    }

    @Suppress("DEPRECATION")
    private fun immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            val c = window.insetsController ?: return
            c.hide(WindowInsets.Type.systemBars())
            c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }

    private fun missing() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, ByteArrayInputStream(ByteArray(0)))

    private fun mime(p: String) = when (p.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "js" -> "application/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "png" -> "image/png"
        "svg" -> "image/svg+xml"
        "ttf" -> "font/ttf"
        else -> "application/octet-stream"
    }

    companion object {
        // Android's own address for pages carried inside an app (it never goes out to the internet)
        const val HOST = "appassets.androidplatform.net"
    }
}
