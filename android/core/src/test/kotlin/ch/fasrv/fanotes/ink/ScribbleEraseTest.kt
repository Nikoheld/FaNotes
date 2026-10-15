package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ScribbleEraseTest {
    private val pageWidth = 900.0
    private val pageHeight = 1273.0

    @Test
    fun scribblingOverAWordDeletesOnlyThatWord() {
        val word = listOf(
            line(190, 190, 190, 228), line(180, 190, 202, 190),
            line(214, 202, 214, 226), line(214, 202, 232, 202), line(214, 214, 229, 214), line(214, 226, 232, 226),
            stroke(listOf(252 to 204, 243 to 202, 240 to 210, 252 to 215, 255 to 223, 244 to 228)),
            line(270, 190, 270, 228), line(262, 200, 280, 200),
        )
        val nextWord = listOf(line(330, 190, 330, 228), line(350, 190, 350, 228))
        val lineAbove = listOf(line(185, 151, 280, 151))
        val scribble = stroke(
            listOf(174 to 202, 278 to 222, 181 to 219, 281 to 199, 179 to 206, 279 to 225, 183 to 216, 276 to 201),
            3.5,
        )
        val match = detectScribbleErase(scribble, word + nextWord + lineAbove, pageWidth, pageHeight)
        assertNotNull(match)
        assertEquals(word.indices.toList(), match.indexes)
        assertTrue(match.intersectionCount >= 3)
        assertTrue(match.reversalCount >= 3)
        val shortScribble = stroke(
            listOf(180 to 203, 225 to 212, 274 to 220, 230 to 214, 184 to 207, 226 to 204, 270 to 201, 238 to 207),
            3.5,
        )
        assertNull(detectScribbleErase(shortScribble, word, pageWidth, pageHeight, 0))
        assertNotNull(detectScribbleErase(shortScribble, word, pageWidth, pageHeight, 100))
        assertNotNull(detectScribbleErase(scribble, word, pageWidth, pageHeight, 0))
        assertNull(detectScribbleErase(stroke(listOf(174 to 210, 281 to 211)), word, pageWidth, pageHeight))
        assertNull(detectScribbleErase(scribble, nextWord, pageWidth, pageHeight))
    }

    private fun line(x1: Int, y1: Int, x2: Int, y2: Int) = stroke(listOf(x1 to y1, x2 to y2))

    private fun stroke(pixels: List<Pair<Int, Int>>, width: Double = 4.0) = InkStroke(
        points = pixels.mapIndexed { index, (x, y) ->
            StrokePoint(
                x / pageWidth,
                y / pageHeight,
                index * 12.0,
                0.55,
                0.0,
                0.0,
                "pen",
            )
        },
        baseWidth = width,
        pressureEnabled = true,
        color = "#191c24",
    )
}
