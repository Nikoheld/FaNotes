package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.json.stringify
import java.util.zip.CRC32
import java.util.zip.Deflater
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class InkSessionTest {
    @Test
    fun strokeRoundTripsInDesktopJson() {
        val now = "2026-01-02T03:04:05.000Z"
        val session = InkSession(newInkDocument("Hello", "dots", now))
        session.beginStroke()
        session.addSample(StrokePoint(0.2, 0.3, 12.5, 0.5, 0.0, 0.0, "pen"))
        session.endStroke(StrokeStyle(), now)
        val json = session.document.toJson().stringify()
        assertEquals(
            """{"schemaVersion":1,"title":"Hello","paperStyle":"dots","sourceWidth":900,"sourceHeight":1273,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","overlayQuality":1.75,"overlayQualityZoom":6,"strokes":[{"points":[{"x":0.2,"y":0.3,"t":12.5,"pressure":0.5,"tiltX":0,"tiltY":0,"pointerType":"pen"}],"baseWidth":3.5,"pressureEnabled":true,"color":"#202333","purpose":"handwriting","brush":"fineliner","opacity":1,"colorEffect":"solid"}]}""",
            json,
        )
    }

    @Test
    fun eraserSplitsAStrokeAndUndoRestoresIt() {
        val session = InkSession(newInkDocument("Page", "dots", isoNow(0)))
        session.beginStroke()
        session.addSample(point(0.30, 0.50))
        session.addSample(point(0.40, 0.50))
        session.addSample(point(0.50, 0.50))
        session.endStroke(StrokeStyle(), isoNow(1))
        val erased = session.erase(listOf(point(0.40, 0.50)), radiusPagePx = 20.0, now = isoNow(2))
        assertTrue(erased)
        assertEquals(2, session.document.strokes.size)
        assertTrue(session.undo())
        assertEquals(1, session.document.strokes.size)
        assertTrue(session.redo())
        assertEquals(2, session.document.strokes.size)
    }

    @Test
    fun undoAfterACancelledGrowKeepsTheEarlierStrokeOnTheSamePixels() {
        val session = InkSession(newInkDocument("Page", "dots", isoNow(0)))
        session.beginStroke()
        session.addSample(point(0.2, 0.2))
        session.endStroke(StrokeStyle(), isoNow(1))
        session.beginStroke()
        session.addSample(point(0.4, 0.4))
        session.endStroke(StrokeStyle(), isoNow(2))
        val earlier = session.document.strokes[0].points[0]
        val pageX = earlier.x * session.document.sourceWidth
        val pageY = earlier.y * session.document.sourceHeight
        session.beginStroke()
        session.addSample(StrokePoint(0.2, 0.99, 3.0, 0.5, 0.0, 0.0, "pen"))
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        session.cancelStroke()
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        val beforeUndo = session.document.strokes
        assertTrue(session.undo())
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        val restored = session.document.strokes.single().points.single()
        assertEquals(pageX, restored.x * session.document.sourceWidth, 0.01)
        assertEquals(pageY, restored.y * session.document.sourceHeight, 0.01)
        assertTrue(session.redo())
        assertEquals(beforeUndo, session.document.strokes)
        val redone = session.document.strokes[0].points[0]
        assertEquals(pageX, redone.x * session.document.sourceWidth, 0.01)
        assertEquals(pageY, redone.y * session.document.sourceHeight, 0.01)
    }

    @Test
    fun undoAfterSynthesizedGrowthKeepsEarlierInkOnTheSamePixels() {
        val session = InkSession(newInkDocument("Page", "dots", isoNow(0)))
        session.beginStroke()
        session.addSample(point(0.2, 0.3))
        session.endStroke(StrokeStyle(), isoNow(1))
        val pageX = session.document.strokes[0].points[0].x * session.document.sourceWidth
        val pageY = session.document.strokes[0].points[0].y * session.document.sourceHeight
        val added = InkStroke(
            points = listOf(StrokePoint(0.4, 0.5, 1.0, 0.5, 0.0, 0.0, "pen")),
            baseWidth = 3.0,
            pressureEnabled = true,
            color = "#202333",
        )
        val result = HandwritingSynthesisResult(
            strokes = listOf(added),
            normalizedText = "A",
            missingCharacters = emptyList(),
            overflow = false,
            overflowCharacters = 0,
            glyphCount = 1,
            lineCount = 1,
            connectionCount = 0,
            usedSampleIds = emptyList(),
            fontSizeUsed = 32.0,
            bounds = null,
            pageWidth = session.document.sourceWidth,
            pageHeight = session.document.sourceHeight + 400.0,
        )
        assertTrue(session.insertSynthesized(result, isoNow(2)))
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        assertTrue(session.undo())
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        val restored = session.document.strokes.single().points.single()
        assertEquals(pageX, restored.x * session.document.sourceWidth, 0.01)
        assertEquals(pageY, restored.y * session.document.sourceHeight, 0.01)
    }

    @Test
    fun undoAfterAConstructedShapeGrowsThePageKeepsEarlierInkOnTheSamePixels() {
        val session = InkSession(newInkDocument("Page", "dots", isoNow(0)))
        session.beginStroke()
        session.addSample(point(0.25, 0.35))
        session.endStroke(StrokeStyle(), isoNow(1))
        val pageX = session.document.strokes[0].points[0].x * session.document.sourceWidth
        val pageY = session.document.strokes[0].points[0].y * session.document.sourceHeight
        val shape = session.commitShape(
            listOf(
                StrokePoint(0.4, 0.4, 1.0, 0.5, 0.0, 0.0, "pen"),
                StrokePoint(0.4, 0.99, 2.0, 0.5, 0.0, 0.0, "pen"),
            ),
            StrokeStyle(),
            isoNow(2),
        )
        assertNotNull(shape)
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        assertTrue(session.undo())
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        val restored = session.document.strokes.single().points.single()
        assertEquals(pageX, restored.x * session.document.sourceWidth, 0.01)
        assertEquals(pageY, restored.y * session.document.sourceHeight, 0.01)
    }

    @Test
    fun growingThePageKeepsExistingInkInPlace() {
        val session = InkSession(newInkDocument("Page", "dots", isoNow(0)))
        session.beginStroke()
        session.addSample(point(0.2, 0.2))
        session.endStroke(StrokeStyle(), isoNow(1))
        val before = session.document.strokes[0].points[0]
        val beforeY = before.y * session.document.sourceHeight
        session.beginStroke()
        session.addSample(StrokePoint(0.2, 0.99, 2.0, 0.5, 0.0, 0.0, "pen"))
        assertTrue(session.document.sourceHeight > PAGE_START_HEIGHT)
        val afterY = session.document.strokes[0].points[0].y * session.document.sourceHeight
        assertEquals(beforeY, afterY, 0.01)
    }

    @Test
    fun writingInTheLeftMarginInsertsOriginPaper() {
        val session = InkSession(newInkDocument("Page", "dots", isoNow(0)))
        session.beginStroke()
        session.addSample(point(0.5, 0.5))
        session.endStroke(StrokeStyle(), isoNow(1))
        val beforeX = session.document.strokes[0].points[0].x * session.document.sourceWidth
        session.beginStroke()
        session.addSample(point(0.02, 0.5))
        assertEquals(108.0, session.document.originX)
        assertEquals(PAGE_START_WIDTH + 108.0, session.document.sourceWidth)
        val afterX = session.document.strokes[0].points[0].x * session.document.sourceWidth
        assertEquals(beforeX + 108.0, afterX, 0.01)
        assertEquals(108.0, paperOriginScrollDelta(session.document.originX))
    }

    @Test
    fun corridorLeapDoesNotJoinDistantPoints() {
        val session = InkSession(newInkDocument("Page", "dots", isoNow(0)))
        session.beginStroke()
        assertTrue(session.addSample(point(0.6, 0.4)))
        assertTrue(session.addSample(point(0.62, 0.42)))
        val accepted = session.addSample(point(0.1, 0.02))
        assertTrue(!accepted)
        assertEquals(2, session.livePoints.size)
    }

    @Test
    fun interiorSamplesPullTowardTheNextPointWhenSmoothingIsOn() {
        val points = listOf(
            StrokePoint(0.0, 0.0, 0.0, 0.5, 0.0, 0.0, "pen"),
            StrokePoint(10.0, 10.0, 1.0, 0.5, 0.0, 0.0, "pen"),
            StrokePoint(10.0, 0.0, 2.0, 0.5, 0.0, 0.0, "pen"),
        )
        assertEquals(10.0, smoothedPagePoint(points, 1, { it.x }, 0.0))
        assertEquals(0.0, smoothedPagePoint(points, 0, { it.x }, 1.0))
        assertEquals(10.0, smoothedPagePoint(points, 2, { it.x }, 1.0))
        val factor = strokeSmoothFactor(1.0)
        val expectedY = 10.0 * (1.0 - factor) + 5.0 * factor
        assertEquals(expectedY, smoothedPagePoint(points, 1, { it.y }, 1.0), 1e-9)
        assertEquals(0.68.coerceIn(0.0, 0.92) * 0.35, strokeSmoothFactor(0.68), 1e-9)
    }

    fun pressureWidthMatchesTheDesktopFormula() {
        assertEquals(3.5, pressureWidth(3.5, 0.9, pressureEnabled = false))
        assertEquals(3.5 * (0.4 + 0.5 * 1.12), pressureWidth(3.5, 0.5, pressureEnabled = true))
    }

    @Test
    fun ribbonRendersAVisibleStroke() {
        val points = (0 until 24).map { index ->
            val t = index / 23.0
            StrokePoint(0.15 + t * 0.7, 0.55 + 0.12 * sin(t * PI * 2), t * 400, 0.25 + 0.6 * t, 0.0, 0.0, "pen")
        }
        val stroke = InkStroke(points, 4.5, true, "#2457d6", brush = "fineliner")
        val png = renderRibbonPng(stroke, 640, 360)
        assertTrue(png.size > 500)
        assertEquals(137.toByte(), png[0])
        assertEquals('P'.code.toByte(), png[1])
        assertEquals('N'.code.toByte(), png[2])
        assertEquals('G'.code.toByte(), png[3])
        // Cursor agents keep a preview. GitHub runners cannot create that directory.
        val artifacts = java.io.File("/opt/cursor/artifacts")
        if ((artifacts.isDirectory || artifacts.mkdirs()) && artifacts.canWrite()) {
            java.io.File(artifacts, "ink-stroke.png").writeBytes(png)
        }
    }

    private fun point(x: Double, y: Double) = StrokePoint(x, y, 0.0, 0.6, 0.0, 0.0, "pen")
}

/** Software raster of the same outline the Android canvas fills. */
fun renderRibbonPng(stroke: InkStroke, width: Int, height: Int): ByteArray {
    val outline = ribbonOutline(stroke, stroke.points.let { PAGE_START_WIDTH }, PAGE_START_HEIGHT)
    val pixels = IntArray(width * height) { 0xFFFBFCFC.toInt() }
    val scale = width / PAGE_START_WIDTH
    val xs = FloatArray(outline.size / 2)
    val ys = FloatArray(outline.size / 2)
    for (index in xs.indices) {
        xs[index] = outline[index * 2] * scale.toFloat()
        ys[index] = outline[index * 2 + 1] * scale.toFloat()
    }
    var minY = height
    var maxY = 0
    for (y in ys) {
        val row = y.toInt()
        if (row < minY) minY = row
        if (row > maxY) maxY = row
    }
    for (row in minY.coerceAtLeast(0)..maxY.coerceAtMost(height - 1)) {
        val crossings = mutableListOf<Float>()
        for (index in xs.indices) {
            val next = (index + 1) % xs.size
            val y1 = ys[index]
            val y2 = ys[next]
            if ((y1 <= row && y2 > row) || (y2 <= row && y1 > row)) {
                val t = (row - y1) / (y2 - y1)
                crossings += xs[index] + t * (xs[next] - xs[index])
            }
        }
        crossings.sort()
        var cursor = 0
        while (cursor + 1 < crossings.size) {
            val start = crossings[cursor].toInt().coerceIn(0, width - 1)
            val end = crossings[cursor + 1].toInt().coerceIn(0, width - 1)
            for (column in start..end) pixels[row * width + column] = 0xFF2457D6.toInt()
            cursor += 2
        }
    }
    return encodePng(width, height, pixels)
}

private fun encodePng(width: Int, height: Int, argb: IntArray): ByteArray {
    val raw = java.io.ByteArrayOutputStream()
    for (row in 0 until height) {
        raw.write(0)
        for (column in 0 until width) {
            val pixel = argb[row * width + column]
            raw.write((pixel shr 16) and 0xff)
            raw.write((pixel shr 8) and 0xff)
            raw.write(pixel and 0xff)
        }
    }
    val deflater = Deflater()
    deflater.setInput(raw.toByteArray())
    deflater.finish()
    val compressed = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (!deflater.finished()) compressed.write(buffer, 0, deflater.deflate(buffer))
    deflater.end()
    val out = java.io.ByteArrayOutputStream()
    out.write(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
    fun chunk(type: String, data: ByteArray) {
        val length = java.nio.ByteBuffer.allocate(4).putInt(data.size).array()
        out.write(length)
        val typeBytes = type.toByteArray()
        out.write(typeBytes)
        out.write(data)
        val crc = CRC32()
        crc.update(typeBytes)
        crc.update(data)
        out.write(java.nio.ByteBuffer.allocate(4).putInt(crc.value.toInt()).array())
    }
    val ihdr = java.nio.ByteBuffer.allocate(13)
    ihdr.putInt(width)
    ihdr.putInt(height)
    ihdr.put(8)
    ihdr.put(2)
    ihdr.put(0)
    ihdr.put(0)
    ihdr.put(0)
    chunk("IHDR", ihdr.array())
    chunk("IDAT", compressed.toByteArray())
    chunk("IEND", ByteArray(0))
    return out.toByteArray()
}
