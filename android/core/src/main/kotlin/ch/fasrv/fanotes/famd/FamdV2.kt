package ch.fasrv.fanotes.famd

import ch.fasrv.fanotes.json.JsonParseException
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonNull
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32
import kotlin.math.round

/**
 * Compact companion (`fanotes-famd:v2`). Markdown stays in front of the
 * header. Points are 36 little-endian bytes (coordinates, pressure, time, and
 * tilt), then a JSON-safe base-85. A shared pointer type is stored once.
 * A bad length or CRC throws instead of looking like an empty note.
 */
const val FAMD_V2_SCHEMA = "fanotes-famd-v2"
private const val FAMD_V2_TOKEN = "fanotes-famd:v2"
private const val POINT_STRIDE = 36
private val PACKED_POINT_KEYS = setOf("x", "y", "t", "pressure", "tiltX", "tiltY", "pointerType")
private val PACKED_STROKE_KEYS = setOf("points", "famdPts", "famdPtExtra", "famdPtr", "famdPtrList", "famdPtrIdx")
private const val MAX_PAYLOAD_CHARS = 32 * 1024 * 1024
private const val FAMD85 =
    "!#\$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvw"

class FamdCorruptException(message: String) : IllegalArgumentException(message)

private val FAMD85_INDEX = IntArray(128) { -1 }.also { table ->
    check(FAMD85.length == 85)
    FAMD85.forEachIndexed { index, char -> table[char.code] = index }
}

private val V2_HEADER = Regex("""^<!--\s*fanotes-famd:v2\s+chars=(\d+)\s+crc=([0-9a-fA-F]{8})\s*-->\n""")

fun crcHex(text: String): String {
    val crc = CRC32()
    crc.update(text.toByteArray(Charsets.UTF_8))
    return "%08x".format(crc.value)
}

fun famdEncodingForSave(existing: String?): String {
    if (existing.isNullOrEmpty()) return "v2"
    if (isActiveV2(existing)) return "v2"
    if (existing.contains("fanotes-famd:v1")) return "v1"
    return "v2"
}

fun isActiveV2(source: String): Boolean {
    if (source.isEmpty()) return false
    val v2 = source.lastIndexOf(FAMD_V2_TOKEN)
    val v1 = source.lastIndexOf("fanotes-famd:v1")
    return v2 >= 0 && v2 > v1
}

fun v2CutIndex(source: String): Int {
    if (!source.contains(FAMD_V2_TOKEN)) return -1
    return try {
        locateV2(source)?.cut ?: -1
    } catch (_: FamdCorruptException) {
        val tokenAt = source.lastIndexOf(FAMD_V2_TOKEN)
        val start = source.lastIndexOf("<!--", tokenAt)
        if (start < 0) tokenAt else if (start > 0 && source[start - 1] == '\n') start - 1 else start
    }
}

fun readV2Payload(source: String): JsonValue.Obj {
    val located = locateV2(source) ?: throw FamdCorruptException("missing famd v2 header")
    if (located.jsonStart + located.length > source.length) throw FamdCorruptException("truncated famd v2 payload")
    val json = source.substring(located.jsonStart, located.jsonStart + located.length)
    if (json.length != located.length) throw FamdCorruptException("truncated famd v2 payload")
    if (crcHex(json) != located.crc) throw FamdCorruptException("famd v2 checksum")
    val parsed = try {
        parseJson(json) as? JsonValue.Obj
    } catch (_: JsonParseException) {
        null
    } ?: throw FamdCorruptException("famd v2 json")
    if (parsed.string("schema") != FAMD_V2_SCHEMA) throw FamdCorruptException("famd v2 schema")
    val ink = parsed["ink"]
    if (ink != null) parsed.put("ink", unpackInk(ink))
    parsed.put("schema", jsonString(FAMD_SCHEMA))
    return parsed
}

fun encodeV2Document(body: String, payload: JsonValue.Obj): String {
    val stored = JsonValue.Obj()
    stored.put("schema", jsonString(FAMD_V2_SCHEMA))
    stored.put("updatedAt", (payload["updatedAt"] ?: jsonString(isoNow())).deepCopy())
    stored.put("ink", packInk(payload["ink"]))
    stored.put("worksheets", (payload["worksheets"] ?: JsonValue.Arr()).deepCopy())
    val paper = payload.string("paperStyle")
    if (isPaperStyle(paper)) stored.put("paperStyle", jsonString(paper!!))
    copyArray(payload, stored, "noteLinks")
    copyArray(payload, stored, "noteBackups")
    val stats = payload["pageStats"]
    if (stats is JsonValue.Obj) stored.put("pageStats", stats.deepCopy())
    copyArray(payload, stored, "textFields")
    val json = stored.stringify()
    val header = "<!-- fanotes-famd:v2 chars=${json.length} crc=${crcHex(json)} -->\n"
    return if (body.isEmpty()) "$header$json\n" else "$body\n\n$header$json\n"
}

private data class LocatedV2(val cut: Int, val jsonStart: Int, val length: Int, val crc: String)

private fun locateV2(source: String): LocatedV2? {
    val tokenAt = source.lastIndexOf(FAMD_V2_TOKEN)
    if (tokenAt < 0) return null
    val start = source.lastIndexOf("<!--", tokenAt)
    if (start < 0) throw FamdCorruptException("truncated famd v2 header")
    val match = V2_HEADER.find(source.substring(start)) ?: throw FamdCorruptException("truncated famd v2 header")
    val length = match.groupValues[1].toIntOrNull() ?: throw FamdCorruptException("famd v2 length")
    if (length < 2 || length > MAX_PAYLOAD_CHARS) throw FamdCorruptException("famd v2 length")
    val cut = if (start > 0 && source[start - 1] == '\n') start - 1 else start
    return LocatedV2(cut, start + match.value.length, length, match.groupValues[2].lowercase())
}

private fun copyArray(from: JsonValue.Obj, to: JsonValue.Obj, key: String) {
    val value = from[key] as? JsonValue.Arr ?: return
    if (value.items.isEmpty()) return
    to.put(key, value.deepCopy())
}

private fun encode85(bytes: ByteArray): String {
    if (bytes.size % 4 != 0) throw FamdCorruptException("famd v2 point block length")
    val out = StringBuilder(bytes.size / 4 * 5)
    var index = 0
    while (index < bytes.size) {
        var value = ((bytes[index].toLong() and 0xFF) shl 24) or
            ((bytes[index + 1].toLong() and 0xFF) shl 16) or
            ((bytes[index + 2].toLong() and 0xFF) shl 8) or
            (bytes[index + 3].toLong() and 0xFF)
        val chars = CharArray(5)
        for (digit in 4 downTo 0) {
            chars[digit] = FAMD85[(value % 85).toInt()]
            value /= 85
        }
        out.append(chars)
        index += 4
    }
    return out.toString()
}

private fun decode85(value: String): ByteArray {
    if (value.length % 5 != 0) throw FamdCorruptException("famd v2 point block")
    val bytes = ByteArray(value.length / 5 * 4)
    var index = 0
    var offset = 0
    while (index < value.length) {
        var number = 0L
        for (digit in 0 until 5) {
            val code = value[index + digit].code
            val decoded = if (code < 128) FAMD85_INDEX[code] else -1
            if (decoded < 0) throw FamdCorruptException("famd v2 point block")
            number = number * 85 + decoded
        }
        if (number > 0xFFFFFFFFL) throw FamdCorruptException("famd v2 point block")
        bytes[offset] = (number ushr 24).toByte()
        bytes[offset + 1] = (number ushr 16).toByte()
        bytes[offset + 2] = (number ushr 8).toByte()
        bytes[offset + 3] = number.toByte()
        index += 5
        offset += 4
    }
    return bytes
}

private fun quantizeUnit(value: Double?): Int {
    if (value == null || !value.isFinite()) return 0
    return round(value.coerceIn(0.0, 1.0) * 65535.0).toInt()
}

private fun finiteOrNaN(point: JsonValue.Obj?, key: String): Double {
    val number = point?.double(key) ?: return Double.NaN
    return if (number.isFinite()) number else Double.NaN
}

private fun putFloat64(buffer: ByteBuffer, value: Double) {
    if (value.isFinite()) {
        buffer.putDouble(value)
        return
    }
    buffer.putInt(0)
    buffer.putInt(0x7ff80000)
}

private fun pointExtras(point: JsonValue.Obj?, keepPointer: Boolean): JsonValue.Obj? {
    if (point == null) return null
    val extra = JsonValue.Obj()
    for ((key, value) in point.fields) {
        if (key in PACKED_POINT_KEYS && (key != "pointerType" || !keepPointer)) continue
        extra.fields[key] = value.deepCopy()
    }
    return extra.takeIf { it.fields.isNotEmpty() }
}

private class PackedPointer(
    val overflow: Boolean = false,
    val famdPtr: String? = null,
    val famdPtrList: List<String>? = null,
    val famdPtrIdx: String? = null,
)

private fun packPointer(points: JsonValue.Arr): PackedPointer {
    val types = points.items.map { (it as? JsonValue.Obj)?.string("pointerType") }
    if (types.all { it == null }) return PackedPointer()
    val first = types.first()
    if (types.all { it == first }) return PackedPointer(famdPtr = first)
    val dict = mutableListOf<String>()
    val indexOf = LinkedHashMap<String, Int>()
    for (type in types) {
        if (type != null && type !in indexOf) {
            if (dict.size == 255) return PackedPointer(overflow = true)
            indexOf[type] = dict.size
            dict.add(type)
        }
    }
    val raw = ByteArray(types.size)
    types.forEachIndexed { index, type ->
        raw[index] = (if (type == null) 255 else indexOf.getValue(type)).toByte()
    }
    val pad = (4 - (raw.size % 4)) % 4
    val padded = if (pad == 0) raw else raw + ByteArray(pad)
    return PackedPointer(famdPtrList = dict, famdPtrIdx = encode85(padded))
}

private fun packPoints(points: JsonValue.Arr, keepPointer: Boolean): Pair<String, JsonValue.Arr?> {
    val buffer = ByteBuffer.allocate(points.items.size * POINT_STRIDE).order(ByteOrder.LITTLE_ENDIAN)
    val extras = JsonValue.Arr()
    var anyExtra = false
    for (item in points.items) {
        val point = item as? JsonValue.Obj
        buffer.putShort((quantizeUnit(point?.double("x")) and 0xFFFF).toShort())
        buffer.putShort((quantizeUnit(point?.double("y")) and 0xFFFF).toShort())
        putFloat64(buffer, finiteOrNaN(point, "pressure"))
        putFloat64(buffer, finiteOrNaN(point, "t"))
        putFloat64(buffer, finiteOrNaN(point, "tiltX"))
        putFloat64(buffer, finiteOrNaN(point, "tiltY"))
        val extra = pointExtras(point, keepPointer)
        if (extra != null) anyExtra = true
        extras.items.add(extra ?: JsonValue.Null)
    }
    return encode85(buffer.array()) to if (anyExtra) extras else null
}

private fun packStroke(stroke: JsonValue): JsonValue {
    val obj = stroke as? JsonValue.Obj ?: return stroke
    val points = obj.array("points") ?: return stroke.deepCopy()
    val next = JsonValue.Obj()
    for ((key, value) in obj.fields) {
        if (key in PACKED_STROKE_KEYS) continue
        next.fields[key] = value.deepCopy()
    }
    val pointer = packPointer(points)
    val (encoded, extra) = packPoints(points, pointer.overflow)
    next.put("famdPts", jsonString(encoded))
    if (extra != null) next.put("famdPtExtra", extra)
    if (pointer.famdPtr != null) next.put("famdPtr", jsonString(pointer.famdPtr))
    if (pointer.famdPtrList != null && pointer.famdPtrIdx != null) {
        next.put("famdPtrList", JsonValue.Arr(pointer.famdPtrList.map { jsonString(it) }.toMutableList()))
        next.put("famdPtrIdx", jsonString(pointer.famdPtrIdx))
    }
    return next
}

private fun packInk(ink: JsonValue?): JsonValue {
    val obj = ink as? JsonValue.Obj ?: return ink ?: jsonNull()
    val strokes = obj.array("strokes") ?: return obj.deepCopy()
    val next = JsonValue.Obj()
    for ((key, value) in obj.fields) {
        if (key != "strokes") next.fields[key] = value.deepCopy()
    }
    next.put("strokes", JsonValue.Arr(strokes.items.map(::packStroke).toMutableList()))
    return next
}

private fun unpackStroke(stroke: JsonValue): JsonValue {
    val obj = stroke as? JsonValue.Obj ?: return stroke
    val packed = obj.string("famdPts") ?: return stroke
    val bytes = decode85(packed)
    if (bytes.size % POINT_STRIDE != 0) throw FamdCorruptException("famd v2 point block length")
    val view = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    val extras = obj.array("famdPtExtra")
    val points = JsonValue.Arr()
    val count = bytes.size / POINT_STRIDE
    for (index in 0 until count) {
        val point = JsonValue.Obj()
        point.put("x", jsonNumber((view.short.toInt() and 0xFFFF) / 65535.0))
        point.put("y", jsonNumber((view.short.toInt() and 0xFFFF) / 65535.0))
        val pressure = view.double
        val time = view.double
        val tiltX = view.double
        val tiltY = view.double
        if (!time.isNaN()) point.put("t", jsonNumber(time))
        if (!pressure.isNaN()) point.put("pressure", jsonNumber(pressure))
        if (!tiltX.isNaN()) point.put("tiltX", jsonNumber(tiltX))
        if (!tiltY.isNaN()) point.put("tiltY", jsonNumber(tiltY))
        val extra = extras?.items?.getOrNull(index) as? JsonValue.Obj
        if (extra != null) {
            for ((key, value) in extra.fields) point.put(key, value.deepCopy())
        }
        obj.string("famdPtr")?.let { point.put("pointerType", jsonString(it)) }
        points.items.add(point)
    }
    val pointerList = obj.array("famdPtrList")
    val pointerIndex = obj.string("famdPtrIdx")
    if (pointerList != null && pointerIndex != null) {
        val raw = decode85(pointerIndex)
        if (raw.size < count) throw FamdCorruptException("famd v2 pointer index")
        for (index in 0 until count) {
            val code = raw[index].toInt() and 0xFF
            if (code == 255) continue
            val name = (pointerList.items.getOrNull(code) as? JsonValue.Str)?.value
                ?: throw FamdCorruptException("famd v2 pointer index")
            (points.items[index] as JsonValue.Obj).put("pointerType", jsonString(name))
        }
    }
    val next = JsonValue.Obj()
    for ((key, value) in obj.fields) {
        if (key in PACKED_STROKE_KEYS && key != "points") continue
        next.fields[key] = value.deepCopy()
    }
    next.put("points", points)
    return next
}

private fun unpackInk(ink: JsonValue): JsonValue {
    val obj = ink as? JsonValue.Obj ?: return ink
    val strokes = obj.array("strokes") ?: return ink
    val next = obj.deepCopy() as JsonValue.Obj
    next.put("strokes", JsonValue.Arr(strokes.items.map(::unpackStroke).toMutableList()))
    return next
}
