package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.parseInkDocument
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson

/*
 * What the conflict screen shows for one version of a file: its text, its handwriting, a PDF or an image, decoded
 * from the raw bytes in the vault. Port of `fanotes/src/lib/sync/conflictPreview.ts`. Nothing here writes;
 * resolving a conflict is the sync engine's and the view model's job.
 */

sealed interface ConflictPreview {
    val size: Int

    data object Missing : ConflictPreview {
        override val size: Int = 0
    }

    data class Damaged(override val size: Int) : ConflictPreview

    /** A note: readable text plus the handwriting page and typed text boxes of a `.famd`. */
    data class Note(
        val lines: List<String>,
        val words: Int,
        val ink: InkDocument?,
        val strokes: Int,
        val textFields: Int,
        override val size: Int,
    ) : ConflictPreview

    /** A stored ink page (`.fanotes/assets/ID.json`). */
    data class Ink(val ink: InkDocument?, val strokes: Int, override val size: Int) : ConflictPreview

    data class Pdf(val bytes: ByteArray, override val size: Int) : ConflictPreview

    data class Image(val bytes: ByteArray, val mime: String, override val size: Int) : ConflictPreview

    data class Text(val lines: List<String>, override val size: Int) : ConflictPreview

    /** A writing-mode file as the writer reads it: paragraphs, chapter and scene titles, a bible sheet. */
    data class Story(val role: String, val lines: List<String>, val words: Int, val paragraphs: Int, override val size: Int) : ConflictPreview

    data class Binary(override val size: Int) : ConflictPreview
}

class ConflictFileBytes(val path: String, val bytes: ByteArray?)

const val CONFLICT_PREVIEW_LINES = 4000

private val IMAGE_TYPES = mapOf(
    "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "gif" to "image/gif",
    "webp" to "image/webp", "avif" to "image/avif", "bmp" to "image/bmp",
)
private val TEXT_TYPES = setOf("txt", "json", "csv", "tex", "html", "css", "js", "ts", "yaml", "yml", "xml")

private fun extensionOf(path: String): String {
    val name = path.substringAfterLast('/')
    val dot = name.lastIndexOf('.')
    return if (dot > 0) name.substring(dot + 1).lowercase() else ""
}

private fun decode(bytes: ByteArray): String? = try {
    Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
} catch (_: java.nio.charset.CharacterCodingException) {
    null
}

/** Note text as the reader sees it: no famd payload, no hidden FaNotes markers. */
fun readableNoteText(source: String): String = ch.fasrv.fanotes.famd.stripFamdPayload(source)
    .replace("\r\n", "\n")
    .replace(Regex("<!--[\\s\\S]*?-->"), "")
    .replace(Regex("\n{3,}"), "\n\n")
    .trim()

private fun wordsIn(text: String) = Regex("[\\p{L}\\p{N}]+").findAll(text).count()

private fun oneLine(text: String) = text.replace(Regex("\\s*\\n\\s*"), " ").trim()

private fun runsText(runs: JsonValue?): String =
    (runs as? JsonValue.Arr)?.items.orEmpty().joinToString("") { (it as? JsonValue.Obj)?.string("text").orEmpty() }

private val HEADING_STYLES = mapOf("chapter" to "# ", "heading" to "## ", "subheading" to "### ")

/** Scenes, `story.json` and bible sheets as readable text, never raw JSON. Null for any other path. */
fun storyPreview(path: String, bytes: ByteArray): ConflictPreview? {
    val role = storyRoleOf(path)
    if (role != StoryRole.SCENE && role != StoryRole.MANIFEST && role != StoryRole.ENTITY) return null
    val value = decode(bytes)?.let { runCatching { parseJson(it) as? JsonValue.Obj }.getOrNull() }
        ?: return ConflictPreview.Damaged(bytes.size)
    val lines = ArrayList<String>()
    var paragraphs = 0
    when (role) {
        StoryRole.SCENE -> for (entry in value.array("paragraphs")?.items.orEmpty()) {
            val paragraph = entry as? JsonValue.Obj ?: continue
            if (paragraph.bool("deleted") == true) continue
            paragraphs += 1
            val prefix = HEADING_STYLES[paragraph.string("style")] ?: if (paragraph.string("style") == "quote") "> " else ""
            val kept = if (paragraph.fields["conflictOf"].let { it != null && it != JsonValue.Null && (it as? JsonValue.Str)?.value != "" }) "» " else ""
            lines += "$prefix$kept${oneLine(runsText(paragraph["runs"]))}"
        }
        StoryRole.MANIFEST -> {
            lines += "# ${oneLine(value.string("title").orEmpty())}"
            value.string("subtitle")?.takeIf { it.isNotBlank() }?.let { lines += oneLine(it) }
            value.string("author")?.takeIf { it.isNotBlank() }?.let { lines += oneLine(it) }
            fun walk(nodes: JsonValue?, depth: Int) {
                for (entry in (nodes as? JsonValue.Arr)?.items.orEmpty()) {
                    val node = entry as? JsonValue.Obj ?: continue
                    if (depth > 8) continue
                    paragraphs += 1
                    val title = oneLine(node.string("title").orEmpty())
                    val synopsis = oneLine(node.string("synopsis").orEmpty())
                    val tail = if (synopsis.isNotEmpty()) " – $synopsis" else ""
                    if (node.string("kind") == "scene") {
                        lines += "${"  ".repeat(maxOf(0, depth - 1))}- $title$tail"
                    } else {
                        lines += "${if (depth == 0) "## " else "### "}$title$tail"
                        walk(node["children"], depth + 1)
                    }
                }
            }
            walk(value["binder"], 0)
            val words = value.array("dictionary")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value }
            if (words.isNotEmpty()) {
                lines += ""
                lines += words.take(200).joinToString(", ") + if (words.size > 200) " …" else ""
            }
        }
        else -> {
            lines += "# ${oneLine(value.string("name").orEmpty())}${if (value.bool("archived") == true) " (archiviert)" else ""}"
            value.string("role")?.takeIf { it.isNotBlank() }?.let { lines += oneLine(it) }
            val aliases = value.array("aliases")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value }
            if (aliases.isNotEmpty()) lines += aliases.joinToString(", ")
            value.string("when")?.takeIf { it.isNotBlank() }?.let { lines += oneLine(it) }
            for (entry in value.array("fields")?.items.orEmpty()) {
                val field = entry as? JsonValue.Obj ?: continue
                if (field.string("value").orEmpty().isNotBlank()) lines += "- ${oneLine(field.string("label").orEmpty())}: ${oneLine(field.string("value").orEmpty())}"
            }
            value.string("notes")?.takeIf { it.isNotBlank() }?.let {
                lines += ""
                lines += it.replace("\r\n", "\n").split('\n')
            }
            paragraphs = lines.size
        }
    }
    val text = lines.joinToString("\n")
    return ConflictPreview.Story(
        role = when (role) { StoryRole.ENTITY -> "bible"; StoryRole.MANIFEST -> "manifest"; else -> "scene" },
        lines = lines.take(CONFLICT_PREVIEW_LINES),
        words = wordsIn(text.replace(Regex("(?m)^(#+\\s|-\\s)"), "")),
        paragraphs = paragraphs,
        size = bytes.size,
    )
}

private fun inkOf(value: JsonValue.Obj?): InkDocument? {
    val ink = value ?: return null
    if (ink.array("strokes")?.items.isNullOrEmpty()) return null
    return runCatching { parseInkDocument(ink, "", "dots", "") }.getOrNull()?.takeIf { it.strokes.isNotEmpty() }
}

/** One version of a document from its files; a note's `.md` and `.famd` are read together. */
fun previewOfVersion(files: List<ConflictFileBytes>): ConflictPreview {
    val present = files.filter { it.bytes != null }
    if (present.isEmpty()) return ConflictPreview.Missing
    val size = present.sumOf { it.bytes!!.size }
    if (present.size == 1) storyPreview(present[0].path, present[0].bytes!!)?.let { return it }
    val markdown = present.firstOrNull { extensionOf(it.path) in setOf("md", "markdown") }
    val famd = present.firstOrNull { extensionOf(it.path) == "famd" }
    if (markdown != null || famd != null) {
        var text = ""
        var ink: InkDocument? = null
        var fields = 0
        if (famd != null) {
            val source = decode(famd.bytes!!) ?: return ConflictPreview.Damaged(size)
            val parsed = runCatching { parseFamd(source) }.getOrNull() ?: return ConflictPreview.Damaged(size)
            if (source.contains("fanotes-famd:") && parsed.payload == null) return ConflictPreview.Damaged(size)
            ink = inkOf(parsed.payload?.obj("ink"))
            fields = parsed.payload?.array("textFields")?.items.orEmpty().count { !(it as? JsonValue.Obj)?.string("text").isNullOrBlank() }
            text = readableNoteText(parsed.markdown)
        }
        if (markdown != null) {
            val source = decode(markdown.bytes!!) ?: return ConflictPreview.Damaged(size)
            text = readableNoteText(source)
        }
        return ConflictPreview.Note(
            lines = if (text.isEmpty()) emptyList() else text.split('\n').take(CONFLICT_PREVIEW_LINES),
            words = wordsIn(text),
            ink = ink,
            strokes = ink?.strokes?.size ?: 0,
            textFields = fields,
            size = size,
        )
    }
    val file = present[0]
    val extension = extensionOf(file.path)
    val bytes = file.bytes!!
    if (extension == "pdf") return ConflictPreview.Pdf(bytes, size)
    IMAGE_TYPES[extension]?.let { return ConflictPreview.Image(bytes, it, size) }
    if (file.path.startsWith(".fanotes/assets/") && extension == "json") {
        val parsed = decode(bytes)?.let { runCatching { parseJson(it) as? JsonValue.Obj }.getOrNull() }
        if (parsed != null) {
            val ink = inkOf(parsed)
            return ConflictPreview.Ink(ink, ink?.strokes?.size ?: 0, size)
        }
    }
    if (extension in TEXT_TYPES) {
        decode(bytes)?.let { return ConflictPreview.Text(it.replace("\r\n", "\n").split('\n').take(CONFLICT_PREVIEW_LINES), size) }
    }
    return ConflictPreview.Binary(size)
}

/** Which lines differ: indices into the original's and the copy's lines. */
class ChangedLines(val original: Set<Int>, val copy: Set<Int>)

fun changedLines(original: List<String>, copy: List<String>): ChangedLines {
    val rows = diffLines(original.joinToString("\n"), copy.joinToString("\n"))
    val left = HashSet<Int>()
    val right = HashSet<Int>()
    var leftIndex = 0
    var rightIndex = 0
    for (row in rows) {
        when (row.kind) {
            "same" -> { leftIndex += 1; rightIndex += 1 }
            "removed" -> { left += leftIndex; leftIndex += 1 }
            else -> { right += rightIndex; rightIndex += 1 }
        }
    }
    return ChangedLines(left, right)
}

/** Short German size text for the version header, for example `12 KB`. */
fun conflictSizeLabel(bytes: Int): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> "%.1f MB".format(java.util.Locale.GERMAN, bytes / 1048576.0)
}

/** One line under a version: "132 Wörter · 18 Striche · 12 KB". */
fun conflictSummary(preview: ConflictPreview): String = when (preview) {
    ConflictPreview.Missing -> "Nicht vorhanden"
    is ConflictPreview.Damaged -> "Beschädigt · ${conflictSizeLabel(preview.size)}"
    is ConflictPreview.Note -> buildList {
        add("${preview.words} Wörter")
        if (preview.strokes > 0) add("${preview.strokes} Striche")
        if (preview.textFields > 0) add("${preview.textFields} Textfelder")
        add(conflictSizeLabel(preview.size))
    }.joinToString(" · ")
    is ConflictPreview.Ink -> "${preview.strokes} Striche · ${conflictSizeLabel(preview.size)}"
    is ConflictPreview.Pdf -> "PDF · ${conflictSizeLabel(preview.size)}"
    is ConflictPreview.Image -> "Bild · ${conflictSizeLabel(preview.size)}"
    is ConflictPreview.Text -> "${preview.lines.size} Zeilen · ${conflictSizeLabel(preview.size)}"
    is ConflictPreview.Story -> "${preview.words} Wörter · ${preview.paragraphs} Einträge · ${conflictSizeLabel(preview.size)}"
    is ConflictPreview.Binary -> "Binärdatei · ${conflictSizeLabel(preview.size)}"
}
