package ch.fasrv.fanotes.json

/**
 * Small JSON DOM whose object key order is insertion order, matching
 * `JSON.parse` / `JSON.stringify` in the desktop client. Numbers keep the
 * lexeme they were parsed with so an untouched payload can be written back
 * without changing its bytes.
 */
sealed class JsonValue {
    class Obj(val fields: LinkedHashMap<String, JsonValue> = linkedMapOf()) : JsonValue() {
        operator fun get(key: String): JsonValue? = fields[key]
        fun string(key: String): String? = (fields[key] as? Str)?.value
        fun double(key: String): Double? = (fields[key] as? Num)?.value
        fun bool(key: String): Boolean? = (fields[key] as? Bool)?.value
        fun obj(key: String): Obj? = fields[key] as? Obj
        fun array(key: String): Arr? = fields[key] as? Arr
        fun put(key: String, value: JsonValue?): Obj {
            if (value == null) fields.remove(key) else fields[key] = value
            return this
        }
    }

    class Arr(val items: MutableList<JsonValue> = mutableListOf()) : JsonValue()

    data class Str(val value: String) : JsonValue()
    data class Num(val raw: String, val value: Double) : JsonValue()
    data class Bool(val value: Boolean) : JsonValue()
    data object Null : JsonValue()
}

open class JsonParseException(message: String) : IllegalArgumentException(message)

fun jsonString(value: String) = JsonValue.Str(value)
fun jsonBool(value: Boolean) = JsonValue.Bool(value)
fun jsonNull() = JsonValue.Null

/** JavaScript `JSON.stringify` number shape for values we create ourselves. */
fun jsonNumber(value: Double): JsonValue.Num {
    if (value.isNaN() || value.isInfinite()) throw IllegalArgumentException("JSON numbers must be finite")
    return JsonValue.Num(jsNumber(value), value)
}

fun jsonArray(vararg items: JsonValue) = JsonValue.Arr(items.toMutableList())

fun jsonObject(vararg pairs: Pair<String, JsonValue?>): JsonValue.Obj {
    val obj = JsonValue.Obj()
    for ((key, value) in pairs) if (value != null) obj.fields[key] = value
    return obj
}

/** Limits are checked before allocating DOM nodes or entering another recursive frame. */
data class JsonLimits(val maxDepth: Int = 64, val maxNodes: Int = 1_000_000)
class JsonLimitException(val depth: Int, val nodes: Int) :
    JsonParseException("JSON resource limit depth=$depth nodes=$nodes")
data class JsonShape(val depth: Int, val nodes: Int)

fun parseJson(text: String, limits: JsonLimits = JsonLimits()): JsonValue = JsonParser(text, limits).parseValue()

private class JsonParser(private val text: String, private val limits: JsonLimits) {
    private var depth = 0
    private var nodes = 0
    private var index = 0

    fun parseValue(): JsonValue {
        skip()
        if (index >= text.length) throw JsonParseException("Unexpected end of JSON")
        val value = readValue()
        skip()
        if (index != text.length) throw JsonParseException("Trailing data at $index")
        return value
    }

    private fun readValue(): JsonValue {
        skip()
        if (index >= text.length) throw JsonParseException("Unexpected end of JSON")
        depth += 1
        nodes += 1
        if (depth > limits.maxDepth || nodes > limits.maxNodes) throw JsonLimitException(depth, nodes)
        val value = when (val char = text[index]) {
            '{' -> readObject()
            '[' -> readArray()
            '"' -> JsonValue.Str(readString())
            't' -> literal("true", jsonBool(true))
            'f' -> literal("false", jsonBool(false))
            'n' -> literal("null", jsonNull())
            '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' -> readNumber()
            else -> throw JsonParseException("Unexpected '${char}' at $index")
        }
        depth -= 1
        return value
    }

    private fun literal(token: String, value: JsonValue): JsonValue {
        if (!text.startsWith(token, index)) throw JsonParseException("Expected $token at $index")
        index += token.length
        return value
    }

    private fun readObject(): JsonValue.Obj {
        index += 1
        val obj = JsonValue.Obj()
        skip()
        if (peek('}')) {
            index += 1
            return obj
        }
        while (true) {
            skip()
            if (index >= text.length || text[index] != '"') throw JsonParseException("Expected object key at $index")
            val key = readString()
            skip()
            expect(':')
            obj.fields[key] = readValue()
            skip()
            when {
                peek('}') -> {
                    index += 1
                    return obj
                }
                peek(',') -> index += 1
                else -> throw JsonParseException("Expected ',' or '}' at $index")
            }
        }
    }

    private fun readArray(): JsonValue.Arr {
        index += 1
        val array = JsonValue.Arr()
        skip()
        if (peek(']')) {
            index += 1
            return array
        }
        while (true) {
            array.items += readValue()
            skip()
            when {
                peek(']') -> {
                    index += 1
                    return array
                }
                peek(',') -> index += 1
                else -> throw JsonParseException("Expected ',' or ']' at $index")
            }
        }
    }

    private fun readString(): String {
        expect('"')
        val out = StringBuilder()
        while (index < text.length) {
            val char = text[index++]
            when {
                char == '"' -> return out.toString()
                char == '\\' -> out.append(readEscape())
                char.code < 0x20 -> throw JsonParseException("Raw control character in string")
                else -> out.append(char)
            }
        }
        throw JsonParseException("Unterminated string")
    }

    private fun readEscape(): Char {
        if (index >= text.length) throw JsonParseException("Bad escape")
        return when (val char = text[index++]) {
            '"', '\\', '/' -> char
            'b' -> '\b'
            'f' -> '\u000C'
            'n' -> '\n'
            'r' -> '\r'
            't' -> '\t'
            'u' -> {
                if (index + 4 > text.length) throw JsonParseException("Bad unicode escape")
                val hex = text.substring(index, index + 4)
                index += 4
                val code = hex.toIntOrNull(16) ?: throw JsonParseException("Bad unicode escape")
                code.toChar()
            }
            else -> throw JsonParseException("Bad escape \\$char")
        }
    }

    private fun readNumber(): JsonValue.Num {
        val start = index
        if (peek('-')) index += 1
        if (index >= text.length || !text[index].isDigit()) throw JsonParseException("Bad number")
        if (text[index] == '0') index += 1
        else while (index < text.length && text[index].isDigit()) index += 1
        if (peek('.')) {
            index += 1
            if (index >= text.length || !text[index].isDigit()) throw JsonParseException("Bad number")
            while (index < text.length && text[index].isDigit()) index += 1
        }
        if (index < text.length && (text[index] == 'e' || text[index] == 'E')) {
            index += 1
            if (index < text.length && (text[index] == '+' || text[index] == '-')) index += 1
            if (index >= text.length || !text[index].isDigit()) throw JsonParseException("Bad number")
            while (index < text.length && text[index].isDigit()) index += 1
        }
        val raw = text.substring(start, index)
        val value = raw.toDoubleOrNull() ?: throw JsonParseException("Bad number $raw")
        return JsonValue.Num(raw, value)
    }

    private fun skip() {
        while (index < text.length && text[index].isWhitespace()) index += 1
    }

    private fun peek(char: Char) = index < text.length && text[index] == char

    private fun expect(char: Char) {
        if (!peek(char)) throw JsonParseException("Expected '$char' at $index")
        index += 1
    }
}

fun JsonValue.stringify(): String {
    shape() // Also rejects cycles before a StringBuilder can grow without bound.
    return buildString { appendJson(this@stringify) }
}

private fun StringBuilder.appendJson(value: JsonValue) {
    when (value) {
        is JsonValue.Null -> append("null")
        is JsonValue.Bool -> append(if (value.value) "true" else "false")
        is JsonValue.Num -> append(value.raw)
        is JsonValue.Str -> append(escapeJson(value.value))
        is JsonValue.Arr -> {
            append('[')
            value.items.forEachIndexed { index, item ->
                if (index > 0) append(',')
                appendJson(item)
            }
            append(']')
        }
        is JsonValue.Obj -> {
            append('{')
            var first = true
            for ((key, item) in value.fields) {
                if (!first) append(',')
                first = false
                append(escapeJson(key))
                append(':')
                appendJson(item)
            }
            append('}')
        }
    }
}

/** Escape the way `JSON.stringify` does, including U+2028 and U+2029. */
fun escapeJson(value: String): String = buildString(value.length + 2) {
    append('"')
    for (char in value) {
        when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000C' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            '\u2028' -> append("\\u2028")
            '\u2029' -> append("\\u2029")
            else -> if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
        }
    }
    append('"')
}

fun jsNumber(value: Double): String {
    if (value == 0.0) return "0"
    val whole = value.toLong()
    if (whole.toDouble() == value && value >= -9_007_199_254_740_992.0 && value <= 9_007_199_254_740_992.0) {
        return whole.toString()
    }
    return value.toString().replace('E', 'e')
}

/** Bounded traversal counts aliases per occurrence: an exponential DAG is not a cheap tree. */
fun JsonValue.shape(limits: JsonLimits = JsonLimits()): JsonShape {
    var nodes = 0
    var maxDepth = 0
    val ancestors = java.util.IdentityHashMap<JsonValue, Boolean>()
    fun visit(value: JsonValue, depth: Int) {
        nodes += 1
        maxDepth = maxOf(maxDepth, depth)
        if (depth > limits.maxDepth || nodes > limits.maxNodes || ancestors.containsKey(value)) {
            throw JsonLimitException(depth, nodes)
        }
        when (value) {
            is JsonValue.Obj -> {
                ancestors[value] = true
                for (item in value.fields.values) visit(item, depth + 1)
                ancestors.remove(value)
            }
            is JsonValue.Arr -> {
                ancestors[value] = true
                for (item in value.items) visit(item, depth + 1)
                ancestors.remove(value)
            }
            else -> Unit
        }
    }
    visit(this, 1)
    return JsonShape(maxDepth, nodes)
}

fun JsonValue.deepCopy(): JsonValue {
    shape() // Preflight before allocating copies; no recursive allocation on cycles/deep trees.
    return copyTree()
}

private fun JsonValue.copyTree(): JsonValue = when (this) {
    is JsonValue.Obj -> JsonValue.Obj(LinkedHashMap<String, JsonValue>(fields.size).also { copy ->
        for ((key, value) in fields) copy[key] = value.copyTree()
    })
    is JsonValue.Arr -> JsonValue.Arr(ArrayList<JsonValue>(items.size).also { copy ->
        for (item in items) copy.add(item.copyTree())
    })
    else -> this // Scalars are immutable.
}
