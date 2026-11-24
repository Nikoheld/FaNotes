package ch.fasrv.fanotes.vault

/**
 * The plain files the desktop vault tree lists besides notes (`TREE_EXTENSIONS` in `fanotes/electron/main.cjs`):
 * images, audio and video. Extensions are matched case-insensitively.
 */
object VaultFiles {
    val IMAGE = setOf(".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")
    val AUDIO = setOf(".mp3", ".wav", ".ogg", ".m4a")
    val VIDEO = setOf(".mp4", ".webm")

    private val MIME = mapOf(
        ".png" to "image/png", ".jpg" to "image/jpeg", ".jpeg" to "image/jpeg", ".webp" to "image/webp",
        ".gif" to "image/gif", ".svg" to "image/svg+xml",
        ".mp3" to "audio/mpeg", ".wav" to "audio/wav", ".ogg" to "audio/ogg", ".m4a" to "audio/mp4",
        ".mp4" to "video/mp4", ".webm" to "video/webm",
        ".pdf" to "application/pdf", ".md" to "text/markdown", ".markdown" to "text/markdown",
    )

    /** The MIME type for "open in another app"; the wildcard type when the extension is unknown. */
    fun mimeOf(path: String): String = MIME[extensionOf(path)] ?: "*/*"
}

/** The media kind of a file name, or null for anything that is not a listed image, audio or video file. */
fun fileKindOf(path: String): NoteKind? {
    val extension = extensionOf(path)
    return when (extension) {
        in VaultFiles.IMAGE -> NoteKind.IMAGE
        in VaultFiles.AUDIO -> NoteKind.AUDIO
        in VaultFiles.VIDEO -> NoteKind.VIDEO
        else -> null
    }
}
