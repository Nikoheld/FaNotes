package ch.fasrv.fanotes.desk

import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals

class StudyTest {
    @Test
    fun dwellLandsOnSundayAndSubjectsSortByTime() {
        val sunday = addDwell(emptyPageStats(0), 120_000, 0)
        assertEquals(120_000, sunday.dwellMs)
        assertEquals(120_000, sunday.dwellByWeekday[0])
        val schule = sunday.copy(inkMs = 30_000, inkLengthMm = 210.0, typingMs = 10_000)
        val picture = aggregateStudy(
            listOf(
                "Schule/Mathe.md" to schule,
                "Eingang.md" to emptyPageStats(0).copy(dwellMs = 30_000),
            ),
        )
        assertEquals("Schule", picture.subjects.first().subject)
        assertEquals(
            "Schule · 2 Seiten · 1 h · 2 min Tippen · 5 min Stift",
            studySubjectSummary(StudySubject("Schule", 2, 3_600_000, 120_000, 300_000, 0.0)),
        )
        assertEquals(150_000, picture.dwellMs)
        assertEquals("2 min", formatStudyDuration(120_000))
        assertEquals(1, openPageStats(emptyPageStats(0), 0, ZoneOffset.UTC).openCount)
    }
}
