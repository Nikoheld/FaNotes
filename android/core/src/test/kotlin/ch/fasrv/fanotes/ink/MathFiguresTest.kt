package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Parity with fanotes/src/lib/mathFigures.ts. Fixtures come from the TS via node (ink-math-parity.tsv). */
class MathFiguresTest {
    private fun rows(kind: String): List<List<String>> {
        val text = javaClass.classLoader.getResource("ink-math-parity.tsv")!!.readText()
        return text.lines().filter { it.startsWith("$kind\t") }.map { it.split('\t') }
    }

    private fun parseMap(text: String): Map<String, Double>? = when (text) {
        "-" -> null
        "+" -> emptyMap()
        else -> text.split(',').associate { it.substringBefore('=') to it.substringAfter('=').toDouble() }
    }

    @Test
    fun pathsMatchTheDesktopForEveryFixture() {
        val figures = rows("fig")
        assertTrue(figures.size >= 79)
        for (row in figures) {
            val expected = row[3].split('|').filter { it.isNotEmpty() }
            assertEquals(expected, mathFigurePaths(row[1], parseMap(row[2])), "${row[1]} ${row[2]}")
        }
    }

    @Test
    fun everyIdHasADefinitionAndDefaults() {
        assertEquals(52, MATH_FIGURE_IDS.size)
        assertEquals(MATH_FIGURE_IDS, MATH_FIGURES.map { it.id })
        for (id in MATH_FIGURE_IDS) {
            assertTrue(isMathFigureId(id))
            assertTrue(defaultFigureParams(id).keys == mathFigureById(id).params.map { it.id }.toSet(), id)
            assertTrue(mathFigurePaths(id, null).isNotEmpty(), id)
        }
        assertFalse(isMathFigureId("nope"))
        assertFalse(isMathFigureId(null))
        assertEquals(emptyList(), mathFigurePaths("nope", null))
        assertFailsWith<IllegalArgumentException> { mathFigureById("nope") }
        assertEquals("Würfel", mathFigureById("cube").label)
        assertEquals("solid", mathFigureById("cube").group)
        assertEquals(MathFigureParam("aspect", "Verhältnis", 0.35, 1.0, 0.05, 0.62), mathFigureById("ellipse").params[0])
    }

    @Test
    fun clampingMatchesTheDesktop() {
        val cases = rows("clamp")
        assertTrue(cases.size >= 11)
        for (row in cases) {
            assertEquals(parseMap(row[3]), clampFigureParams(row[1], parseMap(row[2])), "${row[1]} ${row[2]}")
        }
    }

    @Test
    fun lineWidthHelpersMatchTheDesktop() {
        for (row in rows("line")) {
            val input = row[2].toDouble()
            val expected = row[4].toDouble()
            val actual = if (row[1] == "size") figureLineWidthForSize(input) else clampFigureLineWidth(input, row[3].toDouble())
            assertEquals(expected, actual, "${row[1]} ${row[2]}")
        }
        assertEquals(1.75, clampFigureLineWidth(null, 1.75))
        assertEquals(0.5, FIGURE_LINE_MIN)
        assertEquals(36.0, FIGURE_LINE_MAX)
        assertEquals(0.25, FIGURE_LINE_STEP)
    }
}
