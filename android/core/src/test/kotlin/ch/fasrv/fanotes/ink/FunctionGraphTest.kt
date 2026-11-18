package ch.fasrv.fanotes.ink

import java.net.URLDecoder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Parity with fanotes/src/lib/functionGraph.ts. Fixtures come from the TS via node (ink-math-parity.tsv). */
class FunctionGraphTest {
    private fun rows(kind: String): List<List<String>> {
        val text = javaClass.classLoader.getResource("ink-math-parity.tsv")!!.readText()
        return text.lines().filter { it.startsWith("$kind\t") }.map { it.split('\t') }
    }

    private fun decode(text: String) = URLDecoder.decode(text.replace("+", "%2B"), "UTF-8")

    @Test
    fun graphPathsMatchTheDesktop() {
        val graphs = rows("graph")
        assertTrue(graphs.size >= 30)
        for (row in graphs) {
            val expression = decode(row[1])
            val expected = row[4].split('|').filter { it.isNotEmpty() }
            assertEquals(expected, functionGraphPaths(expression, row[2].toDouble(), row[3].toDouble()), "$expression ${row[2]}..${row[3]}")
        }
        assertEquals(listOf("sin(x)", "cos(x)", "x^2", "1/x", "exp(-x^2)"), GRAPH_PRESETS)
    }

    @Test
    fun errorsMatchTheDesktop() {
        val errors = rows("error")
        assertTrue(errors.size >= 20)
        for (row in errors) {
            val expression = decode(row[1])
            val ex = assertFailsWith<IllegalArgumentException>("$expression ${row[2]}") {
                functionGraphPaths(expression, row[2].toDouble(), row[3].toDouble())
            }
            assertEquals(row[4], ex.message, expression)
        }
    }

    @Test
    fun compiledFormulasEvaluate() {
        assertEquals(4.0, compileFunctionGraph("x^2")(2.0))
        assertEquals(-4.0, compileFunctionGraph("-x^2")(2.0))
        assertEquals(6.0, compileFunctionGraph("2x + 2")(2.0), 1e-12)
        assertEquals(GRAPH_ERROR_EMPTY, assertFailsWith<IllegalArgumentException> { compileFunctionGraph("  ") }.message)
    }

    @Test
    fun stampRebuildsFromTheFormulaOrFallsBackToStoredPaths() {
        val built = readFunctionGraphStamp(" x^2 ", -2.0, 2.0, null)
        assertNotNull(built)
        assertEquals("x^2", built.expression)
        assertEquals(functionGraphPaths("x^2", -2.0, 2.0), built.paths)

        val stored = listOf("M 1 2 L 3 4")
        val fallback = readFunctionGraphStamp("foo(x)", -2.0, 2.0, stored)
        assertEquals(FunctionGraphStamp("foo(x)", -2.0, 2.0, stored), fallback)
        assertNull(readFunctionGraphStamp("foo(x)", -2.0, 2.0, null))
        assertNull(readFunctionGraphStamp("foo(x)", -2.0, 2.0, listOf("M 1 2 <script>")))
        assertEquals(FunctionGraphStamp("", 0.0, 1.0, stored), readFunctionGraphStamp(null, null, null, stored))
        assertNull(readFunctionGraphStamp(null, null, null, emptyList()))
    }
}
