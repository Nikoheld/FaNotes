package ch.fasrv.fanotes.share

import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ShareApiTest {
    private val id = "0123456789abcdef0123456789abcdef"

    private fun point(x: Double, y: Double) = StrokePoint(x, y, 0.0, 0.5, 0.0, 0.0, "pen")

    private fun document(strokes: List<InkStroke>, height: Double = 1273.0) = InkDocument(
        title = "t", paperStyle = "dots", sourceWidth = 900.0, sourceHeight = height, strokes = strokes, createdAt = "", updatedAt = "",
    )

    private fun stroke(vararg points: Pair<Double, Double>, color: String = "#112233") =
        InkStroke(points.map { point(it.first, it.second) }, 3.0, true, color)

    @Test
    fun idsAndUrlsMatchTheDesktopAndTheServerPattern() {
        assertTrue(isShareId(createShareId()))
        assertEquals(32, createShareId().length)
        assertEquals("https://fanotes.fasrv.ch/share/?id=$id", shareViewUrl(id))
        assertEquals("https://fanotes.fasrv.ch/api/v1/share/$id", shareApiUrl(id))
    }

    @Test
    fun requestsCarryTheShareHeaderAndTheRightMethods() {
        val put = buildShareUpload(id, "{}")
        assertEquals("PUT", put.method)
        assertEquals("1", put.headers["X-FaNotes-Share"])
        assertEquals("application/json", put.headers["Content-Type"])
        assertEquals("DELETE", buildShareRevoke(id).method)
        assertEquals("GET", buildShareFetch(id).method)
        assertEquals("", buildShareFetch(id).body)
    }

    @Test
    fun titleIsTheFirstHeadingOrTheFileName() {
        assertEquals("Zelle", shareNoteTitle("Bio/Zelle.md", "text\n## Zelle \nmore"))
        assertEquals("Bio 1", shareNoteTitle("Ordner/Bio 1.md", "kein Titel"))
    }

    @Test
    fun theUploadBodyHasTheFieldsTheServerSanitizerExpects() {
        val note = shareNoteFrom("Bio/Zelle.md", "# Zelle\nText", null, null)
        val calls = mutableListOf<ShareHttpRequest>()
        val record = publishShare(ShareTransport { calls += it; ShareHttpResponse(200, "{\"ok\":true}") }, id, ShareMode.COPY, "Bio/Zelle.md", listOf(note), "2026-11-18T10:00:00.000Z")
        val body = parseJson(calls.single().body) as JsonValue.Obj
        assertEquals(1.0, body.double("schemaVersion"))
        assertEquals(id, body.string("id"))
        assertEquals("copy", body.string("mode"))
        assertEquals("note", body.string("kind"))
        assertEquals("Bio/Zelle.md", body.string("rootPath"))
        assertEquals("Zelle", body.string("title"))
        assertEquals("2026-11-18T10:00:00.000Z", body.string("updatedAt"))
        val first = body.array("notes")!!.items[0] as JsonValue.Obj
        assertEquals("# Zelle\nText", first.string("content"))
        assertEquals(null, first["ink"])
        assertEquals("https://fanotes.fasrv.ch/share/?id=$id", record.link)
        assertEquals(ShareMode.COPY, record.mode)
    }

    @Test
    fun aFolderShareSendsEveryNoteAndTheFolderTitle() {
        val notes = listOf(shareNoteFrom("Bio/a.md", "# A", null, null), shareNoteFrom("Bio/b.md", "# B", null, null))
        val calls = mutableListOf<String>()
        val record = publishShare(ShareTransport { calls += it.body; ShareHttpResponse(204, "") }, id, ShareMode.LIVE, "Bio", notes, "2026-11-18T10:00:00.000Z")
        val body = parseJson(calls.single()) as JsonValue.Obj
        assertEquals("folder", body.string("kind"))
        assertEquals("Bio", body.string("title"))
        assertEquals("live", body.string("mode"))
        assertEquals(2, body.array("notes")!!.items.size)
        assertEquals("folder", record.kind)
    }

    @Test
    fun inkIsSentAsUnitCoordinatesWithTheTextColumn() {
        val doc = document(listOf(stroke(0.1 to 0.2, 0.3 to 0.4), stroke(0.5 to 0.5, color = "red")))
        val payload = jsonObject(
            "textFields" to jsonArray(
                jsonObject("page" to jsonNumber(1.0), "x" to jsonNumber(0.2), "y" to jsonNumber(0.3), "width" to jsonNumber(0.4), "fontSize" to jsonNumber(18.0), "text" to jsonString("Hallo")),
                jsonObject("text" to jsonString("   ")),
            ),
        )
        val note = shareNoteFrom("a.md", "# A", doc, payload)
        val ink = assertNotNull(note.ink)
        assertEquals(900, ink.width)
        assertEquals(1273, ink.height)
        assertEquals(listOf(0.1 to 0.2, 0.3 to 0.4), ink.strokes[0].points)
        assertEquals("#20222b", ink.strokes[1].color)
        assertEquals(1, note.textFields.size)
        assertEquals(72, note.textColumn!!.padX)
        val json = shareNoteJson(note)
        assertEquals(2, json.obj("ink")!!.array("strokes")!!.items.size)
        assertEquals(78.0, json.obj("textColumn")!!.double("padY"))
    }

    @Test
    fun theSheetGrowsToFitLongTextAndKeepsMarksOnTheSamePixel() {
        val doc = document(listOf(stroke(0.5 to 0.5)), height = 400.0)
        val content = (1..200).joinToString("\n") { "Zeile $it" }
        val ink = assertNotNull(shareNoteFrom("a.md", content, doc, null).ink)
        assertTrue(ink.height > 400)
        val y = ink.strokes[0].points[0].second
        assertEquals(0.5 * 400.0 / ink.height, y, 0.0002)
    }

    @Test
    fun collapsedBandsAreNotSentAsBands() {
        val extras = JsonValue.Obj()
        extras.put(
            "sections",
            jsonArray(
                jsonObject("id" to jsonString("s1"), "top" to jsonNumber(0.1), "bodyTop" to jsonNumber(0.15)),
                jsonObject(
                    "id" to jsonString("s2"), "top" to jsonNumber(0.5), "bodyTop" to jsonNumber(0.55),
                    "collapsed" to JsonValue.Bool(true),
                    "hidden" to jsonObject("widthPx" to jsonNumber(900.0), "heightPx" to jsonNumber(100.0), "strokes" to jsonArray()),
                ),
            ),
        )
        val doc = document(listOf(stroke(0.1 to 0.1))).copy(extras = extras)
        val ink = assertNotNull(shareNoteFrom("a.md", "x", doc, null).ink)
        assertEquals(listOf("s1"), ink.sections.map { it.id })
    }

    @Test
    fun refusalsHappenBeforeTheNetworkAndServerErrorsAreShown() {
        val huge = ShareNote("a.md", "A", "x".repeat(SHARE_MAX_NOTE_CHARS + 1))
        var called = false
        val transport = ShareTransport { called = true; ShareHttpResponse(200, "") }
        assertFailsWith<ShareException> { publishShare(transport, id, ShareMode.COPY, "a.md", listOf(huge), "now") }
        assertFailsWith<ShareException> { publishShare(transport, id, ShareMode.COPY, "a.md", emptyList(), "now") }
        assertTrue(!called)
        val refused = assertFailsWith<ShareException> {
            publishShare(ShareTransport { ShareHttpResponse(410, "{\"error\":\"Diese Freigabe wurde beendet.\"}") }, id, ShareMode.COPY, "a.md", listOf(ShareNote("a.md", "A", "x")), "now")
        }
        assertEquals("Diese Freigabe wurde beendet.", refused.message)
        assertEquals(410, refused.status)
        assertEquals("Zu viele Anfragen. Bitte später erneut versuchen.", shareErrorMessage(429, "{\"error\":\"Zu viele Anfragen. Bitte später erneut versuchen.\"}"))
        assertEquals("Die Freigabe ist zu gross.", shareErrorMessage(413, ""))
    }

    @Test
    fun stopAndStatusUseTheDeleteAndGetRoutes() {
        val seen = mutableListOf<String>()
        stopShare(ShareTransport { seen += it.method; ShareHttpResponse(200, "{\"ok\":true}") }, id)
        assertEquals(listOf("DELETE"), seen)
        assertFailsWith<ShareException> { stopShare(ShareTransport { ShareHttpResponse(500, "") }, id) }
        assertEquals(false, shareStillActive(ShareTransport { ShareHttpResponse(410, "{\"stopped\":true}") }, id))
        assertEquals(true, shareStillActive(ShareTransport { ShareHttpResponse(200, "{}") }, id))
        assertEquals(null, shareStillActive(ShareTransport { ShareHttpResponse(500, "") }, id))
    }

    @Test
    fun theDirectoryRoundTripsAndLiveLinksAreFoundForASavedNote() {
        val a = ShareLinkRecord(id, shareViewUrl(id), "Zelle", "Bio/Zelle.md", ShareMode.LIVE, "note", "2026-11-18T10:00:00.000Z")
        val other = "ffffffffffffffffffffffffffffffff"
        val b = ShareLinkRecord(other, shareViewUrl(other), "Bio", "Bio", ShareMode.LIVE, "folder", "2026-11-18T10:00:00.000Z")
        val c = a.copy(id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", mode = ShareMode.COPY)
        val directory = rememberShare(rememberShare(listOf(c), b), a)
        val loaded = parseShareDirectory(serializeShareDirectory(directory))
        assertEquals(directory, loaded)
        assertEquals(setOf(id, other), liveSharesFor(loaded, "Bio/Zelle.md").map { it.id }.toSet())
        assertEquals(listOf(other), liveSharesFor(loaded, "Bio/Andere.md").map { it.id })
        assertTrue(liveSharesFor(markShareStopped(loaded, id), "Bio/Zelle.md").none { it.id == id })
        assertTrue(parseShareDirectory("garbage").isEmpty())
        assertEquals(1, rememberShare(listOf(a), a.copy(title = "neu")).size)
    }
}
