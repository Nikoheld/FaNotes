package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.jsNumber
import ch.fasrv.fanotes.json.parseJson

/**
 * Small helpers shared by the study models. They mirror the total parsers in
 * `fanotes/src/lib/study/blocks.ts`: bad JSON or odd values yield safe defaults.
 */

/** The object in [body], or null when the text is not a JSON object. */
fun parseJsonObjectOrNull(body: String): JsonValue.Obj? = try {
    parseJson(body) as? JsonValue.Obj
} catch (_: Exception) {
    null
}

/** `asText`: a string is cut to [max] UTF-16 units, a finite number becomes its JS string. */
internal fun JsonValue?.asText(max: Int, fallback: String = ""): String = when (this) {
    is JsonValue.Str -> value.take(max)
    is JsonValue.Num -> if (value.isFinite()) jsNumber(value) else fallback
    else -> fallback
}

internal fun JsonValue?.asArray(max: Int): List<JsonValue> = (this as? JsonValue.Arr)?.items?.take(max).orEmpty()

internal fun JsonValue?.asRecord(): JsonValue.Obj = this as? JsonValue.Obj ?: JsonValue.Obj()

internal fun JsonValue.Obj.text(key: String, max: Int, fallback: String = ""): String = this[key].asText(max, fallback)

/** `JSON.stringify(value, null, indent)` for the JSON DOM. */
fun prettyJson(value: JsonValue, indent: Int = 1): String = buildString { appendPretty(value, indent, 0) }

private fun StringBuilder.appendPretty(value: JsonValue, indent: Int, depth: Int) {
    when (value) {
        is JsonValue.Null -> append("null")
        is JsonValue.Bool -> append(if (value.value) "true" else "false")
        is JsonValue.Num -> append(value.raw)
        is JsonValue.Str -> append(escapeJson(value.value))
        is JsonValue.Arr -> {
            if (value.items.isEmpty()) {
                append("[]")
                return
            }
            append("[\n")
            value.items.forEachIndexed { index, item ->
                append(" ".repeat(indent * (depth + 1)))
                appendPretty(item, indent, depth + 1)
                if (index < value.items.lastIndex) append(',')
                append('\n')
            }
            append(" ".repeat(indent * depth)).append(']')
        }
        is JsonValue.Obj -> {
            if (value.fields.isEmpty()) {
                append("{}")
                return
            }
            append("{\n")
            var index = 0
            for ((key, item) in value.fields) {
                append(" ".repeat(indent * (depth + 1)))
                append(escapeJson(key)).append(": ")
                appendPretty(item, indent, depth + 1)
                if (++index < value.fields.size) append(',')
                append('\n')
            }
            append(" ".repeat(indent * depth)).append('}')
        }
    }
}

internal fun num(value: Int): JsonValue = JsonValue.Num(value.toString(), value.toDouble())

/** JS `Math.round`: halves go up, unlike [kotlin.math.round]. */
internal fun jsRound(value: Double): Double = Math.floor(value + 0.5)

private const val ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

/** An id like the desktop `newId`: prefix, six random base-36 characters, three from the clock. */
fun newStudyId(prefix: String, random: java.util.Random = java.util.Random(), now: Long = System.currentTimeMillis()): String {
    val head = buildString { repeat(6) { append(ID_ALPHABET[random.nextInt(36)]) } }
    return prefix + head + java.lang.Long.toString(now, 36).takeLast(3)
}
