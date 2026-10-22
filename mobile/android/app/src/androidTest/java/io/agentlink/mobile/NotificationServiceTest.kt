package io.agentlink.mobile

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** 只连接参数指定的本地假服务，绝不读取个人配对或真实 Codex 会话。 */
@RunWith(AndroidJUnit4::class)
class NotificationServiceTest {
    @Test fun backgroundReceivesAcknowledgesAndPreservesNavigation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val args = InstrumentationRegistry.getArguments()
        val origin = args.getString("fixtureUrl") ?: throw IllegalArgumentException("需要隔离测试服务 fixtureUrl")
        require(origin.startsWith("http://10.0.2.2:") || origin.startsWith("http://127.0.0.1:"))
        val state = AppState(context)
        // 模拟器安装的是独立 debug 包，不与自用 release 共享数据。
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.POST_NOTIFICATIONS}").close()
        val connection = Connection(origin, "android-instrumentation-only", state.deviceId())
        val api = NativeApi(connection)
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        Thread.sleep(2000)
        state.save(connection); api.register(); state.enabled = true
        try {
            instrumentation.runOnMainSync { ContextCompat.startForegroundService(context, Intent(context, NotificationService::class.java)) }
            instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_HOME").close()
            Thread.sleep(1000)
            api.test()
            val deadline = System.currentTimeMillis() + 30000
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            var job = manager.activeNotifications.firstOrNull { it.id == 2 }
            while (job == null && System.currentTimeMillis() < deadline) { Thread.sleep(300); job = manager.activeNotifications.firstOrNull { it.id == 2 } }
            assertNotNull("聊天界面在后台时应展示测试通知", job)
            assertTrue(state.prefs.getLong("lastDeliveredAt", 0) > 0)
            assertTrue(state.seen(job!!.tag))
            // 点击通知的 PendingIntent 由系统打开原应用并传递内部路径。
            job.notification.contentIntent.send(); Thread.sleep(1000)
            assertEquals("/settings", state.prefs.getString("navigation", null))
            val pending = api.request("/${connection.id}/inbox?wait=0").getJSONArray("deliveries")
            assertEquals("展示后向后台确认", 0, pending.length())
        } finally {
            state.enabled = false; context.stopService(Intent(context, NotificationService::class.java))
            api.remove(); api.close(); state.clear(); managerCancel(context)
        }
    }
    private fun managerCancel(context: Context) { context.getSystemService(NotificationManager::class.java).cancelAll() }
}
