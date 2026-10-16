package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.TableAlign
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AiPreviewTest {
    @Test
    fun schoenPreviewHidesMarkersAndKeepsThePaperBlocks() {
        val lines = aiPreviewLines(
            """
            # Titel

            Siehe [Welt](https://example.com) und **fett** sowie [[Notiz|Alias]].

            - [x] Fertig
            """.trimIndent(),
        )
        assertEquals(PaperKind.H1, lines.first().kind)
        assertEquals("Titel", aiPreviewLineText(lines.first()))
        assertEquals(2f, aiPreviewScale(PaperKind.H1))
        assertTrue(aiPreviewHeading(PaperKind.H1))
        val paragraph = lines.first { it.kind == PaperKind.PARAGRAPH }
        assertEquals("Siehe Welt und fett sowie Alias.", aiPreviewLineText(paragraph))
        val task = lines.first { it.kind == PaperKind.TASK }
        assertEquals("☑ Fertig", aiPreviewLineText(task))
        assertEquals("code und kursiv", stripPreviewMarkers("`code` und *kursiv*"))
    }

    @Test
    fun schoenPreviewUsesTheDesktopMarkdownSizesAndMarks() {
        assertEquals(2.15f, aiPreviewReadingScale(PaperKind.H1))
        assertEquals(1.55f, aiPreviewReadingScale(PaperKind.H2))
        assertEquals(1.22f, aiPreviewReadingScale(PaperKind.H3))
        assertEquals(1.02f, aiPreviewReadingScale(PaperKind.H4))
        val h1 = previewHeadingBox(2.15f, true)
        assertEquals(0f, h1.marginTopEm)
        assertEquals(0.8f, h1.marginBottomEm)
        assertEquals(-0.025f, h1.trackingEm)
        assertEquals(1.25f, h1.lineHeight)
        val h2 = previewHeadingBox(1.55f, false)
        assertEquals(1.65f, h2.marginTopEm)
        assertEquals(0.62f, h2.marginBottomEm)
        assertEquals(0f, previewHeadingBox(1.55f, true).marginTopEm)
        assertEquals(1.4f, previewHeadingBox(1.22f, false).marginTopEm)
        assertEquals(0.5f, previewHeadingBox(1.22f, false).marginBottomEm)
        assertEquals(1.25f, previewHeadingBox(1.02f, false).marginTopEm)
        assertEquals(0.45f, previewHeadingBox(1.02f, false).marginBottomEm)
        assertEquals(0f, previewHeadingBox(1f, false).marginTopEm)
        assertEquals(0f, previewHeadingBox(1f, false).marginBottomEm)
        val quote = previewQuoteChrome()
        assertEquals(1.25f, quote.marginEm)
        assertEquals(0.7f, quote.padYEm)
        assertEquals(1.15f, quote.padXEm)
        assertEquals(3f, quote.barDp)
        assertEquals(6f, quote.radiusDp)
        val rule = previewRuleChrome()
        assertEquals(2.2f, rule.marginEm)
        assertEquals(1f, rule.heightDp)
        assertEquals(0f, previewBlockTop(rule.marginEm, true))
        assertEquals(2.2f, previewBlockTop(rule.marginEm, false))
        val fence = previewFenceChrome()
        assertEquals(1f, fence.padYEm)
        assertEquals(1.1f, fence.padXEm)
        assertEquals(6f, fence.radiusDp)
        val math = previewMathChrome()
        assertEquals(1.45f, math.marginEm)
        assertEquals(1.05f, math.padEm)
        assertEquals(12f, math.radiusDp)
        assertEquals(0.075f, math.accentWash)
        assertEquals(0.05f, math.secondaryWash)
        assertEquals(0.1f, math.borderAlpha)
        assertEquals(0.09f, PREVIEW_BORDER_ALPHA)
        assertEquals(0.16f, PREVIEW_BORDER_STRONG_ALPHA)
        assertEquals(0.45f, PREVIEW_LINK_UNDERLINE)
        val flow = previewFlowBox()
        assertEquals(0.65f, flow.paragraphTopEm)
        assertEquals(1f, flow.paragraphBottomEm)
        assertEquals(0f, previewFlowTop("paragraph", true))
        assertEquals(0.65f, previewFlowTop("paragraph", false))
        assertEquals(1f, previewFlowBottom("paragraph"))
        assertEquals(0.28f, previewFlowTop("bullet", false))
        assertEquals(0.28f, previewFlowBottom("task"))
        assertEquals(1.7f, previewFlowStart("number"))
        val taskChrome = previewTaskChrome()
        assertEquals(13f, taskChrome.boxDp)
        assertEquals(0.45f, taskChrome.gapEm)
        val open = previewTaskLine("☐ Lesen", listOf(DetailsInline(2, 7, "strong")))
        assertEquals(false, open?.checked)
        assertEquals("", open?.indent)
        assertEquals("Lesen", open?.text)
        assertEquals(0, open?.inlines?.single()?.start)
        val done = previewTaskLine(
            "  ☑ fertig",
            listOf(DetailsInline(4, 10, "strong")),
        )
        assertEquals(true, done?.checked)
        assertEquals("  ", done?.indent)
        assertEquals("fertig", done?.text)
        assertEquals(0, done?.inlines?.single()?.start)
        assertEquals(6, done?.inlines?.single()?.end)
        assertEquals(null, previewTaskLine("keine Aufgabe", emptyList()))
        assertEquals(0f, previewFlowStart("paragraph"))
        assertEquals(0f, previewFlowTop("heading", false))
        val tableChrome = previewTableChrome()
        assertEquals(1.2f, tableChrome.marginEm)
        assertEquals(10f, tableChrome.radiusDp)
        assertEquals(0.55f, tableChrome.padYEm)
        assertEquals(0.7f, tableChrome.padXEm)
        val lines = aiPreviewReading("# Titel\n\nSiehe **fett** und [^a].\n\n[^a]: Die Quelle\n\n| A | B |\n| --- | --- |\n| 1 | 2 |")
        assertEquals("Titel", lines.first().text)
        assertEquals(2.15f, lines.first().scale)
        val body = lines.first { it.text.startsWith("Siehe") }
        assertEquals("Siehe fett und 1.", body.text)
        assertEquals("strong", body.inlines.first { it.kind == "strong" }.kind)
        val number = body.inlines.first { it.kind == "footnote" }
        assertEquals("1", body.text.substring(number.start, number.end))
        assertEquals("1. Die Quelle ↩", lines.first { it.kind == "footnote" }.text)
        val table = lines.first { it.kind == "table" }
        val shown = expandFieldSeparators(table.text, table.inlines)
        assertEquals("A · B", shown.first)
        assertEquals("left\u001fleft", table.source)
        assertEquals(0.9f, PREVIEW_TABLE_HEAD)
        val row = previewTableCells(
            "Name\u001fWert",
            listOf(DetailsInline(0, 4, "strong"), DetailsInline(5, 9, "link", "https://example.com")),
            "left\u001fright",
        )
        assertEquals("Name", row[0].text)
        assertEquals(TableAlign.LEFT, row[0].align)
        assertEquals(0 to 4, row[0].inlines.single().let { it.start to it.end })
        assertEquals("Wert", row[1].text)
        assertEquals(TableAlign.RIGHT, row[1].align)
        assertEquals("https://example.com", row[1].inlines.single().target)
        assertEquals(0 to 4, row[1].inlines.single().let { it.start to it.end })
        assertEquals(2, previewMarkerEnd("• Punkt", "bullet"))
        assertEquals(6, previewMarkerEnd("  12. Zwei", "number"))
        assertEquals(0, previewMarkerEnd("Satz", "paragraph"))
        assertEquals(0, previewMarkerEnd("•Punkt", "bullet"))
    }

    @Test
    fun schoenCodeAndMathScrollOnOneLine() {
        assertTrue(previewBlockScrolls("code"))
        assertTrue(previewBlockScrolls("math"))
        assertEquals(false, previewBlockScrolls("paragraph"))
        assertTrue(previewBlockCenters("math"))
        assertEquals(false, previewBlockCenters("code"))
        val lines = aiPreviewReading("```\nalpha beta gamma\n```\n\n$$\nx + 1\n$$")
        val code = lines.first { it.kind == "code" }
        assertEquals("alpha beta gamma", code.text)
        assertTrue(previewBlockScrolls(code.kind))
        val math = lines.first { it.kind == "math" }
        assertEquals("x + 1", math.text)
        assertTrue(previewBlockCenters(math.kind))
    }

    @Test
    fun schoenPicturesKeepTheirSourceAndThePreviewFrame() {
        val image = aiPreviewReading("Siehe\n\n![Tafel](bilder/tafel.png)\n\nhttps://example.com/a.png").first { it.kind == "image" }
        assertEquals("Tafel", image.text)
        assertEquals("bilder/tafel.png", image.source)
        val web = aiPreviewReading("![Foto](https://example.com/a.png)").single()
        assertEquals("image", web.kind)
        assertEquals("https://example.com/a.png", web.source)
        val chrome = previewImageChrome()
        assertEquals(12f, chrome.radiusDp)
        assertEquals(1.4f, chrome.marginEm)
        assertEquals(1f, chrome.borderDp)
        assertEquals(13f, chrome.shadowYDp)
        assertEquals(32f, chrome.shadowBlurDp)
        assertEquals(0.16f, chrome.shadowAlpha)
        assertEquals(1.25f, previewLineHeightEm("heading", 1.72))
        assertEquals(1.72f, previewLineHeightEm("paragraph", 1.72))
        assertEquals(2f, previewLineHeightEm("quote", 2.0))
        assertEquals(1.72f, previewLineHeightEm("code", 1.72))
    }

    @Test
    fun schoenInlineCodeUsesThePreviewChip() {
        val box = previewCodeBox(16f)
        assertEquals(16f * PREVIEW_CODE_SCALE, box.textPx, 0.01f)
        assertEquals(box.textPx * 0.38f, box.padX, 0.01f)
        assertEquals(box.textPx * 0.16f, box.padY, 0.01f)
        assertEquals(5f, box.radius)
        assertEquals(1f, box.border)
        assertEquals("#5c6169", previewCodeInk("#6b7280", "#37352f"))
        assertEquals("#2f2f2f", themePalette("dark", true).panelStrong)
        assertEquals("#ffffff", themePalette("light", false).panelStrong)
        assertEquals("#fffdf8", themePalette("sepia", false).panelStrong)

        val (plain, marks) = detailsPlain("Siehe `api` und **fett**")
        val display = previewCodeDisplay(plain, marks, previewMarkerEnd(plain, "paragraph"))
        assertEquals("Siehe \uFFFC und fett", display.text)
        assertEquals("api", display.slots.single().label)
        assertEquals("c0", display.slots.single().id)
        val strong = display.marks.single { it.kind == "strong" }
        assertEquals("fett", display.text.substring(strong.start, strong.end))
        assertEquals(plain.indexOf("fett"), previewSourceOffset(display.sourceAt, strong.start))
        assertTrue(display.marks.none { it.kind == "code" })

        val untouched = previewCodeDisplay("Hallo", emptyList(), 0)
        assertEquals("Hallo", untouched.text)
        assertEquals(2, previewSourceOffset(untouched.sourceAt, 2))
    }
}