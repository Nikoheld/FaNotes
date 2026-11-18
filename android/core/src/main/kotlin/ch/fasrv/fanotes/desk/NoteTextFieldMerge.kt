package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString

/**
 * Per-box merge of note text boxes, ported from `fanotes/electron/noteTextFieldMerge.mjs`, plus the deleted-box
 * records (`textFieldTombstones`) and the style ladder of `fanotes/src/lib/noteTextField.ts`.
 *
 * A box carries `updatedAt` (epoch ms of its last edit). A deleted box leaves `{ id, deletedAt }` in the payload key
 * `textFieldTombstones`, next to `textFields`, so a stale edit of it can be told apart from a box that never existed.
 */

data class NoteTextFieldTombstone(val id: String, val deletedAt: Long)

data class NoteTextFieldOps(val upserts: List<NoteTextField>, val deletes: List<NoteTextFieldTombstone>)

data class NoteTextFieldMergeResult(val fields: List<NoteTextField>, val tombstones: List<NoteTextFieldTombstone>)

const val NOTE_TEXT_FIELD_TOMBSTONE_LIMIT = 200

/** A tombstone older than this is dropped; a stale window that old has long been reloaded. */
const val NOTE_TEXT_FIELD_TOMBSTONE_TTL_MS = 30L * 24 * 60 * 60 * 1000

/** A stamp this far ahead of the local clock is clamped, so one skewed device cannot win every conflict. */
const val NOTE_TEXT_FIELD_CLOCK_SKEW_MS = 5L * 60 * 1000

/** Desktop font-size ladder of the text-box toolbar. */
val NOTE_TEXT_FIELD_FONT_SIZES = listOf(10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48)

/** A colour choice of the text-box toolbar; a null value is the default dark ink. */
data class NoteTextFieldColor(val value: String?, val label: String, val css: String)

val NOTE_TEXT_FIELD_COLORS = listOf(
    NoteTextFieldColor(null, "Schwarz", "#20222b"),
    NoteTextFieldColor("#c62f4a", "Rot", "#c62f4a"),
    NoteTextFieldColor("#c8741a", "Orange", "#c8741a"),
    NoteTextFieldColor("#1f8a5b", "Grün", "#1f8a5b"),
    NoteTextFieldColor("#2563c9", "Blau", "#2563c9"),
    NoteTextFieldColor("#7a4bc4", "Violett", "#7a4bc4"),
)

/** Page width (layout px) at which a stored font size is shown 1:1 on a PDF. */
const val NOTE_TEXT_FIELD_REFERENCE_PAGE_WIDTH = 820.0

private val TOMBSTONE_ID = Regex("^[a-zA-Z0-9._-]{1,96}$")
private const val STAMP_MAX = 8_640_000_000_000_000L

/** A font size the box ladder accepts (10..48); anything else is not remembered. */
fun noteTextFieldFontSizeOrNull(value: Int?): Int? = value?.takeIf { it in 10..48 }

/** Next/previous step of the font-size ladder; unknown sizes snap to the nearest rung first. */
fun stepNoteTextFieldFontSize(size: Int, direction: Int): Int {
    val sizes = NOTE_TEXT_FIELD_FONT_SIZES
    var nearest = 0
    for (index in 1 until sizes.size) {
        if (kotlin.math.abs(sizes[index] - size) < kotlin.math.abs(sizes[nearest] - size)) nearest = index
    }
    val exact = sizes[nearest] == size
    val target = when {
        exact -> nearest + direction
        direction > 0 -> if (sizes[nearest] > size) nearest else nearest + 1
        else -> if (sizes[nearest] < size) nearest else nearest - 1
    }
    return sizes[target.coerceIn(0, sizes.size - 1)]
}

/**
 * Restyles one box like the desktop toolbar does. [color] is applied when [setColor] is true (null: default ink).
 * A change stamps the box; a patch that changes nothing returns the list unchanged.
 */
fun restyleNoteTextField(
    fields: List<NoteTextField>,
    id: String,
    fontSize: Int? = null,
    setColor: Boolean = false,
    color: String? = null,
    bold: Boolean? = null,
    now: Long = System.currentTimeMillis(),
): List<NoteTextField> {
    val current = parseNoteTextFieldList(fields)
    var changed = false
    val next = current.map { field ->
        if (field.id != id) return@map field
        val styled = field.copy(
            fontSize = noteTextFieldFontSizeOrNull(fontSize) ?: field.fontSize,
            color = if (setColor) color?.lowercase()?.takeIf { Regex("^#[0-9a-f]{6}$").matches(it) } else field.color,
            bold = bold ?: field.bold,
        )
        if (sameNoteTextFieldContent(styled, field)) field else {
            changed = true
            styled.copy(updatedAt = maxOf(now, (field.updatedAt ?: 0L) + 1L))
        }
    }
    return if (changed) next else fields
}

/** Everything the user sees or edits, without the edit time. */
fun sameNoteTextFieldContent(left: NoteTextField, right: NoteTextField): Boolean =
    left.page == right.page &&
        left.x == right.x &&
        left.y == right.y &&
        left.width == right.width &&
        left.fontSize == right.fontSize &&
        left.text == right.text &&
        left.color == right.color &&
        left.bold == right.bold

private fun stampOf(field: NoteTextField?): Long = field?.updatedAt ?: 0L

fun parseNoteTextFieldTombstones(array: JsonValue.Arr?): List<NoteTextFieldTombstone> {
    val latest = LinkedHashMap<String, Long>()
    for (item in array?.items.orEmpty()) {
        val obj = item as? JsonValue.Obj ?: continue
        val id = obj.string("id")?.takeIf { TOMBSTONE_ID.matches(it) } ?: continue
        val stamp = obj.double("deletedAt")?.takeIf { it.isFinite() && it > 0 && it <= STAMP_MAX }?.let { kotlin.math.floor(it).toLong() }
            ?: continue
        latest[id] = maxOf(latest[id] ?: 0L, stamp)
    }
    return latest.entries
        .sortedByDescending { it.value }
        .take(NOTE_TEXT_FIELD_TOMBSTONE_LIMIT)
        .map { NoteTextFieldTombstone(it.key, it.value) }
}

fun noteTextFieldTombstonesJson(tombstones: List<NoteTextFieldTombstone>): JsonValue.Arr =
    JsonValue.Arr(tombstones.map { jsonObject("id" to jsonString(it.id), "deletedAt" to jsonNumber(it.deletedAt.toDouble())) }.toMutableList())

/** Writes both keys on a payload copy; an empty list removes its key, as the desktop serializer does. */
fun writeNoteTextFieldsAndTombstones(
    payload: JsonValue.Obj,
    fields: List<NoteTextField>,
    tombstones: List<NoteTextFieldTombstone>,
): JsonValue.Obj {
    val next = writeNoteTextFields(payload, fields)
    next.put("textFieldTombstones", if (tombstones.isEmpty()) null else noteTextFieldTombstonesJson(tombstones))
    return next
}

/**
 * Deletes one box and records it in `textFieldTombstones`, so a desktop window or device that still has the box
 * does not bring it back on its next merge. Returns the payload copy and the remaining boxes.
 */
fun deleteNoteTextFieldInPayload(
    payload: JsonValue.Obj,
    fields: List<NoteTextField>,
    id: String,
    now: Long = System.currentTimeMillis(),
): Pair<JsonValue.Obj, List<NoteTextField>> {
    val current = parseNoteTextFieldList(fields)
    val gone = current.firstOrNull { it.id == id } ?: return (payload.deepCopy() as JsonValue.Obj) to current
    val remaining = current.filter { it.id != id }
    val stored = parseNoteTextFieldTombstones(payload.array("textFieldTombstones"))
    val tombstones = pruneTombstones(stored + NoteTextFieldTombstone(id, maxOf(now, stampOf(gone) + 1)), now)
    return writeNoteTextFieldsAndTombstones(payload, remaining, tombstones) to remaining
}

private fun pruneTombstones(list: List<NoteTextFieldTombstone>, now: Long): List<NoteTextFieldTombstone> {
    val latest = LinkedHashMap<String, Long>()
    for (entry in list) latest[entry.id] = maxOf(latest[entry.id] ?: 0L, entry.deletedAt)
    return latest.entries
        .filter { it.value > now - NOTE_TEXT_FIELD_TOMBSTONE_TTL_MS }
        .sortedByDescending { it.value }
        .take(NOTE_TEXT_FIELD_TOMBSTONE_LIMIT)
        .map { NoteTextFieldTombstone(it.key, it.value) }
}

/** What this device changed relative to the disk state it last saw ([base]). Only changed boxes are sent. */
fun diffNoteTextFields(base: List<NoteTextField>, local: List<NoteTextField>, now: Long): NoteTextFieldOps {
    val baseById = base.associateBy { it.id }
    val localIds = HashSet<String>()
    val upserts = ArrayList<NoteTextField>()
    for (box in local) {
        localIds += box.id
        val before = baseById[box.id]
        if (before != null && sameNoteTextFieldContent(before, box)) continue
        val updatedAt = if (stampOf(box) > stampOf(before)) box.updatedAt!! else maxOf(now, stampOf(before) + 1)
        upserts += box.copy(updatedAt = updatedAt)
    }
    val deletes = base.filter { it.id !in localIds }.map { NoteTextFieldTombstone(it.id, maxOf(now, stampOf(it) + 1)) }
    return NoteTextFieldOps(upserts, deletes)
}

/**
 * Applies one side's changes to the boxes stored on disk. Per box the newer edit wins; a delete and an edit of the
 * same box are compared by time, so typed text is never lost to an older delete and a delete is never undone by an
 * older edit. At the very same millisecond the box stays.
 */
fun applyNoteTextFieldOps(
    current: List<NoteTextField>,
    tombstones: List<NoteTextFieldTombstone>,
    ops: NoteTextFieldOps,
    now: Long,
): NoteTextFieldMergeResult {
    val fields = LinkedHashMap<String, NoteTextField>()
    for (box in current) fields[box.id] = box
    val dead = LinkedHashMap<String, Long>()
    for (entry in tombstones) dead[entry.id] = entry.deletedAt
    val ceiling = now + NOTE_TEXT_FIELD_CLOCK_SKEW_MS
    fun seen(stamp: Long) = minOf(stamp, ceiling)
    for (raw in ops.upserts) {
        val updatedAt = seen(stampOf(raw).takeIf { it > 0 } ?: now)
        val existing = fields[raw.id]
        if (existing != null && seen(stampOf(existing)) > updatedAt) continue
        val deletedAt = dead[raw.id]
        if (deletedAt != null && updatedAt < seen(deletedAt)) continue
        fields[raw.id] = raw.copy(updatedAt = updatedAt)
        dead.remove(raw.id)
    }
    for (gone in ops.deletes) {
        val deletedAt = seen(gone.deletedAt.takeIf { it > 0 } ?: now)
        val existing = fields[gone.id]
        if (existing != null && seen(stampOf(existing)) >= deletedAt) continue
        fields.remove(gone.id)
        dead[gone.id] = maxOf(deletedAt, dead[gone.id] ?: 0L)
    }
    val kept = dead.entries
        .filter { it.value > now - NOTE_TEXT_FIELD_TOMBSTONE_TTL_MS }
        .sortedByDescending { it.value }
        .take(NOTE_TEXT_FIELD_TOMBSTONE_LIMIT)
        .map { NoteTextFieldTombstone(it.key, it.value) }
    return NoteTextFieldMergeResult(fields.values.take(NOTE_TEXT_FIELD_LIMIT), kept)
}

private fun pickBox(base: NoteTextField?, local: NoteTextField, remote: NoteTextField): NoteTextField = when {
    sameNoteTextFieldContent(local, remote) -> remote
    base != null && sameNoteTextFieldContent(local, base) -> remote
    base != null && sameNoteTextFieldContent(remote, base) -> local
    // Both sides changed it (or nothing is known about the common state): the newer edit wins, a tie stays local.
    else -> if (stampOf(remote) > stampOf(local)) remote else local
}

/**
 * Three-way merge of this device's boxes ([local]) with the boxes now on disk ([remote]), against the disk state
 * this device last saw ([base]). Local boxes keep their order; boxes new from disk follow.
 */
fun mergeNoteTextFields(base: List<NoteTextField>, local: List<NoteTextField>, remote: List<NoteTextField>): List<NoteTextField> {
    val baseById = base.associateBy { it.id }
    val remoteById = remote.associateBy { it.id }
    val merged = ArrayList<NoteTextField>()
    val seen = HashSet<String>()
    for (box in local) {
        seen += box.id
        val before = baseById[box.id]
        val stored = remoteById[box.id]
        if (stored == null) {
            if (before != null && sameNoteTextFieldContent(box, before)) continue
            merged += box
            continue
        }
        merged += pickBox(before, box, stored)
    }
    for (stored in remote) {
        if (stored.id in seen) continue
        val before = baseById[stored.id]
        if (before != null && sameNoteTextFieldContent(stored, before)) continue
        merged += stored
    }
    return merged.take(NOTE_TEXT_FIELD_LIMIT)
}

/**
 * The boxes and tombstones to save when the file on disk ([disk]) may have changed since this device read it
 * ([base], the boxes as last read or saved). When the disk still holds [base], the local state is written as is;
 * otherwise only this device's own changes are applied on top of the disk, box by box (desktop main-process rule).
 */
fun noteTextFieldsForSave(
    base: List<NoteTextField>,
    local: List<NoteTextField>,
    localTombstones: List<NoteTextFieldTombstone>,
    disk: List<NoteTextField>,
    diskTombstones: List<NoteTextFieldTombstone>,
    now: Long,
): NoteTextFieldMergeResult {
    val diskUnchanged = disk.size == base.size && disk.zip(base).all { (a, b) -> a.id == b.id && stampOf(a) == stampOf(b) && sameNoteTextFieldContent(a, b) }
    if (diskUnchanged) return NoteTextFieldMergeResult(local, pruneTombstones(localTombstones + diskTombstones, now))
    val ops = diffNoteTextFields(base, local, now)
    return applyNoteTextFieldOps(disk, pruneTombstones(diskTombstones + localTombstones, now), ops, now)
}
