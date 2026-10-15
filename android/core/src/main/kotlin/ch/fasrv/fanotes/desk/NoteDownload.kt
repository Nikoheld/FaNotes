package ch.fasrv.fanotes.desk

const val NOTE_DOWNLOAD_REFUSED = "Nur Markdown-Notizen und PDF-Notizen können direkt heruntergeladen werden."
const val NOTE_DOWNLOAD_MISSING = "Der Eintrag wurde nicht gefunden."
const val NOTE_DOWNLOAD_SAVED = "Notiz gespeichert."

/** File name the desktop download uses: the vault leaf, unchanged. */
fun noteDownloadFileName(path: String): String {
    val name = path.replace('\\', '/').trim('/').substringAfterLast('/').trim()
    return name.ifBlank { "Notiz.md" }
}

/** Web download accepts the markdown note and the PDF note, nothing else. */
fun noteCanDownload(path: String): Boolean {
    val name = noteDownloadFileName(path)
    return name.endsWith(".md", ignoreCase = true) ||
        name.endsWith(".markdown", ignoreCase = true) ||
        name.endsWith(".pdf", ignoreCase = true)
}
