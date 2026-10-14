package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarginTranscriptTest {
    @Test
    fun linesKeepPageOrderAndAWordCanBeCorrected() {
        val transcript = "${formatTranscriptLine(0.2, "Integral")}\n${formatTranscriptLine(0.8, "Wurzel")}"
        val lines = marginLinesFromTranscript(transcript)
        assertEquals("Wurzel", lines[1].text)
        assertEquals(0.8, lines[1].y ?: 0.0, 1e-9)
        assertEquals("0.2000\tTest bleibt", replaceTranscriptWord("0.2000\tTost bleibt", "Tost", "Test"))
        assertTrue(replaceTranscriptWord("0.2000\tTost bleibt", "Tost", "Test").contains("Test"))
        assertEquals("Test Tost", replaceTranscriptWord("Tost Tost", "Tost", "Test"))
    }
}
