package com.glorycast.cam

import android.content.Context
import android.net.ConnectivityManager
import android.os.SystemClock
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.nio.ByteBuffer

/**
 * Finds GloryCast Cam on the church Wi-Fi: asks the whole network "GLORYCAST-CAM?" and the
 * media computer answers with its name and port (server.js, listenForApps). Blocking: call it
 * off the main thread.
 */
object Discovery {
    const val PORT = 7797

    data class Found(val name: String, val ip: String, val port: Int, val version: String) {
        val base get() = "http://$ip:$port"
    }

    fun search(ctx: Context, timeoutMs: Long = 2500): List<Found> {
        val out = LinkedHashMap<String, Found>()
        try {
            DatagramSocket().use { s ->
                s.broadcast = true
                s.soTimeout = 300
                val ask = "GLORYCAST-CAM?".toByteArray()
                val targets = (broadcastAddresses(ctx) + InetAddress.getByName("255.255.255.255")).distinct()
                val end = SystemClock.elapsedRealtime() + timeoutMs
                var nextAsk = 0L
                val buf = ByteArray(2048)
                while (SystemClock.elapsedRealtime() < end) {
                    val now = SystemClock.elapsedRealtime()
                    if (now >= nextAsk) {
                        for (t in targets) try { s.send(DatagramPacket(ask, ask.size, t, PORT)) } catch (e: Exception) { /* this route is closed */ }
                        nextAsk = now + 700
                    }
                    try {
                        val p = DatagramPacket(buf, buf.size)
                        s.receive(p)
                        val o = JSONObject(String(p.data, 0, p.length, Charsets.UTF_8))
                        if (o.optString("app") != "glorycast-cam") continue
                        val ip = p.address.hostAddress ?: continue
                        out[ip] = Found(o.optString("name", ip).ifBlank { ip }, ip, o.optInt("http", 7795), o.optString("version"))
                    } catch (e: SocketTimeoutException) {
                        // keep listening until the time is up
                    } catch (e: Exception) {
                        // not a GloryCast answer
                    }
                }
            }
        } catch (e: Exception) {
            // no Wi-Fi: nothing found
        }
        return out.values.toList()
    }

    /** the Wi-Fi's own broadcast address (some routers drop 255.255.255.255) */
    private fun broadcastAddresses(ctx: Context): List<InetAddress> {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return emptyList()
        val n = Net.wifi ?: cm.activeNetwork ?: return emptyList()
        val lp = cm.getLinkProperties(n) ?: return emptyList()
        return lp.linkAddresses.mapNotNull { la ->
            val a = la.address as? Inet4Address ?: return@mapNotNull null
            val bits = la.prefixLength
            if (bits <= 0 || bits >= 31) return@mapNotNull null
            val ip = ByteBuffer.wrap(a.address).int
            val mask = -1 shl (32 - bits)
            InetAddress.getByAddress(ByteBuffer.allocate(4).putInt(ip or mask.inv()).array())
        }
    }
}
