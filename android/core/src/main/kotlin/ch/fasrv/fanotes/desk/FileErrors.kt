package ch.fasrv.fanotes.desk

/**
 * Short, path-free messages for file-system failures (desktop `fileErrors.ts`). The raw
 * exception text carries absolute temp paths ("…/Inbox/Note.famd.<uuid>.tmp") that help no one.
 * The returned strings are German catalog keys; callers pass them through `ChromeText.ui`.
 */
const val FILE_ERROR_DENIED = "Kein Zugriff auf die Datei."
const val FILE_ERROR_READ_ONLY = "Die Datei ist schreibgeschützt oder gesperrt."
const val FILE_ERROR_BUSY = "Die Datei wird von einem anderen Programm verwendet."
const val FILE_ERROR_MISSING = "Die Datei wurde nicht gefunden."
const val FILE_ERROR_FULL = "Auf dem Datenträger ist kein Speicherplatz mehr frei."

private val PATH_OR_ERRNO = Regex("""[A-Za-z]:\\|/[\w.-]+/|\bE[A-Z]{3,}\b|\.tmp\b""")

/** The catalog message for a known file error anywhere in the cause chain, else null. */
fun fileErrorMessage(error: Throwable?): String? {
    var current = error
    var depth = 0
    while (current != null && depth < 8) {
        val text = current.message.orEmpty()
        when {
            current is java.nio.file.AccessDeniedException -> return FILE_ERROR_DENIED
            current is java.nio.file.ReadOnlyFileSystemException -> return FILE_ERROR_READ_ONLY
            current is java.nio.file.NoSuchFileException || current is java.io.FileNotFoundException && !text.contains("denied", true) && !text.contains("EACCES") && !text.contains("EPERM") && !text.contains("Read-only", true) ->
                return FILE_ERROR_MISSING
            current is java.nio.file.FileSystemException && text.contains("No space left", true) -> return FILE_ERROR_FULL
        }
        val code = Regex("""\b(EPERM|EACCES|EBUSY|ENOENT|ENOSPC|EROFS)\b""").find(text)?.value
        when {
            code == "EPERM" || code == "EROFS" || text.contains("Read-only file system", true) -> return FILE_ERROR_READ_ONLY
            code == "EACCES" || text.contains("Permission denied", true) -> return FILE_ERROR_DENIED
            code == "EBUSY" -> return FILE_ERROR_BUSY
            code == "ENOENT" -> return FILE_ERROR_MISSING
            code == "ENOSPC" || text.contains("No space left", true) -> return FILE_ERROR_FULL
            text.contains("Operation not permitted", true) -> return FILE_ERROR_READ_ONLY
        }
        current = current.cause
        depth += 1
    }
    return null
}

/** A known file error, else the message when it is clean, else `fallback`. */
fun friendlyFileError(error: Throwable, fallback: String): String {
    fileErrorMessage(error)?.let { return it }
    val text = error.message?.trim().orEmpty()
    if (text.isEmpty() || PATH_OR_ERRNO.containsMatchIn(text)) return fallback
    return text
}

/** Back-off before the n-th automatic save retry (0-based): 2 s, 4 s, 8 s, 15 s, then every 30 s. */
fun saveRetryDelayMs(attempt: Int): Long = when {
    attempt <= 0 -> 2_000L
    attempt == 1 -> 4_000L
    attempt == 2 -> 8_000L
    attempt == 3 -> 15_000L
    else -> 30_000L
}
