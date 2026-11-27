package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.sync.MAX_NAME_BYTES
import ch.fasrv.fanotes.sync.takeUtf8Bytes
import java.io.InputStream
import java.io.OutputStream

/** One uploaded file is at most this large (96 MB). */
const val UPLOAD_MAX_BYTES = 96L * 1024 * 1024

/** A stream held more bytes than the caller allowed. */
class FileTooLargeException(val limit: Long) : java.io.IOException("The file is larger than $limit bytes")

/** Copies [input] to [output], failing with [FileTooLargeException] as soon as more than [maxBytes] arrive. */
fun copyBounded(input: InputStream, output: OutputStream, maxBytes: Long): Long {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val read = input.read(buffer)
        if (read < 0) return total
        total += read
        if (total > maxBytes) throw FileTooLargeException(maxBytes)
        output.write(buffer, 0, read)
    }
}

/** The whole stream as bytes, at most [maxBytes]. */
fun readBounded(input: InputStream, maxBytes: Long): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    copyBounded(input, out, maxBytes)
    return out.toByteArray()
}

/** What an upload of several files did; names are the display names the user picked. */
data class UploadSummary(val uploaded: Int, val tooLarge: List<String>, val failed: List<String>)

/**
 * A picked file name as (safe stem, safe extension with its dot or ""). The stem loses path and
 * reserved characters; the extension keeps letters and digits only. The pair fits the 255-byte name limit
 * with room for a " 12" clash number.
 */
fun uploadNameParts(fileName: String): Pair<String, String> {
    val base = fileName.substringAfterLast('/').substringAfterLast('\\')
    val dot = base.lastIndexOf('.')
    val rawExtension = if (dot > 0) base.substring(dot + 1).filter { it.isLetterOrDigit() && it.code < 128 }.take(12) else ""
    val rawStem = if (dot > 0) base.substring(0, dot) else base
    val extension = if (rawExtension.isEmpty()) "" else ".$rawExtension"
    val stem = takeUtf8Bytes(safeNoteName(rawStem.ifBlank { "File" }), MAX_NAME_BYTES - extension.length - 8).ifBlank { "File" }
    return stem to extension
}

/** `stem<suffix>.ext`, the numbered form of a taken name. */
fun uploadLeaf(stem: String, suffix: String, extension: String): String = stem + suffix + extension

private val NOT_LISTED_NAMES = setOf("thumbs.db", "desktop.ini", ".ds_store")

/**
 * True for a real user file the library may list as [NoteKind.FILE]: not a dot-file, not an editor
 * lock or temporary file, not an operating-system index file. Mirrors what sync skips (`isSyncablePath`).
 */
fun isListedUserFile(name: String): Boolean {
    val leaf = name.substringAfterLast('/')
    if (leaf.isEmpty() || leaf.startsWith(".") || leaf.startsWith("~$")) return false
    if (leaf.lowercase() in NOT_LISTED_NAMES || leaf.endsWith(".tmp", ignoreCase = true)) return false
    return true
}

/** The kind a plain file is listed as: media by extension, any other user file as [NoteKind.FILE], hidden ones as null. */
fun listedFileKind(name: String): NoteKind? = fileKindOf(name) ?: if (isListedUserFile(name)) NoteKind.FILE else null

/**
 * True when [path] opens in the note editor: prose, a PDF note or a `.famd`. Media, story folders and every other
 * file (an uploaded `.docx`, `.zip`, ...) have no editor. A name without an extension is still treated as a note.
 */
fun isNotePath(path: String): Boolean {
    if (StoryFiles.isStoryFolder(path)) return false
    val extension = extensionOf(path)
    return extension.isEmpty() || extension in setOf(".md", ".markdown", ".pdf", ".famd")
}
