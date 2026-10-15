package ch.fasrv.fanotes.vault

/** Image and PDF worksheet files, with the same limits and magic bytes as the desktop host. */
data class WorksheetFileFormat(
    val extension: String,
    val kind: String,
    val mime: String,
    val maxBytes: Long,
)

const val WORKSHEET_IMAGE_MAX_BYTES = 32L * 1024 * 1024
const val WORKSHEET_PDF_MAX_BYTES = 96L * 1024 * 1024

const val WORKSHEET_FORMAT_UNSUPPORTED = "Es werden PDF-, PNG-, JPEG-, WebP- und GIF-Arbeitsblätter unterstützt."
const val WORKSHEET_BYTES_MISMATCH = "Die ausgewählte Datei stimmt nicht mit ihrem Bild- oder PDF-Format überein."
const val WORKSHEET_TOO_LARGE = "Das Bild ist leer oder zu groß."

fun worksheetFileFormat(fileName: String, mime: String): WorksheetFileFormat? {
    val named = extensionOf(fileName.substringAfterLast('/').substringAfterLast('\\'))
    val extension = when (named) {
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf" -> named
        else -> when (mime.lowercase().substringBefore(';').trim()) {
            "application/pdf" -> ".pdf"
            "image/jpeg", "image/jpg" -> ".jpg"
            "image/png" -> ".png"
            "image/webp" -> ".webp"
            "image/gif" -> ".gif"
            else -> return null
        }
    }
    return worksheetFormatFor(extension)
}

fun worksheetFormatFor(extension: String): WorksheetFileFormat? = when (extension.lowercase()) {
    ".png" -> WorksheetFileFormat(".png", "image", "image/png", WORKSHEET_IMAGE_MAX_BYTES)
    ".jpg" -> WorksheetFileFormat(".jpg", "image", "image/jpeg", WORKSHEET_IMAGE_MAX_BYTES)
    ".jpeg" -> WorksheetFileFormat(".jpeg", "image", "image/jpeg", WORKSHEET_IMAGE_MAX_BYTES)
    ".webp" -> WorksheetFileFormat(".webp", "image", "image/webp", WORKSHEET_IMAGE_MAX_BYTES)
    ".gif" -> WorksheetFileFormat(".gif", "image", "image/gif", WORKSHEET_IMAGE_MAX_BYTES)
    ".pdf" -> WorksheetFileFormat(".pdf", "pdf", "application/pdf", WORKSHEET_PDF_MAX_BYTES)
    else -> null
}

fun worksheetBytesMatch(extension: String, bytes: ByteArray): Boolean {
    if (bytes.isEmpty()) return false
    return when (extension.lowercase()) {
        ".pdf" -> bytes.size >= 5 && bytes.copyOfRange(0, 5).decodeToString() == "%PDF-"
        ".png" -> bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A),
        )
        ".jpg", ".jpeg" -> bytes.size >= 3 &&
            bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()
        ".webp" -> bytes.size >= 12 &&
            bytes.copyOfRange(0, 4).decodeToString() == "RIFF" &&
            bytes.copyOfRange(8, 12).decodeToString() == "WEBP"
        ".gif" -> bytes.size >= 6 && (
            bytes.copyOfRange(0, 6).decodeToString() == "GIF87a" ||
                bytes.copyOfRange(0, 6).decodeToString() == "GIF89a"
            )
        else -> false
    }
}

/** Null when the file can be stored. Otherwise the desktop error sentence. */
fun worksheetImportError(fileName: String, mime: String, bytes: ByteArray): String? {
    val format = worksheetFileFormat(fileName, mime) ?: return WORKSHEET_FORMAT_UNSUPPORTED
    if (bytes.isEmpty() || bytes.size.toLong() > format.maxBytes) return WORKSHEET_TOO_LARGE
    if (!worksheetBytesMatch(format.extension, bytes)) return WORKSHEET_BYTES_MISMATCH
    return null
}
