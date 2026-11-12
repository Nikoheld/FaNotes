package ch.fasrv.fanotes.companion

import android.app.Application
import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_API_PATH
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Pairing Kanti+ im Browser from the settings screen, end to end against a fake Kanti+ server, the
 * way the screen calls it (on the main thread). Every request must leave the main thread: on a phone a
 * request on the main thread throws NetworkOnMainThreadException (beta.27 did that on "Weiter").
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class WebPairingFlowTest {
    private data class Seen(val method: String, val path: String, val onMain: Boolean)

    private val seen = CopyOnWriteArrayList<Seen>()
    private val guestId = "0123456789abcdef0123456789abcdef"
    private val guestToken = "g".repeat(43)

    private fun fakeServer() = Interceptor { chain ->
        val request = chain.request()
        val path = request.url.encodedPath.removePrefix(SCHULNETZ_API_PATH)
        seen += Seen(request.method, path, Looper.myLooper() == Looper.getMainLooper())
        val (code, body) = when {
            request.method == "POST" && path == "/guest" -> 200 to """{"accountId":"$guestId","token":"$guestToken"}"""
            request.method == "GET" && path == "/web-pair" -> 200 to """{"browser":"Firefox · Linux","expiresAt":"2099-01-01T00:00:00Z","added":0}"""
            request.method == "POST" && path == "/web-pair" -> 200 to """{"ok":true,"finished":true}"""
            request.method == "POST" && path == "/web-pair/offer" -> 200 to """{"code":"7K3QM9XR","expiresAt":"2099-01-01T00:00:00Z"}"""
            request.method == "GET" && path == "/web-sessions" -> 200 to """{"sessions":[{"id":"browser-1","browser":"Firefox · Linux","createdAt":"2026-11-11T20:00:00Z","lastSeenAt":"2026-11-11T20:00:00Z"}]}"""
            else -> 200 to "{}"
        }
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("x")
            .body(body.toResponseBody("application/json".toMediaType())).build()
    }

    private lateinit var model: CompanionModel

    @Before fun setUp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        AppLanguage.install(app)
        AppLanguage.choose("en")
        // A phone with one Schulnetz connection and no FaNotes account: the browser borrows a guest identity.
        app.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).edit().putBoolean("school-linked", true).commit()
        // Approving re-arms background delivery (WorkManager), as on a phone.
        if (!androidx.work.WorkManager.isInitialized()) {
            androidx.work.WorkManager.initialize(app, androidx.work.Configuration.Builder().setExecutor(java.util.concurrent.Executors.newSingleThreadExecutor()).build())
        }
        // The client's own main-thread check stays real: Robolectric runs this test on the main looper.
        val client = SchulnetzClient(OkHttpClient.Builder().addInterceptor(fakeServer()).build())
        val graph = CompanionGraph(app, client)
        graph.commuteRequestsAllowed = false
        model = CompanionModel(graph)
        waitFor("a connection") { model.connections.connections.isNotEmpty() }
    }

    private fun waitFor(what: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 15_000
        while (!condition()) {
            if (System.currentTimeMillis() > until) fail("timed out waiting for $what (message: ${model.message})")
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
    }

    @Test fun approvingABrowserCodeRunsEveryRequestOffTheMainThread() {
        // The screen calls this on the main thread.
        assertTrue(Looper.myLooper() == Looper.getMainLooper())
        model.lookupWebPair("7K3Q-M9XR")
        assertTrue("the screen shows progress while the request runs", model.webPairWorking || model.webPairPrompt != null)
        waitFor("the browser behind the code") { !model.busy }
        assertNull(model.message)
        val prompt = model.webPairPrompt
        assertNotNull(prompt)
        assertEquals("Firefox · Linux", prompt!!.info.browser)

        model.approveWebPair(listOf(model.connections.connections.first().id))
        waitFor("the approval") { !model.busy }
        assertNull(model.webPairPrompt)
        assertEquals(t(R.string.web_pair_done), model.message)

        val pairing = seen.filter { it.path.startsWith("/web-pair") || it.path == "/guest" || it.path == "/web-sessions" }
        assertTrue("guest identity, look-up and approval reached the server: $seen", pairing.map { "${it.method} ${it.path}" }.containsAll(listOf("POST /guest", "GET /web-pair", "POST /web-pair")))
        assertTrue("no request ran on the main thread: ${seen.filter { it.onMain }}", seen.none { it.onMain })
    }

    @Test fun theAppShowsACodeWithoutTouchingTheNetworkOnTheMainThread() {
        model.offerWebPair(listOf(model.connections.connections.first().id))
        waitFor("the offered code") { !model.busy }
        assertNull(model.message)
        assertEquals("7K3QM9XR", model.webPairOffer?.code?.replace("-", ""))
        assertTrue("no request ran on the main thread: ${seen.filter { it.onMain }}", seen.none { it.onMain })
    }

    @Test fun theClientRefusesARequestOnTheMainThread() {
        val client = SchulnetzClient(OkHttpClient.Builder().addInterceptor(fakeServer()).build())
        try {
            client.webPairInfo(SchoolAuth(guestId, guestToken, guest = true), "7K3QM9XR")
            fail("a request on the main thread must not run")
        } catch (expected: MainThreadNetworkException) {
            assertTrue(expected.message.orEmpty().contains("/web-pair"))
        }
        assertTrue("nothing was sent", seen.isEmpty())
    }
}
