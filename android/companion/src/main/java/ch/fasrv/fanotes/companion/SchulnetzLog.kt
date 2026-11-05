package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.formatCrashRecord
import ch.fasrv.fanotes.schulnetz.redactDiagnostic
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.util.concurrent.Executors

/** File-backed ring of the last Schulnetz steps. Secrets are redacted before they hit disk. */
class SchulnetzLog(directory: File) {
    private val dir = directory.apply { mkdirs() }
    private val file = File(dir, "schulnetz.log")
    private val captures = File(dir, "captures").apply { mkdirs() }
    private val lock = Any()
    private val io = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "schulnetz-log").apply { isDaemon = true }
    }

    fun info(message: String) {
        write(redactDiagnostic(message), durable(message))
    }

    fun error(error: Throwable) {
        val frames = error.stackTrace.take(24).joinToString(" | ") {
            ch.fasrv.fanotes.schulnetz.safeFrame("${it.className}.${it.methodName}:${it.lineNumber}")
        }
        write("exception=${ch.fasrv.fanotes.schulnetz.safeLogToken(error.javaClass.name)} frames=$frames", durable = true)
    }

    /** Crash record. Flushed to disk before the process is allowed to die. The message text is omitted. */
    fun crash(version: String, versionCode: Int, thread: String, error: Throwable, context: String) {
        val frames = error.stackTrace.take(24).map { "${it.className}.${it.methodName}:${it.lineNumber}" }
        val line = formatCrashRecord(
            Instant.now().toString(),
            version,
            versionCode,
            thread,
            error.javaClass.name,
            frames,
            context,
        )
        write(line, durable = true)
    }

    private fun durable(message: String): Boolean =
        message.contains("CRASH") || message.contains("stundenplan") || message.contains("load begin") ||
            message.contains("load end") || message.contains("load timeout") || message.contains("previous run") ||
            message.contains("render process")

    private fun write(line: String, durable: Boolean) {
        val flat = line.replace("\r", " ").replace("\n", "\\n")
        if (!durable && android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) io.execute { append(flat, false) }
        else append(flat, durable)
    }

    fun rememberPage(name: String, finalUrl: String, html: String) {
        if (html.isBlank()) return
        val safeName = name.lowercase().replace(Regex("[^a-z0-9_-]"), "").ifBlank { "page" }.take(24)
        val body = "<!-- ${redactSchulnetzSecrets(finalUrl)} -->\n" + redactSchulnetzSecrets(html).take(2_000_000)
        io.execute {
            synchronized(lock) {
                val nowMs = System.currentTimeMillis()
                captures.listFiles()?.forEach { file ->
                    if (file.isFile && captureExpired(file.lastModified(), nowMs)) file.delete()
                }
                File(captures, "$safeName.html").writeText(body)
            }
        }
    }

    fun text(): String = synchronized(lock) { if (file.isFile) file.readText() else "" }

    fun captureFiles(): List<File> = synchronized(lock) {
        captures.listFiles()?.filter { it.isFile }?.sortedBy { it.lastModified() }.orEmpty()
    }

    private fun append(message: String, durable: Boolean) {
        val stamp = Instant.now().toString()
        val line = "$stamp $message\n"
        synchronized(lock) {
            if (durable) {
                FileOutputStream(file, true).use { out ->
                    out.write(line.toByteArray())
                    out.flush()
                    out.fd.sync()
                }
            } else {
                file.appendText(line)
            }
            if (file.length() > MAX_BYTES) trim()
        }
    }

    private fun trim() {
        val lines = file.readLines()
        if (lines.size <= MAX_LINES && file.length() <= MAX_BYTES) return
        val kept = lines.takeLast(MAX_LINES.coerceAtMost(1500))
        file.writeText(kept.joinToString("\n").let { if (it.isEmpty()) it else "$it\n" })
    }

    companion object {
        private const val MAX_BYTES = 1_500_000
        private const val MAX_LINES = 2000
    }
}

internal const val CAPTURE_MAX_AGE_MS = 24L * 60L * 60L * 1000L

internal fun captureExpired(modifiedAt: Long, now: Long, maxAgeMs: Long = CAPTURE_MAX_AGE_MS): Boolean =
    modifiedAt > 0L && now - modifiedAt > maxAgeMs
