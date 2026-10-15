package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue

/**
 * Placed note links: style, page, and removal.
 * Ported from `fanotes/src/lib/noteLink.ts`.
 */

data class NoteLinkStyle(val id: String, val label: String, val appearance: String)

val NOTE_LINK_STYLES = listOf(
    NoteLinkStyle("symbol", "Symbol", "symbol"),
    NoteLinkStyle("text", "Text", "text"),
    NoteLinkStyle("symbol-text", "Symbol und Text", "symbol-text"),
)

private val NOTE_LINK_ID = Regex("^[a-zA-Z0-9._-]{1,96}$")
private const val MAX_PATH = 500
private const val MAX_LABEL = 80

data class NoteLinkPoint(val page: Int, val x: Double, val y: Double)

fun isNoteLinkStyleId(value: String?) = value == "symbol" || value == "text" || value == "symbol-text"

fun noteLinkAppearanceToken(style: String?): String = when (style) {
    "text" -> "text"
    "symbol-text" -> "symbol-text"
    else -> "symbol"
}

fun noteStemName(relativePath: String): String {
    val base = relativePath.replace('\\', '/').substringAfterLast('/').ifBlank { "Notiz" }
    return base.replace(Regex("""\.(md|markdown|famd|pdf)$""", RegexOption.IGNORE_CASE), "").ifBlank { "Notiz" }
}

fun linkedNoteParent(sourcePath: String): String {
    val parts = sourcePath.replace('\\', '/').trim('/').split('/').filter { it.isNotEmpty() }
    return parts.dropLast(1).joinToString("/")
}

fun linkedNotePreferredName(sourcePath: String) = "${noteStemName(sourcePath)} · Notiz"

fun linkedNoteDefaultLabel(targetPath: String) = noteStemName(targetPath)

class NoteLinkException(message: String) : IllegalArgumentException(message)

fun placeNewNoteLink(
    sourcePath: String,
    targetPath: String,
    page: Int = 1,
    x: Double,
    y: Double,
    style: String? = null,
    label: String? = null,
    id: String? = null,
): NoteLinkMark {
    val link = sanitizeNoteLink(id, sourcePath, targetPath, page, x, y, style, label ?: linkedNoteDefaultLabel(targetPath))
        ?: throw NoteLinkException("Die Verlinkung konnte nicht gesetzt werden.")
    if (sanitizePath(sourcePath).isEmpty()) throw NoteLinkException("Die Verlinkung braucht eine Quellnotiz.")
    return link
}

fun restyleNoteLink(link: NoteLinkMark, style: String?): NoteLinkMark {
    return sanitizeNoteLink(link.id, link.sourcePath, link.targetPath, link.page, link.x, link.y, style, link.label)
        ?: throw NoteLinkException("Der Verlinkungsstil ist ungültig.")
}

fun activateNoteLink(link: NoteLinkMark?): String? {
    val target = sanitizePath(link?.targetPath.orEmpty())
    val source = sanitizePath(link?.sourcePath.orEmpty())
    if (target.isEmpty() || source.isEmpty() || target == source || !target.endsWith(".md", ignoreCase = true)) return null
    return target
}

/**
 * Delete or Backspace removes the selected note link when the caret is not in
 * a text field. The desktop window handler uses the same rule.
 */
fun noteLinkDeleteKey(pressed: Boolean, textEntryFocused: Boolean, linkSelected: Boolean): Boolean =
    pressed && linkSelected && !textEntryFocused

fun removeNoteLink(links: List<NoteLinkMark>, id: String): List<NoteLinkMark> {
    val list = links.mapNotNull { sanitizeNoteLink(it.id, it.sourcePath, it.targetPath, it.page, it.x, it.y, it.style, it.label) }
    val key = id.trim()
    if (key.isEmpty() || !NOTE_LINK_ID.matches(key)) throw NoteLinkException("Diese Verlinkung gibt es nicht.")
    val next = list.filter { it.id != key }
    if (next.size == list.size) throw NoteLinkException("Diese Verlinkung gibt es nicht.")
    return next
}

fun parseNoteLinks(array: JsonValue.Arr?): List<NoteLinkMark> {
    val items = array?.items ?: return emptyList()
    val seen = linkedSetOf<String>()
    val links = mutableListOf<NoteLinkMark>()
    for (item in items) {
        val obj = item as? JsonValue.Obj ?: continue
        val link = sanitizeNoteLink(
            id = obj.string("id"),
            sourcePath = obj.string("sourcePath").orEmpty(),
            targetPath = obj.string("targetPath").orEmpty(),
            page = obj.double("page")?.toInt() ?: obj.string("page")?.toIntOrNull() ?: 1,
            x = obj.double("x") ?: 0.5,
            y = obj.double("y") ?: 0.5,
            style = obj.string("style"),
            label = obj.string("label"),
        ) ?: continue
        if (link.id in seen) continue
        seen += link.id
        links += link
    }
    return links
}

/** Sheet fractions become a page-local point. Without frames the sheet is page 1. */
fun noteLinkPointOnSheet(
    x: Double,
    y: Double,
    frames: List<PageFrame>,
    sourceWidth: Double,
    sourceHeight: Double,
): NoteLinkPoint {
    if (frames.isEmpty() || sourceHeight <= 0.0) {
        return NoteLinkPoint(1, x.coerceIn(0.0, 1.0), y.coerceIn(0.0, 1.0))
    }
    val yPx = y * sourceHeight
    val frame = frames.firstOrNull { yPx >= it.top && yPx <= it.top + it.height } ?: frames.first()
    val localX = if (frame.width <= 0.0 || sourceWidth <= 0.0) x.coerceIn(0.0, 1.0) else ((x * sourceWidth) / frame.width).coerceIn(0.0, 1.0)
    val localY = if (frame.height <= 0.0) 0.0 else ((yPx - frame.top) / frame.height).coerceIn(0.0, 1.0)
    return NoteLinkPoint(frame.page.coerceIn(1, 10_000), localX, localY)
}

fun noteLinkToSheet(link: NoteLinkMark, frames: List<PageFrame>, sourceWidth: Double, sourceHeight: Double): Pair<Double, Double> {
    val frame = frames.firstOrNull { it.page == link.page } ?: frames.singleOrNull()
    if (frame == null || sourceWidth <= 0.0 || sourceHeight <= 0.0 || frame.height <= 0.0 || frame.width <= 0.0) {
        return link.x to link.y
    }
    return (link.x * frame.width) / sourceWidth to (frame.top + link.y * frame.height) / sourceHeight
}

private fun sanitizeNoteLink(
    id: String?,
    sourcePath: String,
    targetPath: String,
    page: Int,
    x: Double,
    y: Double,
    style: String?,
    label: String?,
): NoteLinkMark? {
    val source = sanitizePath(sourcePath)
    val target = sanitizePath(targetPath)
    if (source.isEmpty() || target.isEmpty() || source == target || !target.endsWith(".md", ignoreCase = true)) return null
    val safeId = if (id != null && NOTE_LINK_ID.matches(id)) id else newNoteLinkId()
    val safeStyle = if (isNoteLinkStyleId(style)) style!! else "symbol"
    return NoteLinkMark(
        id = safeId,
        sourcePath = source,
        targetPath = target,
        page = if (page in 1..10_000) page else 1,
        x = x.coerceIn(0.0, 1.0),
        y = y.coerceIn(0.0, 1.0),
        style = safeStyle,
        label = sanitizeLabel(label, linkedNoteDefaultLabel(target)),
    )
}

private fun sanitizePath(value: String): String {
    val path = value.replace('\\', '/').trim().trim('/')
    if (path.isEmpty() || path.length > MAX_PATH || path.contains("..") || path.contains('\u0000')) return ""
    return path
}

private fun sanitizeLabel(value: String?, fallback: String): String {
    val label = value?.replace(Regex("""\s+"""), " ")?.trim().orEmpty()
    return (if (label.isEmpty()) fallback else label).take(MAX_LABEL)
}

private fun newNoteLinkId(): String {
    val suffix = java.util.UUID.randomUUID().toString().replace("-", "").take(6)
    return "nl-${System.currentTimeMillis().toString(36)}-$suffix"
}
