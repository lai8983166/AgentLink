package io.agentlink.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.concurrent.Executors

@CapacitorPlugin(name = "AgentLinkNative", permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])])
class AgentLinkPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private fun state() = AppState(context)
    private fun permission() = (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) && NotificationManagerCompat.from(context).areNotificationsEnabled()
    private fun snapshot(): JSObject {
        val s = state()
        return JSObject().put("enabled", s.enabled).put("running", NotificationService.running).put("permission", permission())
            .put("batteryExempt", context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName))
            .put("state", s.prefs.getString("state", "尚未开启")).put("lastConnectedAt", s.prefs.getLong("lastConnectedAt", 0))
            .put("lastDeliveredAt", s.prefs.getLong("lastDeliveredAt", 0)).put("version", BuildConfig.VERSION_NAME)
    }
    @PluginMethod fun status(call: PluginCall) { call.resolve(snapshot()) }
    @PluginMethod fun start(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsGranted"); return
        }
        startGranted(call)
    }
    @PermissionCallback private fun notificationsGranted(call: PluginCall) { startGranted(call) }
    private fun startGranted(call: PluginCall) {
        if (!permission()) { call.reject("请先在系统设置中允许 AgentLink 发送通知"); return }
        val url = try { NotificationPolicy.server(call.getString("url") ?: "") } catch (_: Exception) { call.reject("请输入有效的 HTTPS 服务器地址"); return }
        val token = call.getString("token")?.trim().orEmpty()
        if (token.isEmpty()) { call.reject("请先配对电脑后台"); return }
        executor.execute {
            val s = state(); val connection = Connection(url, token, s.deviceId()); val api = NativeApi(connection)
            try {
                api.register(); s.save(connection); s.enabled = true; s.message("正在连接电脑后台…")
                activity.runOnUiThread {
                    try {
                        ContextCompat.startForegroundService(context, Intent(context, NotificationService::class.java)); call.resolve(snapshot())
                    } catch (_: Exception) { s.enabled = false; call.reject("系统暂不允许启动后台服务，请保持应用在前台后重试") }
                }
            } catch (e: Exception) {
                call.reject(if (e is ApiFailure && e.status == 401) "配对 token 已失效，请重新配对" else if (e is ApiFailure && e.status == 404) "电脑后台尚未更新到支持安卓通知的版本" else "无法连接通知接口，请检查 HTTPS 地址、证书和网络")
            } finally { api.close() }
        }
    }
    @PluginMethod fun stop(call: PluginCall) {
        val s = state(); s.enabled = false; s.message("已关闭安卓任务通知")
        context.stopService(Intent(context, NotificationService::class.java))
        executor.execute {
            try {
                s.connection()?.let { c ->
                    val api = NativeApi(c)
                    try { api.remove() } catch (e: ApiFailure) { if (e.status != 401 && e.status != 404) throw e }
                    finally { api.close() }
                }
                s.clear(); call.resolve(snapshot())
            } catch (_: Exception) { call.reject("本机通知已停止；后台注销失败，请联网后重试解除配对") }
        }
    }
    @PluginMethod fun test(call: PluginCall) {
        executor.execute {
            try {
                val c = state().connection() ?: throw IllegalStateException()
                check(state().enabled); val api = NativeApi(c)
                try { api.test(); call.resolve() } finally { api.close() }
            } catch (_: Exception) { call.reject("测试通知入队失败，请检查后台连接或重新开启通知") }
        }
    }
    @PluginMethod fun batterySettings(call: PluginCall) {
        try {
            val manager = context.getSystemService(PowerManager::class.java)
            val intent = if (!manager.isIgnoringBatteryOptimizations(context.packageName))
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + context.packageName))
                else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
            activity.startActivity(intent); call.resolve()
        } catch (_: Exception) { call.reject("请手动打开系统应用设置，允许后台运行和自启动") }
    }
    @PluginMethod fun consumeNavigation(call: PluginCall) {
        val s = state(); val path = s.prefs.getString("navigation", null)
        s.prefs.edit().remove("navigation").commit()
        call.resolve(if (path != null && NotificationPolicy.safePath(path)) JSObject().put("path", path) else JSObject())
    }
    fun navigationReady() {
        val s = state(); val path = s.prefs.getString("navigation", null) ?: return
        if (NotificationPolicy.safePath(path)) notifyListeners("navigation", JSObject().put("path", path))
    }
    override fun handleOnDestroy() { executor.shutdown(); super.handleOnDestroy() }
}
