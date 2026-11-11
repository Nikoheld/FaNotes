package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The half-class feature is gone: a desk file from beta.26 that still carries `groupChoices` must hide nothing. */
class HalfClassRemovalTest {
    private val monday = LocalDate.parse("2026-09-07")

    private fun lesson(name: String, week: Int, hour: Int) =
        monday.plusWeeks(week.toLong()).let { d ->
            AgendaEvent("$name-$week", "${d}T%02d:00:00".format(hour), "${d}T%02d:45:00".format(hour), "", "", "B12", listOf("Nord"), "c-$name", name, "", "", "", "")
        }

    private val events = (0 until 4).map { lesson("Hbio_G26D", it, 8) } + (0 until 4).map { lesson("Hche_G26D", it, 8) } + (0 until 4).map { lesson("Mathematik", it, 9) }

    private val betaDesk = """{"accent":"#2a6f97","theme":"dark","showMensa":true,"groupChoices":{"hbio_g26d|hche_g26d":["Hbio_G26D"]}}"""

    @Test
    fun `old group choices are ignored and dropped on the next save`() {
        val prefs = parseDeskPrefs(betaDesk)
        assertEquals("dark", prefs.theme)
        assertTrue(prefs.showMensa)
        val saved = serializeDeskPrefs(prefs)
        assertFalse(saved.contains("groupChoices"))
        assertEquals(prefs, parseDeskPrefs(saved))
    }

    @Test
    fun `with such a snapshot both groups stay visible everywhere`() {
        parseDeskPrefs(betaDesk)
        assertEquals(events.size, visibleEvents(events, emptyList()).size)
        val merged = mergedScheduleEvents(events, emptyList(), emptyList())
        assertEquals(setOf("Hbio_G26D", "Hche_G26D", "Mathematik"), merged.map { it.label }.toSet())
        val rows = widgetRows(events, emptyList(), emptyList(), java.time.Instant.parse("2026-09-06T09:00:00Z"))
        assertTrue(rows.any { it.title == "Hbio_G26D" })
        assertTrue(rows.any { it.title == "Hche_G26D" })
        val change = SchulnetzChange("timetable:e1:x", "timetable", "Stundenplan", "Hche_G26D · 08:00 fällt aus", "e1", "2026-09-07")
        assertFalse(changeIsHidden(change, emptyList()))
    }
}
