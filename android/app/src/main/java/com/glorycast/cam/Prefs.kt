package com.glorycast.cam

import android.content.Context

/** What this phone remembers between services: its name, picture settings and lens. */
class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("gccam", Context.MODE_PRIVATE)

    var name: String
        get() = p.getString("name", "") ?: ""
        set(v) = p.edit().putString("name", v).apply()

    /** the media computer used last time, as typed or found ("192.168.1.20:7795") */
    var host: String
        get() = p.getString("host", "") ?: ""
        set(v) = p.edit().putString("host", v).apply()

    /** "environment" (back) or "user" (front), the same words the web camera page uses */
    var facing: String
        get() = p.getString("facing", "environment") ?: "environment"
        set(v) = p.edit().putString("facing", v).apply()

    var quality: Int
        get() = p.getInt("quality", 1080)
        set(v) = p.edit().putInt("quality", v).apply()

    var fps: Int
        get() = p.getInt("fps", 30)
        set(v) = p.edit().putInt("fps", v).apply()

    /** each camera (back, front) keeps its own lens */
    fun mm(facing: String): Int = p.getInt("mm.$facing", 24)
    fun setMm(facing: String, mm: Int) = p.edit().putInt("mm.$facing", mm).apply()
}
