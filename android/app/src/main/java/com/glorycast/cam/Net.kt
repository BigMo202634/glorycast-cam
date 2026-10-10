package com.glorycast.cam

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Church Wi-Fi often has no internet. Android then sends an app's traffic over mobile data,
 * where the media computer can't be reached, so everything this app does goes over the Wi-Fi.
 */
object Net {
    @Volatile var wifi: Network? = null
        private set
    private var watching = false

    fun watch(ctx: Context) {
        if (watching) return
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return
        watching = true
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try {
            cm.registerNetworkCallback(req, object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    wifi = network
                    try { cm.bindProcessToNetwork(network) } catch (e: Exception) { /* keep the default route */ }
                }

                override fun onLost(network: Network) {
                    if (wifi != network) return
                    wifi = null
                    try { cm.bindProcessToNetwork(null) } catch (e: Exception) { /* nothing bound */ }
                }
            })
        } catch (e: Exception) {
            watching = false
        }
    }

    /**
     * The address of GloryCast Cam on the media computer, from what someone typed:
     * "192.168.1.20", "192.168.1.20:7795" or the camera page link "https://192.168.1.20:7796/phone".
     * The app talks to the plain port; the camera page's https port is the one after it.
     */
    fun baseFor(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        var secure = false
        if (s.startsWith("https://", true)) { secure = true; s = s.substring(8) }
        else if (s.startsWith("http://", true)) s = s.substring(7)
        s = s.substringBefore('/').substringBefore('?').trim()
        val colon = s.lastIndexOf(':')
        val host: String
        var port: Int
        if (colon > 0 && s.indexOf(':') == colon) {
            host = s.substring(0, colon)
            port = s.substring(colon + 1).toIntOrNull() ?: return null
            if (secure || port == 7796) port -= 1
        } else {
            host = s
            port = 7795
        }
        if (host.isEmpty() || host.contains(' ')) return null
        return "http://$host:$port"
    }

    /** "192.168.1.20" for "http://192.168.1.20:7795" (the port only when it is not the usual one) */
    fun label(base: String): String {
        val s = base.removePrefix("http://")
        return if (s.endsWith(":7795")) s.removeSuffix(":7795") else s
    }

    fun getJson(url: String, timeoutMs: Int = 3000): JSONObject? = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        try {
            if (c.responseCode != 200) null else JSONObject(c.inputStream.bufferedReader().use { it.readText() })
        } finally {
            c.disconnect()
        }
    } catch (e: Exception) {
        null
    }
}

/** a JSON value that may be missing or null */
fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key)
