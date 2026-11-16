package ch.fasrv.fanotes.study

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class StudyImageBudgetTest {
    private fun image(id: String, chars: Int) =
        StudyImage(id, 1, 0.0, 0.0, 0.4, 1.0, 1.0, false, "data:image/png;base64," + "A".repeat(chars))

    @Test fun constantsMatchDesktop() {
        assertEquals(300_000, ANNOTATION_IMAGE_TARGET_CHARS)
        assertEquals(450_000, ANNOTATION_IMAGE_NEW_MAX_CHARS)
        assertEquals(8_000_000, ANNOTATION_IMAGE_BUDGET_CHARS)
        assertEquals(1200, STUDY_IMAGE_MAX_EDGE)
        // Twelve capped images always fit, and the budget leaves room in a 16 MB note.
        assertTrue(ANNOTATION_IMAGE_BUDGET_CHARS >= ANNOTATION_IMAGE_LIMIT * ANNOTATION_IMAGE_NEW_MAX_CHARS)
        assertTrue(ANNOTATION_IMAGE_BUDGET_CHARS < 16 * 1024 * 1024 / 2)
    }

    @Test fun encodeStepsFollowDesktopOrder() {
        val jpeg = studyEncodeSteps(false)
        assertEquals(24, jpeg.size)
        assertTrue(jpeg.none { it.png })
        assertEquals(listOf(82, 70, 58, 46), jpeg.take(4).map { it.quality })
        assertEquals(1200.0, jpeg[0].edge, 1e-9)
        assertEquals(936.0, jpeg[4].edge, 1e-9)
        assertEquals(1200 * 0.78 * 0.78 * 0.78 * 0.78 * 0.78, jpeg[20].edge, 1e-6)
        val png = studyEncodeSteps(true)
        assertEquals(26, png.size)
        assertTrue(png[0].png)
        assertFalse(png[1].png)
        assertTrue(png[5].png && png[5].edge < 1000.0)
        assertEquals(2, png.count { it.png })
    }

    @Test fun budgetCountsOnlyImages() {
        val items = listOf(image("a", 100), StudyStamp("s", 1, 0.1, 0.1, "gain"), image("b", 50))
        assertEquals(2 * "data:image/png;base64,".length + 150, annotationImageChars(items))
    }

    @Test fun insertBeyondBudgetIsRefused() {
        assertTrue(imageFitsBudget(0, 300_000))
        assertTrue(imageFitsBudget(7_700_000, 300_000))
        assertFalse(imageFitsBudget(7_700_001, 300_000))
        assertFalse(imageFitsBudget(0, 450_001))
    }

    @Test fun messageIsGermanWithUsedSize() {
        assertEquals("Bildspeicher dieser Notiz voll (7,9 von 8,0 MB). Entferne zuerst ein Bild.", imageBudgetMessage(7_900_000))
    }
}
