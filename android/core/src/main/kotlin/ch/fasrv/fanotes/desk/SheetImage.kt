package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import kotlin.math.max
import kotlin.math.min

/**
 * Floating picture geometry, the same contract as the desktop `sheetImage.ts` and the clamp in
 * `validateWorksheetDocument` (electron/main.cjs). A placement is stored in the worksheet JSON as
 * fractions of the paper width: [x] and [width] are the left edge and width, [y] is the top edge in
 * paper widths. The height follows from the picture's own aspect (height / width).
 */
data class SheetImagePlacement(val x: Double, val y: Double, val width: Double)

const val SHEET_IMAGE_MIN_WIDTH = 0.08
const val SHEET_IMAGE_MAX_WIDTH = 1.0
const val SHEET_IMAGE_START_WIDTH = 0.85

/** Lowest top edge in paper widths; matches the main-process validator. */
const val SHEET_IMAGE_MAX_Y = 2000.0
const val SHEET_IMAGE_MIN_ASPECT = 0.02
const val SHEET_IMAGE_MAX_ASPECT = 50.0

private fun finiteOr(value: Double?, fallback: Double) = if (value != null && value.isFinite()) value else fallback

fun clampSheetAspect(value: Double?): Double =
    min(SHEET_IMAGE_MAX_ASPECT, max(SHEET_IMAGE_MIN_ASPECT, finiteOr(value, 0.75)))

fun clampSheetPlacement(placement: SheetImagePlacement): SheetImagePlacement {
    val width = min(SHEET_IMAGE_MAX_WIDTH, max(SHEET_IMAGE_MIN_WIDTH, finiteOr(placement.width, 0.5)))
    return SheetImagePlacement(
        x = min(1.0 - width, max(0.0, finiteOr(placement.x, 0.0))),
        y = min(SHEET_IMAGE_MAX_Y, max(0.0, finiteOr(placement.y, 0.0))),
        width = width,
    )
}

fun sheetImageBottom(placement: SheetImagePlacement, aspect: Double?): Double =
    placement.y + placement.width * clampSheetAspect(aspect)

/** Placement of a worksheet record, or null when it has none or it is not three finite numbers (a full-width block). */
fun readSheetPlacement(record: JsonValue.Obj): SheetImagePlacement? {
    if (record.string("kind") != "image") return null
    val raw = record.obj("placement") ?: return null
    val x = raw.double("x") ?: return null
    val y = raw.double("y") ?: return null
    val width = raw.double("width") ?: return null
    if (!x.isFinite() || !y.isFinite() || !width.isFinite()) return null
    return clampSheetPlacement(SheetImagePlacement(x, y, width))
}

/** Stored aspect (height / width), clamped like the desktop; null when the record carries none. */
fun readSheetAspect(record: JsonValue.Obj): Double? {
    val aspect = record.double("aspect") ?: return null
    return if (aspect.isFinite()) clampSheetAspect(aspect) else null
}

/**
 * Writes a clamped placement and aspect into a parsed worksheet record in place. Every other field of
 * the record (text boxes, highlights, fields from newer builds) stays untouched.
 */
fun writeSheetPlacement(record: JsonValue.Obj, placement: SheetImagePlacement, aspect: Double?) {
    val clamped = clampSheetPlacement(placement)
    val next = JsonValue.Obj()
    next.put("x", jsonNumber(clamped.x))
    next.put("y", jsonNumber(clamped.y))
    next.put("width", jsonNumber(clamped.width))
    record.put("placement", next)
    record.put("aspect", jsonNumber(clampSheetAspect(aspect ?: readSheetAspect(record))))
}

/** Moves a placed picture by a delta in paper widths. */
fun movedSheetPlacement(placement: SheetImagePlacement, dx: Double, dy: Double): SheetImagePlacement =
    clampSheetPlacement(placement.copy(x = placement.x + dx, y = placement.y + dy))

/** Resizes from the bottom-right corner, keeping the top-left fixed. */
fun resizedSheetPlacement(placement: SheetImagePlacement, newWidth: Double): SheetImagePlacement =
    clampSheetPlacement(placement.copy(width = newWidth))
