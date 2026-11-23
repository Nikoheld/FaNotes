package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Synthetic names only. */
class TeacherAbsencesTest {
    private fun page(card: String) = """<html><body><a href="index.php?pageid=1">Start</a>$card</body></html>"""
    private fun card(inner: String) =
        """<div class="mdl-card cls-card mdl-card--information " id="x1"><div class="mdl-card__supporting-text">$inner</div></div><div>Danach<p>Fremd</p></div>"""

    @Test
    fun bothSections() {
        val html = page(card("<p>---Abwesende Lehrpersonen:</p><p>Muster</p><p><br>---Lehrpersonen auf Exkursion:<br>Beispiel Ann (7.30 - 12.45 Uhr)</p>"))
        assertEquals(TeacherAbsences(listOf("Muster"), listOf("Beispiel Ann (7.30 - 12.45 Uhr)")), parseTeacherAbsences(html))
    }

    @Test
    fun onlyOneSection() {
        assertEquals(TeacherAbsences(listOf("Muster"), emptyList()), parseTeacherAbsences(page(card("<p>---Abwesende Lehrpersonen:</p><p>Muster</p>"))))
        assertEquals(TeacherAbsences(emptyList(), listOf("Beispiel")), parseTeacherAbsences(page(card("<p>---Lehrpersonen auf Exkursion:<br>Beispiel</p>"))))
    }

    @Test
    fun severalNamesSplitOnBrAndParagraphsNeverOnCommas() {
        val html = page(card("<p>---Abwesende Lehrpersonen:<br>Muster, Hans<br>Probe</p><p>Beispiel</p><p>---Lehrpersonen auf Exkursion:</p><p>Eins</p><p>Zwei</p>"))
        assertEquals(TeacherAbsences(listOf("Muster, Hans", "Probe", "Beispiel"), listOf("Eins", "Zwei")), parseTeacherAbsences(html))
    }

    @Test
    fun nbspEntitiesCaseAndMissingDashes() {
        val html = page(card("<p>ABWESENDE&nbsp;LEHRPERSONEN :</p><p>M&uuml;ller&nbsp;Test</p><p>Lehrpersonen&nbsp;auf Exkursion</p><p>&nbsp;</p><p>Beispiel &amp; Co</p>"))
        assertEquals(TeacherAbsences(listOf("Müller Test"), listOf("Beispiel & Co")), parseTeacherAbsences(html))
    }

    @Test
    fun noCardIsEmptyAndBlankOrLoginWallIsNull() {
        assertEquals(TeacherAbsences(), parseTeacherAbsences(page("<p>Nichts</p>")))
        assertNull(parseTeacherAbsences(""))
        assertNull(parseTeacherAbsences("  "))
        assertNull(parseTeacherAbsences("<html><body><form><input type=\"password\"></form></body></html>"))
        assertNull(parseTeacherAbsences("<html>ConvergedSignIn pageid=1</html>"))
    }

    @Test
    fun capsEntriesAndLength() {
        val names = (0 until 60).joinToString("") { "<br>Name$it" }
        assertEquals(40, parseTeacherAbsences(page(card("<p>---Abwesende Lehrpersonen:$names</p>")))!!.absent.size)
        assertEquals(120, parseTeacherAbsences(page(card("<p>---Abwesende Lehrpersonen:<br>${"x".repeat(300)}</p>")))!!.absent.single().length)
    }

    @Test
    fun fixtureStartPageHasTheCardAndStaysAStartPage() {
        val html = checkNotNull(javaClass.getResource("/schulnetz/start.html")).readText()
        assertEquals(TeacherAbsences(listOf("Muster"), listOf("Beispiel Ann (7.30 - 12.45 Uhr)")), parseTeacherAbsences(html))
        assertTrue(parseStartRecentGrades(html).size >= 3)
    }

    @Test
    fun readStampUsesTheZurichDay() {
        val html = page(card("<p>---Abwesende Lehrpersonen:</p><p>Muster</p>"))
        assertEquals(TeacherAbsenceDay("2026-11-10", listOf("Muster")), teacherAbsenceRead(html, "2026-11-09T23:30:00Z"))
        assertNull(teacherAbsenceRead("", "2026-11-09T10:00:00Z"))
    }

    @Test
    fun snapshotJsonRoundTripsAndOldJsonStillParses() {
        val value = TeacherAbsenceDay("2026-11-09", listOf("Muster, Hans"), listOf("Beispiel"))
        val parsed = assertNotNull(parseNormalizedSnapshot(SchulnetzSnapshot(teacherAbsences = value).toNormalizedJson()))
        assertEquals(value, parsed.teacherAbsences)
        assertNull(parseNormalizedSnapshot(SchulnetzSnapshot().toNormalizedJson())!!.teacherAbsences)
        assertNull(parseNormalizedSnapshot("""{"revision":1,"teacherAbsences":{"day":"bad","absent":["x"]}}""")!!.teacherAbsences)
    }

    @Test
    fun newerDayWinsAndServerAdoptionTakesIt() {
        val old = TeacherAbsenceDay("2026-11-08", listOf("A"))
        val fresh = TeacherAbsenceDay("2026-11-09", listOf("B"))
        assertEquals(fresh, newerTeacherAbsences(old, fresh))
        assertEquals(fresh, newerTeacherAbsences(fresh, old))
        assertEquals(old, newerTeacherAbsences(null, old))
        assertNull(newerTeacherAbsences(null, TeacherAbsenceDay("bad")))
        assertEquals(fresh, adoptServerSnapshot(SchulnetzSnapshot(teacherAbsences = old), SchulnetzSnapshot(teacherAbsences = fresh)).teacherAbsences)
        assertEquals(fresh, adoptServerSnapshot(SchulnetzSnapshot(teacherAbsences = fresh), SchulnetzSnapshot(teacherAbsences = old)).teacherAbsences)
        assertEquals(old, adoptServerSnapshot(SchulnetzSnapshot(teacherAbsences = old), SchulnetzSnapshot()).teacherAbsences)
    }

    @Test
    fun readGuardKeepsThePriorValueWhenTheReadHasNone() {
        val prior = SchulnetzSnapshot(teacherAbsences = TeacherAbsenceDay("2026-11-09", listOf("A")))
        val kept = keepStoredRead(prior, SchulnetzSnapshot(), blocked = false, timetableFailed = false)
        assertEquals(prior.teacherAbsences, kept.teacherAbsences)
        val blocked = keepStoredRead(prior, SchulnetzSnapshot(), blocked = true, timetableFailed = false, okPages = 0)
        assertEquals(prior.teacherAbsences, blocked.teacherAbsences)
        val next = SchulnetzSnapshot(teacherAbsences = TeacherAbsenceDay("2026-11-09", emptyList()))
        assertEquals(next.teacherAbsences, keepStoredRead(prior, next, blocked = false, timetableFailed = false).teacherAbsences)
    }

    @Test
    fun aChangedValueNeverCreatesAChange() {
        val before = SchulnetzSnapshot(revision = 1, teacherAbsences = TeacherAbsenceDay("2026-11-08", listOf("A")))
        val after = SchulnetzSnapshot(revision = 2, teacherAbsences = TeacherAbsenceDay("2026-11-09", listOf("B", "C"), listOf("D")))
        val today = java.time.LocalDate.of(2026, 11, 9)
        assertTrue(diffSnapshots(before, after, today = today).isEmpty())
        assertTrue(diffSnapshots(SchulnetzSnapshot(revision = 1), after, today = today).isEmpty())
    }

    @Test
    fun deskSettingDefaultsOffAndRoundTrips() {
        assertFalse(DeskPrefs().showTeacherAbsences)
        assertTrue(parseDeskPrefs(serializeDeskPrefs(DeskPrefs(showTeacherAbsences = true))).showTeacherAbsences)
        assertFalse(parseDeskPrefs("{\"theme\":\"system\"}").showTeacherAbsences)
    }
}
