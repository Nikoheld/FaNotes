package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LivePreviewTest {
    @Test
    fun inactiveLinesHideMarkersAndTheCursorLineKeepsThem() {
        val note = "# Titel\n**fett** und *kursiv*\n- Punkt\n- [x] Tun\n> Zitat\n---\n[[Ziel|Name]]\n[Text](https://fanotes.example)\n`code` und \$x\$"
        val onTitle = livePreviewMarks(note, 0, 0)
        assertTrue(onTitle.any { it.kind == LiveKind.H1 && it.start == 0 })
        assertFalse(onTitle.any { it.kind == LiveKind.HIDE && it.start == 0 })
        assertEquals(LiveKind.STRONG, onTitle.first { it.start == note.indexOf("fett") }.kind)
        assertTrue(onTitle.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("**") })

        val onBold = livePreviewMarks(note, note.indexOf("**"), note.indexOf("**"))
        assertFalse(onBold.any { it.kind == LiveKind.STRONG })
        assertTrue(onBold.any { it.kind == LiveKind.HIDE && it.start == 0 && it.end == 2 })
        assertEquals(LiveKind.BULLET, onBold.first { it.start == note.indexOf("- Punkt") }.kind)
        assertEquals(LiveKind.TASK_DONE, onBold.first { it.start == note.indexOf("- [x]") }.kind)
        assertEquals(LiveKind.QUOTE, onBold.first { it.start == note.indexOf("> Zitat") }.kind)
        assertTrue(onBold.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("---") && it.end == note.indexOf("---") + 3 })
        assertTrue(onBold.any { it.kind == LiveKind.RULE && it.start == note.indexOf("---") })
        val onRule = livePreviewMarks("---", 1, 1)
        assertTrue(onRule.any { it.kind == LiveKind.RULE })
        assertFalse(onRule.any { it.kind == LiveKind.HIDE })
        assertEquals(LiveKind.LINK, onBold.first { it.start == note.indexOf("Name") }.kind)
        assertEquals(LiveKind.LINK, onBold.first { it.start == note.indexOf("Text") }.kind)
        assertEquals(LiveKind.CODE, onBold.first { it.start == note.indexOf("code") }.kind)
        assertEquals(LiveKind.MATH, onBold.first { it.start == note.indexOf("x\$") }.kind)
        assertEquals(LiveKind.EMPHASIS, onTitle.first { it.start == note.indexOf("kursiv") }.kind)
    }

    @Test
    fun metadataStaysHiddenOnTheCursorLineAndCodeOwnsItsRange() {
        val hidden = "<!-- fanotes-ink:abc -->"
        val marks = livePreviewMarks(hidden, 0, 0)
        assertEquals(listOf(LiveKind.HIDE, LiveKind.COLLAPSE), marks.map { it.kind })
        assertEquals(0 to hidden.length, marks[0].start to marks[0].end)
        val fenced = "`**a**`\n."
        val code = livePreviewMarks(fenced, fenced.indexOf('.'), fenced.indexOf('.'))
        assertEquals(listOf(LiveKind.HIDE, LiveKind.HIDE, LiveKind.CODE), code.map { it.kind })
        assertFalse(code.any { it.kind == LiveKind.STRONG })
        val rule = livePreviewMarks("| --- | --- |", 0, 0)
        assertTrue(rule.any { it.kind == LiveKind.TABLE_RULE })
        assertTrue(rule.any { it.kind == LiveKind.HIDE })
        assertTrue(livePreviewMarks("| A | B |", 0, 0).any { it.kind == LiveKind.TABLE_ROW })
        assertEquals(emptyList(), livePreviewMarks("", 0, 0))
        val fencedNote = "Vorher\n```kotlin\ncode\n```\nNachher"
        val outsideFence = livePreviewMarks(fencedNote, 0, 0)
        assertTrue(outsideFence.any { it.kind == LiveKind.CODE_FENCE && it.start == fencedNote.indexOf("code") })
        assertTrue(outsideFence.any { it.kind == LiveKind.CODE_FENCE && it.start == fencedNote.indexOf("```kotlin") })
        assertFalse(outsideFence.any { it.kind == LiveKind.CODE_FENCE && it.start == fencedNote.indexOf("Nachher") })
        val insideFence = livePreviewMarks(fencedNote, fencedNote.indexOf("code"), fencedNote.indexOf("code"))
        assertFalse(insideFence.any { it.kind == LiveKind.CODE_FENCE })
        val tilde = "~~~\nalpha\n~~~"
        assertEquals(listOf(1 to 3), codeFenceBlocks(tilde).map { it.openLine to it.closeLine })
        assertTrue(codeFenceBlocks("```\nopen").single().closeLine == 2)
        assertTrue(codeFenceBlocks("```\n~~~\n```").single().closeLine == 3)
    }

    @Test
    fun detailsSummaryHidesTheBodyUntilTheBlockIsOpen() {
        val closed = "<details>\n<summary>**Titel**</summary>\n\nGeheim\n</details>\nNachher"
        val folded = livePreviewMarks(closed, closed.length, closed.length)
        assertEquals("Titel", folded.first { it.kind == LiveKind.DETAILS_SUMMARY }.label)
        assertFalse(folded.first { it.kind == LiveKind.DETAILS_SUMMARY }.open)
        assertFalse(folded.any { it.kind == LiveKind.DETAILS_END })
        assertTrue(folded.any { it.kind == LiveKind.HIDE && it.start == closed.indexOf("Geheim") })
        assertTrue(folded.any { it.kind == LiveKind.HIDE && it.start == closed.indexOf("</details>") })
        val inside = livePreviewMarks(closed, closed.indexOf("Geheim"), closed.indexOf("Geheim"))
        assertFalse(inside.any { it.kind == LiveKind.DETAILS_SUMMARY })

        val inline = "<details><summary>Was</summary>4</details>"
        assertEquals("", livePreviewMarks(inline, 0, 0).first { it.kind == LiveKind.DETAILS_SUMMARY }.body)
        val opened = toggleDetailsOpen(inline, 0)
        assertEquals("<details open><summary>Was</summary>4</details>", opened)
        assertEquals("4", livePreviewMarks(opened!!, 0, 0).first { it.kind == LiveKind.DETAILS_SUMMARY }.body)
        assertEquals(inline, toggleDetailsOpen(opened, 0))

        val multi = "<details open>\n<summary>Titel</summary>\n**Geheim** und [Link](https://x)\n</details>"
        val openMarks = livePreviewMarks(multi, multi.length, multi.length)
        val summary = openMarks.first { it.kind == LiveKind.DETAILS_SUMMARY }
        assertEquals("Titel", summary.label)
        assertTrue(summary.open)
        assertFalse(summary.continues)
        assertEquals("Geheim und Link", summary.body)
        assertFalse(openMarks.any { it.kind == LiveKind.DETAILS_END })
        assertTrue(openMarks.any { it.kind == LiveKind.HIDE && it.start == multi.indexOf("**Geheim**") })
        assertEquals("Dieser Klappbereich ist leer.", detailsReading("  \n"))
        assertEquals("Kapitel\nText", detailsReading("## Kapitel\n\nText"))
        assertEquals(1.45f, detailsCardEm(ch.fasrv.fanotes.text.PaperKind.H1))
        assertEquals(1.25f, detailsCardEm(ch.fasrv.fanotes.text.PaperKind.H2))
        assertEquals(1.22f, detailsCardEm(ch.fasrv.fanotes.text.PaperKind.H3))
        assertEquals(0.96f, ch.fasrv.fanotes.desk.DETAILS_CARD_FONT)
        val chapter = detailsReadingLines("# Kapitel\n\nText")
        assertEquals(listOf("Kapitel", "Text"), chapter.map { it.text })
        assertEquals(1.45f * 0.96f, chapter[0].scale)
        assertEquals(0.96f, chapter[1].scale)
        assertEquals(listOf(true, false), chapter.map { it.heading })
        val openChapter = livePreviewMarks("<details open>\n<summary>Titel</summary>\n# Kapitel\n\nText\n</details>", 0, 0)
            .first { it.kind == LiveKind.DETAILS_SUMMARY }
        assertEquals(chapter.map { it.scale }, openChapter.readingScales)
        assertEquals(chapter.map { it.heading }, openChapter.readingHeadings)
        val blocks = detailsReadingLines("- Punkt\n\n> Zitat\n\n---\n\n1. Eins\n\n```\ncode\n```")
        assertEquals(listOf("bullet", "quote", "rule", "number", "code"), blocks.map { it.kind })
        assertEquals("• Punkt", blocks[0].text)
        assertEquals("Zitat", blocks[1].text)
        assertEquals("1. Eins", blocks[3].text)
        assertEquals("• Punkt\nZitat\n1. Eins\ncode", detailsReading("- Punkt\n\n> Zitat\n\n---\n\n1. Eins\n\n```\ncode\n```"))
        val listed = livePreviewMarks("<details open>\n<summary>Liste</summary>\n- Punkt\n\n---\n</details>", 0, 0)
            .first { it.kind == LiveKind.DETAILS_SUMMARY }
        assertEquals(listOf("bullet", "rule"), listed.readingKinds)
        assertEquals("• Punkt\n—", listed.body)
        val table = detailsReadingLines("| A | B |\n| --- | --- |\n| 1 | 2 |")
        assertEquals(listOf("table", "table"), table.map { it.kind })
        assertEquals(listOf(true, false), table.map { it.heading })
        assertEquals("A\u001fB", table[0].text)
        assertEquals("1\u001f2", table[1].text)
        assertEquals("A · B\n1 · 2", detailsReading("| A | B |\n| --- | --- |\n| 1 | 2 |"))
        assertTrue(openMarks.any { it.kind == LiveKind.HIDE && it.start == multi.indexOf("<summary>") })
        assertTrue(openMarks.any { it.kind == LiveKind.HIDE && it.start == multi.indexOf("</details>") })
        val inlineOpen = livePreviewMarks(opened, 0, 0).first { it.kind == LiveKind.DETAILS_SUMMARY }
        assertTrue(inlineOpen.open)
        assertFalse(inlineOpen.continues)
        assertEquals("toggle", detailsTapAction(400f, 390f, 16f))
        assertEquals("edit", detailsTapAction(400f, 400f - 16f * 4f, 16f))
        assertEquals("toggle", detailsTapAction(400f, 20f, 16f))
        val box = paperDetailsBox(16f)
        assertEquals(10f, box.radius)
        assertEquals(16f * 0.7f, box.marginY)
        assertEquals(16f * 0.9f, box.padX)
        assertEquals(16f * 0.72f, box.padY)
        assertEquals(mixColors(PAPER_PANEL_STRONG, "#ffffff", 0.76), paperDetailsFill())
    }

    @Test
    fun tappingTheTaskBoxFlipsOnlyThatBox() {
        assertEquals("- [x] Offen", toggleTaskMarker("- [ ] Offen", 0))
        assertEquals("- [ ] Fertig", toggleTaskMarker("- [x] Fertig", 3))
        assertEquals("- [ ] Fertig", toggleTaskMarker("- [X] Fertig", 0))
        assertEquals(null, toggleTaskMarker("- [ ] Offen", 6))
        val indented = "  - [ ] A"
        assertEquals("  - [x] A", toggleTaskMarker(indented, 4))
        assertEquals(null, toggleTaskMarker(indented, 0))
        val second = "- [x] Oben\n- [ ] Unten"
        assertEquals("- [x] Oben\n- [x] Unten", toggleTaskMarker(second, second.indexOf("Unten") - 2))
        assertEquals("- [ ] Oben\n- [ ] Unten", toggleTaskMarker(second, 0))
    }

    @Test
    fun otherCopiesOfTheSelectionAreMarkedUntilThereAreTooMany() {
        val text = "beta Beta beta"
        assertEquals(listOf(10 to 14), selectionMatchRanges(text, 0, 4))
        assertEquals(emptyList(), selectionMatchRanges(text, 5, 5))
        assertEquals(emptyList(), selectionMatchRanges("aaaa", 1, 3))
        val many = "a".repeat(102)
        assertEquals(null, selectionMatchRanges(many, 0, 1))
        assertEquals(100, selectionMatchRanges("a".repeat(101), 0, 1)?.size)
    }

    @Test
    fun nextOccurrenceSelectsTheWordThenTheNextWholeCopy() {
        assertEquals(0 to 5, nextEditorOccurrence("Hallo Welt", 2, 2))
        assertEquals(0 to 5, nextEditorOccurrence("Hallo Welt", 5, 5))
        assertEquals(null, nextEditorOccurrence("Hallo Welt", 5, 6))
        assertEquals(0 to 7, editorWordRange("foo_bar baz", 1))
        val repeated = "beta und beta"
        assertEquals(9 to 13, nextEditorOccurrence(repeated, 0, 4))
        assertEquals(0 to 4, nextEditorOccurrence(repeated, 9, 13))
        assertEquals(4 to 8, nextEditorOccurrence("betabeta", 0, 4))
        assertEquals(null, nextEditorOccurrence("Beta beta", 0, 4))
        assertEquals(null, nextEditorOccurrence("nur", 0, 3))
        assertTrue(nextOccurrenceShortcut(true, false, false, false, 'd'))
        assertTrue(nextOccurrenceShortcut(true, false, false, false, 'D'))
        assertFalse(nextOccurrenceShortcut(true, true, false, false, 'd'))
        assertFalse(nextOccurrenceShortcut(false, false, false, false, 'd'))
        assertFalse(nextOccurrenceShortcut(true, false, true, false, 'd'))
        assertFalse(nextOccurrenceShortcut(true, false, false, true, 'd'))
        assertFalse(nextOccurrenceShortcut(true, false, false, false, 'b'))
    }

    @Test
    fun openDetailsKeepThePictureSourceAndFrame() {
        val lines = detailsReadingLines("![Tafel](bilder/tafel.png)\n\nText")
        assertEquals(listOf("image", "paragraph"), lines.map { it.kind })
        assertEquals("Tafel", lines[0].text)
        assertEquals("bilder/tafel.png", lines[0].source)
        assertEquals("", lines[1].source)
        assertEquals("Tafel\nText", detailsReading("![Tafel](bilder/tafel.png)\n\nText"))
        val bare = detailsReadingLines("![](ordner/scan.png)")
        assertEquals("scan.png", bare[0].text)
        assertEquals("ordner/scan.png", bare[0].source)
        val web = detailsReadingLines("![Foto](https://example.com/a.png)")
        assertEquals("https://example.com/a.png", web[0].source)
        val note = "<details open>\n<summary>Bild</summary>\n![Tafel](bilder/tafel.png)\n</details>"
        val card = livePreviewMarks(note, 0, 0).first { it.kind == LiveKind.DETAILS_SUMMARY }
        assertEquals(listOf("image"), card.readingKinds)
        assertEquals(listOf("bilder/tafel.png"), card.readingSources)
        assertEquals("Tafel", card.body)
        assertEquals(240f to 120f, detailsImageFrame(800, 400, 240f))
        assertEquals(100f to 96f, detailsImageFrame(0, 10, 100f))
        val tall = detailsImageFrame(10, 1000, 100f)
        assertEquals(100f * DETAILS_IMAGE_MAX_RATIO, tall.second)
        assertEquals(8f, tall.first)
        assertEquals(12f, detailsImageRadius(16f))
        assertEquals(16f * DETAILS_CARD_FONT * DETAILS_IMAGE_MARGIN_EM, detailsImageMargin(16f))
    }

    @Test
    fun openDetailsKeepInlineMarksFromThePreview() {
        val source = "Siehe **fett**, *kursiv*, ~~weg~~, `code` und [Seite](https://x)"
        val (plain, marks) = detailsPlain(source)
        assertEquals(stripPreviewMarkers(source), plain)
        assertEquals("fett", plain.substring(marks.first { it.kind == "strong" }.let { it.start until it.end }))
        assertEquals("kursiv", plain.substring(marks.first { it.kind == "emphasis" }.let { it.start until it.end }))
        assertEquals("weg", plain.substring(marks.first { it.kind == "strike" }.let { it.start until it.end }))
        assertEquals("code", plain.substring(marks.first { it.kind == "code" }.let { it.start until it.end }))
        val link = marks.first { it.kind == "link" }
        assertEquals("Seite", plain.substring(link.start, link.end))
        assertEquals("https://x", link.target)
        val samples = listOf(
            "plain",
            "**a** __b__",
            "*a* _b_",
            "~~a~~",
            "`a`",
            "[a](b)",
            "[[Ziel|Name]]",
            "[[Mechanik]]",
            "siehe ![alt](bild.png) **c**",
            "[**Hi**](https://y)",
            "**a *b* c**",
        )
        for (sample in samples) assertEquals(stripPreviewMarkers(sample), detailsPlain(sample).first)
        val nested = detailsPlain("[**Hi**](https://y)")
        assertEquals("Hi", nested.first)
        assertEquals("link", nested.second.first { it.kind == "link" }.kind)
        assertEquals(0 to 2, nested.second.first { it.kind == "link" }.let { it.start to it.end })
        assertEquals("https://y", nested.second.first { it.kind == "link" }.target)
        assertEquals(0 to 2, nested.second.first { it.kind == "strong" }.let { it.start to it.end })
        val wiki = detailsPlain("[[Mechanik|Kraft]]")
        assertEquals("Kraft", wiki.first)
        assertEquals("Mechanik", wiki.second.single().target)
        val bullet = detailsReadingLines("- **Punkt** und [Ziel](note.md)")
        assertEquals("• Punkt und Ziel", bullet[0].text)
        val point = bullet[0].inlines.first { it.kind == "strong" }
        assertEquals(2, point.start)
        assertEquals("Punkt", bullet[0].text.substring(point.start, point.end))
        assertEquals("note.md", bullet[0].inlines.first { it.kind == "link" }.target)
        val task = detailsReadingLines("- [ ] **Offen**")
        assertEquals("☐ Offen", task[0].text)
        assertEquals("Offen", task[0].text.substring(task[0].inlines.single().start, task[0].inlines.single().end))
        val table = detailsReadingLines("| **Name** | B |\n| --- | --- |\n| 1 | 2 |")
        val header = table[0].inlines.single { it.kind == "strong" }
        assertEquals("Name", table[0].text.substring(header.start, header.end))
        val note = "<details open>\n<summary>T</summary>\n**Geheim**\n</details>"
        val card = livePreviewMarks(note, 0, 0).first { it.kind == LiveKind.DETAILS_SUMMARY }
        assertEquals("Geheim", card.body)
        assertEquals("strong", card.readingInlines.single().single().kind)
        assertEquals(0 to 6, card.readingInlines.single().single().let { it.start to it.end })
    }

    @Test
    fun paperTextKeepsImageMarksAndDropsTheOtherMarkers() {
        val line = "Siehe **fett**, ~~weg~~, `code` und [Seite](https://x)"
        val (plain, marks) = detailsPlain(line, collapseImages = false)
        assertEquals("Siehe fett, weg, code und Seite", plain)
        assertEquals("fett", plain.substring(marks.first { it.kind == "strong" }.let { it.start until it.end }))
        assertEquals("weg", plain.substring(marks.first { it.kind == "strike" }.let { it.start until it.end }))
        assertEquals("code", plain.substring(marks.first { it.kind == "code" }.let { it.start until it.end }))
        assertEquals("https://x", marks.first { it.kind == "link" }.target)
        assertEquals("Siehe !alt", detailsPlain("Siehe ![alt](bild.png)", collapseImages = false).first)
        assertEquals("Siehe alt", detailsPlain("Siehe ![alt](bild.png)").first)
        assertEquals("a * b", detailsPlain("a * b", collapseImages = false).first)
    }

    @Test
    fun inlineMathAndLongerCodeMarksMatchTheEditor() {
        val line = "Siehe ``wort`` und \$x^2\$"
        val (plain, marks) = detailsPlain(line)
        assertEquals("Siehe wort und x^2", plain)
        val code = marks.single { it.kind == "code" }
        assertEquals("wort", plain.substring(code.start, code.end))
        val math = marks.single { it.kind == "math" }
        assertEquals("x^2", plain.substring(math.start, math.end))
        val protected = detailsPlain("`\$a\$`")
        assertEquals("\$a\$", protected.first)
        assertEquals("code", protected.second.single().kind)
        assertEquals("y", detailsPlain("\$y\$").first)
    }

    @Test
    fun detailsCardsTurnAddressesIntoLinks() {
        val line = "Siehe <https://fanotes.example> und https://example.com/a."
        val (plain, marks) = detailsPlain(line, autolinks = true)
        assertEquals("Siehe https://fanotes.example und https://example.com/a.", plain)
        assertEquals("https://fanotes.example", marks.first { it.kind == "link" }.target)
        val bare = marks.last { it.kind == "link" }
        assertEquals("https://example.com/a", plain.substring(bare.start, bare.end))
        assertEquals("https://example.com/a", bare.target)
        val mail = detailsPlain("Schreib <mailto:ada@example.com>", autolinks = true)
        assertEquals("Schreib mailto:ada@example.com", mail.first)
        assertEquals("mailto:ada@example.com", mail.second.single().target)
        val coded = detailsPlain("`https://example.com`", autolinks = true)
        assertEquals("https://example.com", coded.first)
        assertEquals(listOf("code"), coded.second.map { it.kind })
        assertEquals("<https://fanotes.example>", detailsPlain("<https://fanotes.example>").first)
        val card = detailsReadingLines("Siehe https://example.com/a.")
        assertEquals("https://example.com/a", card.single().inlines.single().target)
    }

    @Test
    fun detailsListsKeepThePreviewMarker() {
        assertEquals("1. ", detailsNumberMarker("1. Eins"))
        assertEquals("12. ", detailsNumberMarker("12. Zwei"))
        assertEquals("", detailsNumberMarker("Eins"))
        assertEquals(false, detailsTaskChecked("☐ Offen"))
        assertEquals(true, detailsTaskChecked("☑ Fertig"))
        assertEquals(null, detailsTaskChecked("Offen"))
        assertEquals("☐ ", detailsTaskMarker("☐ Offen"))
        val numbered = detailsReadingLines("1. **Eins**")
        assertEquals("number", numbered.single().kind)
        assertEquals("1. ", detailsNumberMarker(numbered.single().text))
        val strong = numbered.single().inlines.single()
        assertEquals("Eins", numbered.single().text.substring(strong.start, strong.end))
        val task = detailsReadingLines("- [x] **Fertig**")
        assertEquals("task", task.single().kind)
        assertEquals(true, detailsTaskChecked(task.single().text))
        assertEquals("Fertig", task.single().text.substring(task.single().inlines.single().start, task.single().inlines.single().end))
        val nested = detailsReadingLines("- a\n    - **nest**\n    1. **zwei**\n    - [ ] **drei**")
        assertEquals(listOf("• a", "    • nest"), nested.filter { it.kind == "bullet" }.map { it.text })
        assertEquals(4, nested.first { it.kind == "number" }.let { detailsListIndent(it.text).length })
        assertEquals("1. ", detailsNumberMarker(nested.first { it.kind == "number" }.text))
        val nestedTask = nested.first { it.kind == "task" }
        assertEquals(false, detailsTaskChecked(nestedTask.text))
        assertEquals(4, detailsListIndent(nestedTask.text).length)
        assertEquals("drei", nestedTask.text.substring(nestedTask.inlines.single().start, nestedTask.inlines.single().end))
    }
}
