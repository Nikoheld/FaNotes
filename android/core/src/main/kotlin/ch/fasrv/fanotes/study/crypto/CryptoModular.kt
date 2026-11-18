package ch.fasrv.fanotes.study.crypto

import java.math.BigInteger

/** Modulo arithmetic with "reduce first" (port of `modular.ts`). The expected values only check what the student entered. */

enum class ModOp(val id: String) { TIMES("*"), PLUS("+"), POWER("^") }

enum class ModField(val id: String) { S1("s1"), S2("s2"), S3("s3"), S4("s4") }

const val MOD_POWER_MAX = 200

data class ModFieldSpec(val key: ModField, val label: String)

fun modFields(op: ModOp): List<ModFieldSpec> = if (op == ModOp.POWER) {
    listOf(ModFieldSpec(ModField.S1, "a mod m"), ModFieldSpec(ModField.S3, "(a mod m) hoch b"), ModFieldSpec(ModField.S4, "Resultat mod m"))
} else {
    listOf(
        ModFieldSpec(ModField.S1, "a mod m"),
        ModFieldSpec(ModField.S2, "b mod m"),
        ModFieldSpec(ModField.S3, if (op == ModOp.TIMES) "Produkt" else "Summe"),
        ModFieldSpec(ModField.S4, "Resultat mod m"),
    )
}

private val NUMBER = Regex("^[0-9]{1,12}$")

internal fun bigOrNull(value: String): BigInteger? = if (NUMBER.matches(value)) BigInteger(value) else null

fun modPow(base: BigInteger, exponent: BigInteger, modulus: BigInteger): BigInteger = base.mod(modulus).modPow(exponent, modulus)

/** Problem with the inputs, or "" when the scaffold can be used. */
fun modProblem(op: ModOp, a: String, b: String, m: String): String {
    val va = bigOrNull(a)
    val vb = bigOrNull(b)
    val vm = bigOrNull(m)
    if (va == null || vb == null || vm == null) return "Gib a, b und m als ganze Zahlen ein."
    if (vm < BigInteger.valueOf(2)) return "m muss mindestens 2 sein."
    if (op == ModOp.POWER && vb > BigInteger.valueOf(MOD_POWER_MAX.toLong())) return "Der Exponent ist für die Zwischenrechnung zu gross (höchstens $MOD_POWER_MAX)."
    return ""
}

fun modExpected(op: ModOp, a: String, b: String, m: String): Map<ModField, String>? {
    if (modProblem(op, a, b, m).isNotEmpty()) return null
    val x = bigOrNull(a)!!
    val y = bigOrNull(b)!!
    val mod = bigOrNull(m)!!
    val s1 = x.mod(mod)
    val s2 = y.mod(mod)
    val s3 = when (op) {
        ModOp.POWER -> s1.pow(y.toInt())
        ModOp.TIMES -> s1 * s2
        ModOp.PLUS -> s1 + s2
    }
    return mapOf(ModField.S1 to s1.toString(), ModField.S2 to s2.toString(), ModField.S3 to s3.toString(), ModField.S4 to s3.mod(mod).toString())
}

enum class FieldState { OK, BAD, OPEN }

/** Checks one filled field. An empty field stays OPEN; the expected value is not part of the result. */
fun checkModField(op: ModOp, a: String, b: String, m: String, key: ModField, value: String): FieldState {
    val typed = value.trim()
    if (typed.isEmpty()) return FieldState.OPEN
    val expected = modExpected(op, a, b, m)
    return if (expected != null && typed.all { it in '0'..'9' } && BigInteger(typed) == BigInteger(expected.getValue(key))) FieldState.OK else FieldState.BAD
}

val MOD_RULES = listOf(
    "(a + b) mod m = ((a mod m) + (b mod m)) mod m",
    "(a · b) mod m = ((a mod m) · (b mod m)) mod m",
    "(a hoch b) mod m = ((a mod m) hoch b) mod m",
)
