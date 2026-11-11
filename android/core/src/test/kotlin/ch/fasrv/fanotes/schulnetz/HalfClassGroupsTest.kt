package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HalfClassGroupsTest {
    private val monday = LocalDate.parse("2026-09-07")

    private fun lesson(name: String, week: Int, day: Int, hour: Int, teacher: String = "Nord", status: String = "", id: String = "$name-$week-$day-$hour") =
        monday.plusWeeks(week.toLong()).plusDays(day.toLong()).let { d ->
            AgendaEvent(id, "${d}T%02d:00:00".format(hour), "${d}T%02d:45:00".format(hour), "", "", "B12", listOf(teacher), "c-$name", name, status, "", "", "")
        }

    private fun weekly(name: String, hour: Int, day: Int = 0, weeks: Int = 4, teacher: String = "Nord") =
        (0 until weeks).map { lesson(name, it, day, hour, teacher) }

    @Test
    fun `h subjects in the same slot form one set`() {
        val sets = detectGroupSets(weekly("Hbio_G26D", 8, teacher = "Aebi") + weekly("Hche_G26D", 8, teacher = "Bader") + weekly("Mathematik", 9))
        assertEquals(1, sets.size)
        assertEquals("hbio_g26d|hche_g26d", sets[0].key)
        assertEquals(listOf("Hbio_G26D", "Hche_G26D"), sets[0].options.map { it.label })
        assertEquals(listOf("Aebi", "Bader"), sets[0].options.map { it.teacher })
        assertEquals(listOf(1, 1), sets[0].options.map { it.lessonsPerWeek })
    }

    @Test
    fun `lessons per week counts weeks with lessons`() {
        val twice = weekly("Hbio_G26D", 8) + weekly("Hbio_G26D", 10)
        val sets = detectGroupSets(twice + weekly("Hche_G26D", 8) + weekly("Hche_G26D", 10))
        assertEquals(listOf(2, 2), sets.single().options.map { it.lessonsPerWeek })
    }

    @Test
    fun `numbered groups form a family`() {
        val sets = detectGroupSets(weekly("Amos 1.1", 8) + weekly("Amos 1.2", 10, day = 2) + weekly("Amos 2.1", 13) + weekly("Chemie", 14))
        assertEquals(1, sets.size)
        assertEquals("amos 1.1|amos 1.2", sets[0].key)
    }

    @Test
    fun `semester groups form a family`() {
        val sets = detectGroupSets(weekly("Heng-Sem1", 8) + weekly("Heng-Sem2", 10, day = 1))
        assertEquals(listOf("heng-sem1|heng-sem2"), sets.map { it.key })
        assertEquals(1, detectGroupSets(weekly("Heng_sem1", 8) + weekly("Heng_SEM2", 8, day = 3)).size)
    }

    @Test
    fun `sport female and male groups form a family`() {
        assertEquals(listOf("spf|spm"), detectGroupSets(weekly("spf", 8) + weekly("spm", 10, day = 3)).map { it.key })
        assertEquals(1, detectGroupSets(weekly("SPF_G26D_1", 8) + weekly("SPM_G26D_1", 10, day = 3)).size)
    }

    @Test
    fun `unrelated courses that overlap once are not a set`() {
        val once = weekly("Mathematik", 8) + weekly("Deutsch", 9) + listOf(lesson("Physik", 0, 0, 8), lesson("Physik", 1, 1, 8), lesson("Physik", 2, 2, 8))
        assertTrue(detectGroupSets(once).isEmpty())
    }

    @Test
    fun `cancelled lessons and tiny options are ignored`() {
        val cancelled = weekly("Hbio_G26D", 8) + (0 until 4).map { lesson("Hche_G26D", it, 0, 8, status = "cancelled") }
        assertTrue(detectGroupSets(cancelled).isEmpty())
        assertTrue(detectGroupSets(weekly("Amos 1.1", 8) + listOf(lesson("Amos 1.2", 0, 1, 8))).isEmpty())
    }

    @Test
    fun `overlap and family sets merge`() {
        val events = weekly("Amos 1.1", 8) + weekly("Amos 1.2", 10) + weekly("Hamos", 8)
        val sets = detectGroupSets(events)
        assertEquals(1, sets.size)
        assertEquals(3, sets[0].options.size)
    }

    private val events = weekly("Hbio_G26D", 8) + weekly("Hche_G26D", 8) + weekly("Mathematik", 9)
    private val sets = detectGroupSets(events)
    private val key = sets.single().key

    @Test
    fun `a choice hides the other group only`() {
        val choices = mapOf(key to listOf("Hbio_G26D"))
        val visible = visibleEvents(events, emptyList(), groupSets = sets, groupChoices = choices)
        assertEquals(setOf("Hbio_G26D", "Mathematik"), visible.map { it.label }.toSet())
        assertEquals(8, visible.size)
    }

    @Test
    fun `without a choice nothing is hidden`() {
        assertEquals(events.size, visibleEvents(events, emptyList(), groupSets = sets, groupChoices = emptyMap()).size)
        assertEquals(events.size, visibleEvents(events, emptyList(), groupSets = sets, groupChoices = mapOf(key to emptyList())).size)
    }

    @Test
    fun `a choice for a vanished set or unknown course is ignored`() {
        assertEquals(events.size, visibleEvents(events, emptyList(), groupSets = sets, groupChoices = mapOf("gone|set" to listOf("Gone"))).size)
        assertEquals(events.size, visibleEvents(events, emptyList(), groupSets = sets, groupChoices = mapOf(key to listOf("Nope"))).size)
    }

    @Test
    fun `exams are not hidden by a group choice`() {
        val exam = AgendaEvent("x", "2026-09-07T08:00:00", "2026-09-07T08:45:00", "Prüfung Hche_G26D", "", "", emptyList(), "c", "Hche_G26D", "", "exam", "", "")
        assertFalse(lessonHiddenByGroup(exam, sets, mapOf(key to listOf("Hbio_G26D"))))
    }

    @Test
    fun `timetable change for a non chosen course is dropped`() {
        val choices = mapOf(key to listOf("Hbio_G26D"))
        fun change(body: String, category: String = "timetable") = SchulnetzChange("timetable:e1:x", category, "Stundenplan", body, "e1", "2026-09-07")
        assertTrue(changeIsHidden(change("Hche_G26D · 08:00 fällt aus"), emptyList(), sets, choices))
        assertFalse(changeIsHidden(change("Hbio_G26D · 08:00 fällt aus"), emptyList(), sets, choices))
        assertFalse(changeIsHidden(change("Mathematik"), emptyList(), sets, choices))
        assertFalse(changeIsHidden(change("Hche_G26D", "grade"), emptyList(), sets, choices))
    }

    @Test
    fun `widget rows follow the choice`() {
        val now = java.time.Instant.parse("2026-09-06T09:00:00Z")
        val rows = widgetRows(events, emptyList(), emptyList(), now, groupChoices = mapOf(key to listOf("Hche_G26D")))
        assertTrue(rows.none { it.title == "Hbio_G26D" })
        assertTrue(rows.any { it.title == "Hche_G26D" })
    }

    @Test
    fun `desk prefs keep group choices`() {
        val prefs = DeskPrefs(groupChoices = mapOf("a|b" to listOf("A \"x\""), "c|d" to listOf("C", "D")))
        assertEquals(prefs.groupChoices, parseDeskPrefs(serializeDeskPrefs(prefs)).groupChoices)
        assertTrue(parseDeskPrefs("{\"accent\":\"#2a6f97\"}").groupChoices.isEmpty())
        assertTrue(parseDeskPrefs("{\"groupChoices\":{\"a|b\":[],\"c\":\"x\"}}").groupChoices.isEmpty())
    }
}
