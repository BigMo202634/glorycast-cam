package com.glorycast.cam

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.max

/** GloryCast colours (the same as the web pages) */
object C {
    const val NAVY = 0xFF0F1E3D.toInt()
    const val NAVY2 = 0xFF172A50.toInt()
    const val SHEET = 0xF00A1226.toInt()
    const val LINE = 0xFF2C4475.toInt()
    const val GOLD = 0xFFC9A227.toInt()
    const val TEXT = 0xFFEEF2FA.toInt()
    const val MUTED = 0xFF9BA9C6.toInt()
    const val SOFT = 0xFFDFE5F2.toInt()
    const val LIVE = 0xFFE5383B.toInt()
    const val NEXT = 0xFF2FBF71.toInt()
    const val WARN = 0xFFFFB020.toInt()
    const val NA = 0xFFC7B98A.toInt()
}

/** small helpers for building the screens in code */
class Ui(val ctx: Context) {
    private val density = ctx.resources.displayMetrics.density
    val regular: Typeface = font(500)
    val semi: Typeface = font(600)
    val bold: Typeface = font(700)
    val heavy: Typeface = font(800)

    private fun font(weight: Int): Typeface {
        val fallback = Typeface.create(Typeface.SANS_SERIF, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
        if (Build.VERSION.SDK_INT < 26) return fallback
        return try {
            Typeface.Builder(ctx.assets, "Montserrat-VF.ttf").setFontVariationSettings("'wght' $weight").build() ?: fallback
        } catch (e: Exception) {
            fallback
        }
    }

    fun dp(v: Float): Int = (v * density + 0.5f).toInt()
    fun dp(v: Int): Int = dp(v.toFloat())

    fun box(fill: Int, radius: Float, stroke: Int = 0, strokeW: Float = 1f): GradientDrawable = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        if (stroke != 0) setStroke(dp(strokeW), stroke)
    }

    fun pressable(d: Drawable, radius: Float): Drawable =
        RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), d, box(0xFFFFFFFF.toInt(), radius))

    fun text(s: CharSequence, sp: Float, color: Int = C.TEXT, face: Typeface = regular): TextView = TextView(ctx).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
        typeface = face
        setLineSpacing(0f, 1.25f)
    }

    /** a dark button with a light outline (gold = the main action) */
    fun button(label: String, gold: Boolean = false, sp: Float = 13f): TextView = text(label, sp, if (gold) C.NAVY else C.TEXT, if (gold) heavy else bold).apply {
        gravity = Gravity.CENTER
        isClickable = true
        isFocusable = true
        setLines(1)
        ellipsize = TextUtils.TruncateAt.END
        setPadding(dp(12), dp(9), dp(12), dp(9))
        background = pressable(if (gold) box(C.GOLD, 12f) else box(0x80000000.toInt(), 10f, 0x47FFFFFF, 1f), if (gold) 12f else 10f)
    }

    fun chip(label: String): TextView = text(label, 12.5f, C.TEXT, semi).apply {
        gravity = Gravity.CENTER
        isClickable = true
        isFocusable = true
        setLines(1)
        setPadding(dp(11), dp(7), dp(11), dp(7))
        style(this, false)
    }

    fun style(chip: TextView, on: Boolean) {
        chip.setTextColor(if (on) C.NAVY else C.TEXT)
        chip.background = pressable(if (on) box(C.GOLD, 99f) else box(C.NAVY2, 99f, C.LINE, 1f), 99f)
    }

    fun enable(v: View, on: Boolean) {
        v.isEnabled = on
        v.alpha = if (on) 1f else 0.35f
    }

    fun lp(w: Int, h: Int, top: Int = 0) = ViewGroup.MarginLayoutParams(w, h).apply { topMargin = top }
}

/** a row of choices where one is picked, wrapping onto more lines when narrow */
class Choice<T>(private val ui: Ui, options: List<Pair<T, String>>, initial: T, private val onPick: (T) -> Unit) {
    val view = Flow(ui.ctx, ui.dp(6), ui.dp(6))
    private val chips = LinkedHashMap<T, TextView>()
    var value: T = initial
        private set

    init {
        for ((v, label) in options) {
            val c = ui.chip(label)
            c.setOnClickListener { if (c.isEnabled && value != v) { set(v); onPick(v) } }
            chips[v] = c
            view.addView(c)
        }
        set(initial)
    }

    fun set(v: T) {
        value = v
        for ((k, c) in chips) ui.style(c, k == v)
    }

    fun enable(v: T, on: Boolean) { chips[v]?.let { ui.enable(it, on) } }
}

/** lays its children out left to right, starting a new line when one does not fit */
class Flow(ctx: Context, private val gapX: Int, private val gapY: Int) : ViewGroup(ctx) {
    override fun onMeasure(wSpec: Int, hSpec: Int) {
        val unlimited = MeasureSpec.getMode(wSpec) == MeasureSpec.UNSPECIFIED
        val maxW = if (unlimited) Int.MAX_VALUE else MeasureSpec.getSize(wSpec) - paddingLeft - paddingRight
        var x = 0
        var y = 0
        var rowH = 0
        var widest = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            if (c.visibility == GONE) continue
            c.measure(MeasureSpec.makeMeasureSpec(if (unlimited) 0 else maxW, if (unlimited) MeasureSpec.UNSPECIFIED else MeasureSpec.AT_MOST),
                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            if (x > 0 && x + c.measuredWidth > maxW) { x = 0; y += rowH + gapY; rowH = 0 }
            x += c.measuredWidth
            widest = max(widest, x)
            x += gapX
            rowH = max(rowH, c.measuredHeight)
        }
        val w = if (MeasureSpec.getMode(wSpec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(wSpec) else widest + paddingLeft + paddingRight
        setMeasuredDimension(w, y + rowH + paddingTop + paddingBottom)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val maxW = r - l - paddingLeft - paddingRight
        var x = 0
        var y = 0
        var rowH = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            if (c.visibility == GONE) continue
            if (x > 0 && x + c.measuredWidth > maxW) { x = 0; y += rowH + gapY; rowH = 0 }
            c.layout(paddingLeft + x, paddingTop + y, paddingLeft + x + c.measuredWidth, paddingTop + y + c.measuredHeight)
            x += c.measuredWidth + gapX
            rowH = max(rowH, c.measuredHeight)
        }
    }
}

/** the live light: a thick frame round the whole screen, on top of everything */
class TallyFrame(ctx: Context, private val ui: Ui) : View(ctx) {
    var color = 0
        set(v) { if (field != v) { field = v; invalidate() } }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    override fun onDraw(c: Canvas) {
        if (color == 0) return
        val s = ui.dp(10).toFloat()
        paint.strokeWidth = s
        paint.color = color
        val r = ui.dp(30).toFloat() - s / 2 // follows a phone's rounded screen corners
        c.drawRoundRect(s / 2, s / 2, width - s / 2, height - s / 2, r, r, paint)
    }
}

/** the brightness line on the right of the screen */
class EvLine(ctx: Context, private val ui: Ui) : View(ctx) {
    /** 0 = top (brightest), 1 = bottom */
    var frac = 0.5f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    var label = "0.0"
        set(v) { field = v; invalidate() }
    var active = false
        set(v) { field = v; invalidate() }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x8CFFFFFF.toInt() }
    private val knob = Paint(Paint.ANTI_ALIAS_FLAG)
    private val sun = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C.GOLD; textAlign = Paint.Align.CENTER; typeface = ui.bold }
    private val value = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C.GOLD; textAlign = Paint.Align.CENTER; typeface = ui.bold; setShadowLayer(3f, 0f, 1f, 0xFF000000.toInt()) }

    override fun onDraw(c: Canvas) {
        val cx = width / 2f
        val top = height * 0.22f
        val bottom = height * 0.70f
        c.drawRoundRect(cx - ui.dp(1), top, cx + ui.dp(1), bottom, ui.dp(1).toFloat(), ui.dp(1).toFloat(), line)
        val y = top + frac * (bottom - top)
        knob.color = if (active) 0x40C9A227 else 0x59000000
        c.drawCircle(cx, y, ui.dp(17).toFloat(), knob)
        sun.textSize = ui.dp(20).toFloat()
        c.drawText("☀", cx, y + ui.dp(7), sun)
        value.textSize = ui.dp(12).toFloat()
        c.drawText(label, cx, bottom + ui.dp(20), value)
    }
}

/**
 * Touches on the picture: drag up and down on the right part for brightness (double-tap there to
 * reset), pinch anywhere to zoom, tap elsewhere to hide or show the buttons.
 */
class TouchPad(ctx: Context) : View(ctx) {
    interface Listener {
        fun onEvStart()
        /** [dy]: how far the finger has moved since it went down, as a part of the screen height */
        fun onEvDrag(dy: Float)
        fun onEvEnd()
        fun onEvReset()
        fun onZoomStart()
        fun onZoom(scale: Float)
        fun onTap()
    }

    var listener: Listener? = null
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private var mode = 0 // 0 none, 1 brightness, 2 tap, 3 zoom
    private var startY = 0f
    private var startX = 0f
    private var moved = false
    private var lastTap = 0L
    private var span0 = 0f

    private val scale = ScaleGestureDetector(ctx, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(d: ScaleGestureDetector): Boolean {
            if (mode == 1) listener?.onEvEnd()
            mode = 3
            moved = true
            span0 = max(1f, d.currentSpan)
            listener?.onZoomStart()
            return true
        }

        override fun onScale(d: ScaleGestureDetector): Boolean {
            listener?.onZoom(d.currentSpan / span0)
            return false // keep measuring from where the pinch started
        }
    })

    override fun onTouchEvent(e: MotionEvent): Boolean {
        scale.onTouchEvent(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startX = e.x
                startY = e.y
                moved = false
                mode = if (e.x > width * 0.7f) 1 else 2
                if (mode == 1) listener?.onEvStart()
            }
            MotionEvent.ACTION_MOVE -> if (mode == 1 && e.pointerCount == 1) {
                val dy = e.y - startY
                if (abs(dy) > slop) moved = true
                if (moved) listener?.onEvDrag(dy / max(1, height))
            } else if (mode == 2 && (abs(e.x - startX) > slop || abs(e.y - startY) > slop)) {
                moved = true
            }
            MotionEvent.ACTION_UP -> {
                val now = e.eventTime
                if (mode == 1) {
                    listener?.onEvEnd()
                    if (!moved && now - lastTap < 350) listener?.onEvReset()
                } else if (mode == 2 && !moved) {
                    listener?.onTap()
                }
                lastTap = if (!moved) now else 0L
                mode = 0
            }
            MotionEvent.ACTION_CANCEL -> {
                if (mode == 1) listener?.onEvEnd()
                mode = 0
            }
        }
        return true
    }
}
