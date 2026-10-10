package com.glorycast.cam

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the camera sending while the screen turns off or someone opens another app, and keeps the
 * Wi-Fi out of power saving so the picture does not stutter.
 */
class CamService : Service() {
    companion object {
        private const val CHANNEL = "camera"
        private const val ACTION_STOP = "com.glorycast.cam.STOP"
        private const val EXTRA_NAME = "name"

        fun start(ctx: Context, name: String) {
            val i = Intent(ctx, CamService::class.java).putExtra(EXTRA_NAME, name)
            try {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (e: Exception) {
                // not allowed right now: the camera still works while the app is open
            }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, CamService::class.java)) } catch (e: Exception) { /* not running */ }
        }
    }

    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Engine.peek()?.stop()
            stopSelf()
            return START_NOT_STICKY
        }
        val n = notification(intent?.getStringExtra(EXTRA_NAME) ?: "")
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
            else startForeground(1, n)
        } catch (e: Exception) {
            stopSelf()
            return START_NOT_STICKY
        }
        hold()
        return START_NOT_STICKY
    }

    @Suppress("DEPRECATION")
    private fun hold() {
        if (wake == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GloryCastCam:camera").apply { setReferenceCounted(false); acquire() }
        }
        if (wifi == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifi = wm.createWifiLock(mode, "GloryCastCam:picture").apply { setReferenceCounted(false); acquire() }
        }
    }

    override fun onDestroy() {
        try { wake?.release() } catch (e: Exception) { /* released */ }
        try { wifi?.release() } catch (e: Exception) { /* released */ }
        wake = null
        wifi = null
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun notification(name: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Camera on", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows while this phone is sending its picture to the media computer"
                setShowBadge(false)
            })
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags)
        val stop = PendingIntent.getService(this, 1, Intent(this, CamService::class.java).setAction(ACTION_STOP), flags)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val label = if (name.isBlank()) "This phone" else "“$name”"
        return b.setSmallIcon(R.drawable.ic_stat_cam)
            .setContentTitle("GloryCast Cam is on")
            .setContentText("$label is sending its picture to the media computer. Tap to open.")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop camera", stop).build())
            .build()
    }
}
