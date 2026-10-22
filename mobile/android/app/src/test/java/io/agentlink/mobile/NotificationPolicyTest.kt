package io.agentlink.mobile

import org.junit.Assert.*
import org.junit.Test

class NotificationPolicyTest {
    @Test fun acceptsOnlyHttpsOrigins() {
        assertEquals("https://agentlink.example:8443", NotificationPolicy.server("https://agentlink.example:8443/"))
        for (value in listOf("http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret", "https://example.com/#x")) {
            assertTrue(runCatching { NotificationPolicy.server(value) }.isFailure)
        }
    }
    @Test fun notificationCannotNavigateToExternalSiteOrApi() {
        assertTrue(NotificationPolicy.safePath("/019-thread")); assertTrue(NotificationPolicy.safePath("/settings"))
        for (path in listOf("//evil.example", "https://evil.example", "/api/v1/status", "/../settings", "/thread?token=x")) assertFalse(NotificationPolicy.safePath(path))
    }
    @Test fun retriesBackOffButRecoverWithinThirtySeconds() {
        assertEquals(1000L, NotificationPolicy.retryDelay(0)); assertEquals(30000L, NotificationPolicy.retryDelay(20))
    }
}
