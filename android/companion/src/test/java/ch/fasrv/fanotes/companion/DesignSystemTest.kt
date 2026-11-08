package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.AgendaEvent
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class DesignSystemTest {
    private val accents = listOf("#2a6f97", "#7f6df2", "#3d8bfd", "#2f9e6b", "#e15b64", "#ffff00", "#000000", "#ffffff", "not-a-colour")

    private fun hex(color: Int) = "#%06X".format(color and 0xFFFFFF)

    @Test fun everyThemeAccentAndBlackModeMeetsContrast() {
        for (theme in KANTI_THEME_IDS + listOf("unknown", "")) for (dark in listOf(false, true)) for (accent in accents) for (amoled in listOf(false, true)) {
            val p = kantiPalette(theme, dark, accent, amoled)
            val where = "$theme dark=$dark accent=$accent amoled=$amoled"
            for (bg in listOf(p.background, p.surface, p.raised, p.sunken)) {
                assertTrue("text on ${hex(bg)} $where", contrastRatio(p.text, bg) >= 7.0)
                assertTrue("muted on ${hex(bg)} $where", contrastRatio(p.muted, bg) >= 4.5)
            }
            for (bg in listOf(p.background, p.surface, p.raised, p.accentSoft)) {
                assertTrue("accent ${hex(p.accent)} on ${hex(bg)} $where", contrastRatio(p.accent, bg) >= 4.5)
                assertTrue("text on accent container $where", contrastRatio(p.text, p.accentSoft) >= 4.5)
            }
            assertTrue("on-accent $where", contrastRatio(p.onAccent, p.accent) >= 4.5)
            assertTrue("on-danger $where", contrastRatio(p.onDanger, p.danger) >= 4.5)
            for ((tone, soft) in listOf(p.success to p.successSoft, p.warning to p.warningSoft, p.danger to p.dangerSoft)) {
                for (bg in listOf(p.background, p.surface, soft)) assertTrue("tone ${hex(tone)} on ${hex(bg)} $where", contrastRatio(tone, bg) >= 4.5)
            }
            assertTrue("outline $where", contrastRatio(p.outline, p.surface) >= 3.0)
        }
    }

    @Test fun storedThemeIdsResolveToThemselvesSoNoSelectionIsMigratedAway() {
        for (id in listOf("light", "dark", "midnight", "forest", "aurora", "sepia", SNOW_THEME_ID)) {
            assertEquals(id, kantiPalette(id, systemDark = false).id)
            assertEquals(id, kantiPalette(id, systemDark = true).id)
        }
        assertEquals("light", kantiPalette("system", systemDark = false).id)
        assertEquals("dark", kantiPalette("system", systemDark = true).id)
        assertEquals("dark", kantiPalette("winter-2031", systemDark = true).id)
        assertEquals("light", kantiPalette(null, systemDark = false).id)
    }

    @Test fun snowIsALightIcyThemeWithItsOwnRestrainedBlue() {
        val ocean = kantiPalette(SNOW_THEME_ID, systemDark = true, accentHex = "#e15b64")
        val violet = kantiPalette(SNOW_THEME_ID, systemDark = false, accentHex = "#7f6df2")
        assertFalse("Snow stays light in system dark mode", ocean.dark)
        assertTrue(ocean.fixedAccent)
        assertEquals("Snow ignores the user accent", ocean.accent, violet.accent)
        val r = (ocean.accent shr 16) and 0xFF; val g = (ocean.accent shr 8) and 0xFF; val b = ocean.accent and 0xFF
        assertTrue("accent is blue", b > r && b > g)
        val bg = ocean.background
        assertTrue("icy background is near white with a blue tint", relativeLuminance(bg) > 0.88 && (bg and 0xFF) >= ((bg shr 16) and 0xFF))
        assertFalse("other themes keep the user accent", kantiPalette("light", false, "#e15b64").fixedAccent)
    }

    @Test fun amoledOnlyBlackensDarkThemes() {
        assertEquals(0xFF000000.toInt(), kantiPalette("midnight", true, amoled = true).background)
        assertEquals(kantiPalette("light", false).background, kantiPalette("light", false, amoled = true).background)
        assertEquals(kantiPalette(SNOW_THEME_ID, false).background, kantiPalette(SNOW_THEME_ID, false, amoled = true).background)
    }

    @Test fun hexParsingRejectsGarbage() {
        assertEquals(0xFF2A6F97.toInt(), parseHexColor("#2a6f97"))
        assertNull(parseHexColor("#2a6f9"))
        assertNull(parseHexColor("blue"))
        assertNull(parseHexColor(null))
    }

    @Test fun onboardingOnlyGreetsATrueFirstRun() {
        assertTrue(needsOnboarding(storedVersion = 0, localAccess = false, hasAccount = false))
        assertFalse("existing local user is not interrupted", needsOnboarding(0, localAccess = true, hasAccount = false))
        assertFalse("existing account is not asked to log in again", needsOnboarding(0, localAccess = false, hasAccount = true))
        assertFalse("completion survives restarts and updates", needsOnboarding(ONBOARDING_VERSION, localAccess = false, hasAccount = false))
    }

    private fun lesson(day: LocalDate) = AgendaEntry("school:x", "Physics", AgendaKind.Lesson, day, "08:15", "09:00")

    @Test fun missingTimetableIsNeverShownAsAFreeDay() {
        assertEquals(TodayLead.Next, todayLead(lesson(LocalDate.of(2026, 11, 9)), schoolKnown = true, unreadAhead = true))
        assertEquals(TodayLead.Unread, todayLead(null, schoolKnown = true, unreadAhead = true))
        assertEquals(TodayLead.Unread, todayLead(null, schoolKnown = false, unreadAhead = true))
        assertEquals(TodayLead.Connect, todayLead(null, schoolKnown = false, unreadAhead = false))
        assertEquals(TodayLead.Clear, todayLead(null, schoolKnown = true, unreadAhead = false))
    }

    @Test fun unreadDaysBeforeTheNextCommitmentAreFound() {
        val monday = LocalDate.of(2026, 11, 9)
        val read = SchulnetzSnapshot(fetchedAt = "2026-11-08T18:00:00Z", weekRead = mapOf("2026-11-09" to "2026-11-08T18:00:00Z"), weekSpanStart = "2026-11-09", weekSpanEnd = "2026-11-22")
        assertFalse(unreadSchoolDayBefore(read, monday, monday.plusDays(4), monday))
        assertTrue("next week was never read", unreadSchoolDayBefore(read, monday, monday.plusDays(9), monday))
        val never = SchulnetzSnapshot()
        assertFalse("an unconnected device has nothing unread", unreadSchoolDayBefore(never, monday, monday.plusDays(9), monday))
        val lessonsOnly = SchulnetzSnapshot(fetchedAt = "2026-11-08T18:00:00Z", events = listOf(AgendaEvent(id = "a", start = "2026-11-10T08:15:00+01:00", end = "2026-11-10T09:00:00+01:00", text = "Physics", comment = "", room = "B12", teachers = emptyList(), courseId = "physics", courseName = "Physics", status = "", eventType = "lesson", color = "", timetableText = "")))
        assertFalse(unreadSchoolDayBefore(lessonsOnly, monday, monday.plusDays(4), monday))
    }

    @Test fun railPositionsFollowTheList() {
        assertEquals(RailPosition.Single, railPosition(0, 1))
        assertEquals(RailPosition.First, railPosition(0, 3))
        assertEquals(RailPosition.Middle, railPosition(1, 3))
        assertEquals(RailPosition.Last, railPosition(2, 3))
    }

    @Test fun snowflakesStayInsideTheCard() {
        for (seconds in listOf(0f, 1f, 7.5f, SNOWFALL_SECONDS)) for (y in listOf(0f, 0.5f, 0.99f)) {
            val (x, fy) = flakePosition(0.5f, y, 0.12f, 0.035f, 1f, seconds)
            assertTrue(x in 0.45f..0.55f)
            assertTrue(fy in -0.1f..1.05f)
        }
    }
}
