package io.agentlink.mobile

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity
import androidx.core.content.ContextCompat

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(AgentLinkPlugin::class.java)
        saveNavigation(intent)
        super.onCreate(savedInstanceState)
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        saveNavigation(intent)
        (bridge.getPlugin("AgentLinkNative")?.instance as? AgentLinkPlugin)?.navigationReady()
    }
    override fun onResume() {
        super.onResume()
        if (AppState(this).enabled && !NotificationService.running) {
            runCatching { ContextCompat.startForegroundService(this, Intent(this, NotificationService::class.java)) }
                .onFailure { AppState(this).message("后台服务未能恢复，请在设置中重新开启通知") }
        }
    }
    private fun saveNavigation(intent: Intent?) {
        val path = intent?.getStringExtra("notificationPath") ?: return
        if (NotificationPolicy.safePath(path)) AppState(this).prefs.edit().putString("navigation", path).commit()
        intent.removeExtra("notificationPath")
    }
}
