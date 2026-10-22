package io.agentlink.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

class NotificationService : Service() {
    companion object { @Volatile var running = false; private const val CONNECTION = "connection"; private const val TASKS = "tasks" }
    private val generation = AtomicInteger()
    private var worker: Thread? = null
    @Volatile private var api: NativeApi? = null
    private lateinit var state: AppState
    override fun onCreate() {
        super.onCreate(); state = AppState(this)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CONNECTION, "后台连接", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(TASKS, "任务完成与出错", NotificationManager.IMPORTANCE_DEFAULT))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val connection = runCatching { state.connection() }.getOrNull()
        if (!state.enabled || connection == null) { stopSelf(); return START_NOT_STICKY }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CONNECTION).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("AgentLink 正在保持连接").setContentText("接收任务完成和出错通知，点击打开")
            .setContentIntent(open).setOngoing(true).build()
        ServiceCompat.startForeground(this, 1, notification, if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        val current = generation.incrementAndGet(); api?.cancel(); worker?.interrupt(); running = true
        worker = Thread({ receive(connection, current) }, "agentlink-notifications").also { it.start() }
        return START_STICKY
    }
    private fun receive(connection: Connection, current: Int) {
        val client = NativeApi(connection); api = client; var attempt = 0; var registered = false
        fun active() = generation.get() == current && state.enabled && !Thread.currentThread().isInterrupted
        try {
            while (active()) {
                try {
                    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        state.message("通知权限已关闭，请在系统设置中允许通知"); Thread.sleep(15000); continue
                    }
                    if (!registered) { client.register(); registered = true }
                    state.message("后台连接正常，等待任务通知")
                    val deliveries = client.inbox()
                    if (!active()) break
                    state.prefs.edit().putLong("lastConnectedAt", System.currentTimeMillis()).apply(); attempt = 0
                    for (i in 0 until deliveries.length()) {
                        if (!active()) break
                        val job = deliveries.getJSONObject(i); val id = job.getString("id")
                        // 有效期由后台时钟判断；手机时间偏差不能导致未展示通知被确认。
                        if (!state.seen(id)) {
                            if (!showTask(id, job.getJSONObject("notification"))) break
                            state.delivered(id)
                        }
                        if (active()) client.ack(id)
                    }
                } catch (e: InterruptedException) { break }
                catch (e: Exception) {
                    if (!active()) break
                    if (e is ApiFailure && e.status == 401) { state.enabled = false; state.message("配对已失效，请重新配对并开启通知"); break }
                    if (e is ApiFailure && e.status == 404) registered = false
                    state.message("连接中断，正在重试；请确认电脑后台和网络可用")
                    try { Thread.sleep(NotificationPolicy.retryDelay(attempt++)) } catch (_: InterruptedException) { break }
                }
            }
        } finally {
            client.close()
            if (generation.get() == current) { running = false; stopSelf() }
        }
    }
    private fun showTask(id: String, payload: JSONObject): Boolean {
        val manager = NotificationManagerCompat.from(this)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (!manager.areNotificationsEnabled() || (Build.VERSION.SDK_INT >= 26 && getSystemService(NotificationManager::class.java).getNotificationChannel(TASKS)?.importance == NotificationManager.IMPORTANCE_NONE)) {
            state.message("系统已禁止任务通知，请在应用通知设置中开启")
            Thread.sleep(15000); return false
        }
        val path = payload.optString("url").takeIf(NotificationPolicy::safePath) ?: "/settings"
        val intent = Intent(this, MainActivity::class.java).putExtra("notificationPath", path)
            .setData(android.net.Uri.parse("agentlink://notification/" + id))
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.notify(id, 2, NotificationCompat.Builder(this, TASKS).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(payload.optString("title", "AgentLink · 任务通知").take(120))
            .setContentText(payload.optString("body").take(200)).setContentIntent(pending)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true).setOnlyAlertOnce(true).build())
        return true
    }
    override fun onDestroy() {
        generation.incrementAndGet(); running = false; api?.cancel(); worker?.interrupt(); super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
