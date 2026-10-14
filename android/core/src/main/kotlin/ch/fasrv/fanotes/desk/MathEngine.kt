package ch.fasrv.fanotes.desk

import kotlin.math.PI
import kotlin.math.E
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Local arithmetic and school algebra used by the desktop math panel.
 * Covers the actions a tablet can evaluate without the desktop CAS:
 * calculate, simplify, expand, factor over the integers, and linear or
 * quadratic equations in one variable. Anything outside that subset fails
 * with a German message instead of a guessed answer.
 */

private const val MAX_INPUT_LENGTH = 512
private val SAFE_FUNCTIONS = setOf("abs", "acos", "asin", "atan", "cos", "exp", "log", "sin", "sqrt", "tan")
private val CONSTANTS = setOf("e", "pi")

class MathEngineException(message: String) : IllegalArgumentException(message)

data class MathStep(val expression: String, val display: String, val kind: String)
data class MathResult(val action: String, val input: String, val normalizedInput: String, val steps: List<MathStep>)

private sealed class Expr {
    data class Num(val value: Double) : Expr()
    data class Var(val name: String) : Expr()
    data class Neg(val inner: Expr) : Expr()
    data class Bin(val op: Char, val left: Expr, val right: Expr) : Expr()
    data class Call(val name: String, val arg: Expr) : Expr()
}

fun solveMathExpression(input: String, action: String): MathResult {
    val normalized = normalizeMathInput(input)
    val equation = normalized.indexOf('=')
    val steps = when (action) {
        "calculate" -> listOf(step(calculate(normalized, equation), "result"))
        "solve" -> solveEquation(normalized, equation)
        "simplify", "expand" -> listOf(step(algebra(normalized, equation), "result"))
        "factor" -> listOf(step(factorExpression(normalized, equation), "result"))
        "step" -> if (equation >= 0) solveEquation(normalized, equation).let { solved ->
            listOf(solved.first().copy(kind = if (solved.size > 1) "intermediate" else solved.first().kind))
        } else listOf(step(algebra(normalized, equation), "result"))
        else -> throw MathEngineException("Diese Mathe-Aktion gibt es nicht.")
    }
    return MathResult(action, input, normalized, steps)
}

fun normalizeMathInput(input: String): String {
    if (input.isBlank()) throw MathEngineException("Der ausgewählte mathematische Ausdruck ist leer.")
    if (input.length > MAX_INPUT_LENGTH) throw MathEngineException("Der ausgewählte Ausdruck ist für eine sichere lokale Berechnung zu lang.")
    var normalized = input
        .replace('−', '-')
        .replace('–', '-')
        .replace('—', '-')
        .replace('×', '*')
        .replace('·', '*')
        .replace('⋅', '*')
        .replace('÷', '/')
        .replace("π", "pi")
        .replace(Regex("√\\s*\\("), "sqrt(")
        .replace(Regex("√\\s*([A-Za-z0-9.]+)"), "sqrt($1)")
        .replace(Regex("\\s+"), "")
    if (normalized.length > MAX_INPUT_LENGTH) throw MathEngineException("Der Ausdruck ist zu lang.")
    if (!Regex("^[0-9A-Za-z_+\\-*/^().,=!]+$").matches(normalized)) {
        throw MathEngineException("Der Ausdruck enthält ein Zeichen, das der lokale Mathematik-Löser noch nicht sicher unterstützt.")
    }
    if (normalized.count { it == '=' } > 1 || normalized.contains("==") || normalized.contains("!=") || normalized.contains(":=") || normalized.contains("**")) {
        throw MathEngineException("Bitte wähle genau einen Term oder eine einzelne Gleichung aus.")
    }
    if (normalized.contains(',') || normalized.contains('!')) {
        throw MathEngineException("Kommas und Fakultät unterstützt dieser Rechner noch nicht.")
    }
    var depth = 0
    var maximum = 0
    for (char in normalized) {
        if (char == '(') maximum = maxOf(maximum, ++depth)
        else if (char == ')' && --depth < 0) throw MathEngineException("Die Klammerung des Ausdrucks ist ungültig oder zu tief verschachtelt.")
    }
    if (depth != 0 || maximum > 24) throw MathEngineException("Die Klammerung des Ausdrucks ist ungültig oder zu tief verschachtelt.")
    Regex("([A-Za-z_][A-Za-z0-9_]*)\\(").findAll(normalized).forEach { match ->
        val name = match.groupValues[1]
        if (name !in SAFE_FUNCTIONS) throw MathEngineException("Die Funktion „$name“ ist im sicheren Mathematikmodus nicht erlaubt.")
    }
    Regex("\\^\\(?(-?\\d{1,4})\\)?").findAll(normalized).forEach { match ->
        if (abs(match.groupValues[1].toInt()) > 100) {
            throw MathEngineException("Exponenten über 100 werden zum Schutz vor blockierenden Berechnungen nicht verarbeitet.")
        }
    }
    return normalized
}

private fun calculate(normalized: String, equation: Int): String {
    if (equation >= 0) throw MathEngineException("Nutze für eine Gleichung die Aktion „Gleichung lösen“.")
    return formatNumber(eval(parse(normalized)))
}

private fun algebra(normalized: String, equation: Int): String {
    if (equation >= 0) {
        val left = polynomial(parse(normalized.substring(0, equation)))
        val right = polynomial(parse(normalized.substring(equation + 1)))
        return "${formatPoly(left)}=${formatPoly(right)}"
    }
    return formatPoly(polynomial(parse(normalized)))
}

private fun factorExpression(normalized: String, equation: Int): String {
    if (equation >= 0) throw MathEngineException("Faktorisieren gilt für einen Term. Für eine Gleichung nutze „Lösen“.")
    val poly = polynomial(parse(normalized))
    return factorPoly(poly) ?: formatPoly(poly)
}

private fun solveEquation(normalized: String, equation: Int): List<MathStep> {
    val whole = if (equation >= 0) normalized else "$normalized=0"
    val cut = whole.indexOf('=')
    val left = polynomial(parse(whole.substring(0, cut)))
    val right = polynomial(parse(whole.substring(cut + 1)))
    val diff = subtract(left, right)
    val variable = (left.keys + right.keys).firstOrNull { it.first.isNotEmpty() }?.first
        ?: throw MathEngineException("Wähle eine Variable aus, nach der die Gleichung gelöst werden soll.")
    if ((left.keys + right.keys).any { it.first.isNotEmpty() && it.first != variable }) {
        throw MathEngineException("Dieser Rechner löst Gleichungen mit einer Variablen.")
    }
    val terms = mutableMapOf<Int, Double>()
    diff.forEach { (key, coeff) -> if (key.first == variable || key.first.isEmpty()) terms[key.second] = (terms[key.second] ?: 0.0) + coeff }
    val cleaned = terms.filterValues { abs(it) > 1e-9 }
    val degree = cleaned.keys.maxOrNull() ?: 0
    if (degree == 0) {
        throw MathEngineException(if (abs(cleaned[0] ?: 0.0) < 1e-8) "Die Gleichung ist für jedes $variable wahr." else "Die Gleichung hat keine Lösung.")
    }
    if (degree > 2) throw MathEngineException("Gleichungen über dem Grad 2 löst dieser Rechner nicht.")
    if (degree == 1) {
        val a = cleaned[1] ?: 0.0
        val c = cleaned[0] ?: 0.0
        val rightSide = -c
        val steps = mutableListOf<MathStep>()
        val solution = rightSide / a
        if (abs(a - 1.0) > 1e-9 && abs(a + 1.0) > 1e-9) {
            steps += step("${formatNumber(a)}*$variable=${formatNumber(rightSide)}", "intermediate")
        } else if (abs(a + 1.0) < 1e-9) {
            steps += step("-$variable=${formatNumber(rightSide)}", "intermediate")
        }
        steps += step("$variable=${formatNumber(solution)}", "result")
        return steps
    }
    val a = cleaned[2] ?: 0.0
    val b = cleaned[1] ?: 0.0
    val c = cleaned[0] ?: 0.0
    val disc = b * b - 4 * a * c
    if (disc < -1e-8) throw MathEngineException("Die Gleichung hat keine reelle Lösung.")
    val root = sqrt(maxOf(0.0, disc))
    val first = (-b + root) / (2 * a)
    val second = (-b - root) / (2 * a)
    val results = listOf(first, second).distinctBy { formatNumber(it) }
    return results.map { step("$variable=${formatNumber(it)}", "result") }
}

private fun polynomial(expr: Expr): Map<Pair<String, Int>, Double> {
    fun num(value: Double) = mapOf("" to 0 to value)
    fun combine(left: Map<Pair<String, Int>, Double>, right: Map<Pair<String, Int>, Double>, sign: Double): Map<Pair<String, Int>, Double> {
        val out = left.toMutableMap()
        right.forEach { (key, coeff) -> out[key] = (out[key] ?: 0.0) + sign * coeff }
        return out.filterValues { abs(it) > 1e-9 }
    }
    fun multiply(left: Map<Pair<String, Int>, Double>, right: Map<Pair<String, Int>, Double>): Map<Pair<String, Int>, Double> {
        val out = mutableMapOf<Pair<String, Int>, Double>()
        for ((lKey, lCoeff) in left) {
            for ((rKey, rCoeff) in right) {
                val name = when {
                    lKey.first.isEmpty() -> rKey.first
                    rKey.first.isEmpty() -> lKey.first
                    lKey.first == rKey.first -> lKey.first
                    else -> throw MathEngineException("Dieser Rechner kennt nur eine Variable.")
                }
                val exp = lKey.second + rKey.second
                if (exp > 8) throw MathEngineException("Polynome über dem Grad 8 werden hier nicht ausmultipliziert.")
                val key = name to exp
                out[key] = (out[key] ?: 0.0) + lCoeff * rCoeff
            }
        }
        return out.filterValues { abs(it) > 1e-9 }
    }
    fun asNumber(map: Map<Pair<String, Int>, Double>): Double? {
        if (map.any { it.key.second != 0 || it.key.first.isNotEmpty() }) return null
        return map["" to 0] ?: 0.0
    }
    fun walk(node: Expr): Map<Pair<String, Int>, Double> = when (node) {
        is Expr.Num -> num(node.value)
        is Expr.Var -> when (node.name) {
            "pi" -> num(PI)
            "e" -> num(E)
            "i" -> throw MathEngineException("Komplexe Zahlen sind in diesem Rechner nicht enthalten.")
            else -> mapOf(node.name to 1 to 1.0)
        }
        is Expr.Neg -> walk(node.inner).mapValues { -it.value }
        is Expr.Bin -> when (node.op) {
            '+' -> combine(walk(node.left), walk(node.right), 1.0)
            '-' -> combine(walk(node.left), walk(node.right), -1.0)
            '*' -> multiply(walk(node.left), walk(node.right))
            '/' -> {
                val divisor = asNumber(walk(node.right)) ?: throw MathEngineException("Geteilt wird hier nur durch eine Zahl.")
                if (abs(divisor) < 1e-12) throw MathEngineException("Division durch null.")
                walk(node.left).mapValues { it.value / divisor }
            }
            '^' -> {
                val exponent = asNumber(walk(node.right)) ?: throw MathEngineException("Der Exponent muss eine Zahl sein.")
                val times = exponent.toInt()
                if (abs(exponent - times) > 1e-9 || times < 0) {
                    val base = asNumber(walk(node.left)) ?: throw MathEngineException("Dieser Exponent geht über den Polynom-Rechner hinaus.")
                    num(base.pow(exponent))
                } else {
                    var acc = num(1.0)
                    val base = walk(node.left)
                    repeat(times) { acc = multiply(acc, base) }
                    acc
                }
            }
            else -> throw MathEngineException("Der Ausdruck ist unvollständig.")
        }
        is Expr.Call -> num(applyCall(node.name, eval(node.arg)))
    }
    val poly = walk(expr)
    if (poly.isEmpty()) return mapOf("" to 0 to 0.0)
    return poly
}

private fun subtract(left: Map<Pair<String, Int>, Double>, right: Map<Pair<String, Int>, Double>): Map<Pair<String, Int>, Double> {
    val out = left.toMutableMap()
    right.forEach { (key, coeff) -> out[key] = (out[key] ?: 0.0) - coeff }
    return out.filterValues { abs(it) > 1e-9 }
}

private fun formatPoly(poly: Map<Pair<String, Int>, Double>): String {
    val variable = poly.keys.firstOrNull { it.first.isNotEmpty() }?.first.orEmpty()
    val terms = sortedMapOf<Int, Double>()
    poly.forEach { (key, coeff) ->
        if (key.first.isNotEmpty() && key.first != variable) throw MathEngineException("Dieser Rechner kennt nur eine Variable.")
        terms[key.second] = (terms[key.second] ?: 0.0) + coeff
    }
    val degrees = terms.keys.filter { abs(terms[it] ?: 0.0) > 1e-9 }.sortedDescending()
    if (degrees.isEmpty()) return "0"
    val text = StringBuilder()
    degrees.forEachIndexed { index, degree ->
        val coeff = terms[degree] ?: 0.0
        val negative = coeff < 0
        if (index == 0) {
            if (negative) text.append('-')
        } else {
            text.append(if (negative) "-" else "+")
        }
        val magnitude = abs(coeff)
        if (degree == 0) {
            text.append(formatNumber(magnitude))
        } else {
            if (abs(magnitude - 1.0) > 1e-9) text.append(formatNumber(magnitude)).append('*')
            text.append(variable)
            if (degree != 1) text.append('^').append(degree)
        }
    }
    return text.toString()
}

private fun factorPoly(poly: Map<Pair<String, Int>, Double>): String? {
    val variable = poly.keys.firstOrNull { it.first.isNotEmpty() }?.first ?: return formatPoly(poly)
    val terms = poly.filter { it.key.first == variable || it.key.first.isEmpty() }
    if (terms.keys.any { it.second > 2 }) return null
    val a = terms[variable to 2] ?: return null
    val b = terms[variable to 1] ?: 0.0
    val c = terms["" to 0] ?: 0.0
    val disc = b * b - 4 * a * c
    if (disc < -1e-8) return null
    val root = sqrt(maxOf(0.0, disc))
    val r1 = (-b + root) / (2 * a)
    val r2 = (-b - root) / (2 * a)
    if (!nearInt(a) || !nearInt(r1) || !nearInt(r2)) return null
    val leading = round(a).toInt()
    val factors = listOf(r1, r2).sortedDescending().joinToString("*") { linearFactor(variable, round(it).toInt()) }
    return if (leading == 1) factors else if (leading == -1) "-$factors" else "$leading*$factors"
}

private fun linearFactor(variable: String, root: Int) = when {
    root == 0 -> variable
    root > 0 -> "($variable-$root)"
    else -> "($variable+${-root})"
}

private fun nearInt(value: Double) = abs(value - round(value)) < 1e-6

private fun step(expression: String, kind: String) = MathStep(expression, mathDisplay(expression), kind)

private fun mathDisplay(expression: String) = expression
    .replace("*", "·")
    .replace("sqrt(", "√(")
    .replace("+-", "−")
    .replace("-", "−")

fun formatNumber(value: Double): String {
    if (!value.isFinite()) throw MathEngineException("Das Ergebnis ist keine endliche Zahl.")
    if (value < 0) return "-" + formatNumber(-value)
    val nearest = round(value)
    if (abs(value - nearest) < 1e-8 && abs(nearest) < 1e15) {
        return if (abs(nearest) < 9_007_199_254_740_992.0) nearest.toLong().toString() else nearest.toString()
    }
    for (den in 2..16) {
        val num = round(value * den)
        if (abs(value * den - num) < 1e-7) {
            val divisor = gcd(abs(num.toLong()), den.toLong())
            return "${(num / divisor).toLong()}/${den / divisor}"
        }
    }
    val text = String.format(java.util.Locale.US, "%.8g", value)
    return text
}

private fun gcd(a: Long, b: Long): Long {
    var x = a
    var y = b
    while (y != 0L) {
        val t = x % y
        x = y
        y = t
    }
    return abs(x)
}

private fun eval(expr: Expr): Double = when (expr) {
    is Expr.Num -> expr.value
    is Expr.Var -> when (expr.name) {
        "pi" -> PI
        "e" -> E
        "i" -> throw MathEngineException("Komplexe Zahlen sind in diesem Rechner nicht enthalten.")
        else -> throw MathEngineException("„Ausrechnen“ ist nur für Terme ohne unbekannte Variablen verfügbar.")
    }
    is Expr.Neg -> -eval(expr.inner)
    is Expr.Bin -> {
        val left = eval(expr.left)
        val right = eval(expr.right)
        when (expr.op) {
            '+' -> left + right
            '-' -> left - right
            '*' -> left * right
            '/' -> if (abs(right) < 1e-12) throw MathEngineException("Division durch null.") else left / right
            '^' -> {
                if (left < 0 && abs(right - round(right)) > 1e-9) throw MathEngineException("Dieser Exponent ist für eine negative Basis nicht reell.")
                val value = left.pow(right)
                if (!value.isFinite()) throw MathEngineException("Das Ergebnis ist keine endliche Zahl.")
                value
            }
            else -> throw MathEngineException("Der Ausdruck ist unvollständig.")
        }
    }
    is Expr.Call -> applyCall(expr.name, eval(expr.arg))
}

private fun applyCall(name: String, value: Double): Double = when (name) {
    "sqrt" -> if (value < 0) throw MathEngineException("Die Wurzel aus einer negativen Zahl ist hier nicht reell.") else sqrt(value)
    "abs" -> abs(value)
    "sin" -> sin(value)
    "cos" -> cos(value)
    "tan" -> tan(value)
    "asin" -> asin(value)
    "acos" -> acos(value)
    "atan" -> atan(value)
    "log" -> if (value <= 0) throw MathEngineException("Der Logarithmus ist nur für positive Zahlen definiert.") else ln(value)
    "exp" -> exp(value)
    else -> throw MathEngineException("Die Funktion „$name“ ist im sicheren Mathematikmodus nicht erlaubt.")
}

private sealed class Tok {
    data class Num(val value: Double) : Tok()
    data class Id(val name: String) : Tok()
    data class Op(val op: Char) : Tok()
    data object LParen : Tok()
    data object RParen : Tok()
}

private class Parser(private val tokens: List<Tok>) {
    private var index = 0
    fun parse(): Expr {
        val expr = parseAdd()
        if (index != tokens.size) throw MathEngineException("Der Ausdruck ist unvollständig.")
        return expr
    }
    private fun parseAdd(): Expr {
        var left = parseMul()
        while (index < tokens.size && tokens[index] is Tok.Op && ((tokens[index] as Tok.Op).op == '+' || (tokens[index] as Tok.Op).op == '-')) {
            val op = (tokens[index] as Tok.Op).op
            index += 1
            left = Expr.Bin(op, left, parseMul())
        }
        return left
    }
    private fun parseMul(): Expr {
        var left = parsePow()
        while (index < tokens.size && tokens[index] is Tok.Op && ((tokens[index] as Tok.Op).op == '*' || (tokens[index] as Tok.Op).op == '/')) {
            val op = (tokens[index] as Tok.Op).op
            index += 1
            left = Expr.Bin(op, left, parsePow())
        }
        return left
    }
    private fun parsePow(): Expr {
        val base = parseUnary()
        if (index < tokens.size && tokens[index] is Tok.Op && (tokens[index] as Tok.Op).op == '^') {
            index += 1
            return Expr.Bin('^', base, parsePow())
        }
        return base
    }
    private fun parseUnary(): Expr {
        if (index < tokens.size && tokens[index] is Tok.Op && (tokens[index] as Tok.Op).op == '-') {
            index += 1
            return Expr.Neg(parseUnary())
        }
        if (index < tokens.size && tokens[index] is Tok.Op && (tokens[index] as Tok.Op).op == '+') {
            index += 1
            return parseUnary()
        }
        return parsePrimary()
    }
    private fun parsePrimary(): Expr {
        if (index >= tokens.size) throw MathEngineException("Der Ausdruck ist unvollständig.")
        return when (val token = tokens[index]) {
            is Tok.Num -> {
                index += 1
                Expr.Num(token.value)
            }
            Tok.LParen -> {
                index += 1
                val inner = parseAdd()
                if (index >= tokens.size || tokens[index] != Tok.RParen) throw MathEngineException("Die Klammerung des Ausdrucks ist ungültig oder zu tief verschachtelt.")
                index += 1
                inner
            }
            is Tok.Id -> {
                index += 1
                if (index < tokens.size && tokens[index] == Tok.LParen) {
                    if (token.name !in SAFE_FUNCTIONS) throw MathEngineException("Die Funktion „${token.name}“ ist im sicheren Mathematikmodus nicht erlaubt.")
                    index += 1
                    val arg = parseAdd()
                    if (index >= tokens.size || tokens[index] != Tok.RParen) throw MathEngineException("Die Klammerung des Ausdrucks ist ungültig oder zu tief verschachtelt.")
                    index += 1
                    Expr.Call(token.name, arg)
                } else {
                    Expr.Var(token.name)
                }
            }
            else -> throw MathEngineException("Der Ausdruck ist unvollständig.")
        }
    }
}

private fun parse(normalized: String): Expr = Parser(tokenize(normalized)).parse()

private fun tokenize(normalized: String): List<Tok> {
    val raw = ArrayList<Tok>()
    var index = 0
    while (index < normalized.length) {
        val char = normalized[index]
        when {
            char.isDigit() || (char == '.' && index + 1 < normalized.length && normalized[index + 1].isDigit()) -> {
                val start = index
                index += 1
                var dots = if (char == '.') 1 else 0
                while (index < normalized.length && (normalized[index].isDigit() || normalized[index] == '.')) {
                    if (normalized[index] == '.') dots += 1
                    index += 1
                }
                if (dots > 1) throw MathEngineException("Der Ausdruck enthält eine ungültige Zahl.")
                val value = normalized.substring(start, index).toDoubleOrNull() ?: throw MathEngineException("Der Ausdruck enthält eine ungültige Zahl.")
                raw += Tok.Num(value)
            }
            char.isLetter() || char == '_' -> {
                val start = index
                index += 1
                while (index < normalized.length && (normalized[index].isLetterOrDigit() || normalized[index] == '_')) index += 1
                raw += Tok.Id(normalized.substring(start, index))
            }
            char == '(' -> { raw += Tok.LParen; index += 1 }
            char == ')' -> { raw += Tok.RParen; index += 1 }
            char == '+' || char == '-' || char == '*' || char == '/' || char == '^' -> { raw += Tok.Op(char); index += 1 }
            else -> throw MathEngineException("Der Ausdruck enthält ein Zeichen, das der lokale Mathematik-Löser noch nicht sicher unterstützt.")
        }
    }
    val tokens = ArrayList<Tok>(raw.size * 2)
    for (token in raw) {
        val previous = tokens.lastOrNull()
        if (previous != null && juxtaposed(previous, token)) tokens += Tok.Op('*')
        tokens += token
    }
    return tokens
}

private fun juxtaposed(previous: Tok, next: Tok): Boolean {
    val nextStarts = next is Tok.Num || next is Tok.LParen || next is Tok.Id
    if (!nextStarts) return false
    return when (previous) {
        is Tok.Num, Tok.RParen -> true
        is Tok.Id -> !(next is Tok.LParen && previous.name in SAFE_FUNCTIONS)
        else -> false
    }
}
