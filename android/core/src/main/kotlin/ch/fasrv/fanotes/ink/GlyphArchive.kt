package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream

/**
 * GlyphenWerk training import. The tablet keeps the strokes from
 * `manifest.jsonl` and does not need the preview images.
 */

const val GLYPH_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024
private const val MAX_RECORDS = 8_000
private const val MAX_LINE_CHARS = 1_000_000
private const val MAX_STROKES = 64
private const val MAX_POINTS = 4_000
private const val MAX_WARNINGS = 24

data class GlyphImportResult(
    val samples: List<GlyphSample>,
    val warnings: List<String>,
)

class GlyphImportException(message: String) : IllegalArgumentException(message)

fun encodeGlyphLibrary(samples: List<GlyphSample>): String {
    val items = samples.map { sample ->
        jsonObject(
            "id" to jsonString(sample.id),
            "label" to jsonString(sample.label),
            "labelId" to jsonString(sample.labelId),
            "sessionId" to jsonString(sample.sessionId),
            "bbox" to jsonArray(*sample.bbox.map { jsonNumber(it) }.toTypedArray()),
            "sourceWidth" to jsonNumber(sample.sourceWidth),
            "sourceHeight" to jsonNumber(sample.sourceHeight),
            "strokes" to jsonArray(*sample.strokes.map { stroke ->
                jsonObject(
                    "baseWidth" to jsonNumber(stroke.baseWidth),
                    "pressureEnabled" to jsonBool(stroke.pressureEnabled),
                    "points" to jsonArray(*stroke.points.map { point ->
                        jsonObject(
                            "x" to jsonNumber(point.x),
                            "y" to jsonNumber(point.y),
                            "t" to jsonNumber(point.t),
                            "pressure" to jsonNumber(point.pressure),
                            "tiltX" to jsonNumber(point.tiltX),
                            "tiltY" to jsonNumber(point.tiltY),
                            "pointerType" to jsonString(point.pointerType),
                        )
                    }.toTypedArray()),
                )
            }.toTypedArray()),
        )
    }
    return jsonObject("samples" to jsonArray(*items.toTypedArray())).stringify()
}

fun decodeGlyphLibrary(text: String): List<GlyphSample> {
    if (text.isBlank()) return emptyList()
    val root = runCatching { parseJson(text) as? JsonValue.Obj }.getOrNull() ?: return emptyList()
    val items = root.array("samples")?.items ?: return emptyList()
    return items.mapNotNull { item -> (item as? JsonValue.Obj)?.let(::sampleFromStored) }
}

fun importGlyphArchive(bytes: ByteArray): GlyphImportResult {
    if (bytes.isEmpty()) throw GlyphImportException("Die Trainingsdatei ist leer.")
    if (bytes.size > GLYPH_ARCHIVE_MAX_BYTES) throw GlyphImportException("Die Trainingsdatei darf höchstens 8 MB groß sein.")
    val text = if (bytes.size >= 2 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4b.toByte()) {
        manifestText(bytes)
    } else {
        bytes.toString(Charsets.UTF_8)
    }
    return parseManifest(text)
}

private fun manifestText(bytes: ByteArray): String {
    val found = ArrayList<String>()
    ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
        var entry = zip.nextEntry
        var read = 0L
        while (entry != null) {
            val name = entry.name.replace('\\', '/')
            if (!entry.isDirectory && name.substringAfterLast('/').equals("manifest.jsonl", ignoreCase = true)) {
                if (name.contains("..")) throw GlyphImportException("Die ZIP enthält einen unsicheren Pfad.")
                val buffer = ByteArray(8192)
                val out = java.io.ByteArrayOutputStream()
                while (true) {
                    val count = zip.read(buffer)
                    if (count < 0) break
                    read += count
                    if (read > GLYPH_ARCHIVE_MAX_BYTES) throw GlyphImportException("manifest.jsonl ist zu groß.")
                    out.write(buffer, 0, count)
                }
                found += out.toString(Charsets.UTF_8)
            }
            zip.closeEntry()
            entry = zip.nextEntry
        }
    }
    if (found.isEmpty()) throw GlyphImportException("Die ZIP enthält keine manifest.jsonl von GlyphenWerk.")
    if (found.size > 1) throw GlyphImportException("Die ZIP enthält mehrere manifest.jsonl-Dateien und ist nicht eindeutig.")
    return found.single()
}

private fun parseManifest(text: String): GlyphImportResult {
    val warnings = ArrayList<String>()
    val samples = ArrayList<GlyphSample>()
    val lines = text.split(Regex("\\r?\\n"))
    if (lines.size > MAX_RECORDS + 1) throw GlyphImportException("manifest.jsonl enthält zu viele Datensätze.")
    lines.forEachIndexed { index, line ->
        if (line.isBlank()) return@forEachIndexed
        if (line.length > MAX_LINE_CHARS) {
            warn(warnings, "Zeile ${index + 1}: Datensatz ist zu groß.")
            return@forEachIndexed
        }
        val record = runCatching { parseJson(line) as? JsonValue.Obj }.getOrNull()
        if (record == null) {
            warn(warnings, "Zeile ${index + 1}: kein JSON-Objekt.")
            return@forEachIndexed
        }
        val sample = sampleFromManifest(record, index)
        if (sample == null) warn(warnings, "Zeile ${index + 1}: Zeichen oder Stiftpunkte sind ungültig.")
        else samples += sample
    }
    if (samples.isEmpty()) throw GlyphImportException("Die Trainingsdatei enthält keine verwendbaren Stiftzeichen.")
    return GlyphImportResult(samples, warnings)
}

private fun sampleFromManifest(record: JsonValue.Obj, index: Int): GlyphSample? {
    val labelId = limited(record.string("label_id") ?: record.string("labelId")) ?: return null
    val label = limited(record.string("unicode") ?: record.string("label")) ?: return null
    if (Regex("sharp[_-]?s", RegexOption.IGNORE_CASE).containsMatchIn(labelId)) return null
    val strokes = strokesOf(record.array("strokes")) ?: return null
    val bbox = bboxOf(record.array("bbox_normalized") ?: record.array("bbox"), strokes)
    val canvas = record.obj("source_canvas") ?: record.obj("sourceCanvas")
    return GlyphSample(
        id = limited(record.string("sample_id") ?: record.string("id")) ?: "import-$index",
        label = label,
        labelId = labelId,
        sessionId = limited(record.string("session_id") ?: record.string("sessionId")) ?: "glyphenwerk-import",
        bbox = bbox,
        sourceWidth = canvas?.double("width")?.takeIf { it > 0.0 } ?: 100.0,
        sourceHeight = canvas?.double("height")?.takeIf { it > 0.0 } ?: 100.0,
        strokes = strokes,
    )
}

private fun sampleFromStored(record: JsonValue.Obj): GlyphSample? {
    val label = limited(record.string("label")) ?: return null
    val strokes = strokesOf(record.array("strokes")) ?: return null
    return GlyphSample(
        id = limited(record.string("id")) ?: return null,
        label = label,
        labelId = limited(record.string("labelId")) ?: label,
        sessionId = limited(record.string("sessionId")) ?: "glyphenwerk-import",
        bbox = bboxOf(record.array("bbox"), strokes),
        sourceWidth = record.double("sourceWidth")?.takeIf { it > 0.0 } ?: 100.0,
        sourceHeight = record.double("sourceHeight")?.takeIf { it > 0.0 } ?: 100.0,
        strokes = strokes,
    )
}

private fun strokesOf(array: JsonValue.Arr?): List<GlyphInk>? {
    val items = array?.items ?: return null
    if (items.isEmpty() || items.size > MAX_STROKES) return null
    var total = 0
    val strokes = ArrayList<GlyphInk>()
    for (item in items) {
        val stroke = item as? JsonValue.Obj ?: return null
        val points = stroke.array("points")?.items ?: return null
        if (points.isEmpty() || points.size > MAX_POINTS) return null
        total += points.size
        if (total > MAX_POINTS) return null
        val mapped = points.map { entry ->
            val point = entry as? JsonValue.Obj ?: return null
            StrokePoint(
                x = (point.double("x") ?: return null).coerceIn(0.0, 1.0),
                y = (point.double("y") ?: return null).coerceIn(0.0, 1.0),
                t = point.double("t") ?: 0.0,
                pressure = (point.double("pressure") ?: 0.5).coerceIn(0.0, 1.0),
                tiltX = (point.double("tiltX") ?: 0.0).coerceIn(-90.0, 90.0),
                tiltY = (point.double("tiltY") ?: 0.0).coerceIn(-90.0, 90.0),
                pointerType = limited(point.string("pointerType")) ?: "pen",
            )
        }
        strokes += GlyphInk(
            points = mapped,
            baseWidth = (stroke.double("baseWidth") ?: 4.0).coerceIn(0.25, 80.0),
            pressureEnabled = stroke.bool("pressureEnabled") != false,
        )
    }
    return strokes
}

private fun bboxOf(array: JsonValue.Arr?, strokes: List<GlyphInk>): List<Double> {
    val numbers = array?.items?.mapNotNull { (it as? JsonValue.Num)?.value }.orEmpty()
    if (numbers.size >= 4 && numbers[2] > 0.0 && numbers[3] > 0.0) {
        return listOf(
            numbers[0].coerceIn(0.0, 1.0),
            numbers[1].coerceIn(0.0, 1.0),
            numbers[2].coerceIn(0.00001, 1.0),
            numbers[3].coerceIn(0.00001, 1.0),
        )
    }
    val points = strokes.flatMap { it.points }
    val left = points.minOf { it.x }
    val top = points.minOf { it.y }
    return listOf(left, top, maxOf(0.04, points.maxOf { it.x } - left), maxOf(0.04, points.maxOf { it.y } - top))
}

private fun limited(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    if (trimmed.isEmpty() || trimmed.length > 96) return null
    if (trimmed.any { it.code < 32 }) return null
    return trimmed
}

private fun warn(warnings: MutableList<String>, message: String) {
    if (warnings.size < MAX_WARNINGS) warnings += message
}
