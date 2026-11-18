package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsNumber

/**
 * Port of the desktop `findLoss` (`lib/study/registry.ts`): the first place where [data] (the sanitised model as
 * JSON) holds less than [raw] (what the note says), or null. Padding and generated ids are not loss.
 */
fun findStudyLoss(raw: JsonValue?, data: JsonValue?, path: String = ""): String? {
    when (raw) {
        is JsonValue.Arr -> {
            if (data !is JsonValue.Arr) return path.ifEmpty { "Wert" }
            if (raw.items.size > data.items.size) return "${path.ifEmpty { "Liste" }} (${raw.items.size} Einträge, übernommen würden ${data.items.size})"
            val byId = data.items.isNotEmpty() && data.items.all { (it as? JsonValue.Obj)?.string("id") != null }
            for ((index, entry) in raw.items.withIndex()) {
                val entryId = (entry as? JsonValue.Obj)?.string("id")
                val other = if (byId && entryId != null) data.items.firstOrNull { (it as JsonValue.Obj).string("id") == entryId } else data.items.getOrNull(index)
                if (other == null) return "$path[$index]"
                findStudyLoss(entry, other, "$path[$index]")?.let { return it }
            }
            return null
        }
        is JsonValue.Obj -> {
            if (data !is JsonValue.Obj) return path.ifEmpty { "Wert" }
            for ((key, value) in data.fields) {
                if (key !in raw.fields || key == "v") continue
                findStudyLoss(raw.fields[key], value, if (path.isNotEmpty()) "$path.$key" else key)?.let { return it }
            }
            return null
        }
        is JsonValue.Str -> return if (data is JsonValue.Str && data.value == raw.value) null else path.ifEmpty { "Text" }
        is JsonValue.Num -> {
            val same = (data is JsonValue.Num && data.value == raw.value) || (data is JsonValue.Str && data.value == jsNumber(raw.value))
            return if (same) null else path.ifEmpty { "Zahl" }
        }
        is JsonValue.Bool -> return if (data is JsonValue.Bool && data.value == raw.value) null else path.ifEmpty { "Wert" }
        else -> return null
    }
}

/**
 * Strict reading for anything that may write a block back: the model, or null when the JSON does not parse or
 * the sanitiser would cut or rewrite something (the caller then leaves the block alone).
 */
fun <T> readStudyStrict(body: String, default: () -> T, normalise: (JsonValue.Obj) -> T, toJson: (T) -> JsonValue): T? {
    if (body.isBlank()) return default()
    val raw = parseJsonObjectOrNull(body) ?: return null
    if (raw.fields.isEmpty()) return default()
    val data = normalise(raw)
    return if (findStudyLoss(raw, toJson(data)) == null) data else null
}
