package com.glorycast.cam

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.camera2.CameraMetadata
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The two screens: joining (name, media computer, picture) and the camera itself. */
class MainActivity : Activity(), Engine.Listener, TouchPad.Listener {

    private companion object {
        val LENSES = intArrayOf(24, 35, 50, 85, 105, 150, 200)
        val WB = listOf(
            CameraMetadata.CONTROL_AWB_MODE_AUTO to "Auto",
            CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT to "Indoor bulbs 3200K",
            CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT to "Tube lights 4000K",
            CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT to "Daylight 5500K",
            CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT to "Cloudy / shade 6500K"
        )
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
    }

    private lateinit var ui: Ui
    private lateinit var prefs: Prefs
    private lateinit var engine: Engine
    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout

    // joining
    private lateinit var join: ScrollView
    private lateinit var nameIn: EditText
    private lateinit var hostIn: EditText
    private lateinit var findText: TextView
    private lateinit var foundRow: Flow
    private lateinit var searchBtn: TextView
    private lateinit var errBox: TextView
    private lateinit var startBtn: TextView
    private lateinit var facingC: Choice<String>
    private lateinit var qualityC: Choice<Int>
    private lateinit var fpsC: Choice<Int>
    private var found: List<Discovery.Found> = emptyList()
    private var picked: Discovery.Found? = null
    private var searching = false
    private var starting = false
    private var pendingBase: String? = null

    // the camera
    private lateinit var cam: FrameLayout
    private lateinit var renderer: SurfaceViewRenderer
    private var sinkOn = false
    private lateinit var tally: TallyFrame
    private lateinit var top: LinearLayout
    private lateinit var bottom: LinearLayout
    private lateinit var pill: TextView
    private lateinit var nameLabel: TextView
    private lateinit var resText: TextView
    private lateinit var battText: TextView
    private lateinit var setBtn: TextView
    private lateinit var lenses: LinearLayout
    private lateinit var evLine: EvLine
    private lateinit var zoomChip: TextView
    private lateinit var waiting: TextView
    private lateinit var lost: TextView
    private lateinit var camErr: TextView
    private lateinit var dim: TextView
    private lateinit var hot: TextView

    // picture settings
    private lateinit var sheet: ScrollView
    private lateinit var qualityL: Choice<Int>
    private lateinit var fpsL: Choice<Int>
    private lateinit var gotText: TextView
    private lateinit var wbBox: LinearLayout
    private lateinit var wbC: Choice<Int>
    private lateinit var wbLock: TextView
    private lateinit var wbNa: TextView
    private lateinit var expLock: TextView
    private lateinit var shutRow: View
    private lateinit var shutBar: SeekBar
    private lateinit var shutVal: TextView
    private lateinit var isoRow: View
    private lateinit var isoBar: SeekBar
    private lateinit var isoVal: TextView
    private lateinit var shutHint: TextView
    private lateinit var expNa: TextView
    private lateinit var focusBtn: TextView
    private lateinit var torchBtn: TextView
    private lateinit var focusNa: TextView

    private var caps: Caps? = null
    private var hideUi = false
    private var lastTally = "off"
    private var ev = 0f
    private var ev0 = 0f
    private var zoom = 1f
    private var zoom0 = 1f
    private var awbLocked = false
    private var aeLocked = false
    private var manualOn = false
    private var focusLocked = false
    private var torchOn = false
    private var shutters = listOf<Int>()
    private var sheetW = 0
    private val zoomHide = Runnable { zoomChip.visibility = View.GONE }
    private val saveMm = Runnable { caps?.let { prefs.setMm(it.facing, (24 * zoom).roundToInt()) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = Ui(this)
        prefs = Prefs(this)
        engine = Engine.get(this)
        Net.watch(applicationContext)
        root = FrameLayout(this).apply { setBackgroundColor(C.NAVY) }
        buildJoin()
        buildCam()
        setContentView(root)
        engine.listener = this
        if (engine.running) showCamera(true) else showJoin()
    }

    override fun onStart() {
        super.onStart()
        engine.listener = this
        if (cam.visibility == View.VISIBLE) {
            if (engine.running) { attachSink(); engine.caps?.let { onCaps(it) }; onUi(engine.state) } else showJoin()
        }
    }

    override fun onResume() {
        super.onResume()
        if (join.visibility == View.VISIBLE) search() else immersive(true)
    }

    override fun onStop() {
        detachSink()
        super.onStop()
    }

    override fun onDestroy() {
        detachSink()
        try { renderer.release() } catch (e: Exception) { /* released */ }
        if (engine.listener === this) engine.listener = null
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && cam.visibility == View.VISIBLE) immersive(true)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            cam.visibility != View.VISIBLE -> super.onBackPressed()
            sheet.visibility == View.VISIBLE -> openSheet(false)
            else -> confirmStop()
        }
    }

    // ================= joining =================

    private fun buildJoin() {
        join = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            setBackgroundColor(C.NAVY)
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(ui.dp(28), ui.dp(20), ui.dp(28), ui.dp(24))
        }
        val a = column()
        val b = column()
        row.addView(a, LinearLayout.LayoutParams(0, WRAP, 1f).apply { rightMargin = ui.dp(16) })
        row.addView(b, LinearLayout.LayoutParams(0, WRAP, 1f).apply { leftMargin = ui.dp(16) })
        join.addView(row, FrameLayout.LayoutParams(MATCH, WRAP))

        // ---- column A: what this is, the media computer, start ----
        val logo = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val icon = ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher)
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = ui.box(C.NAVY2, 8f)
            outlineProvider = ViewOutlineProvider.BACKGROUND
            clipToOutline = true
        }
        logo.addView(icon, LinearLayout.LayoutParams(ui.dp(36), ui.dp(36)))
        val brand = SpannableString("GloryCast Cam").apply { setSpan(ForegroundColorSpan(C.GOLD), 10, 13, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
        logo.addView(ui.text(brand, 20f, C.TEXT, ui.heavy), LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = ui.dp(10) })
        a.addView(logo)
        a.addView(ui.text("Use this phone as a camera", 22f, C.TEXT, ui.bold), ui.lp(WRAP, WRAP, ui.dp(14)))
        a.addView(ui.text("The picture goes over the church Wi-Fi to OBS or vMix on the media computer. Sound still comes from the mixer.", 14f, C.MUTED), ui.lp(MATCH, WRAP, ui.dp(8)))

        a.addView(label("Media computer"), ui.lp(WRAP, WRAP, ui.dp(16)))
        findText = ui.text("Looking for GloryCast Cam on this Wi-Fi…", 13f, C.MUTED)
        a.addView(findText, ui.lp(MATCH, WRAP, ui.dp(6)))
        foundRow = Flow(this, ui.dp(6), ui.dp(6)).apply { visibility = View.GONE }
        a.addView(foundRow, ui.lp(MATCH, WRAP, ui.dp(8)))
        val hostRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        hostIn = input("Or type its address, like 192.168.1.20").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_DONE
            setOnFocusChangeListener { _, has -> if (has) { picked = null; drawFound() } }
        }
        hostRow.addView(hostIn, LinearLayout.LayoutParams(0, WRAP, 1f))
        searchBtn = ui.button("Search again").apply { setOnClickListener { search() } }
        hostRow.addView(searchBtn, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = ui.dp(8) })
        a.addView(hostRow, ui.lp(MATCH, WRAP, ui.dp(8)))

        errBox = ui.text("", 14f, 0xFFFFD6D6.toInt()).apply {
            background = ui.box(0x26E5383B, 10f, C.LIVE, 1f)
            setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10))
            visibility = View.GONE
        }
        a.addView(errBox, ui.lp(MATCH, WRAP, ui.dp(14)))
        startBtn = ui.button("Start camera", gold = true, sp = 17f).apply {
            setPadding(ui.dp(16), ui.dp(15), ui.dp(16), ui.dp(15))
            setOnClickListener { startTap() }
        }
        a.addView(startBtn, ui.lp(MATCH, WRAP, ui.dp(16)))
        a.addView(ui.text("GloryCast Cam for Android ${BuildConfig.VERSION_NAME}", 11f, C.MUTED), ui.lp(WRAP, WRAP, ui.dp(10)))

        // ---- column B: this camera ----
        b.addView(label("Camera name"))
        nameIn = input("Altar").apply {
            setText(prefs.name)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            filters = arrayOf(android.text.InputFilter.LengthFilter(24))
            imeOptions = EditorInfo.IME_ACTION_DONE
        }
        b.addView(nameIn, ui.lp(MATCH, WRAP, ui.dp(6)))
        val quick = Flow(this, ui.dp(8), ui.dp(8))
        for (n in listOf("Altar", "Choir", "Wide", "Pulpit", "Congregation")) {
            quick.addView(ui.text(n, 13f, C.TEXT, ui.semi).apply {
                background = ui.pressable(ui.box(0, 99f, C.LINE, 1f), 99f)
                setPadding(ui.dp(12), ui.dp(6), ui.dp(12), ui.dp(6))
                isClickable = true
                setOnClickListener { nameIn.setText(n); nameIn.setSelection(n.length) }
            })
        }
        b.addView(quick, ui.lp(MATCH, WRAP, ui.dp(10)))

        facingC = Choice(ui, listOf("environment" to "Back", "user" to "Front (selfie)"), prefs.facing) { }
        b.addView(label("Camera"), ui.lp(WRAP, WRAP, ui.dp(16)))
        b.addView(facingC.view, ui.lp(MATCH, WRAP, ui.dp(6)))
        qualityC = Choice(ui, listOf(2160 to "4K", 1080 to "Full HD 1080p", 720 to "HD 720p (weak Wi-Fi)"), prefs.quality) { }
        b.addView(label("Picture"), ui.lp(WRAP, WRAP, ui.dp(14)))
        b.addView(qualityC.view, ui.lp(MATCH, WRAP, ui.dp(6)))
        fpsC = Choice(ui, listOf(24 to "24 fps", 25 to "25", 30 to "30", 50 to "50", 60 to "60 (smooth)"), prefs.fps) { }
        b.addView(label("Frame rate"), ui.lp(WRAP, WRAP, ui.dp(14)))
        b.addView(fpsC.view, ui.lp(MATCH, WRAP, ui.dp(6)))
        b.addView(ui.text("Hold the phone sideways and plug in the charger for long services. The picture stays the way the phone is held when you press Start.", 13f, C.MUTED), ui.lp(MATCH, WRAP, ui.dp(16)))

        root.addView(join, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

    private fun label(s: String) = ui.text(s, 13f, C.MUTED, ui.semi)

    private fun input(hint: String) = EditText(this).apply {
        this.hint = hint
        setHintTextColor(0xFF6F7FA3.toInt())
        setTextColor(C.TEXT)
        textSize = 16f
        typeface = ui.regular
        isSingleLine = true
        background = ui.box(C.NAVY2, 10f, C.LINE, 1f)
        setPadding(ui.dp(14), ui.dp(11), ui.dp(14), ui.dp(11))
    }

    private fun showErr(msg: String?) {
        errBox.text = msg ?: ""
        errBox.visibility = if (msg.isNullOrEmpty()) View.GONE else View.VISIBLE
    }

    private fun search() {
        if (searching || join.visibility != View.VISIBLE) return
        searching = true
        findText.text = "Looking for GloryCast Cam on this Wi-Fi…"
        ui.enable(searchBtn, false)
        Thread {
            val list = Discovery.search(applicationContext)
            main.post {
                searching = false
                ui.enable(searchBtn, true)
                found = list
                if (picked != null && list.none { it.ip == picked?.ip }) picked = null
                if (picked == null && list.size == 1 && hostIn.text.isEmpty()) picked = list[0]
                drawFound()
            }
        }.start()
    }

    private fun drawFound() {
        if (searching) return
        foundRow.removeAllViews()
        for (f in found) {
            val c = ui.chip("${f.name} · ${f.ip}")
            ui.style(c, f == picked)
            c.setOnClickListener { picked = f; hostIn.setText(""); hostIn.clearFocus(); drawFound() }
            foundRow.addView(c)
        }
        foundRow.visibility = if (found.isEmpty()) View.GONE else View.VISIBLE
        findText.text = when {
            found.isEmpty() && Net.wifi == null -> "This phone is not on Wi-Fi. Join the church Wi-Fi, the same one as the media computer."
            found.isEmpty() -> "No media computer found on this Wi-Fi yet. Start GloryCast Cam on the computer, or type the address it shows."
            found.size == 1 -> "Found the media computer:"
            else -> "Found ${found.size} media computers. Tap the one to use:"
        }
        if (found.isEmpty() && hostIn.text.isEmpty() && prefs.host.isNotEmpty()) hostIn.setText(prefs.host)
    }

    private fun startTap() {
        if (starting) return
        val name = nameIn.text.toString().trim()
        if (name.isEmpty()) {
            showErr("Give this camera a name, like Altar or Choir, so the media team knows which phone it is.")
            nameIn.requestFocus()
            return
        }
        val typed = hostIn.text.toString().trim()
        val base = if (typed.isNotEmpty()) Net.baseFor(typed) else picked?.base
        if (base == null) {
            showErr(
                if (typed.isNotEmpty()) "That address doesn't look right. Type it like 192.168.1.20"
                else "No media computer found yet. Start GloryCast Cam on the computer and check this phone is on the same Wi-Fi, or type the computer's address."
            )
            return
        }
        showErr(null)
        prefs.name = name
        prefs.facing = facingC.value
        prefs.quality = qualityC.value
        prefs.fps = fpsC.value
        pendingBase = base
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            val ask = mutableListOf(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= 33) ask += Manifest.permission.POST_NOTIFICATIONS
            requestPermissions(ask.toTypedArray(), 1)
            return
        }
        begin(base, name)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 1) return
        val base = pendingBase ?: return
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) begin(base, prefs.name)
        else showErr("GloryCast Cam needs the camera. Allow it when asked, or turn it on in Settings > Apps > GloryCast Cam > Permissions.")
    }

    private fun begin(base: String, name: String) {
        starting = true
        startBtn.text = "Connecting…"
        ui.enable(startBtn, false)
        hideKeyboard()
        Thread {
            val info = Net.getJson("$base/info")
            main.post {
                starting = false
                startBtn.text = "Start camera"
                ui.enable(startBtn, true)
                if (isFinishing || isDestroyed) return@post
                if (info == null) {
                    showErr("Could not reach GloryCast Cam at ${Net.label(base)}. Check the program is running on the media computer and this phone is on the same Wi-Fi.")
                    return@post
                }
                prefs.host = Net.label(base)
                val deg = displayDegrees()
                lockTo(deg)
                engine.listener = this
                engine.start(Engine.Settings(base, name, facingC.value, qualityC.value, fpsC.value), deg)
                nameLabel.text = name
                showCamera(false)
            }
        }.start()
    }

    /** the picture never turns: the screen stays the way the phone was held at Start */
    private fun lockTo(deg: Int) {
        requestedOrientation = if (deg == 270 || deg == 180) ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    }

    @Suppress("DEPRECATION")
    private fun displayDegrees(): Int {
        val r = if (Build.VERSION.SDK_INT >= 30) display?.rotation ?: Surface.ROTATION_90 else windowManager.defaultDisplay.rotation
        return when (r) {
            Surface.ROTATION_0 -> 0
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 90
        }
    }

    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(root.windowToken, 0)
        currentFocus?.clearFocus()
    }

    // ================= the camera =================

    private fun buildCam() {
        cam = FrameLayout(this).apply { setBackgroundColor(Color.BLACK); visibility = View.GONE }
        renderer = SurfaceViewRenderer(this)
        renderer.init(engine.egl.eglBaseContext, null)
        renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        renderer.setEnableHardwareScaler(true)
        cam.addView(renderer, FrameLayout.LayoutParams(MATCH, MATCH, Gravity.CENTER))

        val pad = TouchPad(this)
        pad.listener = this
        cam.addView(pad, FrameLayout.LayoutParams(MATCH, MATCH))

        evLine = EvLine(this, ui)
        cam.addView(evLine, FrameLayout.LayoutParams(ui.dp(56), MATCH, Gravity.END).apply { rightMargin = ui.dp(10) })

        zoomChip = ui.text("24mm", 16f, C.TEXT, ui.heavy).apply {
            background = ui.box(0x8C000000.toInt(), 99f, 0x4DFFFFFF, 1f)
            setPadding(ui.dp(14), ui.dp(6), ui.dp(14), ui.dp(6))
            visibility = View.GONE
        }
        cam.addView(zoomChip, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = ui.dp(76) })

        // top: live state, name, picture, battery, stop
        top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(ui.dp(18), ui.dp(12), ui.dp(18), ui.dp(24))
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0x99000000.toInt(), 0))
        }
        pill = ui.text("CONNECTING", 12f, C.TEXT, ui.heavy).apply {
            letterSpacing = 0.08f
            setLines(1)
            setPadding(ui.dp(12), ui.dp(5), ui.dp(12), ui.dp(5))
            background = ui.box(0x2EFFFFFF, 99f)
        }
        top.addView(pill)
        nameLabel = ui.text("", 13f, C.TEXT, ui.semi).apply { setLines(1); ellipsize = TextUtils.TruncateAt.END; maxWidth = ui.dp(240) }
        top.addView(nameLabel, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = ui.dp(10) })
        top.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        resText = ui.text("", 13f, C.SOFT, ui.semi).apply { setLines(1) }
        top.addView(resText, LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = ui.dp(12) })
        battText = ui.text("", 13f, C.SOFT, ui.semi).apply { setLines(1) }
        top.addView(battText, LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = ui.dp(12) })
        top.addView(ui.button("Stop").apply { setOnClickListener { confirmStop() } })
        cam.addView(top, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.TOP))

        // bottom: picture settings, lenses, flip
        bottom = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(ui.dp(18), ui.dp(24), ui.dp(18), ui.dp(12))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xA6000000.toInt(), 0))
        }
        setBtn = ui.button("Picture settings").apply { setOnClickListener { openSheet(sheet.visibility != View.VISIBLE) } }
        bottom.addView(setBtn)
        lenses = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = ui.box(0x80000000.toInt(), 10f, 0x47FFFFFF, 1f)
            setPadding(ui.dp(3), ui.dp(3), ui.dp(3), ui.dp(3))
            visibility = View.GONE
        }
        bottom.addView(lenses, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = ui.dp(10); rightMargin = ui.dp(10) })
        bottom.addView(ui.button("Flip").apply { setOnClickListener { engine.flip() } }, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = ui.dp(10) })
        cam.addView(bottom, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))

        buildSheet()

        waiting = banner("Camera ready", "Waiting for OBS or vMix to open this camera.")
        lost = banner("Lost the media computer", "Check this phone is on the church Wi-Fi. Reconnecting…")
        camErr = banner("Camera stopped", "")
        for (v in listOf(waiting, lost, camErr)) cam.addView(v, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER))
        dim = banner("Too dark for smooth motion", "")
        hot = banner("This phone is getting hot", "Take it out of its case and out of the sun, or choose HD 720p. A hot phone slows down and the picture gets jumpy.")
        for (v in listOf(dim, hot)) cam.addView(v, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = ui.dp(64) })

        tally = TallyFrame(this, ui)
        cam.addView(tally, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(cam, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    private fun banner(title: String, small: String) = ui.text(bannerText(title, small), 15f, C.TEXT, ui.semi).apply {
        gravity = Gravity.CENTER
        background = ui.box(0xEB0F1E3D.toInt(), 14f, C.LINE, 1f)
        setPadding(ui.dp(18), ui.dp(14), ui.dp(18), ui.dp(14))
        maxWidth = (screenLong() * 0.6f).toInt()
        visibility = View.GONE
    }

    private fun screenLong() = max(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)

    /** with the settings open on the right, the messages move into the space on the left */
    private fun placeBanners(sheetOpen: Boolean) {
        val room = screenLong() - sheetW - ui.dp(32)
        for (v in listOf(waiting, lost, camErr, dim, hot)) {
            val lp = v.layoutParams as FrameLayout.LayoutParams
            val top = v === dim || v === hot
            lp.gravity = when {
                sheetOpen && top -> Gravity.START or Gravity.TOP
                sheetOpen -> Gravity.START or Gravity.CENTER_VERTICAL
                top -> Gravity.CENTER_HORIZONTAL or Gravity.TOP
                else -> Gravity.CENTER
            }
            lp.leftMargin = if (sheetOpen) ui.dp(16) else 0
            v.layoutParams = lp
            v.maxWidth = if (sheetOpen) room else (screenLong() * 0.6f).toInt()
        }
    }

    private fun bannerText(title: String, small: String): CharSequence {
        val sb = SpannableStringBuilder(title)
        sb.setSpan(StyleSpan(android.graphics.Typeface.BOLD), 0, title.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (small.isNotEmpty()) {
            val at = sb.length
            sb.append("\n").append(small)
            sb.setSpan(RelativeSizeSpan(0.87f), at, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            sb.setSpan(ForegroundColorSpan(C.MUTED), at, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return sb
    }

    private fun buildSheet() {
        sheet = ScrollView(this).apply {
            setBackgroundColor(C.SHEET)
            isVerticalScrollBarEnabled = false
            isClickable = true // touches here don't reach the picture
            visibility = View.GONE
        }
        val s = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.dp(16), ui.dp(14), ui.dp(16), ui.dp(18)) }
        sheet.addView(s, FrameLayout.LayoutParams(MATCH, WRAP))

        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(ui.text("Picture settings", 16f, C.TEXT, ui.bold), LinearLayout.LayoutParams(0, WRAP, 1f))
        head.addView(ui.button("Done").apply { setOnClickListener { openSheet(false) } })
        s.addView(head)

        s.addView(h3("Picture"))
        s.addView(ui.text("Resolution", 13f, C.MUTED, ui.semi), ui.lp(WRAP, WRAP, ui.dp(6)))
        qualityL = Choice(ui, listOf(2160 to "4K", 1080 to "1080p", 720 to "720p (weak Wi-Fi)"), prefs.quality) { pictureChanged() }
        s.addView(qualityL.view, ui.lp(MATCH, WRAP, ui.dp(6)))
        s.addView(ui.text("Frame rate", 13f, C.MUTED, ui.semi), ui.lp(WRAP, WRAP, ui.dp(10)))
        fpsL = Choice(ui, listOf(24 to "24", 25 to "25", 30 to "30", 50 to "50", 60 to "60"), prefs.fps) { pictureChanged() }
        s.addView(fpsL.view, ui.lp(MATCH, WRAP, ui.dp(6)))
        gotText = hint("")
        s.addView(gotText, ui.lp(MATCH, WRAP, ui.dp(8)))
        s.addView(hint("The picture to OBS is always landscape, the way the phone was held when you pressed Start."), ui.lp(MATCH, WRAP, ui.dp(6)))

        s.addView(h3("Lens"))
        s.addView(hint("Tap 24mm to 200mm at the bottom of the screen, or pinch to zoom in between. On phones with a zoom lens, the long settings switch to it by themselves so the picture stays sharp; without one they are a digital zoom."), ui.lp(MATCH, WRAP, ui.dp(6)))

        s.addView(h3("White balance"))
        wbBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        wbC = Choice(ui, WB, CameraMetadata.CONTROL_AWB_MODE_AUTO) { m ->
            engine.camera?.setAwb(m)
            awbLocked = false
            wbLock.text = "Lock white balance as it is now"
        }
        wbBox.addView(wbC.view, ui.lp(MATCH, WRAP, ui.dp(6)))
        wbLock = ui.button("Lock white balance as it is now").apply {
            setOnClickListener {
                if (awbLocked) {
                    engine.camera?.setAwb(CameraMetadata.CONTROL_AWB_MODE_AUTO)
                    awbLocked = false
                    wbC.set(CameraMetadata.CONTROL_AWB_MODE_AUTO)
                    text = "Lock white balance as it is now"
                } else {
                    engine.camera?.setAwbLock(true)
                    awbLocked = true
                    wbC.set(-1)
                    text = "Back to auto white balance"
                }
            }
        }
        wbBox.addView(wbLock, ui.lp(MATCH, WRAP, ui.dp(8)))
        s.addView(wbBox)
        wbNa = na("This phone does not allow white balance control. It stays on auto.")
        s.addView(wbNa, ui.lp(MATCH, WRAP, ui.dp(6)))

        s.addView(h3("Exposure"))
        s.addView(hint("Brightness: drag the ☀ line on the right of the screen up or down. Double-tap it to reset."), ui.lp(MATCH, WRAP, ui.dp(6)))
        expLock = ui.button("Lock exposure as it is now").apply {
            setOnClickListener {
                if (aeLocked || manualOn) {
                    engine.camera?.autoExposure()
                    aeLocked = false
                    manualOn = false
                    shutVal.text = "Auto"
                    isoVal.text = "Auto"
                    text = "Lock exposure as it is now"
                } else {
                    engine.camera?.setAeLock(true)
                    aeLocked = true
                    text = "Back to auto exposure"
                }
            }
        }
        s.addView(expLock, ui.lp(MATCH, WRAP, ui.dp(8)))
        shutBar = seek()
        shutVal = ui.text("Auto", 13f, C.MUTED, ui.semi)
        shutRow = slider("Shutter", shutBar, shutVal)
        s.addView(shutRow, ui.lp(MATCH, WRAP, ui.dp(8)))
        shutBar.setOnSeekBarChangeListener(onSeek { p ->
            val x = shutters.getOrNull(p) ?: return@onSeek
            shutVal.text = "1/$x"
            engine.camera?.setShutter(x)
            manualOn = true
            aeLocked = false
            expLock.text = "Back to auto exposure"
        })
        isoBar = seek()
        isoVal = ui.text("Auto", 13f, C.MUTED, ui.semi)
        isoRow = slider("ISO", isoBar, isoVal)
        s.addView(isoRow, ui.lp(MATCH, WRAP, ui.dp(4)))
        isoBar.setOnSeekBarChangeListener(onSeek { p ->
            val c = caps ?: return@onSeek
            val v = isoFor(c, p)
            isoVal.text = "$v"
            engine.camera?.setIso(v)
            manualOn = true
            aeLocked = false
            expLock.text = "Back to auto exposure"
        })
        shutHint = hint("Under tube lights, set the shutter to 1/50 or 1/100 to stop flicker (Nigeria mains is 50 Hz).")
        s.addView(shutHint, ui.lp(MATCH, WRAP, ui.dp(6)))
        expNa = na("This phone does not allow exposure control. It stays on auto.")
        s.addView(expNa, ui.lp(MATCH, WRAP, ui.dp(6)))

        s.addView(h3("Focus and light"))
        val fl = Flow(this, ui.dp(6), ui.dp(6))
        focusBtn = ui.chip("Focus: auto").apply {
            setOnClickListener {
                focusLocked = !focusLocked
                engine.camera?.setFocusLock(focusLocked)
                ui.style(this, focusLocked)
                text = if (focusLocked) "Focus: locked" else "Focus: auto"
            }
        }
        torchBtn = ui.chip("Torch").apply {
            setOnClickListener {
                torchOn = !torchOn
                engine.camera?.setTorch(torchOn)
                ui.style(this, torchOn)
            }
        }
        fl.addView(focusBtn)
        fl.addView(torchBtn)
        s.addView(fl, ui.lp(MATCH, WRAP, ui.dp(6)))
        focusNa = na("This camera does not allow focus lock or the torch.")
        s.addView(focusNa, ui.lp(MATCH, WRAP, ui.dp(6)))

        sheetW = min(ui.dp(420), (screenLong() * 0.62f).toInt())
        cam.addView(sheet, FrameLayout.LayoutParams(sheetW, MATCH, Gravity.END))
    }

    private fun h3(s: String) = ui.text(s.uppercase(Locale.ROOT), 12f, C.GOLD, ui.bold).apply {
        letterSpacing = 0.1f
        layoutParams = ui.lp(WRAP, WRAP, ui.dp(16))
    }

    private fun hint(s: String) = ui.text(s, 12.5f, C.MUTED)
    private fun na(s: String) = ui.text(s, 12.5f, C.NA).apply { visibility = View.GONE }

    private fun seek() = SeekBar(this).apply {
        progressTintList = ColorStateList.valueOf(C.GOLD)
        thumbTintList = ColorStateList.valueOf(C.GOLD)
        progressBackgroundTintList = ColorStateList.valueOf(0x66FFFFFF)
    }

    private fun slider(name: String, bar: SeekBar, value: TextView): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(ui.text(name, 13f, C.TEXT, ui.semi), LinearLayout.LayoutParams(ui.dp(70), WRAP))
        addView(bar, LinearLayout.LayoutParams(0, WRAP, 1f))
        value.gravity = Gravity.END
        addView(value, LinearLayout.LayoutParams(ui.dp(60), WRAP))
    }

    private fun onSeek(changed: (Int) -> Unit) = object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) { if (fromUser) changed(progress) }
        override fun onStartTrackingTouch(bar: SeekBar) {}
        override fun onStopTrackingTouch(bar: SeekBar) {}
    }

    private fun isoFor(c: Caps, p: Int): Int {
        val v = c.isoMin + (c.isoMax - c.isoMin) * p / 100.0
        return (v / 10).roundToInt() * 10
    }

    private fun pictureChanged() {
        prefs.quality = qualityL.value
        prefs.fps = fpsL.value
        qualityC.set(qualityL.value)
        fpsC.set(fpsL.value)
        gotText.text = "Changing…"
        engine.setPicture(qualityL.value, fpsL.value)
    }

    private fun showCamera(resume: Boolean) {
        join.visibility = View.GONE
        cam.visibility = View.VISIBLE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        immersive(true)
        hideKeyboard()
        val s = engine.settings
        if (s != null) {
            nameLabel.text = s.name
            qualityL.set(s.quality)
            fpsL.set(s.fps)
        }
        if (resume) {
            lockTo(engine.rotation)
            engine.caps?.let { onCaps(it) }
            onUi(engine.state)
        }
        attachSink()
    }

    private fun showJoin() {
        detachSink()
        cam.visibility = View.GONE
        join.visibility = View.VISIBLE
        openSheet(false)
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        immersive(false)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        facingC.set(prefs.facing)
        qualityC.set(prefs.quality)
        fpsC.set(prefs.fps)
        search()
    }

    private fun attachSink() {
        if (sinkOn || !engine.running || cam.visibility != View.VISIBLE) return
        val t = engine.track ?: return
        t.addSink(renderer)
        sinkOn = true
    }

    private fun detachSink() {
        if (!sinkOn) return
        engine.track?.removeSink(renderer)
        sinkOn = false
        renderer.clearImage()
    }

    @Suppress("DEPRECATION")
    private fun immersive(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(!on)
            val c = window.insetsController ?: return
            if (on) {
                c.hide(WindowInsets.Type.systemBars())
                c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                c.show(WindowInsets.Type.systemBars())
            }
        } else {
            window.decorView.systemUiVisibility = if (on) {
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            } else 0
        }
    }

    private fun openSheet(open: Boolean) {
        sheet.visibility = if (open) View.VISIBLE else View.GONE
        placeBanners(open)
        setBtn.setTextColor(if (open) C.NAVY else C.TEXT)
        setBtn.background = ui.pressable(if (open) ui.box(C.GOLD, 10f) else ui.box(0x80000000.toInt(), 10f, 0x47FFFFFF, 1f), 10f)
        if (open) setHideUi(false)
    }

    private fun setHideUi(h: Boolean) {
        hideUi = h
        val v = if (h) View.INVISIBLE else View.VISIBLE
        top.visibility = v
        bottom.visibility = v
    }

    private fun confirmStop() {
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Stop this camera?")
            .setMessage("OBS stops getting the picture from this phone.")
            .setPositiveButton("Stop") { _, _ -> engine.stop() }
            .setNegativeButton("Keep sending", null)
            .show()
    }

    @Suppress("DEPRECATION")
    private fun buzz() {
        val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 120, 60, 120), -1))
        else v.vibrate(longArrayOf(0, 120, 60, 120), -1)
    }

    // ---- lenses ----

    private fun buildLenses(c: Caps) {
        lenses.removeAllViews()
        if (c.zoomOk) for (mm in LENSES) {
            val z = mm / 24f
            if (z < c.zoomMin * 0.98f || z > c.zoomMax * 1.02f) continue // this phone can't reach it
            val label = SpannableString("${mm}mm").apply { setSpan(RelativeSizeSpan(0.78f), "$mm".length, "${mm}mm".length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            lenses.addView(ui.text(label, 13f, C.SOFT, ui.bold).apply {
                gravity = Gravity.CENTER
                setPadding(ui.dp(8), ui.dp(6), ui.dp(8), ui.dp(6))
                tag = mm
                isClickable = true
                setOnClickListener { setZoom(mm / 24f); showZoom() }
            })
        }
        lenses.visibility = if (lenses.childCount > 0) View.VISIBLE else View.GONE
        markLens()
    }

    private fun markLens() {
        val mm = (24 * zoom).roundToInt()
        for (i in 0 until lenses.childCount) {
            val b = lenses.getChildAt(i) as TextView
            val m = b.tag as Int
            val on = abs(m - mm) <= m * 0.03
            b.setTextColor(if (on) C.NAVY else C.SOFT)
            b.background = if (on) ui.box(C.GOLD, 7f) else null
        }
    }

    private fun setZoom(z: Float) {
        val c = caps ?: return
        if (!c.zoomOk) return
        zoom = z.coerceIn(c.zoomMin, c.zoomMax)
        engine.camera?.setZoom(zoom)
        markLens()
        main.removeCallbacks(saveMm)
        main.postDelayed(saveMm, 600)
    }

    private fun showZoom() {
        zoomChip.text = "${(24 * zoom).roundToInt()}mm"
        zoomChip.visibility = View.VISIBLE
        main.removeCallbacks(zoomHide)
        main.postDelayed(zoomHide, 1200)
    }

    // ---- brightness line ----

    private fun evRange(): Triple<Float, Float, Float> {
        val c = caps
        return if (c != null && c.evOk) Triple(c.evMin, c.evMax, c.evStep) else Triple(-2f, 2f, 0.1f)
    }

    private fun setEv(v: Float) {
        val (lo, hi, step) = evRange()
        ev = ((v / step).roundToInt() * step).coerceIn(lo, hi)
        drawEv()
        engine.setEv(ev)
    }

    private fun drawEv() {
        val (lo, hi, _) = evRange()
        evLine.frac = if (hi > lo) (hi - ev) / (hi - lo) else 0.5f
        evLine.label = (if (ev > 0.04f) "+" else "") + String.format(Locale.US, "%.1f", ev)
    }

    // ---- touches on the picture ----

    override fun onEvStart() { ev0 = ev; evLine.active = true }
    override fun onEvDrag(dy: Float) { val (lo, hi, _) = evRange(); setEv(ev0 - dy / 0.56f * (hi - lo)) }
    override fun onEvEnd() { evLine.active = false }
    override fun onEvReset() { setEv(0f) }

    override fun onZoomStart() {
        zoom0 = zoom
        if (caps?.zoomOk != true) {
            zoomChip.text = "Zoom is not available on this camera"
            zoomChip.visibility = View.VISIBLE
            main.removeCallbacks(zoomHide)
            main.postDelayed(zoomHide, 1500)
        }
    }

    override fun onZoom(scale: Float) {
        if (caps?.zoomOk != true) return
        setZoom(zoom0 * scale)
        showZoom()
    }

    override fun onTap() {
        if (lastTally != "live" && sheet.visibility != View.VISIBLE) setHideUi(!hideUi)
    }

    // ---- from the engine (main thread) ----

    override fun onUi(s: UiState) {
        if (s.running) attachSink()
        val t = s.tally
        pill.text = when (t) {
            "live" -> "● LIVE"
            "standby" -> "NOT LIVE"
            "unknown" -> "CONNECTED" // vMix or a plain browser: they can't say when the camera is live
            else -> if (s.lost) "OFFLINE" else if (!s.connected) "CONNECTING" else "READY"
        }
        pill.background = ui.box(when (t) { "live" -> C.LIVE; "standby" -> C.NEXT; else -> 0x2EFFFFFF }, 99f)
        tally.color = when (t) { "live" -> C.LIVE; "standby" -> C.NEXT; else -> 0 }
        if (t == "live" && lastTally != "live") {
            buzz()
            if (hideUi) setHideUi(false)
        }
        lastTally = t
        resText.text = s.res
        resText.setTextColor(if (s.dim) C.WARN else C.SOFT)
        battText.text = s.batt
        val err = s.camErr
        camErr.text = bannerText("Camera stopped", err ?: "")
        camErr.visibility = if (err != null) View.VISIBLE else View.GONE
        lost.visibility = if (s.lost && err == null) View.VISIBLE else View.GONE
        waiting.visibility = if (s.running && s.connected && !s.lost && s.views == 0 && err == null) View.VISIBLE else View.GONE
        if (s.dimShow) dim.text = bannerText("Too dark for smooth motion", "The camera has slowed to ${s.dimFps} frames a second to gather light, so moving shots look jumpy. Add light on this spot.")
        dim.visibility = if (s.dimShow) View.VISIBLE else View.GONE
        hot.visibility = if (s.hot && !s.dimShow) View.VISIBLE else View.GONE
        if (s.got.isNotEmpty()) gotText.text = s.got
    }

    override fun onCaps(c: Caps) {
        caps = c
        renderer.setMirror(c.facing == "user")
        zoom = c.zoom
        buildLenses(c)
        engine.settings?.let { qualityL.set(it.quality); fpsL.set(it.fps) }

        val wbOk = c.awbModes.size > 1 || c.awbLockOk
        wbBox.visibility = if (wbOk) View.VISIBLE else View.GONE
        wbNa.visibility = if (wbOk) View.GONE else View.VISIBLE
        for ((m, _) in WB) wbC.enable(m, m in c.awbModes)
        wbC.set(CameraMetadata.CONTROL_AWB_MODE_AUTO)
        awbLocked = false
        ui.enable(wbLock, c.awbLockOk)
        wbLock.text = "Lock white balance as it is now"

        ev = 0f
        drawEv()
        aeLocked = false
        manualOn = false
        expLock.visibility = if (c.aeLockOk || c.manual) View.VISIBLE else View.GONE
        expLock.text = "Lock exposure as it is now"
        shutters = c.shutters
        shutRow.visibility = if (c.manual) View.VISIBLE else View.GONE
        shutHint.visibility = shutRow.visibility
        isoRow.visibility = shutRow.visibility
        if (c.manual) {
            shutBar.max = max(1, shutters.size - 1)
            shutBar.progress = max(0, shutters.indexOf(50))
            shutVal.text = "Auto"
            isoBar.max = 100
            isoBar.progress = 0
            isoVal.text = "Auto"
        }
        expNa.visibility = if (!c.evOk && !c.manual && !c.aeLockOk) View.VISIBLE else View.GONE

        focusLocked = false
        torchOn = false
        ui.enable(focusBtn, c.focusLockOk)
        ui.style(focusBtn, false)
        focusBtn.text = "Focus: auto"
        ui.enable(torchBtn, c.torchOk)
        ui.style(torchBtn, false)
        focusNa.visibility = if (!c.focusLockOk && !c.torchOk) View.VISIBLE else View.GONE
    }

    override fun onManual(shutter: Int, iso: Int) {
        val c = caps
        manualOn = shutter > 0
        shutVal.text = if (shutter > 0) "1/$shutter" else "Auto"
        isoVal.text = if (iso > 0) "$iso" else "Auto"
        if (iso > 0 && c != null && c.isoMax > c.isoMin) isoBar.progress = ((iso - c.isoMin) * 100.0 / (c.isoMax - c.isoMin)).roundToInt().coerceIn(0, 100)
        if (manualOn) expLock.text = "Back to auto exposure"
    }

    override fun onStopped(error: String?) {
        showJoin()
        showErr(error)
    }
}
