package io.agentlink.nsh

import io.agentlink.mobile.Connection
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import java.util.concurrent.TimeUnit

/** No redirect or implicit write retry; an absent response means an unknown outcome. */
class Transport {
    val client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    fun request(connection: Connection, path: String, method: String, body: String?): Pair<Int, String> {
        require(path.startsWith("/api/v1/") && !path.contains("..") && !path.contains('\\') && !path.contains('#'))
        require(method in listOf("GET", "POST", "PATCH", "DELETE"))
        val payload = if (method in listOf("POST", "PATCH")) (body ?: "{}").toRequestBody("application/json".toMediaType()) else null
        val request = Request.Builder().url(connection.url + path).header("Authorization", "Bearer " + connection.token)
            .header("Cache-Control", "no-store").method(method, payload).build()
        client.newCall(request).execute().use { response -> return response.code to (response.body?.string() ?: "{}") }
    }
    fun close() { client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
}
