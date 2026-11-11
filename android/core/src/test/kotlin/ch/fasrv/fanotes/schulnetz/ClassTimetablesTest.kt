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
        for (ok in listOf("G26A", "G22S", "G26BF")) assertTrue(isClassCode(ok), ok)
        for (bad in listOf("g26a", "G26", "G26ABC", "../G26A", "G26A.pdf", "")) assertFalse(isClassCode(bad), bad)
        for (ok in listOf("516", "Wed_A", "T49", "Telli", "Sporthalle 1")) assertTrue(isRoomName(ok), ok)
        for (bad in listOf("", "../x", "a/b", "x".repeat(25), "<b>")) assertFalse(isRoomName(bad), bad)
    }

    @Test fun theSummaryKeepsOnlyUsableEntries() {
        val summary = parseClassTimetableSummary("""{"available":true,"uploadedAt":"2026-11-11T08:00:00.000Z","semester":"SJ 2026-27","classes":[{"code":"G26A","teacher":"ZimLu"},{"code":"../x","teacher":"X"},{"teacher":"none"}],"rooms":["516","Wed_A","<b>",7]}""")
        assertTrue(summary.available)
        assertEquals(listOf(TimetableClass("G26A", "ZimLu")), summary.classes)
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
            {"day":2,"start":"08:35","end":"09:30","class":"G26B","subject":"spf","teacher":"BauAn"},
            {"day":2,"start":"08:35","end":"09:30","class":"G26A","subject":"spf","teacher":"BauAn"},
            {"day":1,"start":"07:45","end":"08:35","class":"G26A","subject":"Heng-Sem1","teacher":"WeiSa"},
            {"day":9,"start":"07:45","end":"08:35","class":"G26A","subject":"x","teacher":"y"},
            {"day":3,"start":"7:45","class":"G26A"}]}""",
        )!!
        assertEquals("Telli", week.room)
        assertEquals(3, week.lessons.size)
        val days = roomWeekByDay(week)
        assertEquals(listOf(1, 2, 3, 4, 5), days.map { it.first })
        assertEquals(listOf("Heng-Sem1"), days[0].second.map { it.subject })
        assertEquals(listOf(RoomSlot("08:35", "09:30", "spf", "BauAn", listOf("G26A", "G26B"))), days[1].second)
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
}
