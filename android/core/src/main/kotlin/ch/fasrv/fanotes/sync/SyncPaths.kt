package ch.fasrv.fanotes.sync

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

const val RECOGNITION_MODEL_SYNC_PATH = ".fanotes/recognition-model.json"
private const val INTERNAL_DIRECTORY = ".fanotes"
private val SKIPPED_INTERNAL = setOf("history", "onboarding.json", "tree-cache")
private val SKIPPED_NAMES = setOf(".DS_Store", "Thumbs.db", "desktop.ini")

data class SyncPathOptions(
    val excludedPrefixes: List<String> = emptyList(),
    val includeRecognitionModel: Boolean = false,
    val includeHistory: Boolean = false,
)

/** Which vault paths sync. Mirrors `isSyncablePath` in `engine.ts`. */
fun isSyncablePath(path: String, options: SyncPathOptions = SyncPathOptions()): Boolean {
    if (path.isEmpty() || path.length > 1024 || path.contains('\u0000') || path.startsWith("/") || path.contains("//")) return false
    val segments = path.split('/')
    if (segments.any { it.isEmpty() || it == "." || it == ".." }) return false
    val name = segments.last()
    if (name in SKIPPED_NAMES || name.endsWith(".tmp", ignoreCase = true) || name.startsWith(".~lock.") || name.startsWith("~\$")) return false
    if (path == RECOGNITION_MODEL_SYNC_PATH && !options.includeRecognitionModel) return false
    if (pathIsSyncExcluded(path, options.excludedPrefixes)) return false
    if (segments[0] == INTERNAL_DIRECTORY) {
        if (segments.size < 2) return false
        if (segments[1] in SKIPPED_INTERNAL && !(options.includeHistory && segments[1] == "history")) return false
        return segments.drop(1).none { it.startsWith(".") }
    }
    return segments.none { it.startsWith(".") }
}

fun syncPrefixesFromSetting(value: String?): List<String> {
    if (value.isNullOrBlank()) return emptyList()
    val seen = linkedSetOf<String>()
    for (part in value.split(Regex("""[\n,]"""))) {
        val prefix = part.replace('\\', '/').trim().trim('/')
        if (prefix.isEmpty() || prefix.length > 480) continue
        if (prefix.split('/').any { it.isEmpty() || it == "." || it == ".." }) continue
        seen += prefix
    }
    return seen.take(80)
}

fun pathIsSyncExcluded(path: String, prefixes: List<String>): Boolean {
    val normalized = path.replace('\\', '/')
    return prefixes.any { prefix -> normalized == prefix || normalized.startsWith("$prefix/") }
}

private val CONFLICT_STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd HH-mm")

/** `<name> (Konflikt <device> <YYYY-MM-DD HH-MM>).<ext>`, local time, matching the desktop client. */
fun conflictCopyPath(path: String, deviceName: String, at: Instant, zone: ZoneId = ZoneId.systemDefault()): String {
    val slash = path.lastIndexOf('/')
    val directory = if (slash >= 0) path.substring(0, slash + 1) else ""
    val name = if (slash >= 0) path.substring(slash + 1) else path
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val extension = if (dot > 0) name.substring(dot) else ""
    val stamp = CONFLICT_STAMP.format(at.atZone(zone))
    val device = deviceName
        .replace(Regex("""[\\/:*?"<>|\u0000-\u001F]"""), " ")
        .replace(Regex("""\s+"""), " ")
        .trim()
        .take(40)
        .ifBlank { "Gerät" }
    return "$directory$stem (Konflikt $device $stamp)$extension"
}

fun diffLines(before: String, after: String): List<DiffRow> {
    val left = before.replace("\r\n", "\n").split('\n')
    val right = after.replace("\r\n", "\n").split('\n')
    if (left.size.toLong() * right.size > 250_000) {
        return left.map { DiffRow("removed", it) } + right.map { DiffRow("added", it) }
    }
    val table = Array(left.size + 1) { IntArray(right.size + 1) }
    for (row in 1..left.size) {
        for (column in 1..right.size) {
            table[row][column] = if (left[row - 1] == right[column - 1]) {
                table[row - 1][column - 1] + 1
            } else {
                maxOf(table[row - 1][column], table[row][column - 1])
            }
        }
    }
    val rows = ArrayDeque<DiffRow>()
    var row = left.size
    var column = right.size
    while (row > 0 && column > 0) {
        if (left[row - 1] == right[column - 1]) {
            rows.addFirst(DiffRow("same", left[row - 1]))
            row -= 1
            column -= 1
        } else if (table[row - 1][column] >= table[row][column - 1]) {
            rows.addFirst(DiffRow("removed", left[row - 1]))
            row -= 1
        } else {
            rows.addFirst(DiffRow("added", right[column - 1]))
            column -= 1
        }
    }
    while (row > 0) {
        rows.addFirst(DiffRow("removed", left[row - 1]))
        row -= 1
    }
    while (column > 0) {
        rows.addFirst(DiffRow("added", right[column - 1]))
        column -= 1
    }
    return rows
}

data class DiffRow(val kind: String, val text: String)

fun isMarkdownConflictPath(path: String) = Regex("""\.(md|markdown|famd)$""", RegexOption.IGNORE_CASE).containsMatchIn(path)

fun mergeMarkdownKeepingBoth(remote: String, local: String): String {
    val remoteText = remote.replace("\r\n", "\n").trimEnd()
    val remoteParts = paragraphs(remoteText).toSet()
    val extras = paragraphs(local).filter { it !in remoteParts }
    if (extras.isEmpty()) return if (remoteText.isEmpty()) "" else "$remoteText\n"
    val divider = "\n\n"
    return remoteText + (if (remoteText.isEmpty()) "" else divider) + extras.joinToString(divider) + "\n"
}

fun resolveMarkdownConflict(remote: String, local: String, choice: String): String = when (choice) {
    "remote" -> remote.replace("\r\n", "\n")
    "local" -> local.replace("\r\n", "\n")
    else -> mergeMarkdownKeepingBoth(remote, local)
}

private fun paragraphs(value: String) = value.replace("\r\n", "\n").split(Regex("""\n{2,}""")).map { it.trim() }.filter { it.isNotEmpty() }
