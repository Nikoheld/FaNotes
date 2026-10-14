package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class MathEngineTest {
    @Test
    fun arithmeticRespectsPrecedenceAndFractions() {
        assertEquals("14", solveMathExpression("2+3*4", "calculate").steps.single().expression)
        assertEquals("5/6", solveMathExpression("(1/2)+(1/3)", "calculate").steps.single().expression)
        assertEquals("3", solveMathExpression("√9", "calculate").steps.single().expression)
    }

    @Test
    fun calculateRejectsUnknownsAndEquations() {
        val variables = assertFailsWith<MathEngineException> { solveMathExpression("2x", "calculate") }
        assertTrue(variables.message!!.contains("Ausrechnen"))
        val equation = assertFailsWith<MathEngineException> { solveMathExpression("x=1", "calculate") }
        assertTrue(equation.message!!.contains("Gleichung"))
    }

    @Test
    fun linearEquationShowsTheDivisionStep() {
        val steps = solveMathExpression("2*x+3=11", "solve").steps
        assertEquals("2*x=8", steps.first().expression)
        assertEquals("x=4", steps.last().expression)
        assertEquals("x=−4", solveMathExpression("x+5=1", "solve").steps.single().display)
    }

    @Test
    fun quadraticSolveAndFactorMatch() {
        val solved = solveMathExpression("x^2-1=0", "solve").steps.map { it.expression }
        assertEquals(listOf("x=1", "x=-1"), solved)
        assertEquals("(x-1)*(x+1)", solveMathExpression("x^2-1", "factor").steps.single().expression)
        assertEquals("x^2+2*x+1", solveMathExpression("(x+1)^2", "expand").steps.single().expression)
        assertEquals("5*x", solveMathExpression("2x+3x", "simplify").steps.single().expression)
    }

    @Test
    fun unsupportedInputFailsInsteadOfGuessing() {
        assertFailsWith<MathEngineException> { solveMathExpression("foo(1)", "calculate") }
        assertFailsWith<MathEngineException> { solveMathExpression("sin(x)=0", "solve") }
    }
}
