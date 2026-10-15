package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.FAMD_EXTENSION
import ch.fasrv.fanotes.famd.attachNoteInk
import ch.fasrv.fanotes.famd.safeWorksheetSource
import ch.fasrv.fanotes.famd.worksheetRecordPath
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.famd.noteInkId
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.famd.stripFamdPayload
import ch.fasrv.fanotes.famd.worksheetIdsFromMarkdown
import ch.fasrv.fanotes.desk.mergePageStats
import ch.fasrv.fanotes.desk.parsePageStats
import ch.fasrv.fanotes.desk.recordPageSaved
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.newInkDocument
import ch.fasrv.fanotes.ink.parseInkDocument
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
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
    fun move(from: String, to: String)
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
            val nowMs = runCatching { java.time.Instant.parse(now).toEpochMilli() }.getOrElse { System.currentTimeMillis() }
            val stats = recordPageSaved(
                parsePageStats(note.payload.obj("pageStats"), nowMs),
                stripFamdPayload(withMarker),
                document.strokes,
                document.sourceWidth,
                document.sourceHeight,
                nowMs,
            )
            obj.put("pageStats", mergePageStats(note.payload.obj("pageStats"), stats))
        }
        val famdPath = if (note.path.endsWith(FAMD_EXTENSION)) note.path else companionPath(note.path, FAMD_EXTENSION)
        val historyPath = if (note.kind == NoteKind.PDF || note.path.endsWith(FAMD_EXTENSION)) famdPath else note.path
        val previous = io.read(historyPath)?.decodeToString()
        if (previous != null) {
            runCatching { recordNoteHistory(io, historyPath, previous) }
        }
        io.write(famdPath, serializeFamd(withMarker, payload).encodeToByteArray())
        if (note.kind == NoteKind.MARKDOWN && !note.path.endsWith(FAMD_EXTENSION)) {
            val body = stripFamdPayload(withMarker)
            val text = if (body.endsWith("\n") || body.isEmpty()) body else "$body\n"
            io.write(note.path, text.encodeToByteArray())
        }
        writeInkAsset(note.inkId, ink)
        return note.copy(markdown = withMarker, document = document.copy(updatedAt = now), payload = payload, worksheets = worksheetIdsFromMarkdown(withMarker))
    }

    fun createMarkdown(directory: String, title: String, now: String = isoNow(), paper: String = "dots"): String {
        val name = safeNoteName(title)
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$name.md" else "$folder/$name.md"
        if (io.exists(path) || io.exists(companionPath(path, FAMD_EXTENSION))) {
            throw IllegalStateException("A note named $name already exists")
        }
        val body = "# $name\n"
        val document = newInkDocument(name, paper, now)
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
    data class StoredWorksheet(val id: String, val title: String)

    /** Writes image or PDF bytes and the desktop worksheet JSON. It does not create a note. */
    fun storeWorksheet(fileName: String, bytes: ByteArray, mime: String = ""): StoredWorksheet {
        val error = worksheetImportError(fileName, mime, bytes)
        if (error != null) throw IllegalArgumentException(error)
        val format = worksheetFileFormat(fileName, mime) ?: throw IllegalArgumentException(WORKSHEET_FORMAT_UNSUPPORTED)
        val id = UUID.randomUUID().toString()
        val base = fileName.substringAfterLast('/').substringAfterLast('\\')
        val title = safeNoteName(base.substringBeforeLast('.').ifBlank { "Arbeitsblatt" })
        val source = ".fanotes/worksheets/$id${format.extension}"
        val data = ".fanotes/worksheets/$id.json"
        io.write(source, bytes)
        val now = isoNow()
        val record = jsonObject(
            "schemaVersion" to jsonNumber(1.0),
            "id" to jsonString(id),
            "title" to jsonString(title),
            "kind" to jsonString(format.kind),
            "mimeType" to jsonString(format.mime),
            "sourceRelativePath" to jsonString(source),
            "dataRelativePath" to jsonString(data),
            "createdAt" to jsonString(now),
            "updatedAt" to jsonString(now),
            "textBoxes" to jsonArray(),
            "highlights" to jsonArray(),
        )
        io.write(data, record.stringify().encodeToByteArray())
        return StoredWorksheet(id, title)
    }

    fun storeImageWorksheet(fileName: String, bytes: ByteArray, mime: String): StoredWorksheet =
        storeWorksheet(fileName, bytes, mime)

    /** Deletes the worksheet JSON and its image or PDF, and nothing else in the vault. */
    fun deleteWorksheet(id: String) {
        val record = worksheetRecordPath(id) ?: return
        val raw = io.read(record)?.decodeToString()
        val source = raw?.let {
            runCatching { (parseJson(it) as? JsonValue.Obj)?.string("sourceRelativePath") }.getOrNull()
        }
        safeWorksheetSource(id, source)?.let { path -> if (io.exists(path)) io.delete(path) }
        if (io.exists(record)) io.delete(record)
    }

    fun importWorksheetNote(directory: String, fileName: String, bytes: ByteArray, mime: String = "", paper: String = "dots"): String {
        val stored = storeWorksheet(fileName, bytes, mime)
        val id = stored.id
        val title = stored.title
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$title.md" else "$folder/$title.md"
        if (io.exists(path)) throw IllegalStateException("A note named $title already exists")
        val now = isoNow()
        val body = "# $title\n\n<!-- fanotes-worksheet:$id -->\n"
        val document = newInkDocument(title, paper, now)
        val note = OpenNote(path, NoteKind.MARKDOWN, title, body, document, emptyFamdPayload(now), listOf(id), UUID.randomUUID().toString())
        save(note, document, body, now)
        return path
    }

    fun importImageWorksheet(directory: String, fileName: String, bytes: ByteArray, mime: String): String =
        importWorksheetNote(directory, fileName, bytes, mime, "blank")

    fun rename(path: String, title: String): String {
        val parent = path.substringBeforeLast('/', "")
        val folder = io.list(parent).any { it.directory && it.path.trim('/') == path.trim('/') }
        val next = renamedVaultPath(path, title, folder)
        if (next == path) return path
        if (io.exists(next)) throw IllegalArgumentException("An diesem Ort existiert bereits ein Eintrag mit diesem Namen.")
        io.move(path, next)
        if (!folder) moveCompanions(path, next)
        return next
    }

    fun moveEntry(path: String, destFolder: String): String {
        val dest = destFolder.trim('/').replace('\\', '/')
        if (dest.isNotEmpty() && !isDirectory(dest)) {
            throw IllegalArgumentException("Der Zielordner wurde nicht gefunden.")
        }
        val folder = isDirectory(path)
        val next = movedVaultPath(path, dest) { io.exists(it) }
        if (next == path) return path
        io.move(path, next)
        if (!folder) moveCompanions(path, next)
        return next
    }

    private fun isDirectory(path: String): Boolean {
        if (path.isBlank()) return true
        val parent = path.substringBeforeLast('/', "")
        return io.list(parent).any { it.directory && it.path.trim('/') == path.trim('/') }
    }

    private fun moveCompanions(path: String, next: String) {
        val extension = extensionOf(path).ifBlank { ".md" }
        val companionExt = if (extension == FAMD_EXTENSION) ".md" else FAMD_EXTENSION
        val companion = companionPath(path, companionExt)
        if (io.exists(companion)) io.move(companion, companionPath(next, companionExt))
        if (extension == ".pdf") {
            val md = companionPath(path, ".md")
            if (io.exists(md)) io.move(md, companionPath(next, ".md"))
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
            .sortedWith { left, right ->
                ch.fasrv.fanotes.desk.compareVaultEntries(
                    left.kind == NoteKind.FOLDER,
                    left.name,
                    right.kind == NoteKind.FOLDER,
                    right.name,
                )
            }
    }

}

private fun jsonObject(vararg pairs: Pair<String, JsonValue>) = JsonValue.Obj().also { obj ->
    for ((key, value) in pairs) obj.fields[key] = value
}

/**
 * New path for a rename in the same folder. A file keeps its extension even
 * when the typed name includes `.md` or `.pdf`. A folder stays a folder.
 */
/**
 * Destination of a move into [destFolder]. A name that is already there,
 * or whose companion is already there, becomes "Name 2", then "Name 3".
 * Moving a folder into itself is refused. The same parent is a no-op.
 */
fun movedVaultPath(path: String, destFolder: String, occupied: (String) -> Boolean): String {
    val normalized = path.replace('\\', '/').trim('/')
    val dest = destFolder.replace('\\', '/').trim('/')
    if (normalized.isEmpty()) throw IllegalArgumentException("Der Eintrag wurde nicht gefunden.")
    if (dest == normalized || dest.startsWith("$normalized/")) {
        throw IllegalArgumentException("Ein Ordner kann nicht in sich selbst verschoben werden.")
    }
    if (normalized.substringBeforeLast('/', "") == dest) return normalized
    val name = normalized.substringAfterLast('/')
    val extension = extensionOf(name)
    val base = if (extension.isEmpty()) name else name.removeSuffix(extension)
    val companionExt = when {
        name.endsWith(".md", true) || name.endsWith(".markdown", true) || name.endsWith(".pdf", true) -> ".famd"
        name.endsWith(".famd", true) -> ".md"
        else -> ""
    }
    fun join(folder: String, leaf: String) = if (folder.isEmpty()) leaf else "$folder/$leaf"
    fun companionOf(candidate: String): String {
        if (companionExt.isEmpty()) return ""
        return candidate.replace(Regex("""\.[^.]+$"""), "") + companionExt
    }
    for (index in 1..10_000) {
        val candidateName = if (index == 1) name else "$base $index$extension"
        val candidate = join(dest, candidateName)
        val companion = companionOf(candidate)
        if (!occupied(candidate) && (companion.isEmpty() || !occupied(companion))) return candidate
    }
    throw IllegalArgumentException("Es konnte kein eindeutiger Name erzeugt werden.")
}

fun renamedVaultPath(path: String, nextName: String, folder: Boolean): String {
    val trimmed = nextName.trim()
    if (trimmed.isEmpty()) throw IllegalArgumentException("Der Name darf nicht leer sein.")
    val stemInput = if (folder) trimmed else trimmed.replace(Regex("""\.(md|markdown|pdf)$""", RegexOption.IGNORE_CASE), "")
    val stem = safeNoteName(stemInput)
    val leaf = if (folder) stem else stem + extensionOf(path).ifBlank { ".md" }
    val parent = path.substringBeforeLast('/', "")
    return if (parent.isEmpty()) leaf else "$parent/$leaf"
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

    override fun move(from: String, to: String) {
        val source = resolve(from)
        val target = resolve(to)
        if (!Files.exists(source)) return
        if (Files.exists(target)) throw IllegalArgumentException("An diesem Ort existiert bereits ein Eintrag mit diesem Namen.")
        Files.createDirectories(target.parent)
        Files.move(source, target)
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
