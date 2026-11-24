package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChangeHistoryTest {
    private val grade = SchoolGrade("g1", "MATH", "m1", "Mathematik", "Test 1", "2026-03-01", 5.75, 1.0, true, null, "")
    private val snapshot = SchulnetzSnapshot(grades = listOf(grade))
    private fun change(id: String, category: String = "event", at: String = "", title: String = "T $id", body: String = "B", ids: List<String> = emptyList()) =
        SchulnetzChange(id, category, title, body, targetIds = ids, targetId = ids.joinToString(","), at = at)

    @Test
    fun recordsNewestFirstDedupsAndCaps() {
        val first = recordChanges(emptyList(), listOf(change("a", at = "2026-03-01T08:00:00Z"), change("b", at = "2026-03-02T08:00:00Z")), "2026-03-05T00:00:00Z", false, snapshot)
        assertEquals(listOf("b", "a"), first.map { it.id })
        val next = recordChanges(first, listOf(change("a", at = "2026-03-03T08:00:00Z", body = "new")), "now", false, snapshot)
        assertEquals(listOf("a", "b"), next.map { it.id })
        assertEquals("new", next[0].body)
        val many = recordChanges(emptyList(), (1..150).map { change("c$it", at = "2026-01-01T00:%02d:00Z".format(it % 60) + "") }, "now", false, snapshot, limit = 100)
        assertEquals(100, many.size)
    }

    @Test
    fun skipsProbesAndSettingsAndStampsMissingTime() {
        val rows = recordChanges(emptyList(), listOf(change("probe:1"), change("s", "settings"), change("x")), "2026-03-05T00:00:00Z", false, snapshot)
        assertEquals(listOf("x"), rows.map { it.id })
        assertEquals("2026-03-05T00:00:00Z", rows[0].at)
    }

    @Test
    fun guessModeStoresGradeNoticesRedacted() {
        val raw = change("grade:g1:k", "grade", "2026-03-01T08:00:00Z", title = "Neue Note", body = "Mathematik · Test 1 · 5.75", ids = listOf(gradeTargetId(grade)))
        val stored = recordChanges(emptyList(), listOf(raw), "now", true, snapshot)
        assertFalse(stored[0].body.contains("5.75"))
        assertTrue(stored[0].title.contains("Aufdecken"))
    }

    @Test
    fun displayRedactsOnlyStillHiddenGrades() {
        val id = gradeTargetId(grade)
        val raw = change("grade:g1:k", "grade", "2026-03-01T08:00:00Z", title = "Neue Note", body = "Mathematik · Test 1 · 5.75", ids = listOf(id))
        assertTrue(historyForDisplay(listOf(raw), true, setOf(id), snapshot)[0].title.contains("Aufdecken"))
        assertEquals("Neue Note", historyForDisplay(listOf(raw), true, emptySet(), snapshot)[0].title)
        assertEquals("Neue Note", historyForDisplay(listOf(raw), false, setOf(id), snapshot)[0].title)
    }

    @Test
    fun roundTripsThroughJson() {
        val rows = listOf(change("a", "grade", "2026-03-01T08:00:00Z", ids = listOf("t1", "t2")), change("b", at = "2026-03-02T08:00:00Z", body = "quote \" and \\ ok"))
        val back = parseChangeHistory(serializeChangeHistory(rows))
        assertEquals(rows.map { it.id }, back.map { it.id })
        assertEquals(listOf("t1", "t2"), back[0].targetIds)
        assertEquals("quote \" and \\ ok", back[1].body)
        assertTrue(parseChangeHistory("garbage").isEmpty())
        assertTrue(parseChangeHistory(null).isEmpty())
    }
}
