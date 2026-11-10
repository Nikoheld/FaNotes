package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.schulnetz.NotifySettings
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_API_PATH
import ch.fasrv.fanotes.schulnetz.SchoolProvider
import ch.fasrv.fanotes.schulnetz.WebPairFailure
import ch.fasrv.fanotes.schulnetz.webPairFailure
import ch.fasrv.fanotes.sync.SYNC_ORIGIN
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The app's requests for Kanti+ im Browser against a fake Kanti+ server: method, path, identity
 * headers and bodies, and how answers and failures are read.
 */
class WebPairingClientTest {
    private data class Sent(val method: String, val path: String, val query: String?, val headers: Map<String, String>, val body: String)

    private val sent = mutableListOf<Sent>()
    private var answer: (Sent) -> Pair<Int, String> = { 200 to "{}" }
    private val guest = SchoolAuth("0123456789abcdef0123456789abcdef", "t".repeat(43), guest = true)

    private fun client(): SchulnetzClient {
        val fake = Interceptor { chain ->
            val request = chain.request()
            val body = request.body?.let { Buffer().also(it::writeTo).readUtf8() }.orEmpty()
            val row = Sent(request.method, request.url.encodedPath, request.url.query, request.headers.toMap(), body)
            sent += row
            val (code, text) = answer(row)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }
        return SchulnetzClient(OkHttpClient.Builder().addInterceptor(fake).build()).apply { onMainThread = { false } }
    }

    @Before fun language() { AppLanguage.choose("en") }

    @Test fun pairingAsksWithTheConnectionsOwnIdentity() {
        answer = { 200 to """{"browser":"Firefox · Linux","expiresAt":"2026-11-10T12:10:00Z","added":0}""" }
        val info = client().webPairInfo(guest, "7K3QM9XR")
        assertEquals("Firefox · Linux", info.browser)
        val ask = sent.single()
        assertEquals("GET", ask.method)
        assertEquals("$SCHULNETZ_API_PATH/web-pair", ask.path)
        assertEquals("code=7K3Q-M9XR", ask.query)
        assertEquals(guest.accountId, ask.headers["X-Kanti-Guest"])
        assertEquals("Bearer ${guest.token}", ask.headers["Authorization"])
        assertTrue(SYNC_ORIGIN.startsWith("https://"))

        sent.clear()
        client().webPair(guest, "7K3QM9XR", "aabbccddeeff", "AKSA", SchoolProvider.SCHULNETZ, finish = true, unrevealed = setOf("g1"))
        val join = sent.single()
        assertEquals("POST", join.method)
        assertEquals("$SCHULNETZ_API_PATH/web-pair", join.path)
        val body = parseJson(join.body) as JsonValue.Obj
        assertEquals(true, body.bool("finish"))
        assertEquals("aabbccddeeff", body.string("connectionId"))
    }

    @Test fun failuresKeepTheServerStatus() {
        for ((status, failure) in listOf(404 to WebPairFailure.UNKNOWN_CODE, 409 to WebPairFailure.ALREADY_FINISHED, 429 to WebPairFailure.TOO_MANY_TRIES)) {
            answer = { status to """{"error":"x"}""" }
            try {
                client().webPair(guest, "7K3QM9XR", "a", "b", SchoolProvider.SCHULNETZ, finish = true, unrevealed = emptyList())
                fail("expected $status")
            } catch (error: SchulnetzHttpException) {
                assertEquals(failure, webPairFailure(error.status))
            }
        }
        // A server without the ledger answers 404: no ledger, no failure.
        answer = { 404 to """{"error":"x"}""" }
        assertNull(client().reveals(guest))
    }

    @Test fun aTamDeviceLinkAndTheSharedSettingsAreRead() {
        answer = { 200 to """{"linked":true,"mode":"device","baseUrl":"https://intranet.tam.ch/bmz","settingsUpdatedAt":"2026-11-10T11:00:00Z","webSessions":2,"settings":{"guessGrades":true}}""" }
        val state = client().linkDevice(guest, "https://intranet.tam.ch/bmz", "0123456789abcdef01234567", "TAM BMZ")
        assertEquals("device", state.mode)
        assertEquals(2, state.webSessions)
        assertEquals("2026-11-10T11:00:00Z", state.settingsUpdatedAt)
        assertTrue(state.settings.guessGrades)
        val link = sent.single()
        assertEquals("PUT", link.method)
        assertEquals("$SCHULNETZ_API_PATH/link", link.path)
        val body = parseJson(link.body) as JsonValue.Obj
        assertEquals("device", body.string("mode"))
        // No school secret of any kind in a device link.
        assertTrue(listOf("ssoCookies", "refreshToken", "accessToken", "password").none { link.body.contains(it) })

        sent.clear()
        assertEquals("2026-11-10T11:00:00Z", client().saveSettings(guest, NotifySettings(guessGrades = true)))
        assertEquals("$SCHULNETZ_API_PATH/settings", sent.single().path)
    }

    @Test fun browsersAreListedAndRemovedOneByOne() {
        answer = { row -> if (row.method == "GET") 200 to """{"sessions":[{"id":"ab12cd34ef56ab78","browser":"Chrome · Windows","createdAt":"2026-11-10T10:00:00Z","lastSeenAt":"2026-11-10T11:00:00Z"}]}""" else 200 to """{"removed":true}""" }
        val browsers = client().webSessions(guest)
        assertEquals(listOf("ab12cd34ef56ab78"), browsers.map { it.id })
        client().revokeWebSession(guest, "ab12cd34ef56ab78")
        assertEquals("DELETE", sent.last().method)
        assertEquals("$SCHULNETZ_API_PATH/web-sessions/ab12cd34ef56ab78", sent.last().path)
        // An id from the answer can never turn into another path.
        try {
            client().revokeWebSession(guest, "../link")
            fail("expected a rejected id")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test fun theRevealLedgerIsMergedOnTheServer() {
        answer = { 200 to """{"hidden":["g1","g4"],"revealed":["g2"]}""" }
        val merged = client().saveReveals(guest, listOf("g4"), listOf("g2"))
        assertEquals(setOf("g1", "g4"), merged?.hidden)
        val body = parseJson(sent.single().body) as JsonValue.Obj
        assertEquals("PUT", sent.single().method)
        assertEquals(listOf("g4"), body.array("hidden")!!.items.map { (it as JsonValue.Str).value })
    }
}
