package ch.fasrv.fanotes.recognition

import java.text.Normalizer

/**
 * `fanotes/src/lib/mathSolverInput.ts`: the safe input check that runs before the solver, so the
 * solver panel can validate a corrected expression on every keystroke without the host.
 * Messages are the desktop's.
 */
const val MATH_SOLVER_MAX_VARIABLES = 8
private const val MAX_INPUT_LENGTH = 512
private val SAFE_FUNCTIONS = setOf(
    "abs", "acos", "asin", "atan", "cos", "cosh", "exp", "factorial", "log", "max", "min", "sin", "sinh",
    "sqrt", "tan", "tanh",
)
private val CONSTANTS = setOf("e", "i", "pi")
/** `localeCompare`: letters alphabetically, a lower-case letter before its capital. */
private val COLLATOR = java.text.Collator.getInstance(java.util.Locale.ENGLISH)

class MathInputException(message: String) : IllegalArgumentException(message)

data class MathInputInspection(val normalizedInput: String, val variables: List<String>, val isEquation: Boolean)

private fun normalizeUnicode(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFKC)
    .replace(Regex("[−–—]"), "-")
    .replace(Regex("[×·⋅]"), "*")
    .replace("÷", "/")
    .replace("π", "pi")
    .replace(Regex("√\\s*\\("), "sqrt(")
    .replace(Regex("√\\s*([A-Za-z0-9.]+)"), "sqrt($1)")
    .replace(Regex("\\s+"), "")

private fun nestingDepth(value: String): Int {
    var depth = 0
    var maximum = 0
    for (char in value) {
        if (char == '(') {
            depth += 1
            maximum = maxOf(maximum, depth)
        } else if (char == ')') {
            depth -= 1
            if (depth < 0) return -1
        }
    }
    return if (depth == 0) maximum else -1
}

fun normalizeMathInput(input: String): String {
    if (input.isBlank()) throw MathInputException("Der ausgewählte mathematische Ausdruck ist leer.")
    if (input.length > MAX_INPUT_LENGTH) throw MathInputException("Der ausgewählte Ausdruck ist für eine sichere lokale Berechnung zu lang.")
    val normalized = normalizeUnicode(input)
    if (normalized.isEmpty() || normalized.length > MAX_INPUT_LENGTH) throw MathInputException("Der Ausdruck ist zu lang.")
    if (!Regex("^[0-9A-Za-z_+\\-*/^().,=!]+$").matches(normalized)) {
        throw MathInputException("Der Ausdruck enthält ein Zeichen, das der lokale Mathematik-Löser noch nicht sicher unterstützt.")
    }
    if (normalized.count { it == '=' } > 1 || Regex("==|!=|:=|\\*\\*|//").containsMatchIn(normalized)) {
        throw MathInputException("Bitte wähle genau einen Term oder eine einzelne Gleichung aus.")
    }
    val depth = nestingDepth(normalized)
    if (depth < 0 || depth > 24) throw MathInputException("Die Klammerung des Ausdrucks ist ungültig oder zu tief verschachtelt.")
    for (match in Regex("([A-Za-z_][A-Za-z0-9_]*)\\(").findAll(normalized)) {
        val name = match.groupValues[1]
        if (name !in SAFE_FUNCTIONS) throw MathInputException("Die Funktion „$name“ ist im sicheren Mathematikmodus nicht erlaubt.")
    }
    for (match in Regex("\\^\\(?(-?\\d{1,4})\\)?").findAll(normalized)) {
        if (kotlin.math.abs(match.groupValues[1].toInt()) > 100) {
            throw MathInputException("Exponenten über 100 werden zum Schutz vor blockierenden Berechnungen nicht verarbeitet.")
        }
    }
    return normalized
}

fun inspectMathInputSyntax(input: String): MathInputInspection {
    val normalized = normalizeMathInput(input)
    val variables = Regex("[A-Za-z_][A-Za-z0-9_]*").findAll(normalized)
        .map { it.value }
        .filter { it !in SAFE_FUNCTIONS && it !in CONSTANTS }
        .filter { Regex("^[A-Za-z][A-Za-z0-9_]{0,15}$").matches(it) }
        .distinct()
        .sortedWith { left, right ->
            when {
                left == "x" -> -1
                right == "x" -> 1
                else -> COLLATOR.compare(left, right)
            }
        }
        .toList()
    if (variables.size > MATH_SOLVER_MAX_VARIABLES) throw MathInputException("Der Ausdruck enthält zu viele verschiedene Variablen.")
    return MathInputInspection(normalized, variables, normalized.contains('='))
}
