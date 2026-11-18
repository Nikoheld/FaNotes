package ch.fasrv.fanotes.study.crypto

import java.math.BigInteger

/** Diffie-Hellman key exchange (port of `dh.ts`). Expected values only serve to check the student's fields. */

enum class DhField(val id: String) { ALPHA("alpha"), BETA("beta"), SA("sa"), SB("sb") }

/** What is wrong with the inputs (empty when all is fine). */
fun dhProblems(y: String, p: String, a: String, b: String): List<String> {
    val problems = ArrayList<String>()
    val vy = bigOrNull(y)
    val vp = bigOrNull(p)
    val va = bigOrNull(a)
    val vb = bigOrNull(b)
    if (vp == null) problems += "P muss eine ganze Zahl sein." else if (vp < BigInteger.TWO) problems += "P muss mindestens 2 sein."
    if (vy == null) problems += "Y muss eine ganze Zahl sein."
    else if (vp != null && vp >= BigInteger.TWO && vy >= vp) problems += "Y muss kleiner als P sein."
    else if (vy < BigInteger.ONE) problems += "Y muss mindestens 1 sein."
    if (va == null) problems += "A muss eine ganze Zahl sein."
    if (vb == null) problems += "B muss eine ganze Zahl sein."
    return problems
}

fun dhExpected(y: String, p: String, a: String, b: String): Map<DhField, String>? {
    if (dhProblems(y, p, a, b).isNotEmpty()) return null
    val vy = bigOrNull(y)!!
    val vp = bigOrNull(p)!!
    val va = bigOrNull(a)!!
    val vb = bigOrNull(b)!!
    val alpha = modPow(vy, va, vp)
    val beta = modPow(vy, vb, vp)
    return mapOf(
        DhField.ALPHA to alpha.toString(), DhField.BETA to beta.toString(),
        DhField.SA to modPow(beta, va, vp).toString(), DhField.SB to modPow(alpha, vb, vp).toString(),
    )
}

fun checkDhField(y: String, p: String, a: String, b: String, field: DhField, value: String): FieldState {
    val typed = value.trim()
    if (typed.isEmpty()) return FieldState.OPEN
    val expected = dhExpected(y, p, a, b)
    return if (expected != null && typed.all { it in '0'..'9' } && BigInteger(typed) == BigInteger(expected.getValue(field))) FieldState.OK else FieldState.BAD
}

/** Whether the student's s_a and s_b (both filled) agree. Null while one is missing. */
fun secretsAgree(sa: String, sb: String): Boolean? = if (sa.isNotBlank() && sb.isNotBlank()) sa.trim() == sb.trim() else null
