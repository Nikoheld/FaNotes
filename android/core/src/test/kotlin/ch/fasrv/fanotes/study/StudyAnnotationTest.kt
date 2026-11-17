package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.desk.PageFrame
import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StudyAnnotationTest {
    private val fixture = parseJson(requireNotNull(javaClass.getResource("/study/annotations-desktop.json")).readText()) as JsonValue.Obj
    private val size = PageSizeCm(21.0, 29.7)

    /** Order-sensitive canonical form: objects keep key order, numbers compare by value. */
    private fun canon(value: JsonValue?): Any? = when (value) {
        is JsonValue.Obj -> value.fields.map { (k, v) -> k to canon(v) }
        is JsonValue.Arr -> value.items.map { canon(it) }
        is JsonValue.Num -> value.value
        is JsonValue.Str -> value.value
        is JsonValue.Bool -> value.value
        else -> null
    }

    private fun approx(a: Double, b: Double, eps: Double = 0.05) = assertTrue(abs(a - b) < eps, "$a != $b")

    @Test
    fun desktopCleanListRoundTripsByteForByteInContent() {
        val clean = fixture.array("clean")!!
        val parsed = parseStudyAnnotations(clean)
        assertEquals(clean.items.size, parsed.size)
        assertEquals(canon(clean), canon(studyAnnotationsJson(parsed)))
    }

    @Test
    fun sanitiserMatchesDesktopOnMessyInput() {
        val parsed = parseStudyAnnotations(fixture.array("messy"))
        val expected = fixture.array("expected")!!
        assertEquals(expected.items.size, parsed.size)
        assertEquals(canon(expected), canon(studyAnnotationsJson(parsed)))
    }

    @Test
    fun unknownKindsAndBadImagesDrop() {
        assertNull(sanitizeAnnotation(parseJson("""{"kind":"hologram","id":"z"}""")))
        assertNull(sanitizeAnnotation(parseJson("""{"kind":"image","src":"javascript:alert(1)"}""")))
        assertNull(sanitizeAnnotation(parseJson("""{"kind":"image","src":"data:image/svg+xml;base64,AAAA"}""")))
        assertNull(sanitizeAnnotation(parseJson("""{"kind":"stroke","pts":[[0.1,0.1]]}""")))
        assertNull(sanitizeAnnotation(parseJson("""{"kind":"measure","mode":"angle","pts":[[0,0],[1,1]]}""")))
        assertNull(sanitizeAnnotation(null))
        assertEquals("event", (sanitizeAnnotation(parseJson("""{"kind":"stamp","stamp":"nonsense"}""")) as StudyStamp).stamp)
    }

    @Test
    fun badIdIsReplacedAndFieldsClamped() {
        val c = sanitizeAnnotation(parseJson("""{"kind":"callout","id":"bad id!","ax":4,"ay":-2,"text":"${"x".repeat(500)}","color":"red"}""")) as StudyCallout
        assertTrue(c.id.startsWith("an-"))
        assertEquals(1.0, c.ax)
        assertEquals(0.0, c.ay)
        assertEquals(120, c.text.length)
        assertEquals("#1d4ed8", c.color)
        assertEquals(1.0, c.lx) // label follows the anchor when absent
    }

    @Test
    fun capsAndDuplicates() {
        val many = JsonValue.Arr((0 until 700).map { parseJson("""{"kind":"stamp","id":"s$it","stamp":"gain"}""") }.toMutableList())
        assertEquals(ANNOTATION_LIMIT, parseStudyAnnotations(many).size)
        assertEquals(1, parseStudyAnnotations(parseJson("""[{"kind":"stamp","id":"a"},{"kind":"stamp","id":"a"}]""")).size)
        assertTrue(parseStudyAnnotations(parseJson("\"nope\"")).isEmpty())
        val png = "data:image/png;base64,iVBORw0KGgo="
        val images = JsonValue.Arr((0 until 15).map { parseJson("""{"kind":"image","id":"i$it","src":"$png"}""") }.toMutableList())
        assertEquals(ANNOTATION_IMAGE_LIMIT, parseStudyAnnotations(images).size)
    }

    @Test
    fun famdRoundTripKeepsAnnotationsInBothEncodings() {
        val list = parseStudyAnnotations(fixture.array("clean"))
        for (encoding in listOf("v1", "v2")) {
            val payload = writeStudyAnnotations(emptyFamdPayload("2026-01-02T03:04:05.000Z"), list)
            val text = serializeFamd("body", payload, encoding)
            val back = parseFamd(text).payload!!
            assertEquals(list, readStudyAnnotations(back), encoding)
            // a second save through the codec does not change them
            assertEquals(canon(back.array("annotations")), canon(parseFamd(serializeFamd("body", back, encoding)).payload!!.array("annotations")), encoding)
        }
    }

    @Test
    fun emptyListDropsTheKeyButKeepsOtherPayloadKeys() {
        val payload = writeStudyAnnotations(emptyFamdPayload("2026-01-02T03:04:05.000Z"), listOf(StudyStamp("s", 1, 0.5, 0.5, "gain")))
        assertNotNull(payload.array("annotations"))
        val cleared = writeStudyAnnotations(payload, listOf(StudyTerms(emptyList())))
        assertNull(cleared.array("annotations"))
        assertEquals("fanotes-famd-v1", cleared.string("schema"))
    }

    @Test
    fun measureMathMatchesDesktop() {
        val rad = 35 * Math.PI / 180
        val vertex = SPoint(0.3, 0.5)
        fun frac(dx: Double, dy: Double) = SPoint(vertex.x + dx / size.width, vertex.y + dy / size.height)
        val m3 = StudyMeasure("m", 1, MEASURE_ANGLE, listOf(frac(6.0, 0.0), vertex, frac(6 * Math.cos(rad), -6 * Math.sin(rad))), "#dc2626")
        approx(measureValue(m3, size), 35.0)
        assertEquals("35°", formatMeasure(m3, 35.0))
        assertEquals("35,5°", formatMeasure(m3, 35.5))
        val m4 = StudyMeasure("m", 1, MEASURE_ANGLE, listOf(SPoint(0.1, 0.1), SPoint(0.5, 0.1), SPoint(0.2, 0.4), SPoint(0.5, 0.4 - 0.3 * Math.tan(rad) * size.width / size.height)), "#dc2626")
        approx(measureValue(m4, size), 35.0)
        approx(angleAt(SPoint(0.0, 0.0), SPoint(1.0, 0.0), SPoint(0.0, 1.0)), 90.0)
        approx(angleAt(SPoint(0.0, 0.0), SPoint(1.0, 0.0), SPoint(-1.0, 0.0)), 180.0)
        assertEquals(0.0, angleAt(SPoint(0.0, 0.0), SPoint(0.0, 0.0), SPoint(1.0, 0.0)))
        val d = StudyMeasure("d", 1, MEASURE_DISTANCE, listOf(SPoint(0.0, 0.0), SPoint(0.5, 0.0)), "#dc2626")
        approx(measureValue(d, size), 10.5)
        assertEquals("10,5 cm", formatMeasure(d, 10.5))
    }

    @Test
    fun measureValuesMatchTheDesktopFixture() {
        val rows = fixture.array("measures")!!.items.map { it as JsonValue.Obj }
        assertTrue(rows.isNotEmpty())
        for (row in rows) {
            val pts = row.array("pts")!!.items.map { p -> (p as JsonValue.Arr).let { SPoint((it.items[0] as JsonValue.Num).value, (it.items[1] as JsonValue.Num).value) } }
            val item = StudyMeasure("m", 1, row.string("mode")!!, pts, "#dc2626")
            val value = measureValue(item, size)
            approx(value, row.double("value")!!, 1e-9)
            assertEquals(row.string("text"), formatMeasure(item, value))
        }
    }

    @Test
    fun numberingLegendAndTermsMatchDesktop() {
        val list = parseStudyAnnotations(parseJson("""[
          {"kind":"callout","id":"c1","page":1,"ax":0.1,"ay":0.1,"lx":0.5,"ly":0.6,"num":5,"text":"Femur"},
          {"kind":"callout","id":"c2","page":1,"ax":0.1,"ay":0.1,"lx":0.2,"ly":0.2,"num":9,"text":"Tibia"},
          {"kind":"callout","id":"c3","page":1,"ax":0.1,"ay":0.1,"lx":0.3,"ly":0.3,"text":"free"},
          {"kind":"stamp","id":"s1","page":1,"x":0.5,"y":0.5,"stamp":"letter-h"},
          {"kind":"stamp","id":"s2","page":2,"x":0.5,"y":0.5,"stamp":"letter-h"},
          {"kind":"stamp","id":"s3","page":2,"x":0.5,"y":0.5,"stamp":"loss"}]"""))
        assertEquals(10, nextCalloutNumber(list))
        val renumbered = renumberCallouts(list)
        assertEquals(listOf("c1" to 2, "c2" to 1), renumbered.filterIsInstance<StudyCallout>().filter { it.num != null }.map { it.id to it.num })
        val rows = legendRows(renumbered, mapOf("letter-h" to "hemimetabol (unvollst.)"))
        assertEquals(listOf("H", "✕", "1", "2"), rows.map { it.glyph })
        assertEquals("hemimetabol (unvollst.)", rows[0].label)
        val expected = fixture.array("termsFromText")!!.items.map { it as JsonValue.Arr }
        for (pair in expected) {
            assertEquals((pair.items[1] as JsonValue.Arr).items.map { (it as JsonValue.Str).value }, termsFromText((pair.items[0] as JsonValue.Str).value))
        }
    }

    @Test
    fun fixtureNumberingMatchesDesktop() {
        val list = parseStudyAnnotations(fixture.array("clean"))
        assertEquals(fixture.double("nextNumber")!!.toInt(), nextCalloutNumber(list))
        val desktop = fixture.array("renumbered")!!.items.map { (it as JsonValue.Arr).let { p -> (p.items[0] as JsonValue.Str).value to ((p.items[1] as? JsonValue.Num)?.value?.toInt()) } }
        assertEquals(desktop, renumberCallouts(list).filterIsInstance<StudyCallout>().map { it.id to it.num })
        val rows = fixture.array("rows")!!.items.map { (it as JsonValue.Obj).string("glyph") }
        assertEquals(rows, legendRows(list, mapOf("gain" to "dazugekommen")).map { it.glyph })
    }

    @Test
    fun historyIsAnUndoRedoStackWithALimit() {
        var h = AnnotationHistory(limit = 3)
        h = h.push(emptyList())
        h = h.push(listOf(StudyTerms(listOf("a"))))
        val (h1, back) = h.undo(listOf(StudyTerms(listOf("a", "b"))))!!
        assertEquals(listOf(StudyTerms(listOf("a"))), back)
        val (h2, again) = h1.redo(back)!!
        assertEquals(listOf(StudyTerms(listOf("a", "b"))), again)
        assertTrue(h2.canUndo)
        var cap = AnnotationHistory(limit = 3)
        repeat(5) { cap = cap.push(listOf(StudyTerms(listOf("$it")))) }
        assertEquals(3, cap.past.size)
        assertNull(AnnotationHistory().undo(emptyList()))
    }

    // ---- layout and hit testing -----------------------------------------------------------

    private val measurer = TextMeasurer { text, font, _ -> text.length * font * 0.55 }
    private val box = PageBox(100.0, 50.0, 800.0, 1131.0)

    @Test
    fun pageBoxFollowsFramesAndZoom() {
        val frames = listOf(PageFrame(1, 0.0, 1000.0, 700.0), PageFrame(2, 1040.0, 1000.0, 700.0))
        val second = studyPageBox(2, frames, 10.0, 20.0, 2.0, 900.0, 2100.0)!!
        assertEquals(PageBox(10.0, 20.0 + 2080.0, 1400.0, 2000.0), second)
        assertEquals(PageBox(10.0, 20.0, 1800.0, 4200.0), studyPageBox(1, emptyList(), 10.0, 20.0, 2.0, 900.0, 2100.0))
        assertNull(studyPageBox(2, emptyList(), 0.0, 0.0, 1.0, 900.0, 2100.0))
        assertEquals(1.75, second.k)
        // a single frame serves every page number, like note text fields
        assertNotNull(studyPageBox(5, listOf(frames[0]), 0.0, 0.0, 1.0, 900.0, 1000.0))
        assertNull(studyPageBox(5, frames, 0.0, 0.0, 1.0, 900.0, 2100.0))
    }

    @Test
    fun hitTestPicksTheTopmostObjectAndPart() {
        val items = listOf(
            StudyImage("img", 1, 0.1, 0.1, 0.5, 1.0, 1.0, false, "data:image/png;base64,AA=="),
            StudyStroke("st", 1, listOf(SPoint(0.1, 0.5), SPoint(0.9, 0.5)), "#facc15", 18.0, 0.4),
            StudyCallout("c", 1, 0.3, 0.3, 0.6, 0.2, "Caput", "#1d4ed8"),
            StudyStamp("s", 1, 0.8, 0.8, "gain"),
            StudyLegend("lg", 1, 0.05, 0.9),
            StudyMeasure("m", 1, MEASURE_ANGLE, listOf(SPoint(0.2, 0.7), SPoint(0.4, 0.75), SPoint(0.5, 0.65)), "#dc2626"),
        )
        val boxFor = { _: Int -> box }
        fun hit(fx: Double, fy: Double, selected: String? = null) = hitTest(items, boxFor, box.px(fx), box.py(fy), selected, 10.0, measurer)
        assertEquals(StudyHit("c", StudyPart.LABEL), hit(0.6, 0.2))
        assertEquals(StudyHit("c", StudyPart.ANCHOR), hit(0.3, 0.3))
        assertEquals(StudyHit("s", StudyPart.BODY), hit(0.8, 0.8))
        assertEquals(StudyHit("m", StudyPart.POINT, 1), hit(0.4, 0.75))
        assertEquals(StudyHit("st", StudyPart.STROKE), hit(0.7, 0.5))
        assertEquals(StudyHit("img", StudyPart.BODY), hit(0.2, 0.3))
        assertEquals(StudyHit("img", StudyPart.RESIZE), hit(0.6, 0.1 + 0.5 * 800.0 / 1131.0, selected = "img"))
        assertNull(hit(0.95, 0.3))
        val legendHit = hit(0.06, 0.9 + 0.005)
        assertEquals("lg", legendHit?.id)
    }

    @Test
    fun legendRowsAreHitForEditing() {
        val list = listOf(StudyStamp("s", 1, 0.8, 0.8, "gain"), StudyLegend("lg", 1, 0.05, 0.05))
        val layout = legendLayout(list[1] as StudyLegend, list, box, measurer)
        assertEquals(1, layout.rows.size)
        val row = layout.rowRects[0]
        val hit = hitTest(list, { box }, row.cx, row.cy, null, 4.0, measurer)
        assertEquals(StudyHit("lg", StudyPart.LEGEND_ROW, 0, "gain"), hit)
        assertTrue(layout.rect.h > row.h)
    }

    @Test
    fun dragRulesMoveTheRightField() {
        val c = StudyCallout("c", 1, 0.3, 0.3, 0.6, 0.2, "x", "#1d4ed8")
        assertEquals(0.4, (dragged(c, StudyPart.ANCHOR, -1, 0.1, 0.0, 0.0, 0.0) as StudyCallout).ax, 1e-9)
        assertEquals(0.7, (dragged(c, StudyPart.LABEL, -1, 0.1, 0.0, 0.0, 0.0) as StudyCallout).lx, 1e-9)
        assertEquals(1.0, (dragged(c, StudyPart.LABEL, -1, 0.9, 0.0, 0.0, 0.0) as StudyCallout).lx, 1e-9)
        val img = StudyImage("i", 1, 0.1, 0.1, 0.4, 1.0, 1.0, true, "data:image/png;base64,AA==")
        assertEquals(img, dragged(img, StudyPart.BODY, -1, 0.2, 0.2, 0.0, 0.0))
        assertEquals(0.5, (dragged(img, StudyPart.RESIZE, -1, 0.0, 0.0, 0.6, 0.0) as StudyImage).w, 1e-9)
        val m = StudyMeasure("m", 1, MEASURE_DISTANCE, listOf(SPoint(0.1, 0.1), SPoint(0.5, 0.5)), "#dc2626")
        assertEquals(SPoint(0.2, 0.1), (dragged(m, StudyPart.POINT, 0, 0.1, 0.0, 0.0, 0.0) as StudyMeasure).pts[0])
    }

    @Test
    fun placementHelpersFollowTheDesktopTools() {
        val tap = newCallout(emptyList(), 1, 0.3, 0.3, 0.3, 0.3, "#1d4ed8", true)
        assertEquals(1, tap.num)
        assertEquals(0.4, tap.lx, 1e-9)
        assertEquals(0.25, tap.ly, 1e-9)
        val drag = newCallout(listOf(tap), 1, 0.3, 0.3, 0.7, 0.5, "#1d4ed8", true)
        assertEquals(2, drag.num)
        assertEquals(0.7, drag.lx)
        val branch = newBranchStroke(2, listOf(SPoint(0.1, 0.1)), "#facc15", 18.0)
        assertEquals(2, branch.pts.size)
        assertEquals(0.4, branch.opacity)
        assertEquals(emptyList(), addItem(emptyList(), StudyImage("bad", 1, 0.0, 0.0, 0.4, 1.0, 1.0, false, "not-a-data-url")))
        assertEquals(listOf("a", "b"), termsOf(withTerms(emptyList(), listOf("a", "b"))))
        assertEquals(emptyList(), withTerms(listOf(StudyTerms(listOf("a"))), emptyList()))
    }

    @Test
    fun sheetGrowKeepsMarksOnTheSamePaper() {
        val list = listOf<StudyAnnotation>(StudyStamp("s", 1, 0.5, 0.5, "gain"))
        val grown = studyAfterSheetGrow(list, 1000.0, 1000.0, 1000.0, 2000.0, 0.0, 0.0)
        assertEquals(0.25, (grown[0] as StudyStamp).y, 1e-9)
        assertEquals(0.5, (grown[0] as StudyStamp).x, 1e-9)
        assertTrue(studyAfterSheetGrow(list, 1000.0, 1000.0, 1000.0, 1000.0, 0.0, 0.0) === list)
        assertEquals(parseJson(stampJson()).let { canon(it) }, canon(studyAnnotationJson(list[0])))
    }

    private fun stampJson() = """{"kind":"stamp","id":"s","page":1,"x":0.5,"y":0.5,"stamp":"gain","size":24}"""

    @Test
    fun calloutLabelGrowsWithTextAndZoom() {
        val c = StudyCallout("c", 1, 0.3, 0.3, 0.5, 0.5, "Caput", "#1d4ed8")
        val small = calloutLabelRect(c, box, false, measurer)
        val big = calloutLabelRect(c, box.copy(width = 1600.0, height = 2262.0), false, measurer)
        assertTrue(big.w > small.w * 1.9)
        val numbered = c.copy(num = 3)
        assertTrue(calloutLabelRect(numbered, box, false, measurer).w < calloutLabelRect(numbered, box, true, measurer).w)
    }
}
