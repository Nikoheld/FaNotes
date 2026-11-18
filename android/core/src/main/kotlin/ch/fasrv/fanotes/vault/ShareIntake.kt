package ch.fasrv.fanotes.vault

/**
 * Files other apps hand to FaNotes ("Teilen" / "Öffnen mit"): a PDF from mail, Teams or the browser, a photo of a
 * worksheet, a Markdown file. Each becomes a note in the vault, the way the desktop imports files:
 *
 * - PDF: a PDF note (desktop "PDF importieren"),
 * - image: a new note with the image as a worksheet (desktop "Arbeitsblatt importieren" without an open note),
 * - Markdown or plain text: a Markdown note with that text.
 *
 * Pure rules only; the app reads the content URIs.
 */
enum class IncomingKind { PDF, IMAGE, MARKDOWN, UNSUPPORTED }

/** Largest file taken in. School PDFs are big, but a share must not exhaust the heap (`largeHeap` is ~512 MB). */
const val INCOMING_MAX_BYTES = 160L * 1024 * 1024

/** At most this many files of one share are imported. */
const val INCOMING_MAX_FILES = 20

private val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "bmp")
private val MARKDOWN_EXTENSIONS = setOf("md", "markdown", "mdown", "txt")

fun incomingKind(name: String?, mime: String?): IncomingKind {
    val type = mime.orEmpty().lowercase().substringBefore(';').trim()
    val extension = name.orEmpty().substringAfterLast('.', "").lowercase()
    return when {
        type == "application/pdf" || extension == "pdf" -> IncomingKind.PDF
        type.startsWith("image/") || extension in IMAGE_EXTENSIONS -> IncomingKind.IMAGE
        type == "text/markdown" || type == "text/x-markdown" || extension in MARKDOWN_EXTENSIONS -> IncomingKind.MARKDOWN
        type == "text/plain" -> IncomingKind.MARKDOWN
        else -> IncomingKind.UNSUPPORTED
    }
}

/**
 * A safe file name for an incoming file: the provider's display name without folders or characters a vault cannot
 * hold, with the extension its kind needs. [index] numbers unnamed files of one share.
 */
fun incomingFileName(displayName: String?, mime: String?, kind: IncomingKind, index: Int = 0): String {
    val leaf = displayName.orEmpty().replace('\\', '/').substringAfterLast('/')
        .replace(Regex("""[\u0000-\u001f<>:"|?*]"""), "")
        .trim().trim('.')
        .take(120)
    val fallback = when (kind) {
        IncomingKind.PDF -> "Geteiltes PDF"
        IncomingKind.IMAGE -> "Geteiltes Bild"
        IncomingKind.MARKDOWN -> "Geteilte Notiz"
        IncomingKind.UNSUPPORTED -> "Geteilte Datei"
    }.let { if (index > 0) "$it ${index + 1}" else it }
    val stem = leaf.substringBeforeLast('.', leaf).trim().ifEmpty { fallback }
    val current = leaf.substringAfterLast('.', "").lowercase()
    val extension = when (kind) {
        IncomingKind.PDF -> "pdf"
        IncomingKind.IMAGE -> current.takeIf { it in IMAGE_EXTENSIONS } ?: imageExtension(mime)
        IncomingKind.MARKDOWN -> "md"
        IncomingKind.UNSUPPORTED -> current.ifEmpty { "bin" }
    }
    return "$stem.$extension"
}

private fun imageExtension(mime: String?): String = when (mime.orEmpty().lowercase()) {
    "image/png" -> "png"
    "image/webp" -> "webp"
    "image/gif" -> "gif"
    "image/heic" -> "heic"
    "image/heif" -> "heif"
    else -> "jpg"
}

/** Text of a shared Markdown or text file: UTF-8 (a BOM is dropped), line endings as `\n`. */
fun incomingMarkdownText(bytes: ByteArray): String {
    var text = bytes.decodeToString()
    if (text.startsWith("﻿")) text = text.substring(1)
    return text.replace("\r\n", "\n").replace('\r', '\n')
}

/** Text shared without a file (`EXTRA_TEXT`, e.g. a link from the browser) becomes a note body. */
fun sharedTextNote(subject: String?, text: String): Pair<String, String> {
    val title = subject?.trim()?.lines()?.firstOrNull()?.take(80)?.ifBlank { null } ?: "Geteilter Text"
    val body = "# $title\n\n${text.trim()}\n"
    return title to body
}

/** The message after a share, the desktop's tone. */
fun incomingSummary(imported: Int, skipped: Int, tooLarge: Int): String = buildString {
    append(
        when (imported) {
            0 -> "Nichts importiert."
            1 -> "1 Datei importiert."
            else -> "$imported Dateien importiert."
        },
    )
    if (skipped > 0) append(" $skipped nicht unterstützt (PDF, Bilder, Markdown).")
    if (tooLarge > 0) append(" $tooLarge zu gross.")
}
