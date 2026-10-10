package com.glorycast.cam

import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * Talks to GloryCast Cam on the media computer exactly like the camera web page does:
 * a live event stream in (GET /events?role=phone), small JSON posts out.
 * The picture itself goes straight to OBS over WebRTC.
 */
class Signal(private val base: String, private val name: String, private val cb: Callback) {
    interface Callback {
        fun onEvent(from: Signal, ev: String, data: JSONObject)
        fun onUp(from: Signal)
        fun onDown(from: Signal)
    }

    /** this phone's id on the server; a new one after every reconnect */
    @Volatile var id: String? = null
        private set
    @Volatile private var closed = false
    @Volatile private var conn: HttpURLConnection? = null
    private val posts = Executors.newSingleThreadExecutor { r -> Thread(r, "gccam-post").apply { isDaemon = true } }

    fun start() {
        Thread({ loop() }, "gccam-events").apply { isDaemon = true; start() }
    }

    fun close() {
        closed = true
        try { conn?.disconnect() } catch (e: Exception) { /* closed */ }
        posts.shutdown()
    }

    private fun loop() {
        var retry = 1500L
        while (!closed) {
            try {
                val q = "role=phone&name=" + URLEncoder.encode(name, "UTF-8")
                val c = URL("$base/events?$q").openConnection() as HttpURLConnection
                c.connectTimeout = 4000
                c.readTimeout = 40000 // the server pings every 15 s
                c.setRequestProperty("Accept", "text/event-stream")
                c.useCaches = false
                conn = c
                if (closed) break
                if (c.responseCode != 200) throw IOException("HTTP " + c.responseCode)
                cb.onUp(this)
                val r = BufferedReader(InputStreamReader(c.inputStream, Charsets.UTF_8))
                var ev = "message"
                val data = StringBuilder()
                while (!closed) {
                    val line = r.readLine() ?: break
                    if (line.isEmpty()) {
                        if (data.isNotEmpty()) dispatch(ev, data.toString())
                        ev = "message"; data.setLength(0)
                        continue
                    }
                    if (line.startsWith(":")) continue
                    val i = line.indexOf(':')
                    val field = if (i < 0) line else line.substring(0, i)
                    var value = if (i < 0) "" else line.substring(i + 1)
                    if (value.startsWith(" ")) value = value.substring(1)
                    when (field) {
                        "event" -> ev = value
                        "data" -> { if (data.isNotEmpty()) data.append('\n'); data.append(value) }
                        "retry" -> value.toLongOrNull()?.let { retry = it.coerceIn(500, 10000) }
                    }
                }
            } catch (e: Exception) {
                // the media computer is not there (yet), or the Wi-Fi dropped: try again
            } finally {
                try { conn?.disconnect() } catch (e: Exception) { /* closed */ }
                conn = null
            }
            if (closed) break
            id = null
            cb.onDown(this)
            try { Thread.sleep(retry) } catch (e: InterruptedException) { break }
        }
    }

    private fun dispatch(ev: String, s: String) {
        val o = try { JSONObject(s) } catch (e: Exception) { JSONObject() }
        if (ev == "hello") id = o.str("id")
        cb.onEvent(this, ev, o)
    }

    /** posts go out one at a time, in order, so an offer always reaches OBS before its candidates */
    fun post(path: String, body: JSONObject) {
        val me = id ?: return
        if (closed) return
        body.put("id", me).put("from", me)
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        try {
            posts.execute { send(path, bytes, "application/json") }
        } catch (e: Exception) { /* closing */ }
    }

    fun signal(to: String, data: JSONObject) = post("/signal", JSONObject().put("to", to).put("data", data))

    /** the small still OBS shows while the live picture (re)connects; runs on the caller's thread */
    fun postStill(jpeg: ByteArray) {
        val me = id ?: return
        if (closed) return
        send("/still?id=" + URLEncoder.encode(me, "UTF-8"), jpeg, "image/jpeg")
    }

    private fun send(path: String, bytes: ByteArray, type: String): Int = try {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.connectTimeout = 4000
        c.readTimeout = 8000
        c.requestMethod = "POST"
        c.doOutput = true
        c.useCaches = false
        c.setRequestProperty("Content-Type", type)
        c.setFixedLengthStreamingMode(bytes.size)
        c.outputStream.use { it.write(bytes) }
        val code = c.responseCode
        // read the answer to the end so the connection can be used again
        (if (code >= 400) c.errorStream else c.inputStream)?.use { it.readBytes() }
        code
    } catch (e: Exception) {
        0
    }
}
