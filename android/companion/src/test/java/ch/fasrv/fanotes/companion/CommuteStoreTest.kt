package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.commute.*
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_API_PATH
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** The app's Pendelstrecken requests and the files behind them, against a fake Kanti+ server. */
class CommuteStoreTest {
    private data class Sent(val method: String, val path: String, val query: String?, val headers: Map<String, String>, val body: String)

    private val sent = mutableListOf<Sent>()
    private var routesBody = commuteBody(listOf(CommuteSamples.route()), CommuteSettings(5, listOf("informatik 1.2")))
    private var boardBody = ""
    private var failBoard = false
    private var tripBody = """{"trip":{"id":"t1","legs":[{"kind":"ride","line":"S29","stopCount":1,"stops":[{"name":"Mitte","realtime":true}]}]},"position":{"state":"atStop","legIndex":0,"point":1},"updatedAt":"2026-11-13T07:00:00+01:00","stale":false,"gone":false,"sources":{"realtime":"search.ch","platforms":null,"formation":null}}"""
    /** Treats every thread outside the IO pool as the main thread, like StrictMode does for the real one. */
    private var strictThreads = false
    private val auth = SchoolAuth("0123456789abcdef0123456789abcdef", "t".repeat(43), guest = true)
    private lateinit var dir: File
    private var account = ""
    private var now = 1_000_000L
    private var boardsShown = 0

    @Before fun setUp() {
        AppLanguage.choose("en")
        dir = Files.createTempDirectory("commute").toFile()
        val board = CommuteSamples.fixtureFiles(java.time.ZonedDateTime.now(), 20).second
        boardBody = board
    }

    @After fun tearDown() { dir.deleteRecursively() }

    private fun client(): SchulnetzClient {
        val fake = Interceptor { chain ->
            val request = chain.request()
            val body = request.body?.let { Buffer().also(it::writeTo).readUtf8() }.orEmpty()
            val row = Sent(request.method, request.url.encodedPath, request.url.encodedQuery, request.headers.toMap(), body)
            sent += row
            val (code, text) = when {
                row.path.endsWith("/commute/board") -> if (failBoard) 502 to "{}" else 200 to boardBody
                row.path.endsWith("/commute/stops") -> 200 to """{"stops":[{"id":"9000001","name":"Testdorf, Dorfplatz","type":"bus"}]}"""
                row.path.endsWith("/commute/trip") -> 200 to tripBody
                row.path.endsWith("/commute/trips") -> 200 to """{"trips":[{"id":"t1","departure":"2026-11-13T07:35:00+01:00"}]}"""
                row.path.endsWith("/commute") && row.method == "PUT" -> { routesBody = row.body; 200 to row.body }
                row.path.endsWith("/commute") -> 200 to routesBody
                else -> 404 to "{}"
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }
        return SchulnetzClient(OkHttpClient.Builder().addInterceptor(fake).build()).apply { onMainThread = { strictThreads && !Thread.currentThread().name.startsWith("DefaultDispatcher") } }
    }

    private fun store(accountId: String = auth.accountId) = CommuteStore(
        dir, client(), { auth.copy(accountId = accountId) }, { account }, { account = it.orEmpty() }, { boardsShown++ }, { now },
    )

    private val api = "$SCHULNETZ_API_PATH/commute"

    @Test fun firstRefreshReadsRoutesThenTheBoardAndKeepsBothOnDisk() = runBlocking {
        val store = store()
        assertTrue(store.refresh())
        assertEquals(listOf("GET $api", "GET $api/board"), sent.map { "${it.method} ${it.path}" })
        assertEquals(auth.accountId, sent[0].headers["X-Kanti-Guest"])
        assertEquals("Bearer ${auth.token}", sent[0].headers["Authorization"])
        val ui = store.state.value
        assertTrue(ui.loaded)
        assertEquals(1, ui.routes.size)
        assertEquals(5, ui.settings.delayThreshold)
        assertEquals(1, ui.boards.size)
        assertEquals(now, ui.boardAt)
        assertEquals(1, boardsShown)
        // A fresh start reads the same from disk without a request.
        val cached = CommuteStore.readCache(dir)
        assertEquals(ui.routes, cached.routes)
        assertEquals(ui.boards.map { it.routeId }, cached.boards.map { it.routeId })
        assertTrue(cached.boardAt > 0)
    }

    @Test fun boardsYoungerThanThirtySecondsAreNotFetchedAgain() = runBlocking {
        val store = store()
        store.refresh()
        sent.clear()
        now += 20_000
        assertTrue(store.refresh())
        assertTrue(sent.isEmpty())
        now += 11_000
        assertTrue(store.refresh())
        assertEquals(listOf("GET $api/board"), sent.map { "${it.method} ${it.path}" })
        sent.clear()
        assertTrue(store.refresh(force = true))
        assertEquals(1, sent.size)
        sent.clear()
        assertTrue(store.refresh(withRoutes = true))
        assertEquals(listOf("GET $api", "GET $api/board"), sent.map { "${it.method} ${it.path}" })
    }

    @Test fun aFailedBoardKeepsTheOlderOneAndMarksItFailed() = runBlocking {
        val store = store()
        store.refresh()
        failBoard = true
        now += 60_000
        assertFalse(store.refresh())
        val ui = store.state.value
        assertTrue(ui.failed)
        assertEquals(1, ui.boards.size)
        assertEquals(now - 60_000, ui.boardAt)
        assertFalse(ui.refreshing)
        failBoard = false
        assertTrue(store.refresh(force = true))
        assertFalse(store.state.value.failed)
    }

    @Test fun savingSendsTheWholeListWithTheKeptSettings() = runBlocking {
        val store = store()
        store.refresh()
        sent.clear()
        val added = CommuteSamples.route("bbbbbbbbbbbb", "Heimweg", ScheduleMode.LAST_LESSON)
        val result = store.save(store.state.value.routes + added, delayThreshold = 10)
        assertTrue(result.isSuccess)
        val put = sent.first { it.method == "PUT" }
        assertEquals(api, put.path)
        val sentState = parseCommuteState(put.body)!!
        assertEquals(listOf("a1b2c3d4e5f6", "bbbbbbbbbbbb"), sentState.routes.map { it.id })
        assertEquals(10, sentState.settings.delayThreshold)
        assertEquals(listOf("informatik 1.2"), sentState.settings.hiddenLabels)
        // The board is asked for again afterwards.
        assertEquals("GET $api/board", sent.last().let { "${it.method} ${it.path}" })
        assertEquals(2, store.state.value.routes.size)
    }

    @Test fun hiddenLabelsAreSentOnlyWhenTheyChangeAndRoutesExist() = runBlocking {
        val store = store()
        store.refresh()
        sent.clear()
        assertFalse(store.syncHiddenLabels(listOf("informatik 1.2")))
        assertTrue(sent.isEmpty())
        assertTrue(store.syncHiddenLabels(listOf("informatik 1.2", "zeichnen")))
        assertEquals(listOf("informatik 1.2", "zeichnen"), parseCommuteState(sent.first { it.method == "PUT" }.body)!!.settings.hiddenLabels)
        assertEquals(5, parseCommuteState(sent.first { it.method == "PUT" }.body)!!.settings.delayThreshold)
        // Without routes nothing is sent at all.
        routesBody = commuteBody(emptyList(), CommuteSettings())
        val empty = store()
        empty.refresh(withRoutes = true)
        sent.clear()
        assertFalse(empty.syncHiddenLabels(listOf("x")))
        assertTrue(sent.isEmpty())
    }

    @Test fun routesAreSentBackWhenTheIdentityChangedAndTheServerHasNone() = runBlocking {
        val first = store()
        first.refresh()
        assertEquals(auth.accountId, account)
        // The guest became a FaNotes account: the server's new identity knows nothing yet.
        val local = routesBody
        routesBody = commuteBody(emptyList(), CommuteSettings())
        sent.clear()
        val second = CommuteStore(dir, client(), { auth.copy(accountId = "fedcba9876543210fedcba9876543210") }, { account }, { account = it.orEmpty() }, {}, { now })
        // Fresh process: nothing in memory, the files are all there is.
        second.refresh(force = true, withRoutes = true)
        assertEquals(1, sent.count { it.method == "PUT" })
        assertEquals(parseCommuteState(local)!!.routes, parseCommuteState(routesBody)!!.routes)
        assertEquals("fedcba9876543210fedcba9876543210", account)
    }

    @Test fun anEmptyServerListDoesNotResurrectRoutesForTheSameIdentity() = runBlocking {
        store().refresh()
        routesBody = commuteBody(emptyList(), CommuteSettings())
        sent.clear()
        val again = store()
        again.refresh(force = true, withRoutes = true)
        assertTrue(sent.none { it.method == "PUT" })
        assertTrue(again.state.value.routes.isEmpty())
    }

    @Test fun stopSearchAndTripsUseTheirEndpoints() = runBlocking {
        val store = store()
        val stops = store.searchStops("Testdorf, Dorf")
        assertEquals("Testdorf, Dorfplatz", stops.single().name)
        assertEquals("q=Testdorf%2C%20Dorf", sent.last().query)
        val trips = store.trips("a1b2c3d4e5f6", "2026-11-13T07:35:00+01:00", arrive = false)
        assertEquals("t1", trips.single().id)
        assertEquals("route=a1b2c3d4e5f6&at=2026-11-13T07%3A35%3A00%2B01%3A00&timeType=depart", sent.last().query)
        store.trips("a1b2c3d4e5f6", "2026-11-13T07:35:00+01:00", arrive = true)
        assertTrue(sent.last().query!!.endsWith("timeType=arrive"))
    }

    @Test fun clearingForgetsTheFilesAndTheIdentity() = runBlocking {
        val store = store()
        store.refresh()
        store.clearLocal()
        assertFalse(store.state.value.loaded)
        assertFalse(CommuteStore.readCache(dir).loaded)
        assertEquals("", account)
    }

    @Test fun tripDetailAsksTheTripEndpointOnTheIoDispatcher() = runBlocking {
        strictThreads = true
        val detail = store().tripDetail("a1b2c3d4e5f6", "S29|07:05", "2026-11-13T07:05:00+01:00")
        val call = sent.single()
        assertEquals("GET", call.method)
        assertEquals("$api/trip", call.path)
        assertEquals("route=a1b2c3d4e5f6&trip=S29%7C07%3A05&at=2026-11-13T07%3A05%3A00%2B01%3A00", call.query)
        assertEquals("Bearer ${auth.token}", call.headers["Authorization"])
        assertEquals(PositionState.AT_STOP, detail.position?.state)
        assertEquals("Mitte", detail.trip?.legs?.single()?.stops?.single()?.name)
    }

    @Test fun tripDetailFailsLoudlyOnAnUnreadableAnswer() {
        tripBody = "not json"
        val failed = runCatching { runBlocking { store().tripDetail("a1b2c3d4e5f6", "t", "2026-11-13T07:05:00+01:00") } }
        assertTrue(failed.isFailure)
    }
}
