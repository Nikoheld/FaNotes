package ch.fasrv.fanotes.desk

/**
 * A pasted or dropped image becomes a worksheet on the open note, the way the
 * desktop window paste does. The text editor keeps a normal paste. A clipboard
 * image without a file name is stored as Bild, with the extension of its type.
 */
fun clipboardImageMime(raw: String?): String? {
    val mime = raw?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    return when (mime) {
        "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif" -> if (mime == "image/jpg") "image/jpeg" else mime
        else -> null
    }
}

fun clipboardImageFileName(mime: String?): String = when (clipboardImageMime(mime)) {
    "image/jpeg" -> "Bild.jpg"
    "image/webp" -> "Bild.webp"
    "image/gif" -> "Bild.gif"
    else -> "Bild.png"
}

/** True when the paste target is not the note's text field, so the image goes on the sheet. */
fun pasteImageOntoSheet(editorFocused: Boolean): Boolean = !editorFocused

/** A dropped file becomes a worksheet only when it is a paper image. The name is Bild plus the type. */
fun droppedImageFile(mime: String?): String? {
    val type = clipboardImageMime(mime) ?: return null
    return clipboardImageFileName(type)
}
