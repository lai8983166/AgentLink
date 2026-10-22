package io.agentlink.mobile

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiFailure(val status: Int) : IOException("HTTP $status")
class NativeApi(private val connection: Connection) {
    private val client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(35, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    @Volatile private var active: Call? = null
    fun request(path: String, method: String = "GET", body: JSONObject? = null): JSONObject {
        val builder = Request.Builder().url(connection.url + "/api/v1/native-push/devices" + path)
            .header("Authorization", "Bearer " + connection.token).header("Cache-Control", "no-store")
        if (method != "GET") builder.method(method, if (method == "DELETE") null else (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        val call = client.newCall(builder.build()); active = call
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw ApiFailure(response.code)
                return JSONObject(response.body?.string() ?: "{}")
            }
        } finally { active = null }
    }
    fun register() { request("", "POST", JSONObject().put("id", connection.id)) }
    fun inbox() = request("/${connection.id}/inbox").getJSONArray("deliveries")
    fun ack(id: String) { request("/${connection.id}/ack", "POST", JSONObject().put("ids", org.json.JSONArray().put(id))) }
    fun remove() { request("/${connection.id}", "DELETE") }
    fun test() { request("/${connection.id}/test", "POST") }
    fun cancel() { active?.cancel() }
    fun close() { cancel(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
}
