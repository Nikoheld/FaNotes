package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.Instant

/** File-backed ring of the last Schulnetz steps. Secrets are redacted before they hit disk. */
class SchulnetzLog(directory: File) {
    private val dir = directory.apply { mkdirs() }
    private val file = File(dir, "schulnetz.log")
    private val captures = File(dir, "captures").apply { mkdirs() }
    private val lock = Any()

    fun info(message: String) {
        append(redactSchulnetzSecrets(message).replace("\r", " ").replace("\n", "\\n"))
    }

    fun error(error: Throwable) {
        val writer = StringWriter()
        error.printStackTrace(PrintWriter(writer))
        append(redactSchulnetzSecrets(writer.toString()).replace("\r\n", "\n"))
    }

    fun rememberPage(name: String, finalUrl: String, html: String) {
        if (html.isBlank()) return
        val safeName = name.lowercase().replace(Regex("[^a-z0-9_-]"), "").ifBlank { "page" }.take(24)
        val body = "<!-- ${redactSchulnetzSecrets(finalUrl)} -->\n" + redactSchulnetzSecrets(html).take(200_000)
        synchronized(lock) {
            File(captures, "$safeName.html").writeText(body)
            val files = captures.listFiles()?.sortedBy { it.lastModified() }.orEmpty()
            if (files.size > 4) files.dropLast(4).forEach { it.delete() }
        }
    }

    fun text(): String = synchronized(lock) { if (file.isFile) file.readText() else "" }

    fun captureFiles(): List<File> = synchronized(lock) {
        captures.listFiles()?.filter { it.isFile }?.sortedBy { it.lastModified() }.orEmpty()
    }

    private fun append(message: String) {
        val stamp = Instant.now().toString()
        synchronized(lock) {
            file.appendText("$stamp $message\n")
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
