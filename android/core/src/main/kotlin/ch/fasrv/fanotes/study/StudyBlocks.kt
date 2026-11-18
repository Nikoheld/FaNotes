package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue

/**
 * Study blocks live inside a note as fenced code blocks (` ```fanotes-key `, then JSON,
 * then the closing fence). The note stays plain text. Ported from `lib/study/blocks.ts`.
 */
enum class StudyKind(val id: String) {
    KEY("key"), SORT("sort"), MAP("map"), PLATE("plate"), TERM("term"), CRYPTO("crypto");

    companion object {
        fun of(id: String): StudyKind? = entries.firstOrNull { it.id == id }
    }
}

data class StudyBlockRef(
    val kind: StudyKind,
    /** Offset of the opening fence. */
    val from: Int,
    /** Offset just after the closing fence (no trailing newline). */
    val to: Int,
    /** JSON text between the fences. */
    val body: String,
    val startLine: Int,
    val endLine: Int,
)

private val OPEN = Regex("""^( {0,3})(`{3,})fanotes-(key|sort|map|plate|term|crypto)[ \t]*$""")
private val PLAIN_FENCE = Regex("""^ {0,3}(`{3,}|~{3,})""")

/** All study blocks of a note, ignoring look-alikes inside other fences. */
fun findStudyBlocks(markdown: String): List<StudyBlockRef> {
    if (!markdown.contains("fanotes-")) return emptyList()
    val blocks = ArrayList<StudyBlockRef>()
    val raw = markdown.split('\n')
    val lines = raw.map { if (it.endsWith('\r')) it.dropLast(1) else it }
    val starts = IntArray(raw.size)
    var offset = 0
    raw.forEachIndexed { index, line ->
        starts[index] = offset
        offset += line.length + 1
    }
    var other: Regex? = null
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        val closing = other
        if (closing != null) {
            if (closing.matches(line)) other = null
            index += 1
            continue
        }
        val open = OPEN.matchEntire(line)
        if (open != null) {
            val closer = Regex("""^ {0,3}`{${open.groupValues[2].length},}\s*$""")
            var end = -1
            for (scan in index + 1 until lines.size) {
                if (closer.matches(lines[scan])) {
                    end = scan
                    break
                }
            }
            if (end < 0) {
                index += 1
                continue
            }
            blocks += StudyBlockRef(
                kind = StudyKind.of(open.groupValues[3])!!,
                from = starts[index],
                to = starts[end] + lines[end].length,
                body = lines.subList(index + 1, end).joinToString("\n"),
                startLine = index + 1,
                endLine = end + 1,
            )
            index = end + 1
            continue
        }
        val plain = PLAIN_FENCE.find(line)
        if (plain != null) {
            val marker = plain.groupValues[1]
            val char = if (marker[0] == '`') "`" else "~"
            other = Regex("""^ {0,3}${Regex.escape(char)}{${marker.length},}\s*$""")
        }
        index += 1
    }
    return blocks
}

fun serializeStudyBlock(kind: StudyKind, data: JsonValue): String = "```fanotes-${kind.id}\n${prettyJson(data)}\n```"

fun replaceStudyBlock(markdown: String, ref: StudyBlockRef, data: JsonValue): String =
    markdown.substring(0, ref.from) + serializeStudyBlock(ref.kind, data) + markdown.substring(ref.to)

/** Inserts a block as its own paragraph at [at] (end of text by default). */
fun insertStudyBlock(markdown: String, kind: StudyKind, data: JsonValue, at: Int = markdown.length): String {
    val before = markdown.substring(0, at)
    val after = markdown.substring(at)
    val lead = when {
        before.isEmpty() -> ""
        before.endsWith("\n\n") -> ""
        before.endsWith("\n") -> "\n"
        else -> "\n\n"
    }
    val tail = when {
        after.isEmpty() -> "\n"
        after.startsWith("\n\n") -> ""
        after.startsWith("\n") -> "\n"
        else -> "\n\n"
    }
    return before + lead + serializeStudyBlock(kind, data) + tail + after
}

// -- pictures ---------------------------------------------------------------------

const val IMAGE_DATA_LIMIT = 220_000
private val VAULT_IMAGE = Regex("""^\.fanotes/worksheets/[A-Za-z0-9-]{8,64}\.(?:png|jpe?g|webp|gif)$""")
private val DATA_IMAGE = Regex("""^data:image/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$""")

fun isVaultImageRef(value: String) = VAULT_IMAGE.matches(value)

/** Vault files and small data URLs are kept; anything else (remote URLs, odd paths) is dropped. */
fun asStudyImage(value: JsonValue?): String {
    val text = (value as? JsonValue.Str)?.value ?: return ""
    if (isVaultImageRef(text)) return text
    return if (DATA_IMAGE.matches(text) && text.length <= IMAGE_DATA_LIMIT) text else ""
}

/** Picture references (vault files, old data URLs) of every study block, so the editor can load them as bitmaps. */
fun studyImageRefs(markdown: String): List<String> {
    if (!markdown.contains("fanotes-")) return emptyList()
    val refs = LinkedHashSet<String>()
    for (block in findStudyBlocks(markdown)) {
        when (block.kind) {
            StudyKind.PLATE -> parsePlateData(block.body)?.items?.forEach { if (it.img.isNotEmpty()) refs += it.img }
            StudyKind.KEY -> parseKeyData(block.body)?.compareImage?.takeIf { it.isNotEmpty() }?.let { refs += it }
            else -> Unit
        }
    }
    return refs.toList()
}
