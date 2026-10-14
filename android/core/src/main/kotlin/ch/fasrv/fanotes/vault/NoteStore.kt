package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.FAMD_EXTENSION
import ch.fasrv.fanotes.famd.attachNoteInk
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.famd.noteInkId
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.famd.stripFamdPayload
import ch.fasrv.fanotes.famd.worksheetIdsFromMarkdown
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.newInkDocument
import ch.fasrv.fanotes.ink.parseInkDocument
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.stringify
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.isRegularFile
import kotlin.io.path.name
import kotlin.io.path.relativeTo

interface VaultIo {
    fun read(path: String): ByteArray?
    fun write(path: String, bytes: ByteArray)
    fun delete(path: String)
    fun exists(path: String): Boolean
    fun mtime(path: String): Long
    fun list(directory: String): List<VaultEntry>
    fun walkFiles(): List<VaultEntry>
}

data class VaultEntry(val path: String, val directory: Boolean, val size: Long, val mtimeMs: Long)

enum class NoteKind { MARKDOWN, PDF, FOLDER }

data class VaultNode(
    val name: String,
    val path: String,
    val kind: NoteKind,
    val modifiedAt: Long,
    val children: List<VaultNode> = emptyList(),
)

data class OpenNote(
    val path: String,
    val kind: NoteKind,
    val title: String,
    val markdown: String,
    val document: InkDocument,
    val payload: JsonValue.Obj,
    val worksheets: List<String>,
    val inkId: String,
)

class NoteStore(private val io: VaultIo) {
    fun tree(): List<VaultNode> = buildTree("")

    fun readNote(path: String): OpenNote {
        val normalized = normalize(path)
        val extension = extensionOf(normalized)
        val famdPath = if (extension == FAMD_EXTENSION) normalized else companionPath(normalized, FAMD_EXTENSION)
        val markdownPath = when (extension) {
            ".pdf" -> null
            FAMD_EXTENSION -> companionPath(normalized, ".md").takeIf { io.exists(it) }
            else -> normalized
        }
        val famdBytes = io.read(famdPath)
        val famd = famdBytes?.let { parseFamd(it.decodeToString()) }
        val mdBytes = markdownPath?.let { io.read(it) }
        val markdown = when {
            mdBytes != null -> stripFamdPayload(mdBytes.decodeToString())
            famd != null -> famd.markdown
            else -> ""
        }
        val payload = famd?.payload ?: emptyFamdPayload(isoNow())
        val title = titleOf(normalized)
        val document = parseInkDocument(payload.obj("ink"), title, payload.string("paperStyle") ?: "dots", payload.string("updatedAt") ?: isoNow())
        val inkId = noteInkId(markdown) ?: UUID.randomUUID().toString()
        return OpenNote(
            path = normalized,
            kind = if (extension == ".pdf") NoteKind.PDF else NoteKind.MARKDOWN,
            title = title,
            markdown = markdown,
            document = document,
            payload = payload,
            worksheets = worksheetIdsFromMarkdown(markdown),
            inkId = inkId,
        )
    }

    fun save(note: OpenNote, document: InkDocument, markdown: String, now: String = isoNow()): OpenNote {
        val withMarker = attachNoteInk(markdown, note.inkId)
        val ink = document.copy(title = note.title, updatedAt = now).toJson()
        val payload = (note.payload.deepCopy() as JsonValue.Obj).also { obj ->
            obj.put("schema", jsonString("fanotes-famd-v1"))
            obj.put("updatedAt", jsonString(now))
            obj.put("ink", ink)
            val sheets = worksheetIdsFromMarkdown(withMarker)
            obj.put("worksheets", JsonValue.Arr(sheets.map { jsonString(it) }.toMutableList()))
            obj.put("paperStyle", jsonString(document.paperStyle))
        }
        val famdPath = if (note.path.endsWith(FAMD_EXTENSION)) note.path else companionPath(note.path, FAMD_EXTENSION)
        io.write(famdPath, serializeFamd(withMarker, payload).encodeToByteArray())
        if (note.kind == NoteKind.MARKDOWN && !note.path.endsWith(FAMD_EXTENSION)) {
            val body = stripFamdPayload(withMarker)
            val text = if (body.endsWith("\n") || body.isEmpty()) body else "$body\n"
            io.write(note.path, text.encodeToByteArray())
        }
        writeInkAsset(note.inkId, ink)
        return note.copy(markdown = withMarker, document = document.copy(updatedAt = now), payload = payload, worksheets = worksheetIdsFromMarkdown(withMarker))
    }

    fun createMarkdown(directory: String, title: String, now: String = isoNow()): String {
        val name = safeNoteName(title)
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$name.md" else "$folder/$name.md"
        if (io.exists(path) || io.exists(companionPath(path, FAMD_EXTENSION))) {
            throw IllegalStateException("A note named $name already exists")
        }
        val body = "# $name\n"
        val document = newInkDocument(name, "dots", now)
        val note = OpenNote(path, NoteKind.MARKDOWN, name, body, document, emptyFamdPayload(now), emptyList(), UUID.randomUUID().toString())
        save(note, document, body, now)
        return path
    }

    fun createFolder(directory: String, title: String) {
        val name = safeNoteName(title)
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$name/.keep" else "$folder/$name/.keep"
        io.write(path, ByteArray(0))
    }

    fun importPdf(directory: String, fileName: String, bytes: ByteArray): String {
        val stem = safeNoteName(fileName.substringBeforeLast('.').ifBlank { "Document" })
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$stem.pdf" else "$folder/$stem.pdf"
        if (io.exists(path)) throw IllegalStateException("A note named $stem already exists")
        io.write(path, bytes)
        val now = isoNow()
        val document = newInkDocument(stem, "blank", now)
        val note = OpenNote(path, NoteKind.PDF, stem, "", document, emptyFamdPayload(now), emptyList(), UUID.randomUUID().toString())
        save(note, document, "", now)
        return path
    }

    /**
     * Image worksheet in the desktop layout: bytes under `.fanotes/worksheets`,
     * a JSON record, and a Markdown note that points at it.
     */
    fun importImageWorksheet(directory: String, fileName: String, bytes: ByteArray, mime: String): String {
        val extension = when {
            mime.contains("png") || fileName.endsWith(".png", true) -> ".png"
            mime.contains("webp") || fileName.endsWith(".webp", true) -> ".webp"
            mime.contains("gif") || fileName.endsWith(".gif", true) -> ".gif"
            else -> ".jpg"
        }
        val id = UUID.randomUUID().toString()
        val title = safeNoteName(fileName.substringBeforeLast('.').ifBlank { "Worksheet" })
        val source = ".fanotes/worksheets/$id$extension"
        val data = ".fanotes/worksheets/$id.json"
        io.write(source, bytes)
        val now = isoNow()
        val record = jsonObject(
            "schemaVersion" to jsonNumber(1.0),
            "id" to jsonString(id),
            "title" to jsonString(title),
            "kind" to jsonString("image"),
            "mimeType" to jsonString(mime.ifBlank { "image/jpeg" }),
            "sourceRelativePath" to jsonString(source),
            "dataRelativePath" to jsonString(data),
            "createdAt" to jsonString(now),
            "updatedAt" to jsonString(now),
            "textBoxes" to jsonArray(),
            "highlights" to jsonArray(),
        )
        io.write(data, record.stringify().encodeToByteArray())
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$title.md" else "$folder/$title.md"
        if (io.exists(path)) throw IllegalStateException("A note named $title already exists")
        val body = "# $title\n\n<!-- fanotes-worksheet:$id -->\n"
        val document = newInkDocument(title, "blank", now)
        val note = OpenNote(path, NoteKind.MARKDOWN, title, body, document, emptyFamdPayload(now), listOf(id), UUID.randomUUID().toString())
        save(note, document, body, now)
        return path
    }

    fun rename(path: String, title: String) {
        val name = safeNoteName(title)
        val parent = path.substringBeforeLast('/', "")
        val extension = extensionOf(path).ifBlank { ".md" }
        val next = if (parent.isEmpty()) "$name$extension" else "$parent/$name$extension"
        if (next == path) return
        if (io.exists(next)) throw IllegalStateException("That name is already used")
        moveTree(path, next)
        val companionExt = if (extension == FAMD_EXTENSION) ".md" else FAMD_EXTENSION
        val companion = companionPath(path, companionExt)
        if (io.exists(companion)) moveTree(companion, companionPath(next, companionExt))
        if (extension == ".pdf") {
            val md = companionPath(path, ".md")
            if (io.exists(md)) moveTree(md, companionPath(next, ".md"))
        }
    }

    fun delete(path: String) {
        io.delete(path)
        val extension = extensionOf(path)
        val companions = buildList {
            if (extension != FAMD_EXTENSION) add(companionPath(path, FAMD_EXTENSION))
            if (extension != ".md") add(companionPath(path, ".md"))
            if (extension == ".pdf") add(companionPath(path, ".famd"))
        }
        for (companion in companions.distinct()) if (io.exists(companion)) io.delete(companion)
    }

    private fun writeInkAsset(id: String, ink: JsonValue.Obj) {
        io.write(".fanotes/assets/$id.json", ink.stringify().encodeToByteArray())
    }

    private fun buildTree(directory: String): List<VaultNode> {
        return io.list(directory)
            .filter { !it.path.substringAfterLast('/').startsWith(".") }
            .mapNotNull { entry ->
                val name = entry.path.substringAfterLast('/')
                if (entry.directory) {
                    VaultNode(name, entry.path, NoteKind.FOLDER, entry.mtimeMs, buildTree(entry.path))
                } else {
                    val extension = extensionOf(name)
                    when (extension) {
                        ".md", ".markdown" -> VaultNode(titleOf(name), entry.path, NoteKind.MARKDOWN, entry.mtimeMs)
                        ".pdf" -> VaultNode(titleOf(name), entry.path, NoteKind.PDF, entry.mtimeMs)
                        FAMD_EXTENSION -> {
                            val md = companionPath(entry.path, ".md")
                            val markdown = companionPath(entry.path, ".markdown")
                            if (io.exists(md) || io.exists(markdown)) null
                            else VaultNode(titleOf(name), entry.path, NoteKind.MARKDOWN, entry.mtimeMs)
                        }
                        else -> null
                    }
                }
            }
            .sortedWith(compareBy<VaultNode> { it.kind != NoteKind.FOLDER }.thenBy { it.name.lowercase() })
    }

    private fun moveTree(from: String, to: String) {
        val bytes = io.read(from) ?: return
        io.write(to, bytes)
        io.delete(from)
    }

}

private fun jsonObject(vararg pairs: Pair<String, JsonValue>) = JsonValue.Obj().also { obj ->
    for ((key, value) in pairs) obj.fields[key] = value
}

fun safeNoteName(raw: String): String {
    val cleaned = raw.replace(Regex("""[\\/:*?"<>|\u0000-\u001F]"""), " ").replace(Regex("""\s+"""), " ").trim().trim('.')
    return cleaned.take(120).ifBlank { "Note" }
}

fun extensionOf(path: String): String {
    val name = path.substringAfterLast('/')
    val dot = name.lastIndexOf('.')
    return if (dot <= 0) "" else name.substring(dot).lowercase()
}

fun titleOf(path: String): String = path.substringAfterLast('/').replace(Regex("""\.(md|markdown|famd|pdf)$""", RegexOption.IGNORE_CASE), "")

fun normalize(path: String): String {
    val cleaned = path.replace('\\', '/').trim().trim('/')
    if (cleaned.isEmpty() || cleaned.length > 1024 || cleaned.contains('\u0000') || cleaned.contains("//")) {
        throw IllegalArgumentException("Invalid vault path")
    }
    if (cleaned.split('/').any { it.isEmpty() || it == "." || it == ".." }) throw IllegalArgumentException("Invalid vault path")
    return cleaned
}

/** Real directory vault. Writes are temp-file plus move, and `*.tmp` is skipped by sync. */
class DirectoryVault(val root: Path) : VaultIo {
    override fun read(path: String): ByteArray? {
        val target = resolve(path)
        if (!Files.isRegularFile(target)) return null
        return Files.readAllBytes(target)
    }

    override fun write(path: String, bytes: ByteArray) {
        val target = resolve(path)
        Files.createDirectories(target.parent)
        val temp = target.resolveSibling(target.fileName.toString() + ".${UUID.randomUUID()}.tmp")
        Files.write(temp, bytes)
        try {
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    override fun delete(path: String) {
        val target = resolve(path)
        if (Files.isDirectory(target)) {
            Files.walk(target).sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
        } else {
            Files.deleteIfExists(target)
        }
    }

    override fun exists(path: String) = Files.exists(resolve(path))

    override fun mtime(path: String): Long {
        val target = resolve(path)
        return if (Files.exists(target)) Files.getLastModifiedTime(target).toMillis() else 0L
    }

    override fun list(directory: String): List<VaultEntry> {
        val dir = if (directory.isBlank()) root else resolve(directory)
        if (!Files.isDirectory(dir)) return emptyList()
        return Files.list(dir).use { stream ->
            stream.map { child ->
                val relative = child.relativeTo(root).toString().replace('\\', '/')
                VaultEntry(relative, Files.isDirectory(child), if (Files.isRegularFile(child)) Files.size(child) else 0L, Files.getLastModifiedTime(child).toMillis())
            }.toList()
        }
    }

    override fun walkFiles(): List<VaultEntry> {
        if (!Files.exists(root)) return emptyList()
        return Files.walk(root).use { stream ->
            stream.filter { Files.isRegularFile(it) }.map { file ->
                val relative = file.relativeTo(root).toString().replace('\\', '/')
                VaultEntry(relative, false, Files.size(file), Files.getLastModifiedTime(file).toMillis())
            }.toList()
        }
    }

    private fun resolve(path: String): Path {
        val normal = normalize(path)
        val target = root.resolve(normal).normalize()
        if (!target.startsWith(root)) throw IllegalArgumentException("Path escapes the vault")
        return target
    }
}
