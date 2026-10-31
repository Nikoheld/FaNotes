package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.ink.keepMarkOnPage
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import kotlin.math.max
import kotlin.math.min

/**
 * Keyboard text box on a markdown or PDF note.
 * Ported from `fanotes/src/lib/noteTextField.ts`.
 * Stored in the famd `textFields` array, not in the markdown body.
 */

data class NoteTextField(
    val id: String,
    val page: Int,
    val x: Double,
    val y: Double,
    val width: Double,
    val text: String,
    val fontSize: Int,
)

private val TEXT_FIELD_ID = Regex("^[a-zA-Z0-9._-]{1,96}$")
const val NOTE_TEXT_FIELD_LIMIT = 200
const val TEXT_FIELD_LIMIT_MESSAGE = "Auf dieser Notiz sind schon 200 Textfelder."
private const val TEXT_FIELD_MAX_CHARS = 8000
const val NOTE_TEXT_FIELD_WIDTH = 0.32
const val NOTE_TEXT_FIELD_FONT = 16

data class ArmedTextFieldTap(
    val fields: List<NoteTextField>,
    val placed: NoteTextField?,
    val message: String?,
    val stillPlacing: Boolean,
)

fun newNoteTextFieldId(): String {
    val suffix = java.util.UUID.randomUUID().toString().replace("-", "").take(6)
    return "tf-${System.currentTimeMillis().toString(36)}-$suffix"
}

/** Click point becomes the top-left of a new empty field, kept on the page. */
fun placeNoteTextField(point: NoteLinkPoint, id: String? = null): NoteTextField {
    val width = NOTE_TEXT_FIELD_WIDTH
    return sanitizeNoteTextField(
        id = id,
        page = point.page,
        x = min(clampUnit(point.x, 0.5), 1.0 - width),
        y = min(clampUnit(point.y, 0.5), 0.92),
        width = width,
        text = "",
        fontSize = NOTE_TEXT_FIELD_FONT,
    )
}

/**
 * A tap while text-field placement is armed stores a note text field on any
 * open page. Empty frames are a normal markdown page with no worksheet bitmap:
 * the point stays on page 1. This does not create a worksheet box.
 */
fun commitArmedTextFieldTap(
    armed: Boolean,
    x: Double,
    y: Double,
    frames: List<PageFrame>,
    sourceWidth: Double,
    sourceHeight: Double,
    existing: List<NoteTextField>,
    id: String? = null,
): ArmedTextFieldTap {
    val current = parseNoteTextFieldList(existing)
    if (!armed) return ArmedTextFieldTap(current, null, null, false)
    if (current.size >= NOTE_TEXT_FIELD_LIMIT) {
        return ArmedTextFieldTap(current, null, TEXT_FIELD_LIMIT_MESSAGE, true)
    }
    val point = noteLinkPointOnSheet(x, y, frames, sourceWidth, sourceHeight)
    return acceptPlacedTextField(current, placeNoteTextField(point, id))
}

fun acceptPlacedTextField(existing: List<NoteTextField>, field: NoteTextField): ArmedTextFieldTap {
    val current = parseNoteTextFieldList(existing)
    if (current.size >= NOTE_TEXT_FIELD_LIMIT) {
        return ArmedTextFieldTap(current, null, TEXT_FIELD_LIMIT_MESSAGE, true)
    }
    val clean = sanitizeNoteTextField(field.id, field.page, field.x, field.y, field.width, field.text, field.fontSize)
    if (current.any { it.id == clean.id }) return ArmedTextFieldTap(current, null, null, true)
    return ArmedTextFieldTap(current + clean, clean, null, false)
}

fun parseNoteTextFields(array: JsonValue.Arr?): List<NoteTextField> {
    val items = array?.items ?: return emptyList()
    val seen = linkedSetOf<String>()
    val fields = mutableListOf<NoteTextField>()
    for (item in items) {
        val obj = item as? JsonValue.Obj ?: continue
        val field = sanitizeNoteTextField(
            id = obj.string("id"),
            page = wholeInt(obj, "page"),
            x = obj.double("x"),
            y = obj.double("y"),
            width = obj.double("width"),
            text = obj.string("text"),
            fontSize = wholeInt(obj, "fontSize"),
        )
        if (field.id in seen) continue
        seen += field.id
        fields += field
        if (fields.size >= NOTE_TEXT_FIELD_LIMIT) break
    }
    return fields
}

fun parseNoteTextFieldList(fields: List<NoteTextField>): List<NoteTextField> {
    val seen = linkedSetOf<String>()
    val clean = mutableListOf<NoteTextField>()
    for (field in fields) {
        val next = sanitizeNoteTextField(field.id, field.page, field.x, field.y, field.width, field.text, field.fontSize)
        if (next.id in seen) continue
        seen += next.id
        clean += next
        if (clean.size >= NOTE_TEXT_FIELD_LIMIT) break
    }
    return clean
}

fun noteTextFieldsJson(fields: List<NoteTextField>): JsonValue.Arr = JsonValue.Arr(parseNoteTextFieldList(fields).map { field ->
    ch.fasrv.fanotes.json.jsonObject(
        "id" to jsonString(field.id),
        "page" to jsonNumber(field.page.toDouble()),
        "x" to jsonNumber(field.x),
        "y" to jsonNumber(field.y),
        "width" to jsonNumber(field.width),
        "fontSize" to jsonNumber(field.fontSize.toDouble()),
        "text" to jsonString(field.text),
    )
}.toMutableList())

/** Writes `textFields` on a payload copy. An empty list removes the key. Markdown is not touched. */
fun writeNoteTextFields(payload: JsonValue.Obj, fields: List<NoteTextField>): JsonValue.Obj {
    val next = payload.deepCopy() as JsonValue.Obj
    val clean = parseNoteTextFieldList(fields)
    if (clean.isEmpty()) next.put("textFields", null) else next.put("textFields", noteTextFieldsJson(clean))
    return next
}

fun patchNoteTextField(
    fields: List<NoteTextField>,
    id: String,
    text: String? = null,
    page: Int? = null,
    x: Double? = null,
    y: Double? = null,
    width: Double? = null,
    fontSize: Int? = null,
): List<NoteTextField> {
    val current = parseNoteTextFieldList(fields)
    return parseNoteTextFieldList(current.map { field ->
        if (field.id != id) field
        else field.copy(
            page = page ?: field.page,
            x = x ?: field.x,
            y = y ?: field.y,
            width = width ?: field.width,
            text = text ?: field.text,
            fontSize = fontSize ?: field.fontSize,
        )
    })
}

fun removeNoteTextField(fields: List<NoteTextField>, id: String): List<NoteTextField> =
    parseNoteTextFieldList(fields).filter { it.id != id }

/**
 * Stored x/y/width are fractions of the painted sheet, the same space as ink.
 * A page grow keeps the box on the same paper instead of stretching it.
 */
fun noteTextFieldsAfterOriginGrow(
    fields: List<NoteTextField>,
    prevWidth: Double,
    prevHeight: Double,
    nextWidth: Double,
    nextHeight: Double,
    padX: Double = 0.0,
    padY: Double = 0.0,
): List<NoteTextField> {
    val padXSafe = max(0.0, if (padX.isFinite()) padX else 0.0)
    val padYSafe = max(0.0, if (padY.isFinite()) padY else 0.0)
    val prevW = if (prevWidth > 0.0) prevWidth else 1.0
    val nextW = if (nextWidth > 0.0) nextWidth else prevW
    val widthScale = prevW / nextW
    var changed = false
    val remapped = fields.map { field ->
        val x = keepMarkOnPage(field.x, prevWidth, nextWidth, padXSafe)
        val y = keepMarkOnPage(field.y, prevHeight, nextHeight, padYSafe)
        val width = clampWidth(field.width * widthScale)
        if (x == field.x && y == field.y && width == field.width) field
        else {
            changed = true
            field.copy(x = x, y = y, width = width)
        }
    }
    return if (changed) remapped else fields
}

/** Sheet fractions for the field origin. Without frames the stored point is already on the sheet. */
fun noteTextFieldOrigin(
    field: NoteTextField,
    frames: List<PageFrame>,
    sourceWidth: Double,
    sourceHeight: Double,
): Pair<Double, Double> {
    val frame = frames.firstOrNull { it.page == field.page } ?: frames.singleOrNull()
    if (frame == null || sourceWidth <= 0.0 || sourceHeight <= 0.0 || frame.height <= 0.0 || frame.width <= 0.0) {
        return field.x to field.y
    }
    return (field.x * frame.width) / sourceWidth to (frame.top + field.y * frame.height) / sourceHeight
}

/** Width as a fraction of the whole sheet. Without frames the stored width is that fraction. */
fun noteTextFieldWidthFraction(field: NoteTextField, frames: List<PageFrame>, sourceWidth: Double): Double {
    val frame = frames.firstOrNull { it.page == field.page } ?: frames.singleOrNull()
    if (frame == null || sourceWidth <= 0.0 || frame.width <= 0.0) return field.width
    return field.width * frame.width / sourceWidth
}

private fun sanitizeNoteTextField(
    id: String?,
    page: Int?,
    x: Double?,
    y: Double?,
    width: Double?,
    text: String?,
    fontSize: Int?,
): NoteTextField {
    val safeId = if (id != null && TEXT_FIELD_ID.matches(id)) id else newNoteTextFieldId()
    return NoteTextField(
        id = safeId,
        page = clampPage(page),
        x = clampUnit(x, 0.5),
        y = clampUnit(y, 0.5),
        width = clampWidth(width),
        text = text?.take(TEXT_FIELD_MAX_CHARS) ?: "",
        fontSize = clampFontSize(fontSize),
    )
}

private fun wholeInt(obj: JsonValue.Obj, key: String): Int? {
    val number = obj.double(key)
    if (number != null) {
        if (!number.isFinite()) return null
        val asInt = number.toInt()
        return if (asInt.toDouble() == number) asInt else null
    }
    return obj.string(key)?.toIntOrNull()
}

private fun clampUnit(value: Double?, fallback: Double): Double {
    val number = value ?: return fallback
    if (!number.isFinite()) return fallback
    return number.coerceIn(0.0, 1.0)
}

private fun clampWidth(value: Double?): Double {
    val number = value ?: return NOTE_TEXT_FIELD_WIDTH
    if (!number.isFinite()) return NOTE_TEXT_FIELD_WIDTH
    return number.coerceIn(0.12, 0.92)
}

private fun clampPage(value: Int?): Int = if (value != null && value in 1..10_000) value else 1

private fun clampFontSize(value: Int?): Int = if (value != null && value in 10..48) value else NOTE_TEXT_FIELD_FONT
