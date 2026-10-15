package ch.fasrv.fanotes.desk

/**
 * Display math the desktop editor folds into one card.
 * A line that is only `$$` opens the block, and the next such line closes it.
 * The source is everything between those fences, trimmed. A caret inside the
 * block, including either fence, leaves the source visible.
 */
data class DisplayMathBlock(
    val from: Int,
    val to: Int,
    val openLine: Int,
    val closeLine: Int,
    val source: String,
)

fun displayMathBlocks(text: String): List<DisplayMathBlock> {
    if (text.isEmpty()) return emptyList()
    val lines = mathDocumentLines(text)
    val blocks = ArrayList<DisplayMathBlock>()
    var open: MathDocLine? = null
    for (line in lines) {
        if (!MATH_FENCE.matches(line.text)) continue
        val start = open
        if (start == null) {
            open = line
            continue
        }
        open = null
        val sourceFrom = minOf(start.to + 1, line.from).coerceIn(0, text.length)
        val sourceTo = maxOf(sourceFrom, line.from - 1).coerceIn(sourceFrom, text.length)
        blocks += DisplayMathBlock(
            start.from,
            line.to,
            start.number,
            line.number,
            text.substring(sourceFrom, sourceTo).trim(),
        )
    }
    return blocks
}

/** True when the selection touches the fences or the formula, the way CodeMirror does. */
fun displayMathIntersects(block: DisplayMathBlock, selectionStart: Int, selectionEnd: Int): Boolean {
    val from = minOf(selectionStart, selectionEnd)
    val to = maxOf(selectionStart, selectionEnd)
    return to >= block.from && from <= block.to
}

sealed class MathNode {
    data class Row(val parts: List<MathNode>) : MathNode()
    data class Atom(val text: String) : MathNode()
    data class Script(val base: MathNode, val sup: MathNode?, val sub: MathNode?) : MathNode()
    data class Frac(val num: MathNode, val den: MathNode) : MathNode()
    data class Radical(val body: MathNode) : MathNode()
}

/**
 * School formulas the paper card typesets: fractions, roots, scripts, and the
 * Greek letters and operators a note actually writes. An unknown command keeps
 * its name so the formula is never dropped.
 */
fun layoutDisplayMath(source: String): MathNode {
    val trimmed = source.replace('\n', ' ').trim()
    if (trimmed.isEmpty()) return MathNode.Atom("")
    return MathParser(trimmed).parse()
}

/** Compact shape used by tests and by a painter that walks the same tree. */
fun mathNodeShape(node: MathNode): String = when (node) {
    is MathNode.Atom -> node.text
    is MathNode.Row -> node.parts.joinToString("") { mathNodeShape(it) }
    is MathNode.Script -> {
        val up = node.sup?.let { "^" + mathNodeShape(it) }.orEmpty()
        val down = node.sub?.let { "_" + mathNodeShape(it) }.orEmpty()
        mathNodeShape(node.base) + "[$up$down]"
    }
    is MathNode.Frac -> "(" + mathNodeShape(node.num) + ")/(" + mathNodeShape(node.den) + ")"
    is MathNode.Radical -> "√(" + mathNodeShape(node.body) + ")"
}

private class MathParser(private val source: String) {
    private var index = 0

    fun parse(): MathNode {
        val parts = ArrayList<MathNode>()
        while (index < source.length && source[index] != '}') parts += parseScript()
        return flatten(parts)
    }

    private fun parseScript(): MathNode {
        val base = parseAtom()
        var sup: MathNode? = null
        var sub: MathNode? = null
        while (index < source.length && (source[index] == '^' || source[index] == '_')) {
            val kind = source[index]
            index += 1
            val script = parseAtom()
            if (kind == '^') sup = script else sub = script
        }
        return if (sup == null && sub == null) base else MathNode.Script(base, sup, sub)
    }

    private fun parseAtom(): MathNode {
        skipSpace()
        if (index >= source.length || source[index] == '}') return MathNode.Atom("")
        return when (val char = source[index]) {
            '{' -> {
                index += 1
                val inner = parse()
                if (index < source.length && source[index] == '}') index += 1
                inner
            }
            '\\' -> parseCommand()
            '^', '_' -> MathNode.Atom("")
            else -> {
                index += 1
                MathNode.Atom(char.toString())
            }
        }
    }

    private fun parseCommand(): MathNode {
        index += 1
        if (index >= source.length) return MathNode.Atom("")
        if (!source[index].isLetter()) return MathNode.Atom(source[index++].toString())
        val start = index
        while (index < source.length && source[index].isLetter()) index += 1
        val name = source.substring(start, index)
        return when (name) {
            "frac", "dfrac", "tfrac" -> MathNode.Frac(parseGroup(), parseGroup())
            "sqrt" -> MathNode.Radical(parseGroup())
            "text", "mathrm", "mathbf", "operatorname" -> MathNode.Atom(flattenText(parseGroup()))
            "left", "right" -> MathNode.Atom("")
            else -> MathNode.Atom(MATH_SYMBOLS[name] ?: name)
        }
    }

    private fun parseGroup(): MathNode {
        skipSpace()
        if (index < source.length && source[index] == '{') return parseAtom()
        return parseAtom()
    }

    private fun skipSpace() {
        while (index < source.length && source[index].isWhitespace()) index += 1
    }
}

private fun flatten(parts: List<MathNode>): MathNode = when (parts.size) {
    0 -> MathNode.Atom("")
    1 -> parts[0]
    else -> MathNode.Row(parts)
}

private fun flattenText(node: MathNode): String = when (node) {
    is MathNode.Atom -> node.text
    is MathNode.Row -> node.parts.joinToString("") { flattenText(it) }
    is MathNode.Script -> flattenText(node.base) + (node.sup?.let(::flattenText) ?: "") + (node.sub?.let(::flattenText) ?: "")
    is MathNode.Frac -> flattenText(node.num) + "/" + flattenText(node.den)
    is MathNode.Radical -> flattenText(node.body)
}

private data class MathDocLine(val number: Int, val from: Int, val to: Int, val text: String)

private fun mathDocumentLines(text: String): List<MathDocLine> {
    val lines = ArrayList<MathDocLine>()
    var start = 0
    var number = 1
    while (start <= text.length) {
        var end = start
        while (end < text.length && text[end] != '\n') end += 1
        lines += MathDocLine(number, start, end, text.substring(start, end))
        if (end >= text.length) break
        start = end + 1
        number += 1
    }
    return lines
}

private val MATH_FENCE = Regex("""^\s*\$\$\s*$""")

private val MATH_SYMBOLS = mapOf(
    "alpha" to "α",
    "beta" to "β",
    "gamma" to "γ",
    "delta" to "δ",
    "epsilon" to "ε",
    "varepsilon" to "ε",
    "zeta" to "ζ",
    "eta" to "η",
    "theta" to "θ",
    "iota" to "ι",
    "kappa" to "κ",
    "lambda" to "λ",
    "mu" to "μ",
    "nu" to "ν",
    "xi" to "ξ",
    "pi" to "π",
    "rho" to "ρ",
    "sigma" to "σ",
    "tau" to "τ",
    "phi" to "φ",
    "varphi" to "φ",
    "chi" to "χ",
    "psi" to "ψ",
    "omega" to "ω",
    "Gamma" to "Γ",
    "Delta" to "Δ",
    "Theta" to "Θ",
    "Lambda" to "Λ",
    "Xi" to "Ξ",
    "Pi" to "Π",
    "Sigma" to "Σ",
    "Phi" to "Φ",
    "Psi" to "Ψ",
    "Omega" to "Ω",
    "cdot" to "·",
    "times" to "×",
    "div" to "÷",
    "pm" to "±",
    "mp" to "∓",
    "leq" to "≤",
    "le" to "≤",
    "geq" to "≥",
    "ge" to "≥",
    "neq" to "≠",
    "ne" to "≠",
    "approx" to "≈",
    "equiv" to "≡",
    "infty" to "∞",
    "sum" to "∑",
    "prod" to "∏",
    "int" to "∫",
    "partial" to "∂",
    "nabla" to "∇",
    "ldots" to "…",
    "cdots" to "⋯",
    "dots" to "…",
    "to" to "→",
    "rightarrow" to "→",
    "leftarrow" to "←",
    "in" to "∈",
    "notin" to "∉",
    "subset" to "⊂",
    "subseteq" to "⊆",
    "forall" to "∀",
    "exists" to "∃",
    "circ" to "°",
    "quad" to " ",
    "qquad" to "  ",
)
