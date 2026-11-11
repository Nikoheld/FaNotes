package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Other classes and rooms (synthetic data only). */
class ClassTimetablesTest {
    @Test fun onlyTheAlteKantiPathCounts() {
        assertTrue(isAksaBase("https://www.schulnetz-ag.ch/aksa"))
        assertTrue(isAksaBase("https://www.schulnetz-ag.ch/aksa/"))
        assertTrue(isAksaBase("https://www.schulnetz-ag.ch/AKSA?x=1"))
        assertFalse(isAksaBase("https://www.schulnetz-ag.ch/kska"))
        assertFalse(isAksaBase("https://www.schulnetz-ag.ch/aksa/extra"))
        assertFalse(isAksaBase("https://www.schulnetz-ag.ch"))
        assertFalse(isAksaBase(""))
    }

    @Test fun namesAreValidatedStrictly() {
        for (ok in listOf("G26A", "G22S", "G26BF", "I24B", "W23C", "G26ABC")) assertTrue(isClassCode(ok), ok)
        for (bad in listOf("g26a", "G26", "G26ABCD", "26A", "../G26A", "G26A.pdf", "")) assertFalse(isClassCode(bad), bad)
        for (ok in listOf("516", "Wed_A", "T49", "Telli", "Sporthalle 1")) assertTrue(isRoomName(ok), ok)
        for (bad in listOf("", "../x", "a/b", "x".repeat(25), "<b>")) assertFalse(isRoomName(bad), bad)
    }

    @Test fun theSummaryKeepsOnlyUsableEntries() {
        val summary = parseClassTimetableSummary("""{"available":true,"uploadedAt":"2026-11-11T08:00:00.000Z","semester":"SJ 2026-27","classes":[{"code":"G26A","teacher":"TstOo"},{"code":"../x","teacher":"X"},{"teacher":"none"}],"rooms":["516","Wed_A","<b>",7]}""")
        assertTrue(summary.available)
        assertEquals(listOf(TimetableClass("G26A", "TstOo")), summary.classes)
        assertEquals(listOf("516", "Wed_A"), summary.rooms)
        assertEquals("SJ 2026-27", summary.semester)
    }

    @Test fun anythingElseIsNotAvailable() {
        assertFalse(parseClassTimetableSummary("""{"available":false}""").available)
        assertFalse(parseClassTimetableSummary("""{"available":true,"classes":[],"rooms":[]}""").available)
        assertFalse(parseClassTimetableSummary("not json").available)
        assertFalse(parseClassTimetableSummary("[]").available)
        assertFalse(parseClassTimetableSummary("""{"available":"true"}""").available)
    }

    @Test fun aRoomWeekGroupsClassesThatShareALesson() {
        val week = parseRoomWeek(
            """{"room":"Telli","entries":[
            {"day":2,"start":"08:35","end":"09:30","class":"G26B","subject":"spf","teacher":"TstAa"},
            {"day":2,"start":"08:35","end":"09:30","class":"G26A","subject":"spf","teacher":"TstAa"},
            {"day":1,"start":"07:45","end":"08:35","class":"G26A","subject":"Heng-Sem1","teacher":"WeiSa"},
            {"day":9,"start":"07:45","end":"08:35","class":"G26A","subject":"x","teacher":"y"},
            {"day":3,"start":"7:45","class":"G26A"}]}""",
        )!!
        assertEquals("Telli", week.room)
        assertEquals(3, week.lessons.size)
        val days = roomWeekByDay(week)
        assertEquals(listOf(1, 2, 3, 4, 5), days.map { it.first })
        assertEquals(listOf("Heng-Sem1"), days[0].second.map { it.subject })
        assertEquals(listOf(RoomSlot("08:35", "09:30", "spf", "TstAa", listOf("G26A", "G26B"))), days[1].second)
        assertTrue(days[2].second.isEmpty())
    }

    @Test fun unreadableRoomAnswersAreNull() {
        assertNull(parseRoomWeek("nope"))
        assertNull(parseRoomWeek("""{"room":"../x","entries":[]}"""))
        assertNull(parseRoomWeek("""{"entries":[]}"""))
    }

    @Test fun theCachedPdfNameChangesWithTheUpload() {
        val first = classPdfCacheName("G26D", "2026-11-11T08:00:00.000Z")
        val second = classPdfCacheName("G26D", "2026-11-12T08:00:00.000Z")
        assertTrue(first != second)
        assertTrue(first.endsWith("-G26D.pdf") && !first.contains('/') && !first.contains(':'))
    }

    private val classJson = """{"class":"G26A","teacher":"TstAa","semester":"SJ 2026-27","entries":[
        {"day":2,"start":"09:35","end":"10:20","subject":"Mathematik","teacher":"TstBb","room":"T01","footnote":"1"},
        {"day":1,"start":"07:45","end":"08:30","subject":"Deutsch","teacher":"TstAa","room":"T02"},
        {"day":9,"start":"07:45","subject":"Bad day"},{"day":1,"start":"7:45","subject":"Bad time"},
        {"day":3,"start":"08:35","subject":"Nur Fach"},"junk"],"footnotes":[{"nr":"1","text":"x"}]}"""

    @Test fun aClassWeekIsParsedDefensively() {
        val week = parseClassWeek(classJson)!!
        assertEquals("G26A", week.code)
        assertEquals("TstAa", week.teacher)
        assertEquals(3, week.lessons.size)
        val bare = week.lessons.first { it.day == 3 }
        assertEquals(ClassLesson(3, "08:35", "", "Nur Fach", "", ""), bare)
        assertNull(parseClassWeek("nope"))
        assertEquals(emptyList(), parseClassWeek("{}")!!.lessons)
    }

    @Test fun aClassWeekMapsToOrderedGridCells() {
        val cells = classWeekCells(parseClassWeek(classJson)!!)
        assertEquals(listOf(1, 2, 3), cells.map { it.day })
        assertEquals(TimetableCell(2, "09:35", "10:20", "Mathematik", "TstBb", "T01"), cells[1])
    }

    @Test fun aRoomWeekMapsClassesIntoThePlace() {
        val week = parseRoomWeek("""{"room":"T01","entries":[
            {"day":1,"start":"07:45","end":"08:30","class":"G26B","subject":"Physik","teacher":"TstAa"},
            {"day":1,"start":"07:45","end":"08:30","class":"G26A","subject":"Physik","teacher":"TstAa"}]}""")!!
        val cells = roomWeekCells(week)
        assertEquals(listOf(TimetableCell(1, "07:45", "08:30", "Physik", "TstAa", "G26A, G26B")), cells)
    }
}
