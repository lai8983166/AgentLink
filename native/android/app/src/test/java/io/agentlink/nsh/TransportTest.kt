package io.agentlink.nsh

import io.agentlink.mobile.Connection
import io.agentlink.mobile.NotificationPolicy
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Test
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

class TransportTest {
    @Test fun redirectDoesNotLeakBearerToAnotherOrigin() {
        val origin = MockWebServer(); val other = MockWebServer(); origin.start(); other.start()
        val transport = Transport()
        try {
            origin.enqueue(MockResponse().setResponseCode(302).addHeader("Location", other.url("/capture")))
            val result = transport.request(Connection(origin.url("/").toString().trimEnd('/'), "synthetic-token", "synthetic-device"), "/api/v1/status", "GET", null)
            assertEquals(302, result.first)
            assertEquals("Bearer synthetic-token", origin.takeRequest().getHeader("Authorization"))
            assertNull(other.takeRequest(100, TimeUnit.MILLISECONDS))
        } finally { transport.close(); origin.shutdown(); other.shutdown() }
    }
    @Test fun writesAreNotRetriedAndHaveJsonContentType() {
        val server = MockWebServer(); server.start(); val transport = Transport()
        try {
            server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
            assertEquals(503, transport.request(Connection(server.url("/").toString().trimEnd('/'), "synthetic", "device"), "/api/v1/sessions", "POST", "{}").first)
            val request = server.takeRequest(); assertEquals("POST", request.method)
            assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
            assertEquals(1, server.requestCount)
            assertFalse(transport.client.retryOnConnectionFailure)
        } finally { transport.close(); server.shutdown() }
    }
    @Test fun pairingRejectsInsecureAndEmbeddedCredentials() {
        for (url in listOf("http://agent.example.com", "https://user:pass@agent.example.com", "https://agent.example.com/api", "https://agent.example.com/?token=sample")) {
            try { NotificationPolicy.server(url); fail("accepted invalid root") } catch (_: IllegalArgumentException) { }
        }
        assertEquals("https://agent.example.com", NotificationPolicy.server("https://agent.example.com/"))
    }
}
