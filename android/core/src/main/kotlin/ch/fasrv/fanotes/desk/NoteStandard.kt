package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.ink.OVERLAY_QUALITY
import ch.fasrv.fanotes.ink.OVERLAY_QUALITY_ZOOM
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.stringify

/**
 * Desktop „Alte Notizen auf den aktuellen Standard“.
 * Old ink is stamped with the current HiDPI overlay quality. Strokes,
 * markdown, worksheets, links, backups and page stats stay put.
 */

data class NoteStandardConversion(val source: String, val converted: Boolean)

data class NoteStandardBatch(val converted: Int, val skipped: Int, val failed: Int) {
    fun summary(): String = "$converted Notizen aktualisiert, $skipped schon aktuell, $failed übersprungen."
}

fun noteInkQuality(ink: JsonValue.Obj?): Double {
    val quality = ink?.double("overlayQuality") ?: return 0.0
    return if (quality.isFinite()) quality else 0.0
}

fun isOldPixelatedNote(ink: JsonValue.Obj?): Boolean {
    if (ink == null) return false
    val strokes = ink.array("strokes")?.items ?: return false
    if (strokes.isEmpty()) return false
    return noteInkQuality(ink) + 1e-6 < OVERLAY_QUALITY
}

/** A vault `.famd` that can hold note ink. History and other dotfiles stay out. */
fun isConvertibleFamdPath(path: String): Boolean {
    if (!path.endsWith(".famd", ignoreCase = true)) return false
    val normalized = path.replace('\\', '/').trimStart('/')
    return normalized != ".fanotes" && !normalized.startsWith(".fanotes/") && !normalized.contains("/.fanotes/")
}

fun convertFamdToCurrentStandard(source: String): NoteStandardConversion {
    val original = source
    val parsed = parseFamd(original)
    val payload = parsed.payload ?: return NoteStandardConversion(original, false)
    val ink = payload.obj("ink")
    if (!isOldPixelatedNote(ink)) return NoteStandardConversion(original, false)
    val upgradedInk = (ink!!.deepCopy() as JsonValue.Obj).also { copy ->
        copy.array("strokes")?.let { strokes -> copy.put("strokes", strokes.deepCopy()) }
        copy.put("overlayQuality", jsonNumber(OVERLAY_QUALITY))
        copy.put("overlayQualityZoom", jsonNumber(OVERLAY_QUALITY_ZOOM))
    }
    val nextPayload = payload.deepCopy() as JsonValue.Obj
    nextPayload.put("ink", upgradedInk)
    val nextSource = serializeFamd(parsed.markdown, nextPayload)
    val roundTrip = parseFamd(nextSource)
    if (roundTrip.markdown != parsed.markdown) throw IllegalStateException("convert round-trip dropped markdown")
    if (strokeJson(roundTrip.payload?.obj("ink")) != strokeJson(upgradedInk)) {
        throw IllegalStateException("convert round-trip dropped or changed ink strokes")
    }
    if (stringList(roundTrip.payload, "worksheets") != stringList(payload, "worksheets")) {
        throw IllegalStateException("convert round-trip dropped worksheets")
    }
    if (payload.array("noteLinks") != null && roundTrip.payload?.array("noteLinks")?.stringify() != payload.array("noteLinks")?.stringify()) {
        throw IllegalStateException("convert round-trip dropped note links")
    }
    if (payload.array("noteBackups") != null && roundTrip.payload?.array("noteBackups")?.stringify() != payload.array("noteBackups")?.stringify()) {
        throw IllegalStateException("convert round-trip dropped note backups")
    }
    if (payload.obj("pageStats") != null && roundTrip.payload?.obj("pageStats")?.stringify() != payload.obj("pageStats")?.stringify()) {
        throw IllegalStateException("convert round-trip dropped page stats")
    }
    val paper = payload.string("paperStyle")
    if (!paper.isNullOrBlank() && roundTrip.payload?.string("paperStyle") != paper) {
        throw IllegalStateException("convert round-trip dropped paper style")
    }
    if (noteInkQuality(roundTrip.payload?.obj("ink")) + 1e-6 < OVERLAY_QUALITY) {
        throw IllegalStateException("convert round-trip did not keep current ink quality")
    }
    return NoteStandardConversion(nextSource, true)
}

private fun strokeJson(ink: JsonValue.Obj?): String = ink?.array("strokes")?.stringify() ?: "[]"

private fun stringList(payload: JsonValue.Obj?, key: String): List<String> =
    payload?.array(key)?.items?.mapNotNull { (it as? JsonValue.Str)?.value }.orEmpty()
