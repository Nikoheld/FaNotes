package ch.fasrv.fanotes.desk

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream
import kotlin.io.path.absolutePathString
import kotlin.io.path.deleteIfExists
import kotlin.io.path.name

/**
 * Binary OneNote packages go through hash-checked `one2html` and `7za`.
 * The desktop host runs the pinned linux tools. Android runs the pinned
 * arm64 bionic tools from the app's native library directory. A section
 * that cannot be converted reports that failure. It does not pretend the
 * package had no pages.
 */

internal const val ONE2HTML_SHA256 = "140c347e192d8bed8225f01a4c736e04c19bed241589d46cdc8b241b906eadb0"
internal const val SEVENZIP_SHA256 = "afc9448bd0cc2eeda131cce313ef4994f9656417e0a15c8465fcda9ca859b280"
internal const val ONE2HTML_ANDROID_ARM64_SHA256 =
    "d344f8c3306c6f088bd8e7a2499a683f4fc6d68153d444f809912884791be888"
internal const val SEVENZIP_ANDROID_ARM64_SHA256 =
    "a942b7ee30fe4ae9ae6f01ce14c3fd0a04e279a580a2a22c24bffd6f9ca1a0ad"

private val ONE2HTML_HASHES = setOf(ONE2HTML_SHA256, ONE2HTML_ANDROID_ARM64_SHA256)
private val SEVENZIP_HASHES = setOf(SEVENZIP_SHA256, SEVENZIP_ANDROID_ARM64_SHA256)

private const val ONE_NOTE_NO_PAGES =
    "Im OneNote-Export wurden keine lesbaren Seiten gefunden. Verwende einen aktuellen OneDrive-Export oder eine moderne .one-Datei."
private const val ONE_NOTE_NO_NOTEBOOK = "Im Archiv wurde kein OneNote-Notizbuch gefunden."
private const val ONE_NOTE_UNSUPPORTED = "Der OneNote-Import wird auf dieser Plattform noch nicht unterstützt."

private val ONE_NOTE_MAGIC = byteArrayOf(
    0xe4.toByte(), 0x52, 0x5c, 0x7b,
    0x8c.toByte(), 0xd8.toByte(), 0xa7.toByte(), 0x4d,
    0xae.toByte(), 0xb1.toByte(), 0x53, 0x78,
    0xd0.toByte(), 0x29, 0x96.toByte(), 0xd3.toByte(),
)
private val SEVEN_Z_MAGIC = byteArrayOf(0x37, 0x7a, 0xbc.toByte(), 0xaf.toByte(), 0x27, 0x1c)

internal data class OneNoteRead(val notes: List<DeskNote>, val message: String?)

private class OneNoteFailure(message: String) : Exception(message)

private enum class OneNoteKind { Html, Section, Toc, Archive, Unknown }

internal fun isOneNoteBinary(bytes: ByteArray): Boolean = startsWith(bytes, ONE_NOTE_MAGIC)

internal fun readOneNotePages(
    bytes: ByteArray,
    name: String?,
    one2htmlPath: String?,
    sevenZipPath: String?,
    folder: String,
    taken: Set<String>,
): OneNoteRead {
    return try {
        when (classifyOneNote(bytes, name)) {
            OneNoteKind.Html -> {
                val notes = oneNoteNotes(bytes, folder, taken)
                if (notes.isEmpty()) OneNoteRead(emptyList(), ONE_NOTE_EMPTY) else OneNoteRead(notes, null)
            }
            OneNoteKind.Section -> convertSection(bytes, name, toc = false, one2htmlPath, sevenZipPath, folder, taken)
            OneNoteKind.Toc -> convertSection(bytes, name, toc = true, one2htmlPath, sevenZipPath, folder, taken)
            OneNoteKind.Archive -> convertArchive(bytes, name, one2htmlPath, sevenZipPath, folder, taken)
            OneNoteKind.Unknown -> OneNoteRead(emptyList(), ONE_NOTE_EMPTY)
        }
    } catch (error: OneNoteFailure) {
        OneNoteRead(emptyList(), error.message)
    }
}

private fun classifyOneNote(bytes: ByteArray, name: String?): OneNoteKind {
    val ext = extensionOf(name)
    if (isOneNoteBinary(bytes)) return if (ext == ".onetoc2") OneNoteKind.Toc else OneNoteKind.Section
    if (startsWith(bytes, SEVEN_Z_MAGIC)) return OneNoteKind.Archive
    if (isZip(bytes)) {
        val entries = zipEntryNames(bytes)
        val hasHtml = entries.orEmpty().any { it.endsWith(".html", true) || it.endsWith(".htm", true) }
        val hasSection = entries.orEmpty().any { it.endsWith(".one", true) || it.endsWith(".onetoc2", true) || it.endsWith(".onepkg", true) }
        if (entries != null && hasHtml && !hasSection) return OneNoteKind.Html
        if (hasSection || ext == ".zip" || ext == ".onepkg" || entries == null && (ext == ".zip" || ext == ".onepkg")) {
            return OneNoteKind.Archive
        }
        return OneNoteKind.Unknown
    }
    if (ext == ".html" || ext == ".htm") return OneNoteKind.Html
    if (ext == ".one") return OneNoteKind.Section
    if (ext == ".onetoc2") return OneNoteKind.Toc
    if (ext == ".zip" || ext == ".onepkg") return OneNoteKind.Archive
    val text = runCatching { bytes.toString(Charsets.UTF_8) }.getOrNull().orEmpty()
    if (text.contains('<')) return OneNoteKind.Html
    return OneNoteKind.Unknown
}

private fun convertSection(
    bytes: ByteArray,
    name: String?,
    toc: Boolean,
    one2htmlPath: String?,
    sevenZipPath: String?,
    folder: String,
    taken: Set<String>,
): OneNoteRead = withTemp { dir ->
    val (one2html, _) = prepareTools(one2htmlPath, sevenZipPath, dir)
    val fileName = sectionFileName(name, toc)
    val input = dir.resolve(fileName)
    Files.write(input, bytes)
    val rendered = dir.resolve("rendered")
    Files.createDirectory(rendered)
    try {
        runTool(one2html, listOf("--input", input.absolutePathString(), "--output", rendered.absolutePathString()), "OneNote-Abschnitt $fileName")
    } catch (error: OneNoteFailure) {
        if (!toc) throw error
        val siblings = filesWithExtension(input.parent ?: dir, ".one").filter { it != input }
        if (siblings.isEmpty()) throw error
        rendered.toFile().deleteRecursively()
        Files.createDirectory(rendered)
        renderSections(siblings, one2html, rendered)
    }
    finishRendered(rendered, bytes, folder, taken)
}

private fun convertArchive(
    bytes: ByteArray,
    name: String?,
    one2htmlPath: String?,
    sevenZipPath: String?,
    folder: String,
    taken: Set<String>,
): OneNoteRead = withTemp { dir ->
    val (one2html, sevenZip) = prepareTools(one2htmlPath, sevenZipPath, dir)
    val fileName = inputFileName(name, if (startsWith(bytes, SEVEN_Z_MAGIC)) "notebook.7z" else "notebook.zip")
    val input = dir.resolve(fileName)
    Files.write(input, bytes)
    val extracted = dir.resolve("extracted")
    Files.createDirectory(extracted)
    val listing = runTool(sevenZip, listOf("l", "-slt", "--", input.absolutePathString()), "Archivprüfung")
    assertListingSafe(listing)
    runTool(
        sevenZip,
        listOf("x", "-y", "-bd", "-bb0", "-o${extracted.absolutePathString()}", "--", input.absolutePathString()),
        "Archivextraktion",
    )
    val rendered = dir.resolve("rendered")
    Files.createDirectory(rendered)
    val tocs = filesWithExtension(extracted, ".onetoc2").sortedBy { it.nameCount }
    if (tocs.isNotEmpty()) {
        val toc = tocs.first()
        try {
            runTool(one2html, listOf("--input", toc.absolutePathString(), "--output", rendered.absolutePathString()), "OneNote-Konvertierung")
        } catch (error: OneNoteFailure) {
            val sections = filesWithExtension(toc.parent ?: extracted, ".one")
            if (sections.isEmpty()) throw error
            rendered.toFile().deleteRecursively()
            Files.createDirectory(rendered)
            renderSections(sections, one2html, rendered)
        }
    } else {
        val sections = filesWithExtension(extracted, ".one")
        if (sections.isEmpty()) throw OneNoteFailure(ONE_NOTE_NO_NOTEBOOK)
        renderSections(sections, one2html, rendered)
    }
    finishRendered(rendered, bytes, folder, taken)
}

private fun renderSections(sections: List<Path>, one2html: Path, rendered: Path) {
    sections.forEachIndexed { index, section ->
        val dest = rendered.resolve("section-$index")
        Files.createDirectories(dest)
        runTool(
            one2html,
            listOf("--input", section.absolutePathString(), "--output", dest.absolutePathString()),
            "OneNote-Abschnitt ${section.name}",
        )
    }
}

private fun finishRendered(rendered: Path, source: ByteArray, folder: String, taken: Set<String>): OneNoteRead {
    val pages = contentPages(rendered)
    if (pages.isEmpty()) return OneNoteRead(emptyList(), ONE_NOTE_NO_PAGES)
    return OneNoteRead(notesFromPages(pages, folder, taken, source), null)
}

private fun contentPages(root: Path): List<HtmlPage> {
    val pages = ArrayList<HtmlPage>()
    for (path in htmlFiles(root)) {
        val size = Files.size(path)
        if (size <= 0L) continue
        if (size > 128L * 1024 * 1024) throw OneNoteFailure("Eine OneNote-Seite ist leer oder zu groß.")
        val text = Files.readString(path)
        if (text.isBlank() || previewIsNav(text)) continue
        pages += HtmlPage(htmlTitle(text, path.name), text)
    }
    return pages
}

private fun htmlFiles(root: Path): List<Path> {
    if (!Files.isDirectory(root)) return emptyList()
    return Files.walk(root).use { stream ->
        stream.filter { path ->
            val name = path.name.lowercase()
            Files.isRegularFile(path) && !Files.isSymbolicLink(path) && (name.endsWith(".html") || name.endsWith(".htm"))
        }.sorted().toList()
    }
}

private fun assertListingSafe(listing: String) {
    val text = listing.replace("\r\n", "\n")
    for (record in text.split("\n\n")) {
        val fields = HashMap<String, String>()
        for (line in record.lineSequence()) {
            val split = line.split(" = ", limit = 2)
            if (split.size == 2) fields[split[0]] = split[1]
        }
        val entry = fields["Path"]?.trim()?.takeIf { it.isNotEmpty() } ?: continue
        // The archive itself is the record whose Type is zip, 7z, or onepkg.
        if (!fields["Type"].isNullOrEmpty()) continue
        val value = entry.replace('\\', '/')
        if (value.startsWith("/") || value.startsWith("../") || "/../" in value || value == "..") {
            throw OneNoteFailure("Das OneNote-Archiv enthält einen unsicheren Pfad.")
        }
    }
}

private fun previewIsNav(html: String): Boolean =
    Regex("(?i)<nav\\b").containsMatchIn(html) || Regex("(?i)<iframe\\b").containsMatchIn(html)

private fun prepareTools(one2htmlPath: String?, sevenZipPath: String?, dir: Path): Pair<Path, Path> {
    val located = locateOneNoteTools(one2htmlPath, sevenZipPath) ?: throw OneNoteFailure(ONE_NOTE_UNSUPPORTED)
    val one2html = executableCopy(verifyTool(located.first, ONE2HTML_HASHES, "one2html"), dir, "one2html")
    val sevenZip = executableCopy(verifyTool(located.second, SEVENZIP_HASHES, "7za"), dir, "7za")
    return one2html to sevenZip
}

private fun locateOneNoteTools(one2htmlPath: String?, sevenZipPath: String?): Pair<Path, Path>? {
    if (!one2htmlPath.isNullOrBlank() || !sevenZipPath.isNullOrBlank()) {
        if (one2htmlPath.isNullOrBlank() || sevenZipPath.isNullOrBlank()) return null
        return Path.of(one2htmlPath) to Path.of(sevenZipPath)
    }
    val roots = ArrayList<Path>()
    val env = System.getenv("FANOTES_ONENOTE_DIR")
    if (!env.isNullOrBlank()) roots.add(Path.of(env))
    var dir = Path.of(System.getProperty("user.dir") ?: ".").toAbsolutePath().normalize()
    repeat(6) {
        roots.add(dir.resolve("fanotes/resources/onenote"))
        roots.add(dir.resolve("resources/onenote"))
        dir = dir.parent ?: return@repeat
    }
    val found = roots.asSequence().map { it.normalize() }.mapNotNull { toolDir(it) }.firstOrNull() ?: return null
    return found.resolve("one2html") to found.resolve("7za")
}

private fun toolDir(root: Path): Path? {
    val linux = root.resolve("linux")
    if (Files.isRegularFile(linux.resolve("one2html")) && Files.isRegularFile(linux.resolve("7za"))) return linux
    if (Files.isRegularFile(root.resolve("one2html")) && Files.isRegularFile(root.resolve("7za"))) return root
    return null
}

private fun verifyTool(path: Path, expected: Set<String>, label: String): Path {
    if (!Files.isRegularFile(path)) throw OneNoteFailure("Die eingebettete OneNote-Komponente $label ist beschädigt.")
    val actual = sha256File(path)
    if (expected.none { it.equals(actual, ignoreCase = true) }) {
        throw OneNoteFailure("Die eingebettete OneNote-Komponente $label ist beschädigt.")
    }
    return path
}

private fun executableCopy(source: Path, dir: Path, label: String): Path {
    if (Files.isExecutable(source)) return source
    val copy = dir.resolve(label)
    Files.copy(source, copy)
    val file = copy.toFile()
    file.setReadable(true, true)
    file.setExecutable(true, true)
    return copy
}

private fun runTool(tool: Path, args: List<String>, label: String): String {
    val out = Files.createTempFile("fanotes-tool-out-", ".log")
    val err = Files.createTempFile("fanotes-tool-err-", ".log")
    var process: Process? = null
    try {
        val builder = ProcessBuilder(listOf(tool.absolutePathString()) + args)
            .redirectOutput(out.toFile())
            .redirectError(err.toFile())
        val sink = File("/dev/null")
        if (sink.isFile) builder.redirectInput(ProcessBuilder.Redirect.from(sink))
        process = try {
            builder.start()
        } catch (error: IOException) {
            throw OneNoteFailure("$label ist fehlgeschlagen: ${error.message ?: error.javaClass.simpleName}")
        }
        val finished = try {
            process.waitFor(12, TimeUnit.MINUTES)
        } catch (error: InterruptedException) {
            process.destroyForcibly()
            Thread.currentThread().interrupt()
            throw OneNoteFailure("$label ist fehlgeschlagen: ${error.message ?: "unterbrochen"}")
        }
        if (!finished) {
            process.destroyForcibly()
            throw OneNoteFailure("Der OneNote-Import hat das sichere Zeitlimit überschritten.")
        }
        if (process.exitValue() != 0) {
            val stderr = readTail(err).trim()
            val stdout = readTail(out).trim()
            val chosen = stderr.ifBlank { stdout }.ifBlank { "Code ${process.exitValue()}" }.take(1800)
            throw OneNoteFailure("$label ist fehlgeschlagen: $chosen")
        }
        return readTail(out)
    } finally {
        if (process?.isAlive == true) process.destroyForcibly()
        out.deleteIfExists()
        err.deleteIfExists()
    }
}

private fun readTail(path: Path): String {
    if (!Files.isRegularFile(path)) return ""
    val text = Files.readString(path)
    return if (text.length <= 256 * 1024) text else text.takeLast(256 * 1024)
}

private fun <T> withTemp(block: (Path) -> T): T {
    val dir = Files.createTempDirectory("fanotes-onenote-")
    try {
        return block(dir)
    } finally {
        dir.toFile().deleteRecursively()
    }
}

private fun filesWithExtension(root: Path, extension: String): List<Path> {
    if (!Files.isDirectory(root)) return emptyList()
    val suffix = if (extension.startsWith('.')) extension else ".$extension"
    return Files.walk(root).use { stream ->
        stream.filter { path ->
            Files.isRegularFile(path) && !Files.isSymbolicLink(path) && path.name.endsWith(suffix, ignoreCase = true)
        }.sorted().toList()
    }
}

private fun sectionFileName(name: String?, toc: Boolean): String {
    val fallback = if (toc) "Open Notebook.onetoc2" else "Abschnitt.one"
    val cleaned = inputFileName(name, fallback)
    return when {
        toc && !cleaned.endsWith(".onetoc2", true) -> "$cleaned.onetoc2"
        !toc && !cleaned.endsWith(".one", true) -> "$cleaned.one"
        else -> cleaned
    }
}

private fun inputFileName(name: String?, fallback: String): String {
    val leaf = name?.replace('\\', '/')?.substringAfterLast('/')?.trim().orEmpty()
        .replace(Regex("""[\u0000-\u001f]"""), "")
    if (leaf.isBlank() || leaf == "." || leaf == ".." || leaf.contains('/')) return fallback
    return leaf.take(180)
}

private fun extensionOf(name: String?): String {
    val leaf = name?.replace('\\', '/')?.substringAfterLast('/').orEmpty()
    val dot = leaf.lastIndexOf('.')
    if (dot <= 0) return ""
    return leaf.substring(dot).lowercase()
}

private fun isZip(bytes: ByteArray): Boolean =
    bytes.size >= 2 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4b.toByte()

private fun startsWith(bytes: ByteArray, magic: ByteArray): Boolean {
    if (bytes.size < magic.size) return false
    return magic.indices.all { bytes[it] == magic[it] }
}

private fun zipEntryNames(bytes: ByteArray): List<String>? {
    return try {
        val names = ArrayList<String>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                names += entry.name.replace('\\', '/')
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
        names
    } catch (_: Exception) {
        null
    }
}

private fun sha256File(path: Path): String {
    val digest = MessageDigest.getInstance("SHA-256")
    Files.newInputStream(path).use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}
