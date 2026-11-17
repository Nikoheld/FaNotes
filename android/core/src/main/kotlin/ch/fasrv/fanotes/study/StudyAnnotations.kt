package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.stringify
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Study annotations ("Lernwerkzeuge") on a note page: callout labels, stamps, legends,
 * reference images, branch highlights, measurements and the word bank.
 *
 * Mirrors `fanotes/electron/noteAnnotation.mjs`: the same kinds, the same sanitising and the
 * same key order on write. Coordinates are fractions (0-1) of one PDF page; plain notes use
 * page 1 for the whole sheet. Stored as the optional `annotations` array of the .famd payload.
 */
const val ANNOTATION_LIMIT = 600
const val ANNOTATION_IMAGE_LIMIT = 12
const val ANNOTATION_IMAGE_MAX_CHARS = 1_600_000
const val ANNOTATION_TEXT_MAX = 400
const val ANNOTATION_TERMS_MAX = 80
const val ANNOTATION_STROKE_POINTS_MAX = 600
const val ANNOTATIONS_KEY = "annotations"

data class StampDef(val id: String, val glyph: String, val label: String, val color: String)

val STUDY_STAMPS: List<StampDef> = listOf(
    StampDef("gain", "▲", "gewonnen", "#16a34a"),
    StampDef("loss", "✕", "verloren / reduziert", "#dc2626"),
    StampDef("event", "●", "Ereignis", "#2563eb"),
    StampDef("dot-red", "●", "rot", "#dc2626"),
    StampDef("dot-green", "●", "grün", "#16a34a"),
    StampDef("dot-yellow", "●", "gelb", "#eab308"),
    StampDef("letter-h", "H", "hemimetabol", "#9333ea"),
    StampDef("letter-v", "V", "holometabol", "#ea580c"),
    StampDef("letter-a", "A", "ametabol", "#0891b2"),
    StampDef("check", "✓", "trifft zu", "#16a34a"),
)

fun stampById(id: String): StampDef? = STUDY_STAMPS.firstOrNull { it.id == id }

data class SPoint(val x: Double, val y: Double)

sealed class StudyAnnotation {
    abstract val id: String
}

data class StudyCallout(
    override val id: String,
    val page: Int,
    val ax: Double,
    val ay: Double,
    val lx: Double,
    val ly: Double,
    val text: String,
    val color: String,
    val num: Int? = null,
) : StudyAnnotation()

data class StudyStamp(
    override val id: String,
    val page: Int,
    val x: Double,
    val y: Double,
    val stamp: String,
    val size: Double = 24.0,
) : StudyAnnotation()

data class StudyLegend(
    override val id: String,
    val page: Int,
    val x: Double,
    val y: Double,
    val names: Map<String, String> = emptyMap(),
) : StudyAnnotation()

data class StudyImage(
    override val id: String,
    val page: Int,
    val x: Double,
    val y: Double,
    val w: Double,
    val aspect: Double,
    val opacity: Double,
    val locked: Boolean,
    val src: String,
    val title: String = "",
) : StudyAnnotation()

data class StudyStroke(
    override val id: String,
    val page: Int,
    val pts: List<SPoint>,
    val color: String,
    val width: Double,
    val opacity: Double,
) : StudyAnnotation()

data class StudyMeasure(
    override val id: String,
    val page: Int,
    val mode: String,
    val pts: List<SPoint>,
    val color: String,
) : StudyAnnotation()

data class StudyTerms(val list: List<String>) : StudyAnnotation() {
    override val id: String get() = TERMS_ID
}

const val TERMS_ID = "terms"
const val MEASURE_ANGLE = "angle"
const val MEASURE_DISTANCE = "distance"

/** Page number an annotation belongs to; the word bank has none. */
fun StudyAnnotation.pageOrNull(): Int? = when (this) {
    is StudyCallout -> page
    is StudyStamp -> page
    is StudyLegend -> page
    is StudyImage -> page
    is StudyStroke -> page
    is StudyMeasure -> page
    is StudyTerms -> null
}

private val ID_RE = Regex("^[a-zA-Z0-9._-]{1,96}$")
private val COLOR_RE = Regex("^#[0-9a-fA-F]{6}$")
private val STAMP_IDS = STUDY_STAMPS.map { it.id }.toSet()

private var idCounter = 0L

/**
 * Replacement id for an annotation without a valid one, identical to the desktop `stableAnnotationId`:
 * "an-" + base 36 of the FNV-1a 32 bit hash of the UTF-8 bytes of
 * `kind|index|page|round(x*10000)|round(y*10000)|text`.
 */
fun stableAnnotationId(kind: String, index: Int, page: Int, x: Double, y: Double, text: String): String {
    fun cell(v: Double) = floor(min(1.0, max(0.0, if (v.isFinite()) v else 0.0)) * 10000.0 + 0.5).toLong()
    val canonical = "$kind|$index|$page|${cell(x)}|${cell(y)}|$text"
    var hash = 0x811c9dc5L
    for (byte in canonical.toByteArray(Charsets.UTF_8)) {
        hash = (hash xor (byte.toLong() and 0xFF)) * 0x01000193L and 0xFFFFFFFFL
    }
    return "an-${java.lang.Long.toString(hash, 36)}"
}

private fun stableIdFor(raw: JsonValue.Obj, kind: String, index: Int): String {
    val first = (raw["pts"] as? JsonValue.Arr)?.items?.firstOrNull() as? JsonValue.Arr
    val x = if (kind == "callout") raw["ax"] else if (first != null && first.items.isNotEmpty()) first.items[0] else raw["x"]
    val y = if (kind == "callout") raw["ay"] else if (first != null && first.items.isNotEmpty()) first.items.getOrNull(1) else raw["y"]
    val text = raw.string("text") ?: raw.string("stamp") ?: ""
    return stableAnnotationId(kind, index, page(raw["page"]), num(x, 0.0), num(y, 0.0), text)
}

/** Same shape as the desktop `newAnnotationId` (`an-<time36>-<rand36>`). */
fun newAnnotationId(now: Long = System.currentTimeMillis(), random: Long = java.util.concurrent.ThreadLocalRandom.current().nextLong(0, 2_176_782_336L)): String {
    idCounter += 1
    return "an-${now.toString(36)}-${(random + idCounter).mod(2_176_782_336L).toString(36).padStart(6, '0')}"
}

// ---- value coercion, same results as the JS helpers -----------------------------------------

/** `Number(value)` for the JSON shapes that matter; NaN when the key is absent or not numeric. */
private fun jsNumberOf(value: JsonValue?): Double = when (value) {
    null -> Double.NaN
    is JsonValue.Num -> value.value
    is JsonValue.Null -> 0.0
    is JsonValue.Bool -> if (value.value) 1.0 else 0.0
    is JsonValue.Str -> {
        val trimmed = value.value.trim()
        if (trimmed.isEmpty()) 0.0 else (if (trimmed.last().isLetter() && !trimmed.contains('e', true)) null else trimmed.toDoubleOrNull()) ?: Double.NaN
    }
    else -> Double.NaN
}

private fun num(value: JsonValue?, fallback: Double): Double {
    val n = jsNumberOf(value)
    return if (n.isFinite()) n else fallback
}

private fun unit(value: JsonValue?, fallback: Double) = min(1.0, max(0.0, num(value, fallback)))
private fun clamp(value: JsonValue?, lo: Double, hi: Double, fallback: Double) = min(hi, max(lo, num(value, fallback)))
private fun page(value: JsonValue?): Int {
    val p = num(value, 1.0)
    return if (p == floor(p) && p >= 1.0 && p <= 10_000.0) p.toInt() else 1
}

private fun color(value: JsonValue?, fallback: String): String {
    val text = (value as? JsonValue.Str)?.value
    return if (text != null && COLOR_RE.matches(text)) text.lowercase() else fallback
}

private fun text(value: JsonValue?, max: Int = ANNOTATION_TEXT_MAX): String =
    (value as? JsonValue.Str)?.value?.take(max).orEmpty()

private fun round4(value: Double) = floor(value * 10000.0 + 0.5) / 10000.0

private fun points(value: JsonValue?, min: Int, max: Int): List<SPoint> {
    val arr = value as? JsonValue.Arr ?: return emptyList()
    val out = ArrayList<SPoint>()
    for (entry in arr.items) {
        val pair = entry as? JsonValue.Arr ?: continue
        if (pair.items.size < 2) continue
        val x = jsNumberOf(pair.items[0])
        val y = jsNumberOf(pair.items[1])
        if (!x.isFinite() || !y.isFinite()) continue
        out += SPoint(round4(min(1.0, max(0.0, x))), round4(min(1.0, max(0.0, y))))
        if (out.size >= max) break
    }
    return if (out.size >= min) out else emptyList()
}

private fun validImageSrc(src: String): Boolean {
    if (src.length > ANNOTATION_IMAGE_MAX_CHARS) return false
    val prefix = listOf("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")
        .firstOrNull { src.startsWith(it) } ?: return false
    if (src.length == prefix.length) return false
    for (i in prefix.length until src.length) {
        val c = src[i]
        if (!(c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '+' || c == '/' || c == '=')) return false
    }
    return true
}

/** One annotation object -> typed value, or null when it must be dropped (unknown kind, bad image, too few points). */
fun sanitizeAnnotation(value: JsonValue?, index: Int = 0): StudyAnnotation? {
    val raw = value as? JsonValue.Obj ?: return null
    val kind = raw.string("kind") ?: return null
    val rawId = raw.string("id")
    val id = if (rawId != null && ID_RE.matches(rawId)) rawId else stableIdFor(raw, kind, index)
    return when (kind) {
        "callout" -> {
            val ax = unit(raw["ax"], 0.5)
            val ay = unit(raw["ay"], 0.5)
            val n = (raw["num"] as? JsonValue.Num)?.value
            val number = if (n != null && n == floor(n) && n >= 1.0 && n <= 999.0) n.toInt() else null
            StudyCallout(
                id, page(raw["page"]), ax, ay, unit(raw["lx"], ax), unit(raw["ly"], ay),
                text(raw["text"], 120), color(raw["color"], "#1d4ed8"), number,
            )
        }
        "stamp" -> {
            val stamp = raw.string("stamp")?.takeIf { it in STAMP_IDS } ?: "event"
            StudyStamp(id, page(raw["page"]), unit(raw["x"], 0.5), unit(raw["y"], 0.5), stamp, clamp(raw["size"], 12.0, 64.0, 24.0))
        }
        "legend" -> {
            val names = LinkedHashMap<String, String>()
            val source = raw.obj("names")
            if (source != null) {
                for (key in source.fields.keys.take(40)) {
                    val v = source.string(key)
                    if (key in STAMP_IDS && v != null) names[key] = v.take(60)
                }
            }
            StudyLegend(id, page(raw["page"]), unit(raw["x"], 0.6), unit(raw["y"], 0.05), names)
        }
        "image" -> {
            val src = raw.string("src")?.takeIf { validImageSrc(it) } ?: return null
            StudyImage(
                id, page(raw["page"]), unit(raw["x"], 0.1), unit(raw["y"], 0.1),
                clamp(raw["w"], 0.05, 1.0, 0.4), clamp(raw["aspect"], 0.05, 20.0, 1.0),
                clamp(raw["opacity"], 0.1, 1.0, 1.0), raw.bool("locked") == true, src, text(raw["title"], 80),
            )
        }
        "stroke" -> {
            val pts = points(raw["pts"], 2, ANNOTATION_STROKE_POINTS_MAX)
            if (pts.isEmpty()) return null
            StudyStroke(id, page(raw["page"]), pts, color(raw["color"], "#facc15"), clamp(raw["width"], 2.0, 60.0, 18.0), clamp(raw["opacity"], 0.1, 1.0, 0.4))
        }
        "measure" -> {
            val mode = if (raw.string("mode") == MEASURE_DISTANCE) MEASURE_DISTANCE else MEASURE_ANGLE
            val pts = points(raw["pts"], if (mode == MEASURE_ANGLE) 3 else 2, if (mode == MEASURE_ANGLE) 4 else 2)
            if (pts.isEmpty()) return null
            StudyMeasure(id, page(raw["page"]), mode, pts, color(raw["color"], "#dc2626"))
        }
        "terms" -> {
            val list = ArrayList<String>()
            for (entry in (raw["list"] as? JsonValue.Arr)?.items.orEmpty()) {
                val term = text(entry, 60).trim()
                if (term.isNotEmpty() && term !in list) list += term
                if (list.size >= ANNOTATION_TERMS_MAX) break
            }
            StudyTerms(list)
        }
        else -> null
    }
}

/** The whole `annotations` array; unknown kinds and duplicates drop, caps apply. */
fun parseStudyAnnotations(value: JsonValue?): List<StudyAnnotation> {
    val arr = value as? JsonValue.Arr ?: return emptyList()
    val seen = HashSet<String>()
    val out = ArrayList<StudyAnnotation>()
    var images = 0
    for ((index, entry) in arr.items.withIndex()) {
        val item = sanitizeAnnotation(entry, index) ?: continue
        if (item.id in seen) continue
        if (item is StudyImage) {
            images += 1
            if (images > ANNOTATION_IMAGE_LIMIT) continue
        }
        seen += item.id
        out += item
        if (out.size >= ANNOTATION_LIMIT) break
    }
    return out
}

/** True when the list holds anything worth saving (an empty word bank is not). */
fun annotationsHaveContent(list: List<StudyAnnotation>): Boolean =
    list.any { it !is StudyTerms || it.list.isNotEmpty() }

private fun n(value: Double) = jsonNumber(value)
private fun ptsJson(pts: List<SPoint>) = JsonValue.Arr(pts.map { jsonArray(n(it.x), n(it.y)) as JsonValue }.toMutableList())

/** Key order matches the object literals in `sanitizeAnnotation`, so desktop and Android write the same bytes. */
fun studyAnnotationJson(item: StudyAnnotation): JsonValue.Obj = when (item) {
    is StudyCallout -> jsonObject(
        "kind" to jsonString("callout"), "id" to jsonString(item.id), "page" to n(item.page.toDouble()),
        "ax" to n(item.ax), "ay" to n(item.ay), "lx" to n(item.lx), "ly" to n(item.ly),
        "text" to jsonString(item.text), "color" to jsonString(item.color),
        "num" to item.num?.let { n(it.toDouble()) },
    )
    is StudyStamp -> jsonObject(
        "kind" to jsonString("stamp"), "id" to jsonString(item.id), "page" to n(item.page.toDouble()),
        "x" to n(item.x), "y" to n(item.y), "stamp" to jsonString(item.stamp), "size" to n(item.size),
    )
    is StudyLegend -> jsonObject(
        "kind" to jsonString("legend"), "id" to jsonString(item.id), "page" to n(item.page.toDouble()),
        "x" to n(item.x), "y" to n(item.y),
        "names" to JsonValue.Obj(LinkedHashMap<String, JsonValue>().also { map -> item.names.forEach { (k, v) -> map[k] = jsonString(v) } }),
    )
    is StudyImage -> jsonObject(
        "kind" to jsonString("image"), "id" to jsonString(item.id), "page" to n(item.page.toDouble()),
        "x" to n(item.x), "y" to n(item.y), "w" to n(item.w), "aspect" to n(item.aspect),
        "opacity" to n(item.opacity), "locked" to jsonBool(item.locked), "src" to jsonString(item.src),
        "title" to jsonString(item.title),
    )
    is StudyStroke -> jsonObject(
        "kind" to jsonString("stroke"), "id" to jsonString(item.id), "page" to n(item.page.toDouble()),
        "pts" to ptsJson(item.pts), "color" to jsonString(item.color), "width" to n(item.width), "opacity" to n(item.opacity),
    )
    is StudyMeasure -> jsonObject(
        "kind" to jsonString("measure"), "id" to jsonString(item.id), "page" to n(item.page.toDouble()),
        "mode" to jsonString(item.mode), "pts" to ptsJson(item.pts), "color" to jsonString(item.color),
    )
    is StudyTerms -> jsonObject(
        "kind" to jsonString("terms"), "id" to jsonString(TERMS_ID),
        "list" to JsonValue.Arr(item.list.map { jsonString(it) as JsonValue }.toMutableList()),
    )
}

fun studyAnnotationsJson(list: List<StudyAnnotation>): JsonValue.Arr =
    JsonValue.Arr(parseStudyAnnotationList(list).map { studyAnnotationJson(it) as JsonValue }.toMutableList())

/** Re-applies the caps and dedupe so a bad in-memory list cannot reach the file. */
fun parseStudyAnnotationList(list: List<StudyAnnotation>): List<StudyAnnotation> =
    parseStudyAnnotations(JsonValue.Arr(list.map { studyAnnotationJson(it) as JsonValue }.toMutableList()))

fun readStudyAnnotations(payload: JsonValue.Obj?): List<StudyAnnotation> = parseStudyAnnotations(payload?.array(ANNOTATIONS_KEY))

/** Payload copy with `annotations` replaced; the key is dropped when nothing is worth saving. */
fun writeStudyAnnotations(payload: JsonValue.Obj, list: List<StudyAnnotation>): JsonValue.Obj {
    val next = payload.deepCopy() as JsonValue.Obj
    val clean = parseStudyAnnotationList(list)
    if (!annotationsHaveContent(clean)) next.put(ANNOTATIONS_KEY, null)
    else next.put(ANNOTATIONS_KEY, studyAnnotationsJson(clean))
    return next
}
