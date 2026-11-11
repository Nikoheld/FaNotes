package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.util.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Guards the fast path of [cleanSchulnetzText] (it must stay equal to the original regex pipeline) and the cost of the
 * derived lists the screens build from a full school year (label, widget strip, absence points).
 */
class DerivedWorkGuardTest {
    // --- reference copy of the original implementation (before the plain-text fast path) ---------------------------
    private val cdataWrapped = Regex("""(?is)^<!\[CDATA\[([\s\S]*)\]\]>$""")
    private val cdataOpen = Regex("""(?i)<!\[CDATA\[""")
    private val cdataClose = Regex("""\]\]>""")

    private fun referenceUnwrap(raw: String): String {
        var value = raw.trim()
        while (true) {
            val match = cdataWrapped.find(value) ?: return value
            value = match.groupValues[1].trim()
        }
    }

    private fun referenceClean(raw: String): String =
        cdataClose.replace(cdataOpen.replace(referenceUnwrap(raw), ""), "").replace(Regex("""\s+"""), " ").trim()

    private val tricky = listOf(
        "", " ", "  ", "Mathematik", " Mathematik ", "Mathe  matik", "<![CDATA[Mathematik]]>", "  <![CDATA[ Mathematik ]]>  ",
        "<![CDATA[<![CDATA[Nested]]>]]>", "<![CDATA[a]]>b]]>c", "x]]>y", "x<![CDATA[y", "<![cdata[Lower]]>", "<![CDATA[]]>", "<![CDATA[",
        "]]>", "Raum [B12]", "[]", "a\tb", "a\nb", "a\r\nb", "\ta\t", "a  b   c", "a b", " a ", "a b", "a b", "a　b",
        "a\u0001b", "\u0000", "a\u001Fb", "a\u007Fb", "a\u000Bb", "a\u000Cb", "a\u0085b", "a b", "x <![CDATA[ y ]]> z", "Prüfung: Äpfel & Öl",
        "<![CDATA[\n  Zeile 1\n  Zeile 2\n]]>", "  \n  ", "(a) [b] {c}", "a ] b [ c", "<!CDATA[x]]>",
    )

    @Test
    fun `tricky strings clean exactly like the reference`() {
        tricky.forEach { assertEquals(referenceClean(it), cleanSchulnetzText(it), "input: ${it.map { c -> c.code }}") }
    }

    @Test
    fun `random strings clean exactly like the reference`() {
        val tokens = listOf("a", "B", "z", "Ü", "1", " ", " ", " ", "\t", "\n", "\r", " ", " ", " ", "　", "\u0001", "\u001F", "\u000B",
            "[", "]", "<", ">", "!", "<![CDATA[", "]]>", "CDATA", "-", ":")
        val random = Random(20261111)
        repeat(2000) {
            val text = (0 until random.nextInt(14)).joinToString("") { tokens[random.nextInt(tokens.size)] }
            assertEquals(referenceClean(text), cleanSchulnetzText(text), "input: ${text.map { c -> c.code }}")
        }
    }

    @Test
    fun `label equals the reference label`() {
        fun event(course: String, text: String, tt: String) = AgendaEvent("i", "2026-11-10T08:00:00", "2026-11-10T08:45:00", text, "", "", emptyList(), "c", course, "", "", "", tt)
        listOf(
            Triple("", "<![CDATA[Physik]]>", ""), Triple("  ", "  ", "Tt"), Triple("", "", ""), Triple("Ma", "x", "y"), Triple("<![CDATA[ ]]>", "a  b", "c"),
        ).forEach { (c, t, tt) ->
            val reference = listOf(c, t, tt).map(::referenceClean).firstOrNull { it.isNotBlank() } ?: "Lektion"
            val e = event(c, t, tt)
            assertEquals(reference, e.label)
            assertEquals(reference, e.label)
        }
    }

    // --- timing on a full year (21 weeks, 820 lessons) --------------------------------------------------------------
    private fun year(): Pair<List<AgendaEvent>, SchulnetzSnapshot> {
        val monday = LocalDate.parse("2026-09-07")
        val titles = listOf("Deutsch", "Mathematik", "Englisch", "Französisch", "Biologie", "Chemie", "Physik", "Geschichte", "Geografie", "Sport")
        val starts = listOf("07:45", "08:35", "09:40", "10:30", "11:25", "13:15", "14:05", "15:00")
        val ends = listOf("08:30", "09:20", "10:25", "11:15", "12:10", "14:00", "14:50", "15:45")
        val events = mutableListOf<AgendaEvent>()
        for (week in 0 until 21) for (dayIndex in 0 until 5) for (slot in 0 until 8) {
            if (events.size >= 820) break
            val day = monday.plusWeeks(week.toLong()).plusDays(dayIndex.toLong())
            val title = titles[(slot * 3 + dayIndex + week) % titles.size]
            events += AgendaEvent(
                id = "g-$day-$slot", start = "${day}T${starts[slot]}:00", end = "${day}T${ends[slot]}:00", text = title, comment = "", room = "R$slot",
                teachers = listOf("Lehrperson ${slot + 1}"), courseId = "g-$title", courseName = title, status = "", eventType = "0_stp", color = "", timetableText = title,
            )
        }
        val absences = (0 until 20).map {
            SchoolAbsence("g-a-$it", "2026-10-${10 + it}", "2026-10-${10 + it}", "07:45", "08:30", "Deutsch", "Krankheit", it % 2 == 0, true, "gebucht", "", 1.0 + it % 3, false)
        }
        return events to SchulnetzSnapshot(revision = 1, events = events, absences = absences, absenceQuota = 30.0, absenceRemaining = 21.0)
    }

    private fun bestOf(runs: Int, block: () -> Unit): Double {
        var best = Double.MAX_VALUE
        repeat(runs) {
            val start = System.nanoTime()
            block()
            best = minOf(best, (System.nanoTime() - start) / 1e6)
        }
        return best
    }

    @Test
    fun `label, widget strip and absence points of a full year stay cheap`() {
        val (events, snapshot) = year()
        assertEquals(820, events.size)
        val now = Instant.parse("2026-10-14T06:00:00Z")
        // Warm-up so the budgets measure steady state, as the app's second use of the data does.
        repeat(3) { widgetRows(events, emptyList(), emptyList(), now); absenceTally(snapshot); events.forEach { it.label } }
        val labelCold = bestOf(3) { year().first.forEach { it.label } }
        val labelWarm = bestOf(5) { events.forEach { it.label } }
        val widget = bestOf(5) { widgetRows(events, emptyList(), emptyList(), now) }
        val absence = bestOf(5) { absenceTally(snapshot) }
        println("derived work, 820 lessons: label fresh events %.1f ms, label cached %.2f ms, widgetRows %.1f ms, absenceTally %.2f ms".format(labelCold, labelWarm, widget, absence))
        assertTrue(widget < WIDGET_BUDGET_MS, "widgetRows took %.1f ms (budget %.0f ms)".format(widget, WIDGET_BUDGET_MS))
        assertTrue(labelWarm < LABEL_WARM_BUDGET_MS, "cached label pass took %.2f ms (budget %.0f ms)".format(labelWarm, LABEL_WARM_BUDGET_MS))
        assertTrue(labelCold < LABEL_COLD_BUDGET_MS, "label of 820 fresh events took %.1f ms (budget %.0f ms)".format(labelCold, LABEL_COLD_BUDGET_MS))
        assertTrue(absence < ABSENCE_BUDGET_MS, "absenceTally took %.2f ms (budget %.0f ms)".format(absence, ABSENCE_BUDGET_MS))
    }

    private companion object {
        const val WIDGET_BUDGET_MS = 50.0
        const val LABEL_WARM_BUDGET_MS = 10.0
        const val LABEL_COLD_BUDGET_MS = 100.0
        const val ABSENCE_BUDGET_MS = 20.0
    }
}
