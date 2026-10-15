package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PageStatsTest {
    @Test
    fun aSaveCountsWordsTasksAndTheTable() {
        val markdown = """
            # Titel

            Ein Satz mit zwei Worten.

            - [ ] offen
            - [x] fertig

            | A | B |
            | --- | --- |
            | 1 | 2 |
        """.trimIndent()
        val measured = measureDocument(markdown)
        assertEquals(1, measured.headings)
        assertEquals(2, measured.tasks)
        assertEquals(1, measured.tasksDone)
        assertEquals(1, measured.tables)
        assertTrue(measured.words >= 5)
        val saved = recordPageSaved(emptyPageStats(0), markdown, emptyList(), 900.0, 1273.0, 0)
        assertEquals(1, saved.saveCount)
        assertEquals(measured.words, saved.document.words)
        val grown = recordPageSaved(saved, "$markdown\n\nNoch ein Wort.\n", emptyList(), 900.0, 1273.0, 60_000)
        assertEquals(2, grown.saveCount)
        assertTrue(grown.document.wordsAdded > 0)
    }

    @Test
    fun openingCountsTheLocalHourAndAFullWidthStrokeIs210Millimetres() {
        val opened = openPageStats(emptyPageStats(0), 0, ZoneOffset.UTC)
        assertEquals(1, opened.openCount)
        assertEquals(1, opened.opensByHour[0])
        assertEquals(listOf("1970-01-01"), opened.activeDays)
        val stroke = InkStroke(
            points = listOf(
                StrokePoint(0.0, 0.2, 0.0, 0.5, 0.0, 0.0, "pen"),
                StrokePoint(1.0, 0.2, 100.0, 0.5, 0.0, 0.0, "pen"),
            ),
            baseWidth = 3.5,
            pressureEnabled = true,
            color = "#202333",
        )
        assertEquals(210.0, strokeLengthMm(stroke, 900.0, 1273.0), 0.05)
        val again = parsePageStats(pageStatsJson(opened))
        assertEquals(1, again.openCount)
        val raw = jsonObject(
            "customCounter" to jsonNumber(12.0),
            "typing" to jsonObject("ms" to jsonNumber(5.0), "keystrokes" to jsonNumber(1.0)),
        )
        val merged = mergePageStats(raw, opened)
        assertEquals(12.0, merged.double("customCounter"))
        assertEquals(5.0, merged.obj("typing")?.double("ms"))
    }

    @Test
    fun typingAndInkTimeStayInsideTheDesktopBurst() {
        val start = emptyPageStats(0)
        val first = recordKeystroke(start, 1_000, null)
        val second = recordKeystroke(first, 2_000, 1_000)
        val later = recordKeystroke(second, 9_000, 2_000)
        assertEquals(3, later.typingKeystrokes)
        assertEquals(1_000, later.typingMs)
        val stroke = recordInkActivity(start, points = 2, lengthMm = 210.0, durationMs = 100, nowMs = 5_000, lastStrokeEndedAtMs = null)
        assertEquals(1, stroke.inkStrokes)
        assertEquals(2, stroke.inkPoints)
        assertEquals(210.0, stroke.inkLengthMm)
        assertEquals(100, stroke.inkPenDownMs)
        assertEquals(100, stroke.inkMs)
        val follow = recordInkActivity(stroke, points = 1, lengthMm = 0.0, durationMs = 50, nowMs = 5_400, lastStrokeEndedAtMs = 5_000)
        assertEquals(150, follow.inkPenDownMs)
        assertEquals(500, follow.inkMs)
        val erased = recordInkErased(follow, 2, 6_000)
        assertEquals(2, erased.strokesErased)
    }
}