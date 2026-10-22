package io.agentlink.mobile

import java.net.URI

object NotificationPolicy {
    fun server(value: String): String {
        val uri = URI(value.trim())
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) {
            "请输入不带路径或参数的 HTTPS 服务器地址"
        }
        return uri.toString().trimEnd('/')
    }
    fun safePath(path: String) = path.matches(Regex("^/[a-zA-Z0-9_%.-]+$")) && !path.contains("..")
    fun retryDelay(attempt: Int): Long = minOf(30000L, 1000L shl minOf(attempt, 5))
}
