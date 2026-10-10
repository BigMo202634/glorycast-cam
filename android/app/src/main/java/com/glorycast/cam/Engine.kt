package com.glorycast.cam

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport
import org.webrtc.RtpParameters
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.AddIceObserver
import org.webrtc.DataChannel
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Everything the camera screen shows. Made on the engine thread, drawn on the main thread. */
data class UiState(
    val name: String = "",
    val running: Boolean = false,
    /** the media computer is reachable now */
    val connected: Boolean = false,
    /** it is not reachable now (and the camera is still running) */
    val lost: Boolean = false,
    /** live: on OBS Program. standby: in OBS, not live. unknown: vMix or a browser. off: nothing shows it */
    val tally: String = "off",
    /** OBS or vMix pages showing this camera */
    val views: Int = 0,
    val res: String = "",
    val dim: Boolean = false,
    val dimShow: Boolean = false,
    val dimFps: Int = 0,
    val batt: String = "",
    val hot: Boolean = false,
    val camErr: String? = null,
    val got: String = ""
)

/**
 * The camera, the link to the media computer and one WebRTC picture for each page that shows
 * this camera (the OBS page, and the small previews on the media computer page). It speaks the
 * same protocol as app/phone.html, so OBS links, the media computer page and the live light work
 * exactly as with the web camera.
 */
class Engine private constructor(private val app: Context) {

    data class Settings(val base: String, val name: String, val facing: String, val quality: Int, val fps: Int)

    interface Listener {
        fun onUi(s: UiState)
        fun onCaps(c: Caps)
        fun onManual(shutter: Int, iso: Int)
        /** the camera stopped; [error] says why when it was not the Stop button */
        fun onStopped(error: String?)
    }

    companion object {
        @Volatile private var inst: Engine? = null
        private var webrtcReady = false
        fun get(ctx: Context): Engine = inst ?: synchronized(this) { inst ?: Engine(ctx.applicationContext).also { inst = it } }
        fun peek(): Engine? = inst

        /** the OBS picture's size steps when the Wi-Fi can't keep up: full, 2/3, 1/2 */
        private val STEPS = doubleArrayOf(1.0, 1.5, 2.0)
        private const val ICE = "stun:stun.l.google.com:19302" // only helps when there is internet; the Wi-Fi path is used first
        val UA = "GloryCast Cam Android ${BuildConfig.VERSION_NAME} (${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE})"
    }

    @Volatile var listener: Listener? = null
    val egl: EglBase = EglBase.create()

    private val thread = HandlerThread("gccam-engine").apply { start() }
    private val h = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())

    private var factory: PeerConnectionFactory? = null
    private var source: VideoSource? = null
    @Volatile var track: VideoTrack? = null
        private set
    private var helper: SurfaceTextureHelper? = null
    @Volatile var camera: GcCamera? = null
        private set
    @Volatile private var sig: Signal? = null

    @Volatile var settings: Settings? = null
        private set
    @Volatile var running = false
        private set
    @Volatile var caps: Caps? = null
        private set
    @Volatile var state = UiState()
        private set
    @Volatile var rotation = 90
        private set

    private class Guard {
        var t = 0L
        var sent = 0.0
        var bad = 0
        var good = 0
        var wait = 20
        var changed = 0L
        var upAt = 0L
    }

    private class Peer(val id: String, val kind: String, val pc: PeerConnection, val sender: RtpSender) {
        var seen = true
        var offerSent = false
        var remoteSet = false
        val earlyIce = ArrayList<JSONObject>()     // our candidates found before the offer went out
        val pendingIce = ArrayList<IceCandidate>()  // OBS's candidates that came before its answer
        var step = 0
        var info: JSONObject? = null
        val g = Guard()
    }

    private val peers = HashMap<String, Peer>()
    private var camFps = 0.0
    private var lastFrames = 0L
    private var lastFramesAt = 0L
    private var dimSince = 0L
    private var dimShown = 0L
    private var ev = 0f

    // ---- commands (any thread) ----

    fun start(s: Settings, rotationDeg: Int) = h.post {
        if (running) {
            val cur = settings
            if (cur != null && cur.base == s.base && cur.name == s.name) return@post
            stopNow()
        }
        settings = s
        rotation = rotationDeg
        running = true
        if (!ensureWebrtc()) {
            running = false
            main.post { listener?.onStopped("This phone could not start the video engine.") }
            return@post
        }
        CamService.start(app, s.name)
        state = UiState(name = s.name, running = true)
        publish()
        openCamera()
        sig = Signal(s.base, s.name, sigCallback).also { it.start() }
        h.removeCallbacks(tick2)
        h.removeCallbacks(tick5)
        h.postDelayed(tick2, 2000)
        h.postDelayed(tick5, 5000)
    }

    fun stop() = h.post {
        stopNow()
        main.post { listener?.onStopped(null) }
    }

    fun flip() = h.post {
        val s = settings ?: return@post
        settings = s.copy(facing = if (s.facing == "user") "environment" else "user")
        Prefs(app).facing = settings!!.facing
        openCamera()
    }

    fun setPicture(quality: Int, fps: Int) = h.post {
        val s = settings ?: return@post
        settings = s.copy(quality = quality, fps = fps)
        state = state.copy(got = "Changing…")
        publish()
        openCamera()
    }

    /** brightness in EV steps; done by OBS when the camera can't (sent as a gain to the OBS page) */
    fun setEv(v: Float) {
        ev = v
        val c = caps
        if (c != null && c.evOk) camera?.setEv(v) else h.post { sendLook() }
    }

    // ---- engine thread ----

    private fun ensureWebrtc(): Boolean {
        if (factory != null) return true
        return try {
            synchronized(Companion) {
                if (!webrtcReady) {
                    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
                    webrtcReady = true
                }
            }
            val opts = PeerConnectionFactory.Options().apply {
                // never send the picture over mobile data
                networkIgnoreMask = PeerConnectionFactory.Options.ADAPTER_TYPE_CELLULAR
            }
            val f = PeerConnectionFactory.builder()
                .setOptions(opts)
                // hardware H.264 (cooler phone, longer battery), software VP8 for the small previews
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()
            val src = f.createVideoSource(false)
            val t = f.createVideoTrack("gccam", src)
            t.setEnabled(true)
            val sth = SurfaceTextureHelper.create("gccam-capture", egl.eglBaseContext)
            camera = GcCamera(app, sth, src.capturerObserver, camEvents)
            t.addSink(stillSink)
            factory = f; source = src; track = t; helper = sth
            true
        } catch (e: Throwable) {
            false
        }
    }

    private fun openCamera() {
        val s = settings ?: return
        val p = Prefs(app)
        caps = null
        camera?.open(s.facing, s.quality, s.fps, rotation, p.mm(s.facing) / 24f)
    }

    private fun stopNow() {
        running = false
        h.removeCallbacks(tick2)
        h.removeCallbacks(tick5)
        h.removeCallbacks(prune)
        h.removeCallbacks(retryCamera)
        sig?.close()
        sig = null
        for (id in peers.keys.toList()) closePeer(id)
        camera?.close()
        caps = null
        camFps = 0.0
        lastFramesAt = 0
        state = UiState()
        publish()
        CamService.stop(app)
    }

    private fun publish() {
        val s = state
        main.post { listener?.onUi(s) }
    }

    private val camEvents = object : GcCamera.Events {
        override fun onOpened(caps: Caps) {
            h.post {
                if (!running) return@post
                this@Engine.caps = caps
                val s = settings ?: return@post
                // the sensor runs faster than the chosen rate (no exact range on this phone): drop the extras evenly
                if (caps.cameraFps > caps.fps) source?.adaptOutputFormat(caps.width, caps.height, caps.fps)
                else source?.adaptOutputFormat(caps.width, caps.height, max(caps.cameraFps, caps.fps) + 5)
                ev = 0f
                state = state.copy(camErr = null, got = gotText(caps, s))
                publish()
                for (p in peers.values) tuneSender(p)
                sendStatus()
                sendLook()
                main.post { listener?.onCaps(caps) }
            }
        }

        override fun onError(message: String) {
            h.post {
                if (!running) return@post
                state = state.copy(camErr = message)
                publish()
                h.removeCallbacks(retryCamera)
                h.postDelayed(retryCamera, 2500)
            }
        }

        override fun onManual(shutter: Int, iso: Int) {
            main.post { listener?.onManual(shutter, iso) }
        }
    }

    private val retryCamera = Runnable { if (running) openCamera() }

    private fun gotText(c: Caps, s: Settings): String {
        var msg = "The phone is giving ${c.width}×${c.height} at ${c.fps} fps."
        if (min(c.width, c.height) < s.quality - 8) msg += " This phone does not offer ${if (s.quality == 2160) "4K" else "${s.quality}p"} here, so it uses the best it has."
        if (c.fps < s.fps - 1) msg += " It cannot do ${s.fps} fps at this size."
        return msg
    }

    // ---- the media computer ----

    private val sigCallback = object : Signal.Callback {
        override fun onEvent(from: Signal, ev: String, data: JSONObject) {
            h.post { if (from === sig) onEvent(ev, data) }
        }

        override fun onUp(from: Signal) {
            h.post {
                if (from !== sig) return@post
                state = state.copy(connected = true, lost = false)
                publish()
            }
        }

        override fun onDown(from: Signal) {
            h.post {
                if (from !== sig) return@post
                // the pictures go straight to OBS, so they keep going while this reconnects
                state = state.copy(connected = false, lost = true, tally = "off")
                publish()
            }
        }
    }

    private fun onEvent(ev: String, data: JSONObject) {
        when (ev) {
            "hello" -> {
                state = state.copy(connected = true, lost = false, tally = "off")
                publish()
                sendStatus()
                sendLook()
                // back after a Wi-Fi blip: pictures that kept going stay, ones OBS no longer has are closed
                for (p in peers.values) p.seen = false
                h.removeCallbacks(prune)
                h.postDelayed(prune, 4000)
            }
            "viewer" -> {
                val id = data.str("id") ?: return
                val p = peers[id]
                if (p != null && p.pc.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) p.seen = true
                else makePeer(id, data.str("kind") ?: "view")
            }
            "viewer-left" -> {
                closePeer(data.str("id") ?: return)
                countViews()
            }
            "signal" -> onSignal(data.str("from") ?: return, data.optJSONObject("data") ?: return)
            "tally" -> {
                state = state.copy(tally = data.str("tally") ?: "off")
                publish()
            }
            "replaced" -> {
                val name = settings?.name ?: ""
                stopNow()
                main.post { listener?.onStopped("Another phone started with the name “$name”. Pick a different name for this phone.") }
            }
        }
    }

    private val prune = Runnable {
        for (p in peers.values.toList()) if (!p.seen) closePeer(p.id)
        countViews()
    }

    private fun countViews() {
        val n = peers.values.count { it.kind == "view" }
        if (n != state.views) { state = state.copy(views = n); publish() }
    }

    private fun sendLook() {
        val c = caps
        val gain = if (c != null && !c.evOk) ev.coerceIn(-3f, 3f) else 0f
        sig?.post("/look", JSONObject().put("look", JSONObject().put("gain", gain.toDouble())))
    }

    // ---- one WebRTC picture per page ----

    private fun makePeer(id: String, kind: String) {
        val f = factory ?: return
        val t = track ?: return
        closePeer(id)
        val cfg = PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder(ICE).createIceServer())).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
            keyType = PeerConnection.KeyType.ECDSA
        }
        var peer: Peer? = null
        val obs = object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                h.post {
                    val p = peer ?: return@post
                    if (peers[id] !== p) return@post
                    val ice = JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)
                    if (p.offerSent) sig?.signal(id, JSONObject().put("ice", ice)) else p.earlyIce.add(ice)
                }
            }

            override fun onConnectionChange(s: PeerConnection.PeerConnectionState) {
                h.post {
                    val p = peer ?: return@post
                    if (peers[id] !== p) return@post
                    if (s == PeerConnection.PeerConnectionState.FAILED) {
                        h.postDelayed({ if (peers[id] === p) makePeer(id, kind) }, 1000)
                    }
                }
            }

            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onDataChannel(d: DataChannel) {}
            override fun onRenegotiationNeeded() {}
        }
        val pc = f.createPeerConnection(cfg, obs) ?: return
        val tr = pc.addTransceiver(t, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("gccam")))
        preferCodec(tr, if (kind == "preview") "VP8" else "H264")
        val p = Peer(id, kind, pc, tr.sender)
        peer = p
        peers[id] = p
        pc.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(d: SessionDescription) {
                pc.setLocalDescription(object : SdpAdapter() {
                    override fun onSetSuccess() {
                        h.post {
                            if (peers[id] !== p) return@post
                            tuneSender(p)
                            val ld = pc.localDescription ?: return@post
                            sig?.signal(id, JSONObject().put("sdp", JSONObject().put("type", "offer").put("sdp", ld.description)))
                            p.offerSent = true
                            for (ice in p.earlyIce) sig?.signal(id, JSONObject().put("ice", ice))
                            p.earlyIce.clear()
                        }
                    }
                }, d)
            }
        }, MediaConstraints())
        countViews()
    }

    private fun closePeer(id: String) {
        val p = peers.remove(id) ?: return
        try { p.pc.dispose() } catch (e: Exception) { /* closed */ }
    }

    private fun onSignal(from: String, data: JSONObject) {
        val p = peers[from] ?: return
        data.optJSONObject("sdp")?.let { o ->
            if (o.str("type") != "answer") return@let
            val sdp = o.str("sdp") ?: return@let
            p.pc.setRemoteDescription(object : SdpAdapter() {
                override fun onSetSuccess() {
                    h.post {
                        if (peers[from] !== p) return@post
                        p.remoteSet = true
                        for (c in p.pendingIce) p.pc.addIceCandidate(c, iceAdded)
                        p.pendingIce.clear()
                        tuneSender(p)
                    }
                }
            }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
        }
        data.optJSONObject("ice")?.let { o ->
            val cand = o.str("candidate")
            if (cand.isNullOrEmpty()) return@let
            val c = IceCandidate(o.str("sdpMid") ?: "0", o.optInt("sdpMLineIndex", 0), cand)
            if (p.remoteSet) p.pc.addIceCandidate(c, iceAdded) else p.pendingIce.add(c)
        }
    }

    private val iceAdded = object : AddIceObserver {
        override fun onAddSuccess() {}
        override fun onAddFailure(error: String) {}
    }

    private fun preferCodec(tr: RtpTransceiver, first: String) {
        try {
            val all = factory?.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO)?.codecs ?: return
            val top = all.filter { it.name.equals(first, true) }
            if (top.isEmpty()) return
            tr.setCodecPreferences(top + all.filter { !it.name.equals(first, true) })
        } catch (e: Exception) {
            // keep WebRTC's own order
        }
    }

    /** bits per second for the OBS picture: more for 4K and for 50/60 fps (as phone.html) */
    private fun bitrate(s: Settings): Int {
        val base = when (s.quality) { 2160 -> 20_000_000; 720 -> 3_500_000; else -> 8_000_000 }
        return (base * (if (s.fps >= 50) 1.5 else if (s.fps <= 25) 0.85 else 1.0)).roundToInt()
    }

    /**
     * Every picture keeps its full frame rate; when the Wi-Fi or the phone can't keep up it gets
     * a little less sharp instead of jerky. The small picture on the media computer page is about
     * 640×360 at up to 30 fps.
     */
    private fun tuneSender(p: Peer) {
        val s = settings ?: return
        val prm = try { p.sender.parameters } catch (e: Exception) { return }
        if (prm.encodings.isEmpty()) return
        val e = prm.encodings[0]
        val c = caps
        val short = if (c != null) min(c.width, c.height) else s.quality
        if (p.kind == "preview") {
            e.maxBitrateBps = 1_000_000
            e.scaleResolutionDownBy = max(1.0, short / 360.0)
            e.maxFramerate = min(30, s.fps)
        } else {
            e.maxBitrateBps = bitrate(s)
            e.maxFramerate = s.fps
            e.scaleResolutionDownBy = STEPS[p.step]
        }
        prm.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
        try { p.sender.setParameters(prm) } catch (x: Exception) { /* closed */ }
    }

    // ---- every 2 seconds: real frame rates, the OBS picture's size step, too dark ----

    private val tick2 = object : Runnable {
        override fun run() {
            if (!running) return
            val now = SystemClock.elapsedRealtime()
            val n = camera?.frames ?: 0L
            if (lastFramesAt > 0) {
                val dt = (now - lastFramesAt) / 1000.0
                if (dt > 0.5) camFps = max(0.0, (n - lastFrames) / dt)
            }
            lastFrames = n
            lastFramesAt = now
            checkDim(now)
            for (p in peers.values) {
                if (p.kind != "view") continue
                if (p.pc.connectionState() != PeerConnection.PeerConnectionState.CONNECTED) continue
                try { p.pc.getStats(p.sender) { r -> h.post { guard(p, r, now) } } } catch (e: Exception) { /* closed */ }
            }
            showRes()
            h.postDelayed(this, 2000)
        }
    }

    /** the frame rate this camera was set up for (the chosen one, or less if the phone can't) */
    private fun wantFps(): Int {
        val f = settings?.fps ?: 30
        val c = caps ?: return f
        return min(f, c.fps)
    }

    private fun showRes() {
        val c = caps
        val res = if (c == null) "" else {
            val fps = if (camFps > 1) min(camFps, c.fps.toDouble() + 0.4) else c.fps.toDouble()
            "${c.width}×${c.height} · ${fps.roundToInt()}fps"
        }
        if (res != state.res) { state = state.copy(res = res); publish() }
    }

    private fun checkDim(now: Long) {
        val want = wantFps()
        val dim = caps != null && camFps > 1 && camFps < want * 0.75
        if (!dim) {
            dimSince = 0
            if (state.dim || state.dimShow) { state = state.copy(dim = false, dimShow = false); publish() }
            return
        }
        if (dimSince == 0L) dimSince = now
        var show = state.dimShow
        if (now - dimSince > 6000 && now - dimShown > 120000) {
            dimShown = now
            show = true
            h.postDelayed({ state = state.copy(dimShow = false); publish() }, 9000)
        }
        state = state.copy(dim = true, dimShow = show, dimFps = camFps.roundToInt())
        publish()
    }

    /**
     * When the phone sends clearly fewer frames than the camera makes (weak Wi-Fi, or the phone
     * can't keep up), the OBS picture goes a step smaller so the motion stays smooth; after a
     * long good spell it goes back up. The same rules as phone.html.
     */
    private fun guard(p: Peer, r: RTCStatsReport, now: Long) {
        if (peers[p.id] !== p) return
        var out: RTCStats? = null
        val codecs = HashMap<String, RTCStats>()
        for (x in r.statsMap.values) {
            when (x.type) {
                "outbound-rtp" -> if ((x.members["kind"] ?: x.members["mediaType"]) == "video") out = x
                "codec" -> codecs[x.id] = x
            }
        }
        val o = out ?: return
        val m = o.members
        val sent = num(m["framesSent"]) ?: num(m["framesEncoded"]) ?: 0.0
        val g = p.g
        val dt = (now - g.t) / 1000.0
        val ok = g.t > 0 && dt > 0.5 && dt < 10
        val sentFps = if (ok) max(0.0, sent - g.sent) / dt else 0.0
        g.t = now
        g.sent = sent
        if (!ok) return
        val want = (settings?.fps ?: 30).toDouble()
        val target = min(want, if (camFps > 1) camFps else want)
        if (target >= 10 && sentFps < target * 0.8) { g.bad++; g.good = 0 }
        else if (sentFps >= target * 0.93) { g.good++; g.bad = max(0, g.bad - 1) }
        val step = p.step
        if (g.bad >= 2 && step < STEPS.size - 1 && now - g.changed > 6000) {
            if (g.upAt > 0 && now - g.upAt < 40000) g.wait = min(g.wait * 2, 160) // went back up too soon
            p.step = step + 1; g.changed = now; g.bad = 0; g.good = 0
            tuneSender(p)
        } else if (step > 0 && g.good * 2 >= g.wait && now - g.changed > 6000) {
            p.step = step - 1; g.changed = now; g.upAt = now; g.good = 0
            tuneSender(p)
        }
        val mime = (m["codecId"] as? String)?.let { codecs[it] }?.members?.get("mimeType") as? String
        p.info = JSONObject()
            .put("w", num(m["frameWidth"])?.toInt() ?: 0)
            .put("h", num(m["frameHeight"])?.toInt() ?: 0)
            .put("fps", sentFps.roundToInt())
            .put("why", m["qualityLimitationReason"] as? String ?: "")
            .put("codec", codecName(mime))
            .put("step", p.step)
    }

    private fun num(v: Any?): Double? = (v as? Number)?.toDouble()

    private fun codecName(m: String?): String {
        val s = (m ?: "").replace(Regex("^video/", RegexOption.IGNORE_CASE), "")
        return if (s.equals("h264", true)) "H.264" else s.uppercase()
    }

    // ---- every 5 seconds: what the media computer page shows about this phone ----

    private val tick5 = object : Runnable {
        override fun run() {
            if (!running) return
            sendStatus()
            h.postDelayed(this, 5000)
        }
    }

    private fun sendStatus() {
        val s = settings ?: return
        val sg = sig ?: return
        val st = JSONObject()
        val c = caps
        if (c != null) {
            st.put("width", c.width).put("height", c.height).put("fps", c.fps)
            st.put("mm", if (c.zoomOk) (24 * (camera?.zoomNow ?: 1f)).roundToInt() else JSONObject.NULL)
        }
        st.put("facing", s.facing).put("quality", s.quality.toString()).put("ua", UA).put("app", "android").put("version", BuildConfig.VERSION_NAME)
        if (camFps > 1) st.put("camFps", camFps.roundToInt()).put("want", wantFps())
        peers.values.firstOrNull { it.kind == "view" && it.info != null }?.let { st.put("sent", it.info) }
        var batt = state.batt
        var hot = false
        battery()?.let { (level, charging, temp) ->
            st.put("battery", level).put("charging", charging)
            batt = (if (charging) "⚡ " else "🔋 ") + level + "%"
            if (temp >= 450) hot = true // 45 °C
        }
        if (Build.VERSION.SDK_INT >= 29) {
            val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
            val t = pm.currentThermalStatus
            st.put("thermal", t)
            if (t >= PowerManager.THERMAL_STATUS_SEVERE) hot = true
        }
        st.put("hot", hot)
        if (batt != state.batt || hot != state.hot) { state = state.copy(batt = batt, hot = hot); publish() }
        sg.post("/status", JSONObject().put("status", st))
    }

    private fun battery(): Triple<Int, Boolean, Int>? {
        val i = try { app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) } catch (e: Exception) { null } ?: return null
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        if (level < 0 || scale <= 0) return null
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL ||
            i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        return Triple(level * 100 / scale, charging, i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0))
    }

    // ---- a small still every second: OBS shows it at once while the live picture (re)connects ----

    private val stillBusy = AtomicBoolean(false)
    @Volatile private var lastStillAt = 0L
    private val stills = Executors.newSingleThreadExecutor { r -> Thread(r, "gccam-still").apply { isDaemon = true } }

    private val stillSink = VideoSink { frame ->
        val sg = sig ?: return@VideoSink
        if (sg.id == null) return@VideoSink
        val now = SystemClock.elapsedRealtime()
        if (now - lastStillAt < 1000 || !stillBusy.compareAndSet(false, true)) return@VideoSink
        lastStillAt = now
        val i420 = try {
            val b = frame.buffer
            val k = min(1.0, 960.0 / max(b.width, b.height))
            val w = (b.width * k).toInt() and 1.inv()
            val hh = (b.height * k).toInt() and 1.inv()
            val small = b.cropAndScale(0, 0, b.width, b.height, w, hh)
            val y = small.toI420()
            small.release()
            y
        } catch (e: Exception) {
            null
        }
        if (i420 == null) { stillBusy.set(false); return@VideoSink }
        val rot = frame.rotation
        try {
            stills.execute {
                try { sg.postStill(Jpeg.encode(i420, rot, 70)) } catch (e: Exception) { /* next second */ }
                finally { i420.release(); stillBusy.set(false) }
            }
        } catch (e: Exception) {
            i420.release()
            stillBusy.set(false)
        }
    }
}

/** an SdpObserver that ignores what it isn't told about */
open class SdpAdapter : SdpObserver {
    override fun onCreateSuccess(d: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String) {}
    override fun onSetFailure(error: String) {}
}

/** a JPEG of a video frame, turned upright */
object Jpeg {
    fun encode(b: VideoFrame.I420Buffer, rot: Int, quality: Int): ByteArray {
        val w = b.width
        val h = b.height
        val swap = rot == 90 || rot == 270
        val ow = if (swap) h else w
        val oh = if (swap) w else h
        val nv = ByteArray(ow * oh * 3 / 2)
        val y = b.dataY; val u = b.dataU; val v = b.dataV
        val sy = b.strideY; val su = b.strideU; val sv = b.strideV
        var i = 0
        when (rot) {
            90 -> for (dy in 0 until oh) for (dx in 0 until ow) nv[i++] = y.get((h - 1 - dx) * sy + dy)
            180 -> for (dy in 0 until oh) for (dx in 0 until ow) nv[i++] = y.get((h - 1 - dy) * sy + (w - 1 - dx))
            270 -> for (dy in 0 until oh) for (dx in 0 until ow) nv[i++] = y.get(dx * sy + (w - 1 - dy))
            else -> for (dy in 0 until oh) for (dx in 0 until ow) nv[i++] = y.get(dy * sy + dx)
        }
        // NV21 colour: V then U for each 2x2 block
        val cw = w / 2; val ch = h / 2; val ocw = ow / 2; val och = oh / 2
        for (dy in 0 until och) for (dx in 0 until ocw) {
            val sx: Int
            val syy: Int
            when (rot) {
                90 -> { sx = dy; syy = ch - 1 - dx }
                180 -> { sx = cw - 1 - dx; syy = ch - 1 - dy }
                270 -> { sx = cw - 1 - dy; syy = dx }
                else -> { sx = dx; syy = dy }
            }
            nv[i++] = v.get(syy * sv + sx)
            nv[i++] = u.get(syy * su + sx)
        }
        val out = ByteArrayOutputStream(64 * 1024)
        YuvImage(nv, ImageFormat.NV21, ow, oh, null).compressToJpeg(Rect(0, 0, ow, oh), quality, out)
        return out.toByteArray()
    }
}
