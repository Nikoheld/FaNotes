package ch.fasrv.fanotes.ink

import java.text.Normalizer

// Port of fanotes/src/lib/functionGraph.ts: typed f(x) stamps from a tiny recursive-descent
// parser (no eval). Paths are a 24x24 figure and must match the desktop byte for byte.

const val DEFAULT_GRAPH_EXPRESSION = "sin(x)"
const val DEFAULT_GRAPH_X_MIN = -6.2832
const val DEFAULT_GRAPH_X_MAX = 6.2832
val GRAPH_PRESETS: List<String> = listOf("sin(x)", "cos(x)", "x^2", "1/x", "exp(-x^2)")

const val GRAPH_ERROR_EMPTY = "Die Formel ist leer."
const val GRAPH_ERROR_CHAR = "Die Formel enthält ein Zeichen, das nicht erlaubt ist."
const val GRAPH_ERROR_LONG = "Die Formel ist zu lang."
const val GRAPH_ERROR_PARENS = "Die Klammerung der Formel ist ungültig."
const val GRAPH_ERROR_VARIABLE = "Nur die Variable x ist erlaubt."
const val GRAPH_ERROR_FUNCTION = "Diese Funktion ist nicht erlaubt."
const val GRAPH_ERROR_DOMAIN = "x-Minimum muss kleiner als x-Maximum sein."
const val GRAPH_ERROR_EMPTY_RANGE = "Die Formel hat in diesem Bereich keinen Wert."

private const val FG_MAX_EXPRESSION_LENGTH = 180
private const val FG_MAX_DEPTH = 24
private const val FG_MAX_ABS_EXPONENT = 100.0
private const val FG_SAMPLE_COUNT = 280
private const val FG_BOX = 24.0
private const val FG_MARGIN = 2.2
private const val FG_MAX_PATHS = 32
private const val FG_MAX_PATH_CHARS = 8000
private val fgPathPattern = Regex("^[ML0-9.,\\-\\s\\p{Z}\\uFEFF]+$")

private val fgFunctions: Map<String, (Double) -> Double> = mapOf(
    "sin" to { v -> StrictMath.sin(v) },
    "cos" to { v -> StrictMath.cos(v) },
    "tan" to { v -> StrictMath.tan(v) },
    "asin" to { v -> StrictMath.asin(v) },
    "acos" to { v -> StrictMath.acos(v) },
    "atan" to { v -> StrictMath.atan(v) },
    "sinh" to { v -> StrictMath.sinh(v) },
    "cosh" to { v -> StrictMath.cosh(v) },
    "tanh" to { v -> StrictMath.tanh(v) },
    "sqrt" to { v -> if (v < 0) Double.NaN else StrictMath.sqrt(v) },
    "abs" to { v -> Math.abs(v) },
    "exp" to { v ->
        if (Math.abs(v) > 40) (if (v > 0) Double.POSITIVE_INFINITY else 0.0) else StrictMath.exp(v)
    },
    "ln" to { v -> if (v > 0) StrictMath.log(v) else Double.NaN },
    "log" to { v -> if (v > 0) StrictMath.log(v) else Double.NaN },
    "log10" to { v -> if (v > 0) StrictMath.log10(v) else Double.NaN },
)

private sealed class FgToken {
    class Num(val value: Double) : FgToken()
    class Id(val name: String) : FgToken()
    class Op(val op: Char) : FgToken()
    object Lp : FgToken()
    object Rp : FgToken()
    object Eof : FgToken()
}

private fun fgFail(message: String): Nothing = throw IllegalArgumentException(message)

private fun fgNormalize(input: String): String = Normalizer.normalize(input, Normalizer.Form.NFKC)
    .replace(Regex("[−–—]"), "-")
    .replace(Regex("[×·⋅]"), "*")
    .replace("÷", "/")
    .replace("π", "pi")
    .replace("√", "sqrt")

private fun fgIsDigit(c: Char?) = c != null && c in '0'..'9'

private fun fgTokenize(source: String): List<FgToken> {
    val tokens = ArrayList<FgToken>()
    var index = 0
    while (index < source.length) {
        val char = source[index]
        when {
            char == ' ' || char == '\t' || char == '\n' || char == '\r' -> index += 1
            char == '(' -> { tokens.add(FgToken.Lp); index += 1 }
            char == ')' -> { tokens.add(FgToken.Rp); index += 1 }
            char == '+' || char == '-' || char == '*' || char == '/' || char == '^' -> {
                tokens.add(FgToken.Op(char)); index += 1
            }
            char == '.' || fgIsDigit(char) -> {
                var end = index
                var sawDigit = false
                var sawDot = false
                if (source[end] == '.') { sawDot = true; end += 1 }
                while (end < source.length && fgIsDigit(source[end])) { sawDigit = true; end += 1 }
                if (!sawDot && source.getOrNull(end) == '.') {
                    sawDot = true
                    end += 1
                    while (end < source.length && fgIsDigit(source[end])) { sawDigit = true; end += 1 }
                }
                val exponent = source.getOrNull(end)
                val exponentSign = source.getOrNull(end + 1)
                val exponentDigit = if (exponentSign == '+' || exponentSign == '-') source.getOrNull(end + 2) else exponentSign
                if (sawDigit && (exponent == 'e' || exponent == 'E') && fgIsDigit(exponentDigit)) {
                    end += 1
                    if (source.getOrNull(end) == '+' || source.getOrNull(end) == '-') end += 1
                    while (end < source.length && fgIsDigit(source[end])) end += 1
                }
                if (!sawDigit) fgFail(GRAPH_ERROR_CHAR)
                val value = source.substring(index, end).toDouble()
                if (!value.isFinite()) fgFail(GRAPH_ERROR_CHAR)
                tokens.add(FgToken.Num(value))
                index = end
            }
            (char in 'A'..'Z') || (char in 'a'..'z') || char == '_' -> {
                var end = index + 1
                while (end < source.length) {
                    val next = source[end]
                    val word = (next in 'A'..'Z') || (next in 'a'..'z') || (next in '0'..'9') || next == '_'
                    if (!word) break
                    end += 1
                }
                tokens.add(FgToken.Id(source.substring(index, end)))
                index = end
            }
            else -> fgFail(GRAPH_ERROR_CHAR)
        }
    }
    tokens.add(FgToken.Eof)
    return tokens
}

private class FgParser(private val tokens: List<FgToken>) {
    private var cursor = 0
    private var depth = 0

    private fun peek(): FgToken = tokens[cursor]
    private fun take(): FgToken = tokens[cursor++]
    private fun startsPrimary(t: FgToken) = t is FgToken.Num || t is FgToken.Id || t is FgToken.Lp

    fun parse(): (Double) -> Double {
        val expression = parseAdd()
        if (peek() !is FgToken.Eof) fgFail(GRAPH_ERROR_PARENS)
        return expression
    }

    private fun parseAdd(): (Double) -> Double {
        var left = parseMul()
        while (true) {
            val token = peek()
            if (token !is FgToken.Op || (token.op != '+' && token.op != '-')) break
            take()
            val right = parseMul()
            val previous = left
            left = if (token.op == '+') { x -> previous(x) + right(x) } else { x -> previous(x) - right(x) }
        }
        return left
    }

    private fun parseMul(): (Double) -> Double {
        var left = parseUnary()
        while (true) {
            val token = peek()
            if (token is FgToken.Op && (token.op == '*' || token.op == '/')) {
                take()
                val right = parseUnary()
                val previous = left
                left = if (token.op == '*') { x -> previous(x) * right(x) } else { x -> previous(x) / right(x) }
                continue
            }
            // 2x and 2sin(x): a primary after a factor is a product.
            if (!startsPrimary(token)) break
            val right = parseUnary()
            val previous = left
            left = { x -> previous(x) * right(x) }
        }
        return left
    }

    // Unary minus sits above power, so -x^2 is -(x^2). The exponent may itself be signed.
    private fun parseUnary(): (Double) -> Double {
        val token = peek()
        if (token is FgToken.Op && (token.op == '-' || token.op == '+')) {
            take()
            depth += 1
            if (depth > FG_MAX_DEPTH) fgFail(GRAPH_ERROR_PARENS)
            val inner = parseUnary()
            depth -= 1
            return if (token.op == '-') { x -> -inner(x) } else inner
        }
        return parsePow()
    }

    private fun parsePow(): (Double) -> Double {
        val base = parsePrimary()
        val token = peek()
        if (token !is FgToken.Op || token.op != '^') return base
        take()
        val exponent = parseUnary()
        return { x ->
            val power = exponent(x)
            if (!power.isFinite() || Math.abs(power) > FG_MAX_ABS_EXPONENT) Double.NaN
            else StrictMath.pow(base(x), power)
        }
    }

    private fun parsePrimary(): (Double) -> Double {
        if (depth > FG_MAX_DEPTH) fgFail(GRAPH_ERROR_PARENS)
        val token = take()
        if (token is FgToken.Num) return { _ -> token.value }
        if (token is FgToken.Lp) {
            depth += 1
            val inner = parseAdd()
            depth -= 1
            if (take() !is FgToken.Rp) fgFail(GRAPH_ERROR_PARENS)
            return inner
        }
        if (token is FgToken.Id) {
            if (token.name == "pi") return { _ -> Math.PI }
            if (token.name == "e") return { _ -> Math.E }
            if (token.name == "x") return { x -> x }
            if (peek() is FgToken.Lp) {
                val apply = fgFunctions[token.name] ?: fgFail(GRAPH_ERROR_FUNCTION)
                take()
                depth += 1
                val argument = parseAdd()
                depth -= 1
                if (take() !is FgToken.Rp) fgFail(GRAPH_ERROR_PARENS)
                return { x -> apply(argument(x)) }
            }
            fgFail(GRAPH_ERROR_VARIABLE)
        }
        fgFail(GRAPH_ERROR_PARENS)
    }
}

/** Compile a formula of x. Throws IllegalArgumentException with a German message when rejected. */
fun compileFunctionGraph(expression: String): (Double) -> Double {
    if (expression.isBlank()) fgFail(GRAPH_ERROR_EMPTY)
    if (expression.length > FG_MAX_EXPRESSION_LENGTH) fgFail(GRAPH_ERROR_LONG)
    val normalized = fgNormalize(expression)
    if (normalized.isBlank()) fgFail(GRAPH_ERROR_EMPTY)
    if (normalized.length > FG_MAX_EXPRESSION_LENGTH) fgFail(GRAPH_ERROR_LONG)
    return FgParser(fgTokenize(normalized)).parse()
}

/** Same text as JS `String(Math.round(clamp(v, 0, 24) * 100) / 100)`. */
private fun fgFormat(value: Double): String {
    val clamped = Math.min(FG_BOX, Math.max(0.0, value))
    val cents = Math.floor(clamped * 100.0 + 0.5).toLong()
    if (cents == 0L) return "0"
    val whole = cents / 100
    val frac = (cents % 100).toInt()
    if (frac == 0) return whole.toString()
    return "$whole." + if (frac % 10 == 0) (frac / 10).toString() else frac.toString().padStart(2, '0')
}

private fun fgPolyline(points: List<Pair<Double, Double>>): String {
    if (points.size < 2) return ""
    val sb = StringBuilder("M ${fgFormat(points[0].first)} ${fgFormat(points[0].second)}")
    for (index in 1 until points.size) sb.append(" L ${fgFormat(points[index].first)} ${fgFormat(points[index].second)}")
    return sb.toString()
}

private fun fgQuantile(sorted: List<Double>, ratio: Double): Double {
    val at = Math.floor((sorted.size - 1) * ratio + 0.5).toInt()
    return sorted[Math.min(sorted.size - 1, Math.max(0, at))]
}

/** Axes plus the curve, split where the function jumps (tan, 1/x). */
fun functionGraphPaths(expression: String, xMin: Double, xMax: Double): List<String> {
    if (!xMin.isFinite() || !xMax.isFinite() || !(xMin < xMax)) fgFail(GRAPH_ERROR_DOMAIN)
    val fn = compileFunctionGraph(expression)
    val sx = DoubleArray(FG_SAMPLE_COUNT + 1)
    val sy = DoubleArray(FG_SAMPLE_COUNT + 1)
    val finite = ArrayList<Double>()
    for (index in 0..FG_SAMPLE_COUNT) {
        val x = xMin + (xMax - xMin) * (index.toDouble() / FG_SAMPLE_COUNT)
        var y = fn(x)
        if (!y.isFinite()) y = Double.NaN
        else if (y > 1e6) y = 1e6
        else if (y < -1e6) y = -1e6
        sx[index] = x
        sy[index] = y
        if (y.isFinite()) finite.add(y)
    }
    if (finite.isEmpty()) fgFail(GRAPH_ERROR_EMPTY_RANGE)
    finite.sort()
    var yLo = fgQuantile(finite, 0.04)
    var yHi = fgQuantile(finite, 0.96)
    if (!(yHi > yLo)) {
        val mid = fgQuantile(finite, 0.5)
        val pad = Math.max(0.5, Math.abs(mid) * 0.5)
        yLo = mid - pad
        yHi = mid + pad
    } else {
        val pad = (yHi - yLo) * 0.12
        yLo -= pad
        yHi += pad
    }
    val span = yHi - yLo
    val inner = FG_BOX - 2 * FG_MARGIN
    fun mapX(x: Double) = FG_MARGIN + ((x - xMin) / (xMax - xMin)) * inner
    fun mapY(y: Double) = FG_MARGIN + (1 - (y - yLo) / span) * inner
    val axisX = if (xMin < 0 && xMax > 0) 0.0 else if (xMin >= 0) xMin else xMax
    val axisY = if (yLo < 0 && yHi > 0) 0.0 else if (yLo >= 0) yLo else yHi
    val originX = mapX(axisX)
    val originY = mapY(axisY)
    val left = FG_MARGIN
    val right = FG_MARGIN + inner
    val top = FG_MARGIN
    val bottom = FG_MARGIN + inner
    fun segment(x1: Double, y1: Double, x2: Double, y2: Double) =
        "M ${fgFormat(x1)} ${fgFormat(y1)} L ${fgFormat(x2)} ${fgFormat(y2)}"
    val axisParts = arrayListOf(
        segment(left, originY, right, originY),
        segment(originX, bottom, originX, top),
        segment(right, originY, right - 1.15, originY - 0.7),
        segment(right, originY, right - 1.15, originY + 0.7),
        segment(originX, top, originX - 0.7, top + 1.15),
        segment(originX, top, originX + 0.7, top + 1.15),
    )
    for (ratio in doubleArrayOf(0.25, 0.5, 0.75)) {
        val x = left + inner * ratio
        if (Math.abs(x - originX) > 1.2) axisParts.add(segment(x, originY - 0.35, x, originY + 0.35))
        val y = top + inner * ratio
        if (Math.abs(y - originY) > 1.2) axisParts.add(segment(originX - 0.35, y, originX + 0.35, y))
    }
    val curves = ArrayList<List<Pair<Double, Double>>>()
    var run = ArrayList<Pair<Double, Double>>()
    var previous: Double? = null
    fun flush() {
        if (run.size >= 2) curves.add(run)
        run = ArrayList()
    }
    for (index in 0..FG_SAMPLE_COUNT) {
        val y = sy[index]
        if (!y.isFinite()) {
            flush()
            previous = null
            continue
        }
        val prev = previous
        if (prev != null) {
            val jump = Math.abs(y - prev)
            if (y * prev < 0 && jump > span * 3) {
                flush()
                previous = null
                if (Math.abs(y) > span * 8) continue
            }
        }
        val clipped = Math.min(yHi, Math.max(yLo, y))
        run.add(Pair(mapX(sx[index]), mapY(clipped)))
        previous = y
    }
    flush()
    val paths = listOf(axisParts.joinToString(" ")) + curves.map(::fgPolyline).filter { it.isNotEmpty() }
    return paths.take(FG_MAX_PATHS)
}

data class FunctionGraphStamp(
    val expression: String,
    val xMin: Double,
    val xMax: Double,
    val paths: List<String>,
)

private fun fgStoredPaths(value: List<String>?): List<String>? {
    if (value == null || value.isEmpty() || value.size > FG_MAX_PATHS) return null
    var total = 0
    for (entry in value) {
        if (entry.isEmpty() || entry.length >= FG_MAX_PATH_CHARS) return null
        if (!fgPathPattern.matches(entry)) return null
        total += entry.length
        if (total >= FG_MAX_PATH_CHARS) return null
    }
    return value.toList()
}

/** Rebuild the stamp from the saved formula. Stored paths are the fallback when it no longer samples. */
fun readFunctionGraphStamp(
    expression: String?,
    xMin: Double?,
    xMax: Double?,
    paths: List<String>?,
): FunctionGraphStamp? {
    val text = expression?.trim()?.take(FG_MAX_EXPRESSION_LENGTH) ?: ""
    val lo = xMin ?: Double.NaN
    val hi = xMax ?: Double.NaN
    val domainOk = lo.isFinite() && hi.isFinite() && lo < hi
    if (text.isNotEmpty() && domainOk) {
        try {
            val built = functionGraphPaths(text, lo, hi)
            if (built.isNotEmpty()) return FunctionGraphStamp(text, lo, hi, built)
        } catch (_: Exception) {
            val stored = fgStoredPaths(paths) ?: return null
            return FunctionGraphStamp(text, lo, hi, stored)
        }
    }
    val stored = fgStoredPaths(paths) ?: return null
    return FunctionGraphStamp(text, if (domainOk) lo else 0.0, if (domainOk) hi else 1.0, stored)
}
