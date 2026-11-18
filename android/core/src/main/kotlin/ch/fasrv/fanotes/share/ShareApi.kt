package ch.fasrv.fanotes.share

import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.sectionsOf
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.security.SecureRandom

import kotlin.math.ceil

import kotlin.math.min
import kotlin.math.roundToInt

/*
 * Public note links, matching `fanotes/src/lib/sync/share.ts` and the server `fanotes-site/share-api.mjs`.
 * This is not vault sync: the link id (32 hex characters) is the capability, the body is readable on purpose.
 * Android uploads copies and live links. Editable shares (mode "edit") are not offered here yet.
 */

const val SHARE_ORIGIN = "https://fanotes.fasrv.ch"
const val SHARE_API_PATH = "/api/v1/share"
const val SHARE_VIEW_PATH = "/share/"

/** Server limits (`share-api.mjs`). A note over them is refused before anything leaves the device. */
const val SHARE_MAX_NOTES = 400
const val SHARE_MAX_NOTE_CHARS = 500_000
const val SHARE_MAX_TITLE_CHARS = 300
const val SHARE_MAX_PATH_CHARS = 512
const val SHARE_MAX_BODY_BYTES = 8 * 1024 * 1024
const val SHARE_INK_STROKES = 2500
const val SHARE_INK_POINTS = 40_000
const val SHARE_INK_POINTS_PER_STROKE = 500
const val SHARE_SECTIONS = 80
const val SHARE_TEXT_FIELDS = 200

enum class ShareMode(val wire: String) {
    COPY("copy"),
    LIVE("live"),
    ;

    companion object {
        fun fromWire(value: String?): ShareMode? = entries.firstOrNull { it.wire == value }
    }
}

data class ShareHttpRequest(val method: String, val url: String, val headers: Map<String, String>, val body: String)
data class ShareHttpResponse(val status: Int, val body: String)

/** The only thing the platform supplies. Throws [java.io.IOException] when the server cannot be reached. */
fun interface ShareTransport {
    fun exchange(request: ShareHttpRequest): ShareHttpResponse
}

class ShareException(message: String, val status: Int = 0) : Exception(message)

data class ShareInkStroke(val color: String, val width: Double, val opacity: Double, val points: List<Pair<Double, Double>>)
data class ShareInkSection(val id: String, val top: Double, val bodyTop: Double)
data class ShareInk(val width: Int, val height: Int, val strokes: List<ShareInkStroke>, val sections: List<ShareInkSection> = emptyList())
data class ShareTextField(val page: Int, val x: Double, val y: Double, val width: Double, val fontSize: Int, val text: String)
data class ShareTextColumn(
    val originX: Int,
    val originY: Int,
    val column: Int = SHARE_COLUMN,
    val padX: Int = SHARE_PAD_X,
    val padY: Int = SHARE_PAD_Y,
    val fontSize: Int = SHARE_FONT_SIZE,
    val lineHeight: Double = SHARE_LINE_HEIGHT,
)

data class ShareNote(
    val path: String,
    val title: String,
    val content: String,
    val ink: ShareInk? = null,
    val textFields: List<ShareTextField> = emptyList(),
    val textColumn: ShareTextColumn? = null,
)

private const val SHARE_COLUMN = 820
private const val SHARE_PAD_X = 72
private const val SHARE_PAD_Y = 78
private const val SHARE_FONT_SIZE = 16
private const val SHARE_LINE_HEIGHT = 1.72
private const val SHARE_TEXT_SLACK = 144
private const val SHEET_MAX_HEIGHT = 80_000

private val HEX_COLOR = Regex("^#[0-9a-fA-F]{6}$")

fun createShareId(random: java.util.Random = SecureRandom()): String {
    val bytes = ByteArray(16)
    random.nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

fun isShareId(value: String) = Regex("^[a-f0-9]{32}$").matches(value)

fun shareViewUrl(id: String, origin: String = SHARE_ORIGIN) =
    "${origin.trimEnd('/')}$SHARE_VIEW_PATH?id=${java.net.URLEncoder.encode(id, "UTF-8")}"

fun shareApiUrl(id: String, origin: String = SHARE_ORIGIN) =
    "${origin.trimEnd('/')}$SHARE_API_PATH/${java.net.URLEncoder.encode(id, "UTF-8")}"

private val SHARE_HEADERS = mapOf("Accept" to "application/json", "X-FaNotes-Share" to "1")

/** Title the viewer shows: the first Markdown heading, else the file name without `.md`. */
fun shareNoteTitle(path: String, content: String): String {
    for (line in content.lineSequence()) {
        val heading = Regex("^#{1,6}\\s+(.+?)\\s*$").find(line)
        if (heading != null) return heading.groupValues[1].trim()
    }
    val base = path.replace('\\', '/').trim('/').substringAfterLast('/').ifEmpty { path }
    return base.replace(Regex("\\.(md|markdown)$", RegexOption.IGNORE_CASE), "")
}

private fun unit(value: Double) = (value.coerceIn(-0.25, 1.25) * 10000).roundToInt() / 10000.0

private fun thin(points: List<Pair<Double, Double>>, budget: Int): List<Pair<Double, Double>> {
    if (points.size <= budget) return points
    val step = ceil(points.size.toDouble() / budget).toInt()
    val kept = points.filterIndexed { index, _ -> index % step == 0 }.toMutableList()
    if (kept.last() != points.last()) kept += points.last()
    return kept
}

/**
 * The public drawing of a note's ink: strokes as 0-1 of the page, open bands only. A band that is collapsed
 * on this device keeps its ink hidden in the note; it is not part of the link (the desktop opens such bands first).
 */
fun shareInkFrom(document: InkDocument, heightPx: Double = document.sourceHeight): ShareInk? {
    val drawn = document.strokes.filter { it.symbolId == null && it.figurePaths.isEmpty() && it.points.isNotEmpty() }
    val strokes = mutableListOf<ShareInkStroke>()
    var used = 0
    val scale = if (heightPx > document.sourceHeight) document.sourceHeight / heightPx else 1.0
    for (stroke in drawn) {
        if (strokes.size >= SHARE_INK_STROKES || used >= SHARE_INK_POINTS) break
        val raw = stroke.points.map { unit(it.x) to unit(it.y * scale) }
        val kept = thin(raw, min(SHARE_INK_POINTS_PER_STROKE, SHARE_INK_POINTS - used))
        if (kept.isEmpty()) continue
        strokes += ShareInkStroke(
            color = if (HEX_COLOR.matches(stroke.color)) stroke.color else "#20222b",
            width = stroke.baseWidth.coerceIn(0.5, 48.0),
            opacity = (stroke.opacity ?: 1.0).coerceIn(0.08, 1.0),
            points = kept,
        )
        used += kept.size
    }
    val sections = sectionsOf(document).filter { !it.collapsed }.take(SHARE_SECTIONS).map {
        ShareInkSection(it.id.take(64), unit(it.top * scale), unit(it.bodyTop * scale))
    }.filter { it.bodyTop > it.top }
    if (strokes.isEmpty() && sections.isEmpty()) return null
    val width = document.sourceWidth.takeIf { it in 200.0..24000.0 }?.roundToInt() ?: 900
    val height = heightPx.takeIf { it in 200.0..SHEET_MAX_HEIGHT.toDouble() }?.roundToInt() ?: 1273
    return ShareInk(width, height, strokes, sections)
}

/** Typed text boxes of the `textFields` array of a famd payload, the way the server accepts them. */
fun shareTextFieldsFrom(payload: JsonValue.Obj?): List<ShareTextField> {
    val items = payload?.array("textFields")?.items ?: return emptyList()
    val out = mutableListOf<ShareTextField>()
    for (item in items) {
        val obj = item as? JsonValue.Obj ?: continue
        val text = obj.string("text")?.take(8000) ?: continue
        if (text.isBlank()) continue
        val page = obj.double("page")?.takeIf { it % 1.0 == 0.0 && it in 1.0..10000.0 }?.toInt() ?: 1
        val fontSize = obj.double("fontSize")?.takeIf { it % 1.0 == 0.0 && it in 10.0..48.0 }?.toInt() ?: 16
        out += ShareTextField(
            page = page,
            x = (obj.double("x") ?: 0.5).coerceIn(0.0, 1.0),
            y = (obj.double("y") ?: 0.5).coerceIn(0.0, 1.0),
            width = (obj.double("width") ?: 0.32).coerceIn(0.12, 0.92),
            fontSize = fontSize,
            text = text,
        )
        if (out.size >= SHARE_TEXT_FIELDS) break
    }
    return out
}

/**
 * One note of a link from its Markdown and the companion `.famd` payload. The text column and the sheet height
 * follow `sharePageFromCompanion`: the sheet grows at the bottom until the typed lines fit, and every mark keeps
 * its place on the page.
 */
fun shareNoteFrom(path: String, content: String, document: InkDocument?, payload: JsonValue.Obj?): ShareNote {
    val fields = shareTextFieldsFrom(payload)
    val hasInk = document != null && document.strokes.any { it.symbolId == null && it.figurePaths.isEmpty() }
    var ink: ShareInk? = null
    var column: ShareTextColumn? = null
    if (document != null) {
        val origin = ShareTextColumn(min(20000.0, document.originX).roundToInt(), min(20000.0, document.originY).roundToInt())
        val lines = content.replace("\r\n", "\n").split('\n').size
        val needed = ceil(origin.originY + origin.padY + lines * origin.fontSize * origin.lineHeight + SHARE_TEXT_SLACK)
        val height = if (hasInk && needed > document.sourceHeight && document.sourceHeight < SHEET_MAX_HEIGHT) {
            min(needed, SHEET_MAX_HEIGHT.toDouble())
        } else {
            document.sourceHeight
        }
        ink = shareInkFrom(document, height)
        if (ink != null || fields.isNotEmpty()) column = origin
    } else if (fields.isNotEmpty()) {
        column = ShareTextColumn(0, 0)
    }
    return ShareNote(path.trim('/'), shareNoteTitle(path, content), content, ink, fields, column)
}

fun shareNoteJson(note: ShareNote): JsonValue.Obj {
    val obj = jsonObject(
        "path" to jsonString(note.path),
        "title" to jsonString(note.title),
        "content" to jsonString(note.content),
    )
    note.ink?.let { ink ->
        obj.put(
            "ink",
            jsonObject(
                "width" to jsonNumber(ink.width.toDouble()),
                "height" to jsonNumber(ink.height.toDouble()),
                "strokes" to JsonValue.Arr(
                    ink.strokes.map { stroke ->
                        jsonObject(
                            "color" to jsonString(stroke.color),
                            "width" to jsonNumber(stroke.width),
                            "opacity" to jsonNumber(stroke.opacity),
                            "points" to JsonValue.Arr(
                                stroke.points.map { (x, y) -> jsonObject("x" to jsonNumber(x), "y" to jsonNumber(y)) as JsonValue }.toMutableList(),
                            ),
                        ) as JsonValue
                    }.toMutableList(),
                ),
            ).also { json ->
                if (ink.sections.isNotEmpty()) {
                    json.put(
                        "sections",
                        JsonValue.Arr(
                            ink.sections.map {
                                jsonObject("id" to jsonString(it.id), "top" to jsonNumber(it.top), "bodyTop" to jsonNumber(it.bodyTop)) as JsonValue
                            }.toMutableList(),
                        ),
                    )
                }
            },
        )
    }
    if (note.textFields.isNotEmpty()) {
        obj.put(
            "textFields",
            JsonValue.Arr(
                note.textFields.map {
                    jsonObject(
                        "page" to jsonNumber(it.page.toDouble()),
                        "x" to jsonNumber(it.x),
                        "y" to jsonNumber(it.y),
                        "width" to jsonNumber(it.width),
                        "fontSize" to jsonNumber(it.fontSize.toDouble()),
                        "text" to jsonString(it.text),
                    ) as JsonValue
                }.toMutableList(),
            ),
        )
    }
    val column = note.textColumn
    if (column != null && (note.ink != null || note.textFields.isNotEmpty())) {
        obj.put(
            "textColumn",
            jsonObject(
                "originX" to jsonNumber(column.originX.toDouble()),
                "originY" to jsonNumber(column.originY.toDouble()),
                "column" to jsonNumber(column.column.toDouble()),
                "padX" to jsonNumber(column.padX.toDouble()),
                "padY" to jsonNumber(column.padY.toDouble()),
                "fontSize" to jsonNumber(column.fontSize.toDouble()),
                "lineHeight" to jsonNumber(column.lineHeight),
            ),
        )
    }
    return obj
}

/** Refuses what the server would refuse, so the user hears it before anything is sent. */
fun shareProblem(notes: List<ShareNote>): String? {
    if (notes.isEmpty()) return "Es gibt nichts zu teilen."
    if (notes.size > SHARE_MAX_NOTES) return "Ein Link kann höchstens $SHARE_MAX_NOTES Notizen enthalten."
    for (note in notes) {
        if (note.content.length > SHARE_MAX_NOTE_CHARS) return "„${note.title.take(40)}“ ist für einen Link zu gross."
        if (note.path.length > SHARE_MAX_PATH_CHARS) return "Der Pfad von „${note.title.take(40)}“ ist zu lang."
    }
    return null
}

fun sharePayloadJson(id: String, mode: ShareMode, rootPath: String, title: String, notes: List<ShareNote>, updatedAt: String): String {
    val kind = if (notes.size == 1 && notes[0].path == rootPath.trim('/')) "note" else "folder"
    return jsonObject(
        "schemaVersion" to jsonNumber(1.0),
        "id" to jsonString(id),
        "mode" to jsonString(mode.wire),
        "kind" to jsonString(kind),
        "rootPath" to jsonString(rootPath.trim('/')),
        "title" to jsonString(title.take(SHARE_MAX_TITLE_CHARS)),
        "notes" to JsonValue.Arr(notes.map { shareNoteJson(it) as JsonValue }.toMutableList()),
        "updatedAt" to jsonString(updatedAt),
    ).stringify()
}

fun buildShareUpload(id: String, body: String, origin: String = SHARE_ORIGIN) = ShareHttpRequest(
    "PUT",
    shareApiUrl(id, origin),
    SHARE_HEADERS + ("Content-Type" to "application/json"),
    body,
)

fun buildShareFetch(id: String, origin: String = SHARE_ORIGIN) = ShareHttpRequest("GET", shareApiUrl(id, origin), SHARE_HEADERS, "")

fun buildShareRevoke(id: String, origin: String = SHARE_ORIGIN) = ShareHttpRequest("DELETE", shareApiUrl(id, origin), SHARE_HEADERS, "")

/** What the person sees for a refused request. The server's own German message is used when it sent one. */
fun shareErrorMessage(status: Int, body: String): String {
    val server = runCatching { (parseJson(body) as? JsonValue.Obj)?.string("error") }.getOrNull()
    if (!server.isNullOrBlank() && server.length < 200) return server
    return when (status) {
        413 -> "Die Freigabe ist zu gross."
        429 -> "Zu viele Anfragen. Bitte später erneut versuchen."
        410 -> "Diese Freigabe wurde beendet."
        else -> "Freigabe wurde nicht angenommen ($status)."
    }
}

/** One remembered link of this device. The list is the only place the id is kept; the server cannot list links. */
data class ShareLinkRecord(
    val id: String,
    val link: String,
    val title: String,
    val rootPath: String,
    val mode: ShareMode,
    val kind: String,
    val createdAt: String,
    val stopped: Boolean = false,
)

fun parseShareDirectory(raw: String?): List<ShareLinkRecord> {
    if (raw.isNullOrBlank()) return emptyList()
    val items = runCatching { (parseJson(raw) as? JsonValue.Obj)?.array("shares")?.items }.getOrNull() ?: return emptyList()
    return items.mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        val id = obj.string("id")?.takeIf(::isShareId) ?: return@mapNotNull null
        val mode = ShareMode.fromWire(obj.string("mode")) ?: return@mapNotNull null
        ShareLinkRecord(
            id = id,
            link = obj.string("link") ?: shareViewUrl(id),
            title = obj.string("title").orEmpty(),
            rootPath = obj.string("rootPath").orEmpty(),
            mode = mode,
            kind = if (obj.string("kind") == "folder") "folder" else "note",
            createdAt = obj.string("createdAt").orEmpty(),
            stopped = obj.bool("stopped") == true,
        )
    }.take(200)
}

fun serializeShareDirectory(shares: List<ShareLinkRecord>): String = jsonObject(
    "shares" to JsonValue.Arr(
        shares.take(200).map {
            jsonObject(
                "id" to jsonString(it.id),
                "link" to jsonString(it.link),
                "title" to jsonString(it.title),
                "rootPath" to jsonString(it.rootPath),
                "mode" to jsonString(it.mode.wire),
                "kind" to jsonString(it.kind),
                "createdAt" to jsonString(it.createdAt),
                "stopped" to JsonValue.Bool(it.stopped),
            ) as JsonValue
        }.toMutableList(),
    ),
).stringify()

/** Newest first; a link with the same id replaces the old row. */
fun rememberShare(shares: List<ShareLinkRecord>, record: ShareLinkRecord): List<ShareLinkRecord> =
    listOf(record) + shares.filter { it.id != record.id }

fun markShareStopped(shares: List<ShareLinkRecord>, id: String): List<ShareLinkRecord> =
    shares.map { if (it.id == id) it.copy(stopped = true) else it }

/** Live links whose root is the saved note, or a folder that contains it. */
fun liveSharesFor(shares: List<ShareLinkRecord>, notePath: String): List<ShareLinkRecord> {
    val path = notePath.trim('/')
    return shares.filter { share ->
        !share.stopped && share.mode == ShareMode.LIVE &&
            (share.rootPath.trim('/') == path || (share.kind == "folder" && path.startsWith(share.rootPath.trim('/') + "/")))
    }
}

/** Uploads one prepared body. Returns the record the device remembers. */
fun publishShare(
    transport: ShareTransport,
    id: String,
    mode: ShareMode,
    rootPath: String,
    notes: List<ShareNote>,
    now: String,
    origin: String = SHARE_ORIGIN,
): ShareLinkRecord {
    shareProblem(notes)?.let { throw ShareException(it) }
    val title = if (notes.size == 1) notes[0].title else rootPath.trim('/').substringAfterLast('/')
    val body = sharePayloadJson(id, mode, rootPath, title, notes, now)
    if (body.toByteArray(Charsets.UTF_8).size > SHARE_MAX_BODY_BYTES) throw ShareException("Die Freigabe ist zu gross.")
    val response = transport.exchange(buildShareUpload(id, body, origin))
    if (response.status !in 200..299) throw ShareException(shareErrorMessage(response.status, response.body), response.status)
    return ShareLinkRecord(
        id = id,
        link = shareViewUrl(id, origin),
        title = title,
        rootPath = rootPath.trim('/'),
        mode = mode,
        kind = if (notes.size == 1 && notes[0].path == rootPath.trim('/')) "note" else "folder",
        createdAt = now,
    )
}

fun stopShare(transport: ShareTransport, id: String, origin: String = SHARE_ORIGIN) {
    val response = transport.exchange(buildShareRevoke(id, origin))
    if (response.status >= 400) throw ShareException("Freigabe konnte nicht beendet werden (${response.status}).", response.status)
}

/** Whether a link still answers: 200 yes, 404/410 gone. Used to refresh the list. */
fun shareStillActive(transport: ShareTransport, id: String, origin: String = SHARE_ORIGIN): Boolean? {
    val response = transport.exchange(buildShareFetch(id, origin))
    return when {
        response.status == 404 || response.status == 410 -> false
        response.status in 200..299 -> true
        else -> null
    }
}

