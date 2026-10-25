package com.glorycast.switcher

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Finds OBS on the Wi-Fi: tries every address next to the phone's own for OBS's WebSocket port (4455)
 * and takes the first that answers. The last address found is tried first.
 *
 * Church Wi-Fi often has no internet. Android then sends an app's traffic over mobile data, where OBS
 * can't be reached, so the whole app (the Switch page too) is kept on the Wi-Fi.
 */
object Finder {
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

    /** the phone's own Wi-Fi address and the 254 addresses around it (a /24; a smaller network stays smaller) */
    fun neighbours(ctx: Context): List<String> {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return emptyList()
        val net = wifi ?: cm.activeNetwork ?: return emptyList()
        val lp = cm.getLinkProperties(net) ?: return emptyList()
        val la = lp.linkAddresses.firstOrNull { it.address is Inet4Address && !it.address.isLoopbackAddress } ?: return emptyList()
        val me = la.address.address.map { it.toInt() and 0xFF }
        val ip = (me[0] shl 24) or (me[1] shl 16) or (me[2] shl 8) or me[3]
        val prefix = la.prefixLength.coerceIn(24, 30)
        val mask = -1 shl (32 - prefix)
        val first = ip and mask
        val size = 1 shl (32 - prefix)
        val out = ArrayList<String>()
        for (i in 1 until size - 1) {
            val a = first + i
            if (a == ip) continue
            out.add("${(a ushr 24) and 0xFF}.${(a ushr 16) and 0xFF}.${(a ushr 8) and 0xFF}.${a and 0xFF}")
        }
        return out
    }

    private fun open(host: String, port: Int, timeoutMs: Int): Boolean = try {
        val s = wifi?.socketFactory?.createSocket() ?: java.net.Socket()
        s.use { it.connect(InetSocketAddress(host, port), timeoutMs) }
        true
    } catch (e: Exception) {
        false
    }

    /** OBS's address, or null when nothing on this Wi-Fi answers on the port. Takes a few seconds at most. */
    fun find(ctx: Context, port: Int, last: String?): String? {
        if (!last.isNullOrEmpty() && open(last, port, 700)) return last
        val all = neighbours(ctx)
        if (all.isEmpty()) return null
        val pool = Executors.newFixedThreadPool(64)
        try {
            val cs = ExecutorCompletionService<String?>(pool)
            all.forEach { h -> cs.submit { if (open(h, port, 900)) h else null } }
            val end = System.currentTimeMillis() + 6000
            repeat(all.size) {
                val wait = end - System.currentTimeMillis()
                if (wait <= 0) return null
                val f = cs.poll(wait, TimeUnit.MILLISECONDS) ?: return null
                val h = try { f.get() } catch (e: Exception) { null }
                if (h != null) return h
            }
            return null
        } finally {
            pool.shutdownNow()
        }
    }
}
