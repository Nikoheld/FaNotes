package ch.fasrv.fanotes.desk

/**
 * Markdown conflict choices from `fanotes/src/lib/sync/markdownConflict.ts`.
 * Remote is the file that kept the original path. Local is the Konflikt copy.
 */
fun isMarkdownConflictPath(path: String) = path.endsWith(".md", true) || path.endsWith(".markdown", true)

fun resolveMarkdownConflict(remote: String, local: String, choice: String): String = when (choice) {
    "remote" -> remote.replace("\r\n", "\n")
    "local" -> local.replace("\r\n", "\n")
    "both" -> mergeMarkdownKeepingBoth(remote, local)
    else -> throw IllegalArgumentException("Unbekannte Konfliktlösung.")
}

/** Keep the server copy, then append local paragraphs that are not already in it. */
fun mergeMarkdownKeepingBoth(remote: String, local: String): String {
    val remoteText = remote.replace("\r\n", "\n").trimEnd()
    val remoteParts = paragraphs(remoteText).toSet()
    val extras = paragraphs(local).filter { it !in remoteParts }
    if (extras.isEmpty()) return if (remoteText.isEmpty()) "" else "$remoteText\n"
    val divider = "\n\n"
    return "$remoteText${if (remoteText.isEmpty()) "" else divider}${extras.joinToString(divider)}\n"
}

private fun paragraphs(value: String) = value.replace("\r\n", "\n").split(Regex("\n{2,}"))
    .map { it.trim() }
    .filter { it.isNotEmpty() }
