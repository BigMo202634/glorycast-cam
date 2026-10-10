package com.glorycast.cam

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.util.Size
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.TextureBufferImpl
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** What the open camera can do, for the phone screen and the media computer page. */
data class Caps(
    val facing: String,
    /** the picture size and frame rate the camera gives */
    val width: Int, val height: Int, val fps: Int,
    /** the frame rate the sensor runs at (more than fps when frames are dropped to reach it) */
    val cameraFps: Int,
    val zoomOk: Boolean, val zoomMin: Float, val zoomMax: Float, val zoom: Float,
    val evOk: Boolean, val evMin: Float, val evMax: Float, val evStep: Float,
    val awbModes: List<Int>, val awbLockOk: Boolean, val aeLockOk: Boolean,
    val manual: Boolean, val shutters: List<Int>, val isoMin: Int, val isoMax: Int,
    val focusLockOk: Boolean, val torchOk: Boolean
)

/**
 * The phone camera through Camera2, feeding WebRTC. Unlike a browser it can hold the frame rate
 * (the auto exposure gets a fixed range such as 30-30, so a dim church can't slow it down),
 * switch lenses through the zoom ratio, and use manual exposure, white balance and focus.
 * The picture is always landscape and never turns: it is fixed for the way the phone was held
 * when the camera started.
 */
class GcCamera(
    ctx: Context,
    private val helper: SurfaceTextureHelper,
    private val observer: CapturerObserver,
    private val events: Events
) {
    interface Events {
        fun onOpened(caps: Caps)
        fun onError(message: String)
        /** manual exposure is on at shutter 1/[shutter] and [iso]; 0, 0 when it is back on auto */
        fun onManual(shutter: Int, iso: Int)
    }

    companion object {
        /** shutter speeds offered, as 1/x of a second */
        val SHUTTERS = listOf(30, 50, 60, 100, 120, 250, 500, 1000, 2000)
    }

    private val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val thread = HandlerThread("gccam-camera").apply { start() }
    private val handler = Handler(thread.looper)

    /** frames delivered so far, to measure the real frame rate */
    @Volatile var frames = 0L
        private set
    /** the zoom ratio in use (1 = the main lens, 24mm) */
    @Volatile var zoomNow = 1f
        private set

    private class Cam(
        val id: String, val front: Boolean, val sensor: Int, val size: Size,
        val range: Range<Int>, val fps: Int, val captureFps: Int,
        val zoomRatio: Boolean, val zoomMin: Float, val zoomMax: Float, val active: Rect?,
        val evMin: Int, val evMax: Int, val evStep: Float,
        val afModes: IntArray, val afAuto: Int, val manualFocus: Boolean,
        val manual: Boolean, val expRange: Range<Long>?, val isoRange: Range<Int>?, val shutters: List<Int>,
        val awbModes: IntArray, val aeLockOk: Boolean, val awbLockOk: Boolean,
        val ois: Boolean, val torch: Boolean
    ) {
        fun clampZoom(z: Float) = z.coerceIn(zoomMin, max(zoomMin, zoomMax))
    }

    private class Ctl {
        var zoom = 1f
        var ev = 0
        var awb = CameraMetadata.CONTROL_AWB_MODE_AUTO
        var awbLock = false
        var aeLock = false
        var expNs = 0L
        var iso = 0
        var focusLock = false
        var focusDist = 0f
        var torch = false
    }

    // camera thread only
    private var gen = 0
    private var cam: Cam? = null
    private var ctl = Ctl()
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var request: CaptureRequest.Builder? = null
    private var surface: Surface? = null
    private var listening = false
    private var applyQueued = false

    // read on the capture thread
    @Volatile private var running = false
    @Volatile private var front = false
    @Volatile private var sensor = 90
    @Volatile private var rotation = 0

    // what auto exposure and focus are doing now, for "lock as it is now"
    @Volatile private var lastExp = 0L
    @Volatile private var lastIso = 0
    @Volatile private var lastFocus = 0f

    /**
     * Opens the [facing] camera ("environment" or "user") as close to [height]p at [fps] as it
     * goes. [displayDeg] is the screen rotation the picture is fixed to.
     */
    @SuppressLint("MissingPermission")
    fun open(facing: String, height: Int, fps: Int, displayDeg: Int, zoom: Float) {
        handler.post {
            closeNow()
            val g = gen
            val c: Cam
            try {
                val id = pickId(facing)
                    ?: return@post fail(g, "This phone has no ${if (facing == "user") "front" else "back"} camera GloryCast Cam can use.")
                c = describe(id, mgr.getCameraCharacteristics(id), height, fps)
            } catch (e: Exception) {
                return@post fail(g, "Could not start the camera (${e.message ?: e.javaClass.simpleName}).")
            }
            cam = c
            front = c.front
            sensor = c.sensor
            // the same sums as WebRTC's own Camera2Session, for one fixed screen rotation
            rotation = if (c.front) (c.sensor + displayDeg) % 360 else (c.sensor + 360 - displayDeg) % 360
            ctl = Ctl().also { it.zoom = c.clampZoom(zoom) }
            zoomNow = ctl.zoom
            helper.setTextureSize(c.size.width, c.size.height)
            val s = Surface(helper.surfaceTexture)
            surface = s
            try {
                mgr.openCamera(c.id, object : CameraDevice.StateCallback() {
                    override fun onOpened(d: CameraDevice) {
                        if (g != gen) { d.close(); return }
                        device = d
                        createSession(g, d, s)
                    }

                    override fun onDisconnected(d: CameraDevice) {
                        d.close()
                        if (g == gen) { device = null; fail(g, "Another app took the camera. The picture comes back when it lets go.") }
                    }

                    override fun onError(d: CameraDevice, error: Int) {
                        d.close()
                        if (g == gen) { device = null; fail(g, errorText(error)) }
                    }
                }, handler)
            } catch (e: Exception) {
                fail(g, openError(e))
            }
        }
    }

    fun close() {
        handler.post { closeNow() }
    }

    /** stops for good (the app is closing) */
    fun release() {
        handler.post {
            closeNow()
            if (listening) { helper.stopListening(); listening = false }
            thread.quitSafely()
        }
    }

    // ---- controls: any thread; changes are applied together on the camera thread ----

    fun setZoom(z: Float) = change { c, cam -> c.zoom = cam.clampZoom(z); zoomNow = c.zoom }

    /** brightness in EV steps (stops) */
    fun setEv(ev: Float) = change { c, cam ->
        if (cam.evStep > 0f) c.ev = (ev / cam.evStep).roundToInt().coerceIn(cam.evMin, cam.evMax)
    }

    fun setAwb(mode: Int) = change { c, _ -> c.awb = mode; c.awbLock = false }

    /** keeps the white balance auto has now */
    fun setAwbLock(on: Boolean) = change { c, _ -> c.awbLock = on; c.awb = CameraMetadata.CONTROL_AWB_MODE_AUTO }

    fun setAeLock(on: Boolean) = change { c, _ -> c.aeLock = on; c.expNs = 0; c.iso = 0 }

    /** shutter 1/[x] s; the ISO is set so the picture stays as bright as auto had it */
    fun setShutter(x: Int) = change { c, cam ->
        val r = cam.expRange ?: return@change
        val ir = cam.isoRange ?: return@change
        val ns = (1_000_000_000L / x).coerceIn(r.lower, r.upper)
        val e0 = if (c.expNs > 0) c.expNs else lastExp
        val i0 = if (c.expNs > 0) c.iso else lastIso
        val iso = if (e0 > 0 && i0 > 0) (i0.toDouble() * e0 / ns).roundToInt() else 400
        c.expNs = ns
        c.iso = iso.coerceIn(ir.lower, max(ir.lower, min(ir.upper, 6400)))
        c.aeLock = false
        events.onManual(x, c.iso)
    }

    fun setIso(v: Int) = change { c, cam ->
        val r = cam.expRange ?: return@change
        val ir = cam.isoRange ?: return@change
        if (c.expNs <= 0) {
            val longest = min(r.upper, 1_000_000_000L / max(1, cam.captureFps))
            c.expNs = (if (lastExp > 0) lastExp else 1_000_000_000L / 50).coerceIn(r.lower, max(r.lower, longest))
        }
        c.iso = v.coerceIn(ir.lower, ir.upper)
        c.aeLock = false
        events.onManual((1_000_000_000L / c.expNs).toInt(), c.iso)
    }

    fun autoExposure() = change { c, _ -> c.expNs = 0; c.iso = 0; c.aeLock = false; events.onManual(0, 0) }

    /** keeps the focus where it is now */
    fun setFocusLock(on: Boolean) = change { c, _ -> c.focusLock = on; c.focusDist = lastFocus }

    fun setTorch(on: Boolean) = change { c, _ -> c.torch = on }

    private fun change(block: (Ctl, Cam) -> Unit) {
        handler.post {
            val c = cam ?: return@post
            block(ctl, c)
            if (!applyQueued) {
                applyQueued = true
                handler.post { applyNow() } // after any other changes already waiting
            }
        }
    }

    // ---- camera thread ----

    private fun pickId(facing: String): String? {
        val want = if (facing == "user") CameraMetadata.LENS_FACING_FRONT else CameraMetadata.LENS_FACING_BACK
        val ids = mgr.cameraIdList.filter { id ->
            try { mgr.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == want } catch (e: Exception) { false }
        }
        if (ids.isEmpty()) return null
        if (want == CameraMetadata.LENS_FACING_FRONT) return ids[0]
        // the back camera that reaches furthest: on most phones the first one, which moves to the
        // ultra wide and zoom lenses by itself as the zoom changes
        var best = ids[0]
        var bestSpan = span(best)
        for (id in ids.drop(1)) {
            val s = span(id)
            if (s > bestSpan + 0.01f && bigEnough(id)) { best = id; bestSpan = s }
        }
        return best
    }

    private fun span(id: String): Float = try {
        val ch = mgr.getCameraCharacteristics(id)
        val r = if (Build.VERSION.SDK_INT >= 30) ch.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) else null
        if (r != null && r.lower > 0f) r.upper / r.lower else ch.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1f
    } catch (e: Exception) {
        0f
    }

    private fun bigEnough(id: String): Boolean = try {
        val map = mgr.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        map?.getOutputSizes(SurfaceTexture::class.java)?.any { min(it.width, it.height) >= 720 } == true
    } catch (e: Exception) {
        false
    }

    private fun describe(id: String, ch: CameraCharacteristics, wantH: Int, wantFps: Int): Cam {
        val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: throw IllegalStateException("no picture sizes")
        val sizes = map.getOutputSizes(SurfaceTexture::class.java)?.toList().orEmpty()
        if (sizes.isEmpty()) throw IllegalStateException("no picture sizes")
        fun maxFps(s: Size): Int {
            val d = try { map.getOutputMinFrameDuration(SurfaceTexture::class.java, s) } catch (e: Exception) { 0L }
            return if (d > 0) (1e9 / d).roundToInt() else 30
        }
        // the biggest 16:9 picture up to the chosen size; the frame rate gives way if it must
        val wide = sizes.filter { it.width > it.height && abs(it.width.toFloat() / it.height - 16f / 9f) < 0.02f }
        val pool = wide.ifEmpty { sizes }
        val size = pool.filter { min(it.width, it.height) <= wantH }.maxByOrNull { it.width.toLong() * it.height }
            ?: pool.minByOrNull { it.width.toLong() * it.height }!!
        val sizeMax = max(1, maxFps(size))

        // the auto exposure frame rate range: fixed at the chosen rate when the phone has it,
        // so the camera never slows down to gather light
        val raw = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.toList().orEmpty()
        val unit = if (raw.any { it.upper >= 1000 }) 1000 else 1 // a few old phones count in 1/1000 fps
        val norm = raw.map { Range(it.lower / unit, it.upper / unit) to it }
        val want = min(wantFps, sizeMax)
        val usable = norm.filter { it.first.upper <= sizeMax }.ifEmpty { norm }
        val pick = usable.firstOrNull { it.first.lower == want && it.first.upper == want }
            ?: usable.filter { it.first.upper == want }.maxByOrNull { it.first.lower }
            ?: usable.filter { it.first.lower == it.first.upper && it.first.upper > want }.minByOrNull { it.first.upper }
            ?: usable.filter { it.first.lower <= want && want <= it.first.upper }.maxByOrNull { it.first.lower }
            ?: usable.maxByOrNull { it.first.upper }
        val range = pick?.second ?: Range(15 * unit, 30 * unit)
        val captureFps = pick?.first?.upper ?: 30
        val fps = min(captureFps, want)

        var zoomRatio = false
        var zMin = 1f
        var zMax = 1f
        if (Build.VERSION.SDK_INT >= 30) {
            ch.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)?.let {
                if (it.upper > it.lower + 0.01f) { zoomRatio = true; zMin = it.lower; zMax = it.upper }
            }
        }
        if (!zoomRatio) zMax = ch.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1f
        zMax = min(zMax, 10f)

        val evR = ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)
        val evStep = ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)?.toFloat() ?: 0f

        val af = ch.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
        val afAuto = when {
            CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO in af -> CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO
            CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE in af -> CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
            else -> CameraMetadata.CONTROL_AF_MODE_OFF
        }
        val abilities = ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()
        val manual = CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR in abilities
        val minFocus = ch.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        val expRange = if (manual) ch.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE) else null
        val isoRange = if (manual) ch.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE) else null
        val frameNs = 1_000_000_000L / max(1, captureFps)
        val shutters = if (expRange == null || isoRange == null) emptyList() else SHUTTERS.filter { x ->
            val ns = 1_000_000_000L / x
            ns >= expRange.lower && ns <= expRange.upper && ns <= frameNs
        }
        val ois = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)
            ?.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON) == true

        return Cam(
            id = id,
            front = ch.get(CameraCharacteristics.LENS_FACING) == CameraMetadata.LENS_FACING_FRONT,
            sensor = ch.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90,
            size = size, range = range, fps = fps, captureFps = captureFps,
            zoomRatio = zoomRatio, zoomMin = zMin, zoomMax = zMax,
            active = ch.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE),
            evMin = evR?.lower ?: 0, evMax = evR?.upper ?: 0, evStep = evStep,
            afModes = af, afAuto = afAuto, manualFocus = manual && minFocus > 0f,
            manual = manual, expRange = expRange, isoRange = isoRange, shutters = shutters,
            awbModes = ch.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: intArrayOf(CameraMetadata.CONTROL_AWB_MODE_AUTO),
            aeLockOk = ch.get(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true,
            awbLockOk = ch.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) == true,
            ois = ois,
            torch = ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        )
    }

    @Suppress("DEPRECATION")
    private fun createSession(g: Int, d: CameraDevice, s: Surface) {
        try {
            d.createCaptureSession(listOf(s), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(cs: CameraCaptureSession) {
                    if (g != gen) { try { cs.close() } catch (e: Exception) { /* closed */ }; return }
                    session = cs
                    request = try {
                        d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply { addTarget(s) }
                    } catch (e: Exception) {
                        return fail(g, "The camera stopped working. Starting it again…")
                    }
                    running = true
                    if (!listening) { helper.startListening(sink); listening = true }
                    applyNow()
                    observer.onCapturerStarted(true)
                    events.onOpened(caps())
                }

                override fun onConfigureFailed(cs: CameraCaptureSession) {
                    try { cs.close() } catch (e: Exception) { /* closed */ }
                    fail(g, "The camera could not start at this picture size. Try a lower setting.")
                }
            }, handler)
        } catch (e: Exception) {
            fail(g, openError(e))
        }
    }

    private fun applyNow() {
        applyQueued = false
        val b = request ?: return
        val s = session ?: return
        val c = cam ?: return
        val k = ctl
        try {
            b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
            b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, c.range)
            if (c.zoomRatio && Build.VERSION.SDK_INT >= 30) b.set(CaptureRequest.CONTROL_ZOOM_RATIO, k.zoom)
            else c.active?.let { b.set(CaptureRequest.SCALER_CROP_REGION, crop(it, k.zoom)) }
            if (k.expNs > 0 && c.manual) {
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
                b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, k.expNs)
                b.set(CaptureRequest.SENSOR_SENSITIVITY, k.iso)
                b.set(CaptureRequest.SENSOR_FRAME_DURATION, 1_000_000_000L / max(1, c.captureFps))
            } else {
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
                b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, k.ev)
                if (c.aeLockOk) b.set(CaptureRequest.CONTROL_AE_LOCK, k.aeLock)
            }
            b.set(CaptureRequest.CONTROL_AWB_MODE, k.awb)
            if (c.awbLockOk) b.set(CaptureRequest.CONTROL_AWB_LOCK, k.awbLock)
            when {
                k.focusLock && c.manualFocus -> {
                    b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                    b.set(CaptureRequest.LENS_FOCUS_DISTANCE, k.focusDist)
                }
                k.focusLock -> b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO) // the lens stays put without a trigger
                else -> b.set(CaptureRequest.CONTROL_AF_MODE, c.afAuto)
            }
            if (c.torch) b.set(CaptureRequest.FLASH_MODE, if (k.torch) CameraMetadata.FLASH_MODE_TORCH else CameraMetadata.FLASH_MODE_OFF)
            // optical stabilisation only: digital stabilisation crops and makes tripod pans float
            if (c.ois) b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON)
            b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF)
            s.setRepeatingRequest(b.build(), results, handler)
        } catch (e: Exception) {
            // the session closed in between; the next open sets everything again
        }
    }

    /** the middle 1/zoom of the sensor, in active array coordinates */
    private fun crop(a: Rect, z: Float): Rect {
        val k = max(1f, z)
        val w = (a.width() / k).toInt()
        val h = (a.height() / k).toInt()
        val l = (a.width() - w) / 2
        val t = (a.height() - h) / 2
        return Rect(l, t, l + w, t + h)
    }

    private fun caps(): Caps {
        val c = cam!!
        return Caps(
            facing = if (c.front) "user" else "environment",
            width = c.size.width, height = c.size.height, fps = c.fps, cameraFps = c.captureFps,
            zoomOk = c.zoomMax > c.zoomMin + 0.01f, zoomMin = c.zoomMin, zoomMax = c.zoomMax, zoom = ctl.zoom,
            evOk = c.evStep > 0f && c.evMax > c.evMin,
            evMin = max(-3f, c.evMin * c.evStep), evMax = min(3f, c.evMax * c.evStep), evStep = c.evStep,
            awbModes = c.awbModes.toList(), awbLockOk = c.awbLockOk, aeLockOk = c.aeLockOk,
            manual = c.shutters.isNotEmpty(), shutters = c.shutters,
            isoMin = c.isoRange?.lower ?: 0, isoMax = min(c.isoRange?.upper ?: 0, 3200),
            focusLockOk = c.manualFocus || (CameraMetadata.CONTROL_AF_MODE_AUTO in c.afModes && c.afAuto != CameraMetadata.CONTROL_AF_MODE_OFF),
            torchOk = c.torch
        )
    }

    private fun fail(g: Int, message: String) {
        if (g != gen) return
        closeNow()
        events.onError(message)
    }

    private fun closeNow() {
        gen++
        running = false
        val hadCamera = cam != null
        try { session?.stopRepeating() } catch (e: Exception) { /* closed */ }
        try { session?.close() } catch (e: Exception) { /* closed */ }
        session = null
        request = null
        try { device?.close() } catch (e: Exception) { /* closed */ }
        device = null
        try { surface?.release() } catch (e: Exception) { /* released */ }
        surface = null
        cam = null
        applyQueued = false
        if (hadCamera) observer.onCapturerStopped()
    }

    private fun errorText(error: Int) = when (error) {
        CameraDevice.StateCallback.ERROR_CAMERA_IN_USE, CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE ->
            "Another app is using the camera. Close it and the picture comes back."
        CameraDevice.StateCallback.ERROR_CAMERA_DISABLED -> "The camera is turned off on this phone by a setting or policy."
        else -> "The camera stopped working. Starting it again…"
    }

    private fun openError(e: Exception) = when {
        e is SecurityException -> "Camera permission is off for GloryCast Cam. Turn it on in Settings > Apps > GloryCast Cam > Permissions."
        e is CameraAccessException && (e.reason == CameraAccessException.CAMERA_IN_USE || e.reason == CameraAccessException.MAX_CAMERAS_IN_USE) ->
            "Another app is using the camera. Close it and the picture comes back."
        e is CameraAccessException && e.reason == CameraAccessException.CAMERA_DISABLED -> "The camera is turned off on this phone by a setting or policy."
        else -> "Could not start the camera (${e.message ?: e.javaClass.simpleName})."
    }

    private val results = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(s: CameraCaptureSession, r: CaptureRequest, res: TotalCaptureResult) {
            res.get(CaptureResult.SENSOR_EXPOSURE_TIME)?.let { lastExp = it }
            res.get(CaptureResult.SENSOR_SENSITIVITY)?.let { lastIso = it }
            res.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { lastFocus = it }
        }
    }

    /**
     * Each camera frame, as WebRTC's Camera2Session does it: undo the turn (and the front camera's
     * mirror) Android puts on the texture, and report the turn as the frame's rotation instead.
     */
    private val sink = VideoSink { frame ->
        if (!running) return@VideoSink
        val tb = frame.buffer as? TextureBufferImpl ?: return@VideoSink
        frames++
        val m = Matrix()
        m.preTranslate(0.5f, 0.5f)
        if (front) m.preScale(-1f, 1f)
        m.preRotate(-sensor.toFloat())
        m.preTranslate(-0.5f, -0.5f)
        val out = VideoFrame(tb.applyTransformMatrix(m, tb.width, tb.height), rotation, frame.timestampNs)
        observer.onFrameCaptured(out)
        out.release()
    }
}
