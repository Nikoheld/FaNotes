package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class PreviewListIndentTest {
    @Test
    fun nestedListsAddOneAndAHalfEmPerLevel() {
        assertEquals(0, previewListColumns(""))
        assertEquals(4, previewListColumns("\t"))
        assertEquals(6, previewListColumns("\t  "))
        assertEquals(listOf(1), previewListLevels(listOf("  ")))
        assertEquals(listOf(1, 2), previewListLevels(listOf("", "    ")))
        assertEquals(listOf(1, 2), previewListLevels(listOf("", "\t")))
        assertEquals(listOf(1, 2, 3), previewListLevels(listOf("", "  ", "    ")))
        assertEquals(listOf(1, 2, 2), previewListLevels(listOf("", "    ", "    ")))
        assertEquals(listOf(1, 2, 3, 1), previewListLevels(listOf("", "  ", "    ", "")))
        assertEquals(0f, previewListStartEm(0))
        assertEquals(1.7f, previewListStartEm(1))
        assertEquals(3.2f, previewListStartEm(2))
        assertEquals(4.7f, previewListStartEm(3))
        assertEquals(previewFlowStart("bullet"), previewListStartEm(1))
        assertEquals(32f, previewListIndentPx(2, 10f), 0.01f)
        assertEquals(16f * 1.7f, previewListIndentPx(1, 0f), 0.01f)
        assertEquals("", previewListExtraPad(1))
        val one = "$PREVIEW_LIST_EM_SPACE$PREVIEW_LIST_EN_SPACE"
        assertEquals(one, previewListExtraPad(2))
        assertEquals(one + one, previewListExtraPad(3))
        assertEquals(1, previewListLevelOfPrefix(""))
        assertEquals(1, previewListLevelOfPrefix("    "))
        assertEquals(2, previewListLevelOfPrefix(one))
        assertEquals(3, previewListLevelOfPrefix(one + one))

        val deep = detailsReadingLines("- a\n  - **nest**\n    - c")
        val bullets = deep.filter { it.kind == "bullet" }
        assertEquals("• a", bullets[0].text)
        assertEquals("$one• nest", bullets[1].text)
        assertEquals("${one + one}• c", bullets[2].text)
        assertEquals("nest", bullets[1].text.substring(bullets[1].inlines.single().start, bullets[1].inlines.single().end))

        val wide = detailsReadingLines("- a\n    - b\n\t- c")
        assertEquals(listOf("• a", "$one• b", "$one• c"), wide.filter { it.kind == "bullet" }.map { it.text })

        val number = detailsReadingLines("1. a\n   1. **zwei**").last()
        assertEquals(one, previewReadingListPrefix(number.text))
        assertEquals(one.length + "1. ".length, previewMarkerEnd(number.text, "number"))
        assertEquals("zwei", number.text.substring(number.inlines.single().start, number.inlines.single().end))

        val task = detailsReadingLines("- [ ] a\n  - [x] **fertig**").last()
        assertEquals(one, previewReadingListPrefix(task.text))
        assertEquals(true, detailsTaskChecked(task.text))
        val split = previewTaskLine(task.text, task.inlines)
        assertEquals(one, split?.indent)
        assertEquals("fertig", split?.text)
        assertEquals(0, split?.inlines?.single()?.start)
    }
}
