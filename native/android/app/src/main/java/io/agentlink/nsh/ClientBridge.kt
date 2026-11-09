package io.agentlink.nsh

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.longbridge.nsh.NshView
import io.agentlink.mobile.AppState
import io.agentlink.mobile.Connection
import io.agentlink.mobile.NativeApi
import io.agentlink.mobile.ApiFailure
import io.agentlink.mobile.NotificationPolicy
import io.agentlink.mobile.NotificationService
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

class ClientBridge(private val activity: Activity, private val view: NshView) {
    private val state = AppState(activity)
    private val storage = activity.getSharedPreferences("nsh-client", 0)
    private val executor = Executors.newSingleThreadExecutor()
    private val transport = Transport()
    @Volatile private var closed = false
    @Volatile private var socket: WebSocket? = null
    @Volatile private var socketId: String? = null
    private fun scope() = state.prefs.getString("pairingScope", "") ?: ""
    private fun pending() = state.prefs.getBoolean("pendingUnpair", false)
    private fun info(): JSONObject {
        val c = state.connection()
        return JSONObject().put("paired", c != null && !pending()).put("url", c?.url ?: "")
            .put("scope", scope()).put("pendingUnpair", pending()).put("version", BuildConfig.VERSION_NAME)
    }
    private fun bootstrapInfo(): JSONObject {
        val result = info()
        val path = activity.intent?.getStringExtra("notificationPath")
        if (path != null && activity.intent?.getStringExtra("pairingScope") == scope() && !pending() && NotificationPolicy.safePath(path)) result.put("navigation", path)
        activity.intent?.removeExtra("notificationPath")
        return result
    }
    /** Read local state before loading the UI; never include credentials in launch parameters. */
    fun initialState(): JSONObject = try { bootstrapInfo() } catch (_: Exception) {
        JSONObject().put("restoreError", true)
    }
    private fun connection(data: JSONObject): Connection {
        check(!pending() && data.optString("scope") == scope()) { "配对已变更，请重新打开页面" }
        return requireNotNull(state.connection()) { "请先配对" }
    }
    private fun permitted() = (Build.VERSION.SDK_INT < 33 || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) && NotificationManagerCompat.from(activity).areNotificationsEnabled()
    private fun stopSocket() { socketId = null; socket?.cancel(); socket = null }
    private fun unregister() {
        state.enabled = false
        activity.stopService(Intent(activity, NotificationService::class.java))
        state.connection()?.let { c ->
            val api = NativeApi(c)
            try { api.remove() } catch (e: ApiFailure) { if (e.status != 401 && e.status != 404) throw e }
            finally { api.close() }
        }
    }
    init {
        view.handle("client.call") { raw, reply ->
            val data = try { JSONObject(raw as? Map<*, *> ?: emptyMap<String, Any>()) } catch (_: Exception) { JSONObject() }
            val op = data.optString("op")
            if (op == "notifications.start" && !permitted()) {
                if (Build.VERSION.SDK_INT >= 33) activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 10)
                reply.reject("请允许系统通知权限后再次开启任务通知")
            } else executor.execute {
                try {
                    val result = execute(op, data)
                    if (!closed) reply.resolve(result)
                } catch (_: java.io.IOException) {
                    if (!closed) reply.reject("网络请求未完成；写操作结果待确认，请联网后核对，不要重复发送")
                } catch (e: Exception) {
                    if (!closed) reply.reject(if (e is IllegalArgumentException || e is IllegalStateException) e.message ?: "操作不可用" else "本机操作失败，请重试")
                }
            }
        }
    }
    private fun execute(op: String, data: JSONObject): Any? {
        check(!closed)
        if (op == "bootstrap") return bootstrapInfo()
        if (op == "pair") {
            check(state.connection() == null && !pending()) { "请先解除原配对" }
            val url = NotificationPolicy.server(data.getString("url"))
            val token = data.getString("token").trim()
            require(token.isNotEmpty() && !token.contains('\n') && !token.contains('\r')) { "请输入有效配对 token" }
            val c = Connection(url, token, state.deviceId())
            val (status, body) = transport.request(c, "/api/v1/status", "GET", null)
            check(status in 200..299 && JSONObject(body).has("daemonVersion")) { "配对失败，请检查地址、token 与后台版本" }
            stopSocket(); storage.edit().clear().commit()
            state.save(c)
            check(state.prefs.edit().putString("pairingScope", UUID.randomUUID().toString()).remove("seen").remove("navigation").commit())
            return info()
        }
        if (op == "unpair") {
            // Scope is required even on a retry so an old screen cannot unpair a new identity.
            check(data.optString("scope") == scope()) { "配对已变更" }
            stopSocket(); state.enabled = false
            state.prefs.edit().putBoolean("pendingUnpair", true).commit()
            activity.stopService(Intent(activity, NotificationService::class.java))
            storage.edit().clear().commit()
            try { unregister() } catch (_: Exception) { throw IllegalStateException("本机已停止通知；远程注销未完成，请联网后重试解除配对") }
            state.clear()
            state.prefs.edit().remove("pairingScope").remove("pendingUnpair").remove("seen").remove("navigation").commit()
            (activity.getSystemService(NotificationManager::class.java)).cancelAll()
            return info()
        }
        val c = connection(data)
        return when (op) {
            "request" -> {
                val (status, body) = transport.request(c, data.getString("path"), data.optString("method", "GET"), data.optString("body").ifEmpty { null })
                if (status == 401) { stopSocket(); state.enabled = false; activity.stopService(Intent(activity, NotificationService::class.java)) }
                JSONObject().put("status", status).put("body", body)
            }
            "storage.get" -> storage.getString(key(data), null)
            "storage.set" -> { val value = data.getString("value"); require(value.length <= 8 * 1024 * 1024) { "本地缓存过大" }; check(storage.edit().putString(key(data), value).commit()); true }
            "uuid" -> UUID.randomUUID().toString()
            "ws.open" -> {
                stopSocket()
                val id = data.getString("id"); socketId = id
                val request = Request.Builder().url(c.url.replaceFirst("https://", "wss://") + "/api/v1/ws?token=" + Uri.encode(c.token)).build()
                socket = transport.client.newWebSocket(request, object : WebSocketListener() {
                    fun event(kind: String, text: String? = null) {
                        if (!closed && socketId == id) view.send("client.socket", JSONObject().put("id", id).put("kind", kind).put("data", text))
                    }
                    override fun onOpen(webSocket: WebSocket, response: Response) = event("open")
                    override fun onMessage(webSocket: WebSocket, text: String) = event("message", text)
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = event("close")
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = event("close")
                }); true
            }
            "ws.send" -> { if (socketId == data.getString("id")) socket?.send(data.getString("data")); true }
            "ws.close" -> { if (socketId == data.getString("id")) stopSocket(); true }
            "notifications.status" -> JSONObject().put("enabled", state.enabled).put("running", NotificationService.running)
                .put("permission", permitted()).put("state", state.prefs.getString("state", "尚未开启"))
                .put("lastDeliveredAt", state.prefs.getLong("lastDeliveredAt", 0))
                .put("batteryExempt", activity.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(activity.packageName))
            "downloads.open" -> {
                val path = when (data.optString("variant")) { "original" -> "/downloads/agentlink.apk"; "nsh" -> "/downloads/agentlink-nsh.apk"; else -> "/downloads/" }
                activity.runOnUiThread { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(c.url + path))) }; true
            }
            "notifications.start" -> {
                check(permitted()) { "请在系统设置中允许通知" }
                val api = NativeApi(c); try { api.register() } catch (e: ApiFailure) { throw IllegalStateException(if (e.status == 404) "后台不支持安卓通知，请更新后台" else "通知注册失败，请检查配对") } finally { api.close() }
                state.enabled = true
                try { ContextCompat.startForegroundService(activity, Intent(activity, NotificationService::class.java)) }
                catch (_: Exception) { state.enabled = false; throw IllegalStateException("请保持应用在前台后重试开启通知") }; true
            }
            "notifications.stop" -> { unregister(); true }
            "notifications.test" -> { check(state.enabled) { "请先开启通知" }; val api = NativeApi(c); try { api.test() } finally { api.close() }; true }
            "notifications.settings" -> { activity.runOnUiThread { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.packageName))) }; true }
            else -> throw IllegalArgumentException("不支持的客户端操作")
        }
    }
    private fun key(data: JSONObject): String {
        val key = data.getString("key")
        require(key in listOf("history", "outbox"))
        return key
    }
    fun foreground() {
        view.send("client.lifecycle", "active")
        if (state.enabled && !pending() && permitted()) runCatching { ContextCompat.startForegroundService(activity, Intent(activity, NotificationService::class.java)) }
    }
    fun background() { view.send("client.lifecycle", "background") }
    fun navigate(intent: Intent?) {
        val path = intent?.getStringExtra("notificationPath") ?: return
        if (intent.getStringExtra("pairingScope") == scope() && !pending() && NotificationPolicy.safePath(path)) {
            view.send("client.navigate", JSONObject().put("path", path).put("scope", scope()))
        }
        intent.removeExtra("notificationPath")
    }
    fun close() { closed = true; stopSocket(); executor.shutdownNow(); transport.close() }
}
