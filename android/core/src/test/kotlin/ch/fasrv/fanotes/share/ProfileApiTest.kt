package ch.fasrv.fanotes.share

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProfileApiTest {
    private val owner = "0123456789abcdef0123456789abcdef"
    private val utc = ZoneId.of("UTC")

    @Test
    fun usernamesFollowTheServerRules() {
        assertEquals("anna-lee", normalizeUsername("  Anna-Lee "))
        assertNull(normalizeUsername("ab"))
        assertNull(normalizeUsername("admin"))
        assertNull(normalizeUsername("a__b"))
        assertNull(normalizeUsername("-abc"))
        assertNull(normalizeUsername("abc!"))
        assertNull(usernameProblem("anna"))
        assertEquals("Zuerst einen Benutzernamen festlegen.", usernameProblem(" "))
        assertTrue(usernameProblem("a")!!.startsWith("Erlaubt"))
        assertEquals("https://fanotes.fasrv.ch/user/anna", profileViewUrl("anna"))
        assertTrue(isProfileOwnerId(createProfileOwnerId()))
    }

    @Test
    fun claimSendsTheDesktopBodyAndChecksTheAnswer() {
        var request: ShareHttpRequest? = null
        val claim = claimUsername(
            ShareTransport {
                request = it
                ShareHttpResponse(200, "{\"ok\":true,\"username\":\"anna\",\"path\":\"/user/anna\",\"link\":\"x\",\"joinedAt\":\"2026-01-01T00:00:00.000Z\",\"public\":false}")
            },
            "Anna", owner, "2026-01-01T00:00:00.000Z",
        )
        assertEquals("PUT", request!!.method)
        assertEquals("https://fanotes.fasrv.ch/api/v1/profile", request!!.url)
        val body = parseJson(request!!.body) as JsonValue.Obj
        assertEquals("claim", body.string("action"))
        assertEquals("anna", body.string("username"))
        assertEquals(owner, body.string("ownerId"))
        assertEquals("anna", claim.username)
        assertEquals("https://fanotes.fasrv.ch/user/anna", claim.link)
        assertEquals(false, claim.public)
        assertFailsWith<ProfileException> { claimUsername(ShareTransport { ShareHttpResponse(200, "{\"username\":\"other\"}") }, "anna", owner, "2026-01-01T00:00:00.000Z") }
    }

    @Test
    fun aTakenNameIsReportedAsTaken() {
        val error = assertFailsWith<ProfileException> {
            claimUsername(ShareTransport { ShareHttpResponse(409, "{\"error\":\"Dieser Benutzername ist vergeben.\",\"taken\":true}") }, "anna", owner, "2026-01-01T00:00:00.000Z")
        }
        assertTrue(error.taken)
        assertEquals("Dieser Benutzername ist schon vergeben.", error.message)
        assertFailsWith<ProfileException> { claimUsername(ShareTransport { error("no request") }, "admin", owner, "2026-01-01T00:00:00.000Z") }
        assertFailsWith<ProfileException> { claimUsername(ShareTransport { error("no request") }, "anna", "short", "2026-01-01T00:00:00.000Z") }
    }

    @Test
    fun activityCountsDaysFromStatsAndStampsWithoutNoteText() {
        val notes = listOf(
            ProfileNoteSource(createdAt = "2026-03-01T22:30:00.000Z", modifiedAt = "2026-03-02T08:00:00.000Z", dwellMs = 60_000, activeDays = listOf("2026-03-01", "2026-03-05")),
            ProfileNoteSource(firstOpenedAt = "2026-03-05T10:00:00.000Z", dwellMs = 30_000, historyAt = listOf("2026-03-07T10:00:00.000Z", "bad")),
            ProfileNoteSource(),
        )
        val activity = summarizeProfileActivity(notes, "2026-03-01T22:30:00.000Z", utc)
        assertEquals(3, activity.noteCount)
        assertEquals(90_000, activity.dwellMs)
        assertEquals(listOf("2026-03-01", "2026-03-02", "2026-03-05", "2026-03-07"), activity.activeDays)
        assertEquals(2, activity.dayCounts["2026-03-05"])
        assertEquals(1, activity.dayCounts["2026-03-07"])
        assertEquals("2026-03-01T00:00:00Z", earliestProfileJoinedAt(notes))
        assertNull(earliestProfileJoinedAt(listOf(ProfileNoteSource())))
    }

    @Test
    fun localDaysFollowTheDeviceZone() {
        assertEquals("2026-03-02", profileLocalDay("2026-03-01T23:30:00.000Z", ZoneId.of("Europe/Zurich")))
        assertEquals("2026-03-01", profileLocalDay("2026-03-01T23:30:00.000Z", utc))
        assertEquals("2026-03-01", profileLocalDay("2026-03-01", ZoneId.of("Pacific/Auckland")))
        assertNull(profileLocalDay("1999-01-01", utc))
        assertNull(profileLocalDay("", utc))
    }

    @Test
    fun tooManyDaysAreSampledKeepingTheEnds() {
        val days = (0 until 3000).map { java.time.LocalDate.of(2020, 1, 1).plusDays(it.toLong()).toString() }
        val capped = capProfileDays(days)
        assertEquals(PROFILE_MAX_DAYS, capped.size)
        assertEquals(days.first(), capped.first())
        assertEquals(days.last(), capped.last())
        assertEquals(capped.sorted(), capped)
    }

    @Test
    fun publishSendsOnlyNumbersAndTheThemeTheServerStores() {
        var request: ShareHttpRequest? = null
        val overview = publishProfile(
            ShareTransport {
                request = it
                ShareHttpResponse(200, "{\"public\":true,\"username\":\"anna\",\"link\":\"https://fanotes.fasrv.ch/user/anna\",\"joinedAt\":\"2026-03-01T00:00:00.000Z\",\"noteCount\":2,\"dwellMs\":5000,\"durationLabel\":\"5 s\",\"activeDays\":[\"2026-03-01\"]}")
            },
            "anna", owner,
            listOf(ProfileNoteSource(createdAt = "2026-03-01T10:00:00.000Z", dwellMs = 5000), ProfileNoteSource(activeDays = listOf("2026-03-01"))),
            theme = "snow", accent = "#AABBCC", accentSecondary = "nope", zone = utc,
        )
        val body = parseJson(request!!.body) as JsonValue.Obj
        assertEquals("publish", body.string("action"))
        assertEquals(2.0, body.double("noteCount"))
        assertEquals(5000.0, body.double("dwellMs"))
        assertEquals("#aabbcc", body.string("accent"))
        assertNull(body["theme"])
        assertNull(body["accentSecondary"])
        assertEquals(2.0, body.obj("dayCounts")!!.double("2026-03-01"))
        assertTrue(!request!!.body.contains("title") && !request!!.body.contains("content"))
        assertEquals(2, overview.noteCount)
        assertEquals("5 s", overview.durationLabel)
        assertEquals(listOf("2026-03-01"), overview.activeDays)
    }

    @Test
    fun unpublishAndFetchUseTheDocumentedRoutes() {
        val seen = mutableListOf<ShareHttpRequest>()
        unpublishProfile(ShareTransport { seen += it; ShareHttpResponse(200, "{\"ok\":true}") }, "anna", owner)
        assertEquals("unpublish", (parseJson(seen[0].body) as JsonValue.Obj).string("action"))
        assertNull(fetchPublicProfile(ShareTransport { seen += it; ShareHttpResponse(404, "{\"public\":false}") }, "anna"))
        assertEquals("https://fanotes.fasrv.ch/api/v1/profile/anna", seen[1].url)
        assertEquals("GET", seen[1].method)
        assertNull(fetchPublicProfile(ShareTransport { error("no request") }, "admin"))
        assertFailsWith<ProfileException> { fetchPublicProfile(ShareTransport { ShareHttpResponse(500, "") }, "anna") }
    }
}
