package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue

/**
 * Safe editing of a study block from the tablet. A block is identified by its kind, its offset in the
 * whole note and a hash of its JSON, never by its position in what the editor shows (folded sections
 * hide blocks), and an edit is refused when the note changed underneath it or the block cannot be
 * read back without loss.
 */

fun studyBodyHash(body: String): Int = body.hashCode()

/** The block of [kind] whose JSON hashes to [hash], nearest to [from]; null when the note changed. */
fun locateStudyBlock(markdown: String, kind: StudyKind, from: Int, hash: Int): StudyBlockRef? =
    findStudyBlocks(markdown)
        .filter { it.kind == kind && studyBodyHash(it.body) == hash }
        .minByOrNull { Math.abs(it.from - from) }

/** [updated] laid over [original]: fields the editor does not know stay, objects in lists match by `id`. */
fun mergeJson(original: JsonValue?, updated: JsonValue): JsonValue {
    if (original is JsonValue.Obj && updated is JsonValue.Obj) {
        val out = JsonValue.Obj(LinkedHashMap(original.fields))
        for ((key, value) in updated.fields) out.fields[key] = mergeJson(original.fields[key], value)
        return out
    }
    if (original is JsonValue.Arr && updated is JsonValue.Arr) {
        val byId = original.items.mapNotNull { item -> (item as? JsonValue.Obj)?.string("id")?.let { it to item } }.toMap()
        return JsonValue.Arr(
            updated.items.map { item ->
                val id = (item as? JsonValue.Obj)?.string("id")
                if (id != null && byId[id] != null) mergeJson(byId[id], item) else item
            }.toMutableList(),
        )
    }
    return updated
}

/** The note with [ref] replaced by [updated] merged into the block's own JSON. */
fun writeStudyBlockMerged(markdown: String, ref: StudyBlockRef, updated: JsonValue): String {
    val original = parseJsonObjectOrNull(ref.body)
    // Crypto answers are replaced as a whole (a removed letter of the frequency grid must not come back); only unknown fields stay.
    val merged = if (ref.kind == StudyKind.CRYPTO && updated is JsonValue.Obj) ch.fasrv.fanotes.study.crypto.mergeCryptoJson(original, updated) else mergeJson(original, updated)
    return replaceStudyBlock(markdown, ref, merged)
}

private fun JsonValue.Obj.longer(key: String, max: Int) = (this[key] as? JsonValue.Str)?.value?.let { it.length > max } == true

/** The sorting board when every part of it survives reading and writing; null means "do not edit here". */
fun sortEditable(body: String): SortData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    if (raw.fields.isEmpty()) return defaultSortData()
    val cards = raw["cards"].asArray(Int.MAX_VALUE)
    val groups = raw["groups"].asArray(Int.MAX_VALUE)
    if (cards.size > 120 || groups.size > 12 || raw.longer("title", 120)) return null
    if (cards.any { val c = it.asRecord(); c.longer("text", 200) || c.longer("id", 40) || c.text("text", 200).isBlank() }) return null
    if (groups.any { val g = it.asRecord(); g.longer("title", 80) || g.longer("id", 40) || g["cards"].asArray(Int.MAX_VALUE).size > 120 }) return null
    val data = normaliseSortData(raw)
    if (data.cards.size != cards.size) return null
    val expectedPlaced = groups.sumOf { it.asRecord()["cards"].asArray(Int.MAX_VALUE).size }
    if (data.groups.sumOf { it.cards.size } != expectedPlaced) return null
    return data
}

fun termEditable(body: String): TermData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    if (raw.fields.isEmpty()) return defaultTermData()
    val terms = raw["terms"].asArray(Int.MAX_VALUE)
    if (terms.size > 30) return null
    val limits = mapOf("id" to 40, "term" to 160, "definition" to 2000, "example" to 1000, "source" to 300)
    if (terms.any { entry -> val t = entry.asRecord(); limits.any { (key, max) -> t.longer(key, max) } }) return null
    val data = normaliseTermData(raw)
    return if (data.terms.size == terms.size) data else null
}
