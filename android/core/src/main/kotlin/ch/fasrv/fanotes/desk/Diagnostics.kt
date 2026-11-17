package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonParseException
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.stringify
import java.io.FileNotFoundException
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.file.NoSuchFileException
import java.security.SecureRandom
import javax.net.ssl.SSLException
import kotlin.math.roundToLong

/**
 * Opt-in diagnostics, pure half. A port of `fanotes/src/lib/diagnostics.mjs`: the same payload
 * schema (version 1), the same scrubber and the same privacy rules. Nothing in here touches the
 * network, the file system or the vault. Error text never leaves the device: only a class from
 * an allow-list, a stable code, up to three frames of `ch.fasrv.fanotes` and a grouping hash.
 */
const val DIAGNOSTICS_SCHEMA = 1
const val DIAGNOSTICS_PATH = "/api/v1/diagnostics"
const val DIAGNOSTICS_ORIGIN = "https://fanotes.fasrv.ch"
const val DIAGNOSTICS_INTERVAL_MS = 24L * 60 * 60 * 1000
const val DIAGNOSTICS_MAX_LOGS = 60
const val DIAGNOSTICS_MAX_COUNTERS = 120
const val DIAGNOSTICS_MAX_COMMENT = 1000

val COUNTER_NAME = Regex("^[a-z0-9][a-z0-9._-]{0,39}$")
val INSTALL_ID = Regex("^[0-9a-f]{32}$")
val ERROR_CLASSES = listOf(
    "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
    "DOMException", "AbortError", "NetworkError", "QuotaExceededError", "NotFoundError", "SecurityError",
    "NotAllowedError", "InvalidStateError", "DataError", "OperationError",
)
val ERROR_CODE = Regex("^[A-Z][A-Z0-9_]{1,39}$")
val ERROR_HASH = Regex("^[0-9a-f]{12}$")
val ERROR_KEY = Regex("^[A-Za-z]{2,24}\\|[A-Z0-9_]{0,40}\\|[0-9a-f]{12}$")

/** A frame is a class of this app, never a framework or a library. */
val APP_FRAME = Regex("^ch\\.fasrv\\.fanotes(?:\\.[A-Za-z_][A-Za-z0-9_]{0,60}){1,6}$")

// ---------------------------------------------------------------------------------------------
// Scrubber. Every regex is the JavaScript one with the engine differences made explicit so the
// JVM and Android (ICU) behave the same: ASCII \b, \d and \w, and the JavaScript \s set.
// ---------------------------------------------------------------------------------------------

private const val WORDCH = "A-Za-z0-9_"
private const val B = "(?:(?<=[$WORDCH])(?![$WORDCH])|(?<![$WORDCH])(?=[$WORDCH]))"
private const val S = " \\t\\n\\u000b\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

private fun rx(pattern: String, ignoreCase: Boolean = false): Regex =
    if (ignoreCase) Regex(pattern, setOf(RegexOption.IGNORE_CASE)) else Regex(pattern)

private val SYSTEM_WORDS = setOf("home", "users", "user", "usr", "var", "mnt", "media", "srv", "tmp", "root", "opt", "etc", "lib", "bin")
private const val QUOTE_CHARS = "„“”\"«»‹›‚‘’'`´"
private val PERCENT_RUN = rx("(?:%[0-9a-fA-F]{2})+")
private val QUOTES = rx("[$QUOTE_CHARS][^$QUOTE_CHARS\\n]{0,300}[$QUOTE_CHARS]")

private val SCRUB_STEPS: List<Pair<Regex, (MatchResult) -> String>> = listOf(
    rx("$B(?:Bearer|Basic)[$S]+[A-Za-z0-9._~+/=-]{8,}") to { _ -> "<token>" },
    rx("$B(secret|password|passwort|passwd|token|key|apikey|api[_-]key|authorization|auth|credentials?)$B[ \\t]*[:=][^\\n]*", true) to { m -> "${m.groupValues[1]}: <redacted>" },
    rx("${B}eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}(?:\\.[A-Za-z0-9_-]*)?") to { _ -> "<token>" },
    rx("$B(?:AKIA|ASIA)[0-9A-Z]{12,}$B|${B}sk-[A-Za-z0-9_-]{6,}|$B(?:gh[pousr]_|github_pat_|xox[abprs]-|AIza|glpat-|npm_|pk_live_|sk_live_|rk_live_)[A-Za-z0-9_-]{6,}") to { _ -> "<token>" },
    rx("${B}content://[^\\n,;<>|\"]*", true) to { _ -> "<url>" },
    rx("$B[a-z][a-z0-9+.-]*://[^$S)\"'<>]+|${B}www\\.[^$S)\"'<>]+", true) to { _ -> "<url>" },
    rx("[A-Za-z0-9._%+-]+@[A-Za-z0-9._-]+") to { _ -> "<email>" },
    rx("\\[[0-9a-f:.]{2,45}\\](?::[0-9]{1,5})?", true) to { _ -> "<ip>" },
    rx("(?<![$WORDCH:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![$WORDCH:])|(?<![$WORDCH:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){0,6}::[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){0,6}(?![$WORDCH:])", true) to { _ -> "<ip>" },
    rx("$B[0-9]{1,3}(?:\\.[0-9]{1,3}){3}(?::[0-9]{1,5})?$B") to { _ -> "<ip>" },
    rx("$B[0-9]{3}[- ][0-9]{3}[- ][0-9]{3}$B") to { _ -> "<code>" },
    QUOTES to { _ -> "<quoted>" },
    rx("<dir>(?:[\\\\/][^\\n,;<>|?*\"]*)?") to { _ -> "<path>" },
    rx("(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^$S\\\\]+\\\\|/(?:home|Users|mnt|media|srv|var|tmp|root|opt|run|Volumes|storage|sdcard0?|data)/)[^\\n,;<>|?*\"]*") to { _ -> "<path>" },
    rx("(?:(?:tree|document)/)?(?:primary|home|[0-9A-F]{4}-[0-9A-F]{4}):[^\\n,;<>|?*\"]*", true) to { _ -> "<path>" },
    rx("[^$S/\\\\<>]+(?:[\\\\/][^$S/\\\\<>]+)+[\\\\/]?|[\\\\/][^$S/\\\\<>]+[\\\\/]") to { _ -> "<path>" },
    rx("[^$S<>]+\\.(?:md|markdown|famd|pdf|png|jpe?g|gif|webp|svg|story|json|txt|docx?|odt|mp3|wav|m4a|mp4|webm|zip|onetoc2|onepkg)$B", true) to { _ -> "<file>" },
    rx("$B[A-Fa-f0-9]{24,}$B") to { _ -> "<hash>" },
    rx("$B(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}$B|$B[A-Za-z0-9_-]{40,}$B") to { _ -> "<token>" },
)

private val WHITESPACE_RUN = rx("[$S]+")

/** Where the app lives, so its own paths and names can be found in free text. */
data class DiagnosticsContext(
    val vaultPath: String = "",
    val homeDir: String = "",
    val userName: String = "",
    /** Further absolute paths or URIs of this install (for example the SAF tree URI), scrubbed as a whole, spaces included. */
    val extraPaths: List<String> = emptyList(),
    /** Further names of this install (folder display name, device model, device name), scrubbed as whole phrases. */
    val extraNames: List<String> = emptyList(),
)

/** Strict `decodeURIComponent` for a run of `%XX` escapes. A malformed run stays as it is. */
private fun decodeUriRun(run: String): String {
    val bytes = ByteArray(run.length / 3) { run.substring(it * 3 + 1, it * 3 + 3).toInt(16).toByte() }
    return try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        run
    }
}

private fun dirPattern(dir: String): Regex {
    val pieces = dir.replace('\\', '/').split('/').joinToString("[\\\\/]") { Regex.escape(it) }
    return Regex(pieces, RegexOption.IGNORE_CASE)
}

/**
 * Best-effort removal of anything identifying from free text: URI-decoded first, then secrets,
 * URLs, e-mail addresses, IP addresses, pairing codes, every quoted segment, absolute and
 * relative paths, file names and long tokens. Over-redacting is intended. Free text is only
 * ever sent when the user typed it into the report comment.
 */
fun scrubText(input: String?, context: DiagnosticsContext = DiagnosticsContext(), max: Int = 300): String {
    var text = input ?: ""
    repeat(2) { text = PERCENT_RUN.replace(text) { decodeUriRun(it.value) } }
    fun decoded(value: String): String {
        var out = value
        repeat(2) { out = PERCENT_RUN.replace(out) { decodeUriRun(it.value) } }
        return out
    }
    val extraPaths = context.extraPaths.flatMap { listOf(it, decoded(it)) }
    val dirs = (listOf(context.homeDir, context.vaultPath) + extraPaths).distinct().filter { it.length >= 3 }.sortedByDescending { it.length }
    for (dir in dirs) text = dirPattern(dir).replace(text) { "<dir>" }
    val words = LinkedHashSet<String>()
    for (word in listOf(context.userName) + context.extraNames + context.vaultPath.split(Regex("[\\\\/]"))) {
        if (word.length >= 3 && word.lowercase() !in SYSTEM_WORDS) words += word
    }
    for ((pattern, replacement) in SCRUB_STEPS) text = pattern.replace(text, replacement)
    for (word in words) {
        text = Regex("(?<![\\p{L}\\p{N}])${Regex.escape(word)}(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE).replace(text) { "<name>" }
    }
    return WHITESPACE_RUN.replace(text, " ").trim(' ').take(max)
}

// ---------------------------------------------------------------------------------------------
// Errors: class, code, frames, hash. Never the message.
// ---------------------------------------------------------------------------------------------

data class DescribedError(val errorClass: String, val code: String, val frames: List<Frame>, val hash: String) {
    data class Frame(val file: String, val line: Int)
}

/** cyrb53: a stable 53-bit hash, 12 hex digits, to group equal errors across installs. */
fun hashText(text: String): String {
    var h1 = 0xdeadbeef.toInt()
    var h2 = 0x41c6ce57
    for (char in text) {
        val code = char.code
        h1 = (h1 xor code) * 2654435761u.toInt()
        h2 = (h2 xor code) * 1597334677
    }
    h1 = ((h1 xor (h1 ushr 16)) * 2246822507u.toInt()) xor ((h2 xor (h2 ushr 13)) * 3266489909u.toInt())
    h2 = ((h2 xor (h2 ushr 16)) * 2246822507u.toInt()) xor ((h1 xor (h1 ushr 13)) * 3266489909u.toInt())
    val value = ((h2 and 2097151).toLong() shl 32) + (h1.toLong() and 0xFFFFFFFFL)
    return value.toString(16).padStart(14, '0').takeLast(12)
}

private val QUOTED_PARTS = Regex("\"[^\"]*\"|'[^']*'|„[^“]*“|«[^»]*»")
private val DIGIT_RUN = Regex("[0-9]+")

/** The text a hash is made of: lower case, quoted parts and numbers gone, so equal errors share a hash. */
fun normalizeErrorMessage(message: String): String {
    val lowered = message.lowercase()
    val collapsed = WHITESPACE_RUN.replace(DIGIT_RUN.replace(QUOTED_PARTS.replace(lowered, ""), "#"), " ")
    return collapsed.trim(' ').take(300)
}

private fun classAndCode(error: Throwable): Pair<String, String> = when (error) {
    is JsonParseException -> "SyntaxError" to "PARSE_ERROR"
    is SocketTimeoutException -> "NetworkError" to "TIMEOUT"
    is UnknownHostException -> "NetworkError" to "UNKNOWN_HOST"
    is ConnectException -> "NetworkError" to "CONNECT_FAILED"
    is SSLException -> "NetworkError" to "TLS_ERROR"
    is SocketException -> "NetworkError" to "SOCKET_ERROR"
    is FileNotFoundException, is NoSuchFileException -> "NotFoundError" to "NOT_FOUND"
    is java.io.IOException -> "Error" to "IO_ERROR"
    is kotlinx.coroutines.CancellationException -> "AbortError" to "CANCELLED"
    is SecurityException -> "SecurityError" to "SECURITY"
    is IllegalStateException -> "InvalidStateError" to "ILLEGAL_STATE"
    is NumberFormatException -> "TypeError" to "NUMBER_FORMAT"
    is IllegalArgumentException -> "TypeError" to "ILLEGAL_ARGUMENT"
    is NullPointerException -> "TypeError" to "NULL_POINTER"
    is ClassCastException -> "TypeError" to "CLASS_CAST"
    is IndexOutOfBoundsException -> "RangeError" to "INDEX_OUT_OF_RANGE"
    is ArithmeticException -> "RangeError" to "ARITHMETIC"
    is UnsupportedOperationException -> "NotAllowedError" to "UNSUPPORTED"
    is OutOfMemoryError -> "QuotaExceededError" to "OUT_OF_MEMORY"
    is StackOverflowError -> "RangeError" to "STACK_OVERFLOW"
    else -> "Error" to "OTHER"
}

/** Up to three stack frames inside `ch.fasrv.fanotes`; nothing else from the trace leaves. */
fun appFrames(error: Throwable): List<DescribedError.Frame> {
    val frames = ArrayList<DescribedError.Frame>(3)
    var current: Throwable? = error
    var depth = 0
    while (current != null && frames.size < 3 && depth < 4) {
        for (element in current.stackTrace) {
            val file = element.className.substringBefore('$')
            if (APP_FRAME.matches(file) && element.lineNumber in 1..9_999_999) {
                frames += DescribedError.Frame(file, element.lineNumber)
                if (frames.size >= 3) break
            }
        }
        current = current.cause.takeIf { it !== current }
        depth += 1
    }
    return frames
}

/** [context] only serves to scrub the text the grouping hash is made of; that text is never kept. */
fun describeError(error: Throwable, context: DiagnosticsContext = DiagnosticsContext()): DescribedError {
    val (errorClass, code) = classAndCode(error)
    val message = scrubText(error.message.orEmpty(), context, 600)
    return DescribedError(errorClass, code, appFrames(error), hashText(normalizeErrorMessage(message)))
}

fun errorGroupKey(entry: DescribedError) = "${entry.errorClass}|${entry.code}|${entry.hash}"

// ---------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------

private fun bucketOf(value: Double, edges: List<Int>): Int {
    if (!value.isFinite() || value < 0) return 0
    var result = 0
    for (edge in edges) if (value >= edge) result = edge
    return result
}

private val NOTE_EDGES = listOf(0, 1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000)
private val MB_EDGES = listOf(0, 1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 50000)
fun noteCountBucket(count: Long) = bucketOf(count.toDouble(), NOTE_EDGES)
fun vaultSizeBucketMb(bytes: Long) = bucketOf(bytes.toDouble() / (1024 * 1024), MB_EDGES)
fun roundMs(ms: Long, step: Long = 100): Long = if (ms >= 0) minOf(600_000L, (ms.toDouble() / step).roundToLong() * step) else 0L

fun newInstallId(random: ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }): String =
    random.joinToString("") { "%02x".format(it.toInt() and 0xff) }

/** Only these (name-checked) counters leave the device. */
fun cleanCounters(counters: Map<String, Int>): Map<String, Int> {
    val out = LinkedHashMap<String, Int>()
    for ((name, count) in counters) {
        if (!COUNTER_NAME.matches(name) || count <= 0) continue
        out[name] = minOf(1_000_000, count)
        if (out.size >= DIAGNOSTICS_MAX_COUNTERS) break
    }
    return out
}

data class DiagnosticsConsent(val usage: Boolean = false, val logs: Boolean = false)
data class DiagnosticsApp(val version: String = "", val platform: String = "android", val arch: String = "", val language: String = "")
data class DiagnosticsUsage(
    val counters: Map<String, Int> = emptyMap(),
    val errors: Map<String, Int> = emptyMap(),
    val startupMs: Long = 0,
    val vaultNotes: Long = 0,
    val vaultBytes: Long = 0,
)
data class LogEntry(val at: Long, val error: DescribedError)

private fun num(value: Number) = jsonNumber(value.toDouble())
private fun obj(vararg pairs: Pair<String, JsonValue?>) = jsonObject(*pairs)

/**
 * The exact JSON that is sent, or null. `usage` and `logs` are only included when the matching
 * consent is given; a manual report always carries logs and never usage. With neither there is
 * no payload at all.
 */
fun buildDiagnosticsPayload(
    consent: DiagnosticsConsent,
    installId: String,
    app: DiagnosticsApp,
    usage: DiagnosticsUsage? = null,
    logs: List<LogEntry> = emptyList(),
    comment: String? = null,
    context: DiagnosticsContext = DiagnosticsContext(),
    nowMs: Long = System.currentTimeMillis(),
    manual: Boolean = false,
): JsonValue.Obj? {
    if (!INSTALL_ID.matches(installId)) return null
    val wantUsage = consent.usage && !manual
    val wantLogs = consent.logs || manual
    val payload = obj(
        "schemaVersion" to num(DIAGNOSTICS_SCHEMA),
        "kind" to jsonString(if (manual) "report" else "daily"),
        "installId" to jsonString(installId),
        "sentAt" to num((nowMs.toDouble() / 1000).roundToLong() * 1000),
        "app" to obj(
            "version" to jsonString(app.version.take(40)),
            "platform" to jsonString(app.platform.take(24)),
            "arch" to jsonString(app.arch.take(16)),
            "language" to jsonString(app.language.take(8)),
        ),
    )
    var hasUsage = false
    var hasLogs = false
    if (wantUsage) {
        val data = usage ?: DiagnosticsUsage()
        val counters = JsonValue.Obj()
        for ((name, count) in cleanCounters(data.counters)) counters.put(name, num(count))
        val errors = JsonValue.Obj()
        data.errors.entries.filter { ERROR_KEY.matches(it.key) && it.value > 0 }.take(40)
            .forEach { errors.put(it.key, num(minOf(1_000_000, it.value))) }
        payload.put(
            "usage",
            obj(
                "counters" to counters,
                "errors" to errors,
                "perf" to obj("startupMs" to num(roundMs(data.startupMs))),
                "vault" to obj("notes" to num(noteCountBucket(data.vaultNotes)), "sizeMb" to num(vaultSizeBucketMb(data.vaultBytes))),
            ),
        )
        hasUsage = true
    }
    if (wantLogs) {
        val entries = logs.takeLast(DIAGNOSTICS_MAX_LOGS).mapNotNull { entry ->
            val error = entry.error
            if (error.errorClass !in ERROR_CLASSES || !ERROR_HASH.matches(error.hash)) return@mapNotNull null
            obj(
                "at" to num((entry.at.toDouble() / 1000).roundToLong() * 1000),
                "class" to jsonString(error.errorClass),
                "code" to jsonString(if (ERROR_CODE.matches(error.code)) error.code else ""),
                "frames" to jsonArray(
                    *error.frames.filter { APP_FRAME.matches(it.file) && it.line > 0 }.take(3)
                        .map { obj("file" to jsonString(it.file), "line" to num(it.line)) }.toTypedArray(),
                ),
                "hash" to jsonString(error.hash),
            )
        }
        payload.put("logs", jsonArray(*entries.toTypedArray()))
        hasLogs = true
    }
    if (manual && !comment.isNullOrBlank()) payload.put("comment", jsonString(scrubText(comment, context, DIAGNOSTICS_MAX_COMMENT)))
    if (!hasUsage && !hasLogs) return null
    return payload
}

fun dailySendDue(consent: DiagnosticsConsent, lastSentAt: Long, nowMs: Long = System.currentTimeMillis()): Boolean =
    (consent.usage || consent.logs) &&
        (lastSentAt <= 0 || nowMs - lastSentAt >= DIAGNOSTICS_INTERVAL_MS || lastSentAt > nowMs + 60_000)

/** `JSON.stringify(value, null, 2)`. */
fun prettyJson(value: JsonValue, indent: String = ""): String = when (value) {
    is JsonValue.Obj -> if (value.fields.isEmpty()) "{}" else {
        val inner = "$indent  "
        value.fields.entries.joinToString(",\n", "{\n", "\n$indent}") { (key, item) ->
            "$inner${jsonString(key).stringify()}: ${prettyJson(item, inner)}"
        }
    }
    is JsonValue.Arr -> if (value.items.isEmpty()) "[]" else {
        val inner = "$indent  "
        value.items.joinToString(",\n", "[\n", "\n$indent]") { "$inner${prettyJson(it, inner)}" }
    }
    else -> value.stringify()
}
