package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.FAMD_EXTENSION
import ch.fasrv.fanotes.famd.applyLineEnding
import ch.fasrv.fanotes.famd.attachNoteInk
import ch.fasrv.fanotes.famd.detectLineEnding
import ch.fasrv.fanotes.famd.payloadIsStatsOnly
import ch.fasrv.fanotes.famd.toLf
import ch.fasrv.fanotes.famd.safeWorksheetSource
import ch.fasrv.fanotes.famd.worksheetRecordPath
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.FamdDocument
import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.famdEncodingForSave
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
import ch.fasrv.fanotes.json.JsonLimitException
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.famd.MAX_SYNC_DOCUMENT_BYTES
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

/**
 * The note text of a Markdown file. A file with an embedded FaNotes payload is cut at it, as before; a plain
 * file is kept as it is, minus the one final newline every saved note ends with.
 */
private fun plainMarkdownBody(text: String): String =
    if (text.contains("fanotes-famd")) stripFamdPayload(text) else text.removeSuffix("\n").removeSuffix("\r")

private fun famdHeaderStored(text: String) = text.contains("fanotes-famd:v1") || text.contains("fanotes-famd:v2")

/** A stored header whose payload will not parse must not become an empty note. */
private fun readStoredFamd(bytes: ByteArray): FamdDocument {
    val text = bytes.decodeToString()
    val parsed = parseFamd(text)
    if (famdHeaderStored(text) && parsed.payload == null) {
        throw IllegalStateException("This note could not be read and was left unchanged.")
    }
    return parsed
}

interface VaultIo {
    fun read(path: String): ByteArray?
    fun write(path: String, bytes: ByteArray)
    fun delete(path: String)
    fun move(from: String, to: String)
    fun exists(path: String): Boolean
    fun mtime(path: String): Long

    /** Size in bytes of a file, or -1 when it is missing (or not a file). Lets a caller refuse a huge file before reading it. */
    fun size(path: String): Long
    fun list(directory: String): List<VaultEntry>
    fun walkFiles(): List<VaultEntry>
    fun mkdir(path: String)

    /** An existing file that is flagged read-only (chmod 444): a save must not replace it silently. */
    fun isReadOnly(path: String): Boolean = false

    /**
     * The children of a directory entry that [list] returned. A provider that addresses documents by
     * id (SAF) uses the entry's [VaultEntry.handle] and skips the path lookup; the default reads the path.
     */
    fun list(directory: VaultEntry): List<VaultEntry> = list(directory.path)

    /**
     * The first [maxBytes] of a file, or null when it is not there. For callers that must not hold a
     * whole file in memory (the statistics page). The default reads everything; both vaults override it.
     */
    fun readHead(path: String, maxBytes: Int): VaultHead? = read(path)?.let { all ->
        if (all.size <= maxBytes) VaultHead(all, complete = true) else VaultHead(all.copyOf(maxBytes), complete = false)
    }

    /** [readHead] for an entry that [list] returned: opens it by [VaultEntry.handle] when there is one. */
    fun readHead(entry: VaultEntry, maxBytes: Int): VaultHead? = readHead(entry.path, maxBytes)
}

/**
 * One file or directory of a listing. [handle] is the provider's own id (a SAF document id) so a
 * later read or listing of this entry does not have to look the path up again; it is null for a plain
 * directory and only valid for the listing that produced it.
 */
data class VaultEntry(val path: String, val directory: Boolean, val size: Long, val mtimeMs: Long, val handle: String? = null)

/**
 * STORY: a writing-mode project folder (`Name.story/`), shown and opened as one document.
 * IMAGE, AUDIO and VIDEO are plain media files; they only appear in a tree built with `includeFiles`.
 */
enum class NoteKind {
    MARKDOWN, PDF, FOLDER, STORY, IMAGE, AUDIO, VIDEO;

    /** A note has text and handwriting ([NoteStore.readNote] works on it). A story, a media file and a folder are not notes. */
    val isNote: Boolean get() = this == MARKDOWN || this == PDF
}

data class VaultNode(
    val name: String,
    val path: String,
    val kind: NoteKind,
    val modifiedAt: Long,
    val children: List<VaultNode> = emptyList(),
)

data class NoteCensus(val notes: Int, val folders: Int, val perFolder: Map<String, Int>)

fun folderExists(tree: List<VaultNode>, folder: String): Boolean {
    if (folder.isBlank()) return true
    fun find(nodes: List<VaultNode>): Boolean {
        for (node in nodes) {
            if (node.kind != NoteKind.FOLDER) continue
            if (node.path == folder) return true
            if (find(node.children)) return true
        }
        return false
    }
    return find(tree)
}

/** Notes and folders directly inside [folder]. An empty folder is the vault root. */
fun folderChildren(tree: List<VaultNode>, folder: String): List<VaultNode> {
    if (folder.isBlank()) return tree
    fun find(nodes: List<VaultNode>): List<VaultNode>? {
        for (node in nodes) {
            if (node.kind != NoteKind.FOLDER) continue
            if (node.path == folder) return node.children
            val nested = find(node.children)
            if (nested != null) return nested
        }
        return null
    }
    return find(tree).orEmpty()
}

/** Every user note and folder. [skip] hides desk files such as Hausaufgaben.md. */
fun censusNotes(nodes: List<VaultNode>, skip: Set<String> = emptySet()): NoteCensus {
    var notes = 0
    var folders = 0
    val perFolder = linkedMapOf<String, Int>()
    fun walk(list: List<VaultNode>, folder: String) {
        var here = 0
        for (node in list) {
            when (node.kind) {
                NoteKind.FOLDER -> {
                    folders += 1
                    walk(node.children, node.path)
                }
                NoteKind.MARKDOWN, NoteKind.PDF, NoteKind.STORY -> if (node.path !in skip) {
                    notes += 1
                    here += 1
                }
                // Plain media files are listed on request only and are not notes.
                NoteKind.IMAGE, NoteKind.AUDIO, NoteKind.VIDEO -> Unit
            }
        }
        perFolder[folder.ifBlank { "/" }] = here
    }
    walk(nodes, "")
    return NoteCensus(notes, folders, perFolder)
}

data class OpenNote(
    val path: String,
    val kind: NoteKind,
    val title: String,
    val markdown: String,
    val document: InkDocument,
    val payload: JsonValue.Obj,
    val worksheets: List<String>,
    val inkId: String,
    /**
     * The body references handwriting (an ink marker) but its `.famd` is not on this device yet, e.g.
     * still syncing. Shown as such, never as an empty note, and never saved: a save would write an
     * empty sidecar that could replace the real handwriting on the other devices.
     */
    val inkPending: Boolean = false,
    /**
     * The handwriting file is too large to open on a phone (over [MAX_SYNC_DOCUMENT_BYTES], too many nodes, or the heap ran
     * out). The note comes back with an empty document and payload and is never saved: a save would replace the real handwriting.
     */
    val inkTooLarge: Boolean = false,
)

/** The message [NoteStore.save] throws for a note whose handwriting has not arrived yet. */
const val INK_PENDING_MESSAGE = "This note's handwriting has not reached this device yet. It was left unchanged."

/** The message [NoteStore.save] throws for a note whose handwriting is too large to open here. */
const val INK_TOO_LARGE_MESSAGE = "This note's handwriting is too large to open on this device. It was left unchanged."

/** Most text a note body may have before only its start is shown (the same cap as a sync document). */
private const val NOTE_TEXT_HEAD_BYTES = 1024 * 1024

class NoteStore(private val io: VaultIo, private val onSaved: (String) -> Unit = {}) {
    /** [includeFiles] also lists images, audio and video as [NoteKind.IMAGE], [NoteKind.AUDIO] and [NoteKind.VIDEO]. */
    fun tree(includeFiles: Boolean = false): List<VaultNode> = buildTree("", includeFiles)

    fun readNote(path: String): OpenNote {
        val normalized = normalize(path)
        val extension = extensionOf(normalized)
        // Media and story folders are no notes: never decode them as text.
        if (fileKindOf(normalized) != null || StoryFiles.isStoryFolder(normalized)) {
            throw IllegalArgumentException("Dieser Eintrag ist keine Notiz.")
        }
        val famdPath = if (extension == FAMD_EXTENSION) normalized else companionPath(normalized, FAMD_EXTENSION)
        val markdownPath = when (extension) {
            ".pdf" -> null
            FAMD_EXTENSION -> companionPath(normalized, ".md").takeIf { io.exists(it) }
            else -> normalized
        }
        val limit = MAX_SYNC_DOCUMENT_BYTES.toLong()
        var tooLarge = false
        // A sidecar over the sync cap is never decoded: the phone could not hold the text and the parsed document.
        val famdBytes = if (io.size(famdPath) > limit) {
            tooLarge = true
            null
        } else try {
            io.read(famdPath)
        } catch (_: OutOfMemoryError) {
            tooLarge = true
            null
        }
        var famd: FamdDocument? = null
        if (famdBytes != null) {
            try {
                famd = readStoredFamd(famdBytes)
            } catch (_: JsonLimitException) {
                tooLarge = true
            } catch (_: OutOfMemoryError) {
                tooLarge = true
            }
        }
        // A Markdown file that embeds a payload counts like a sidecar; for a huge one only its start is read.
        val mdTooBig = markdownPath != null && io.size(markdownPath) > limit
        if (mdTooBig) tooLarge = true
        val mdBytes = when {
            markdownPath == null -> null
            mdTooBig -> io.readHead(markdownPath, NOTE_TEXT_HEAD_BYTES)?.bytes
            else -> try { io.read(markdownPath) } catch (_: OutOfMemoryError) { tooLarge = true; null }
        }
        // Ink that lives only inside the markdown, with no sidecar yet, is still the note.
        var embedded: FamdDocument? = null
        if (!tooLarge && famdBytes == null && mdBytes != null && famdHeaderStored(mdBytes.decodeToString())) {
            try {
                embedded = readStoredFamd(mdBytes)
            } catch (_: JsonLimitException) {
                tooLarge = true
            } catch (_: OutOfMemoryError) {
                tooLarge = true
            }
        }
        val markdown = when {
            mdBytes != null -> toLf(plainMarkdownBody(mdBytes.decodeToString()))
            famd != null -> toLf(famd.markdown)
            else -> ""
        }
        val payload = if (tooLarge) emptyFamdPayload(isoNow()) else famd?.payload ?: embedded?.payload ?: emptyFamdPayload(isoNow())
        val title = titleOf(normalized)
        val document = if (tooLarge) newInkDocument(title, "dots", isoNow())
        else parseInkDocument(payload.obj("ink"), title, payload.string("paperStyle") ?: "dots", payload.string("updatedAt") ?: isoNow())
        val inkId = noteInkId(markdown) ?: UUID.randomUUID().toString()
        // A marker is only written together with its sidecar, so a marker without one means it has not arrived.
        val inkPending = !tooLarge && extension != ".pdf" && extension != FAMD_EXTENSION && famdBytes == null && embedded == null && noteInkId(markdown) != null
        return OpenNote(
            path = normalized,
            kind = if (extension == ".pdf") NoteKind.PDF else NoteKind.MARKDOWN,
            title = title,
            markdown = markdown,
            document = document,
            payload = payload,
            worksheets = worksheetIdsFromMarkdown(markdown),
            inkId = inkId,
            inkPending = inkPending,
            inkTooLarge = tooLarge,
        )
    }

    /**
     * [textFieldBase] is the list of text boxes as this device last read or saved them. When given and the file on
     * disk holds other boxes (another device or the desktop wrote it meanwhile), the boxes are merged box by box
     * instead of overwritten, the way the desktop merges its windows.
     */
    fun save(
        note: OpenNote,
        document: InkDocument,
        markdown: String,
        now: String = isoNow(),
        textFieldBase: List<ch.fasrv.fanotes.desk.NoteTextField>? = null,
    ): OpenNote {
        if (note.inkTooLarge) throw IllegalStateException(INK_TOO_LARGE_MESSAGE)
        val famdPathForPlain = if (note.path.endsWith(FAMD_EXTENSION)) note.path else companionPath(note.path, FAMD_EXTENSION)
        if (note.inkPending && !io.exists(famdPathForPlain)) throw IllegalStateException(INK_PENDING_MESSAGE)
        // A plain Markdown note that never had ink stays a plain file: no marker, no sidecar, no asset.
        val plain = note.kind == NoteKind.MARKDOWN &&
            !note.path.endsWith(FAMD_EXTENSION) &&
            noteInkId(markdown) == null &&
            !io.exists(famdPathForPlain) &&
            payloadIsStatsOnly(note.payload, markdown, document.strokes.isNotEmpty(), document.paperStyle)
        if (plain) return savePlainMarkdown(note, document, markdown, now)
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
        // Desktop parity: the temp-file replace would bypass a read-only flag, so refuse instead.
        if (io.isReadOnly(famdPath) || (note.kind == NoteKind.MARKDOWN && io.isReadOnly(note.path))) {
            throw java.nio.file.ReadOnlyFileSystemException()
        }
        val previous = io.read(historyPath)?.decodeToString()
        val historyCompanion = if (historyPath == famdPath) null else io.read(famdPath)?.decodeToString()
        if (previous != null || !historyCompanion.isNullOrBlank()) {
            runCatching { recordNoteHistory(io, historyPath, previous.orEmpty(), companion = historyCompanion) }
        }
        val previousFamd = if (historyPath == famdPath) previous else io.read(famdPath)?.decodeToString()
        if (textFieldBase != null && previousFamd != null) mergeTextFieldsFromDisk(payload, previousFamd, textFieldBase, now)
        io.write(famdPath, serializeFamd(withMarker, payload, famdEncodingForSave(previousFamd)).encodeToByteArray())
        if (note.kind == NoteKind.MARKDOWN && !note.path.endsWith(FAMD_EXTENSION)) {
            val body = stripFamdPayload(withMarker)
            io.write(note.path, markdownFileText(note.path, body).encodeToByteArray())
        }
        writeInkAsset(note.inkId, ink)
        onSaved(famdPath)
        return note.copy(markdown = withMarker, document = document.copy(updatedAt = now), payload = payload, worksheets = worksheetIdsFromMarkdown(withMarker))
    }

    /** The file text of a note body: a final newline, and the line ending the file on disk already has. */
    private fun markdownFileText(path: String, body: String): String {
        val lf = toLf(body)
        val text = if (lf.isEmpty()) lf else "$lf\n"
        val existing = io.read(path)?.decodeToString()
        return applyLineEnding(text, if (existing != null) detectLineEnding(existing) else "lf")
    }

    private fun savePlainMarkdown(note: OpenNote, document: InkDocument, markdown: String, now: String): OpenNote {
        // Same rule as the sidecar path: a temp-file replace would bypass a read-only flag.
        if (io.isReadOnly(note.path)) throw java.nio.file.ReadOnlyFileSystemException()
        val body = if (markdown.contains("fanotes-famd")) stripFamdPayload(markdown) else markdown
        val previous = io.read(note.path)?.decodeToString()
        if (previous != null) runCatching { recordNoteHistory(io, note.path, previous, companion = null) }
        io.write(note.path, markdownFileText(note.path, body).encodeToByteArray())
        onSaved(note.path)
        return note.copy(markdown = markdown, document = document.copy(updatedAt = now))
    }

    private fun mergeTextFieldsFromDisk(payload: JsonValue.Obj, previousFamd: String, base: List<ch.fasrv.fanotes.desk.NoteTextField>, now: String) {
        val disk = runCatching { parseFamd(previousFamd).payload }.getOrNull() ?: return
        val nowMs = runCatching { java.time.Instant.parse(now).toEpochMilli() }.getOrElse { System.currentTimeMillis() }
        val merged = ch.fasrv.fanotes.desk.noteTextFieldsForSave(
            base = base,
            local = ch.fasrv.fanotes.desk.parseNoteTextFields(payload.array("textFields")),
            localTombstones = ch.fasrv.fanotes.desk.parseNoteTextFieldTombstones(payload.array("textFieldTombstones")),
            disk = ch.fasrv.fanotes.desk.parseNoteTextFields(disk.array("textFields")),
            diskTombstones = ch.fasrv.fanotes.desk.parseNoteTextFieldTombstones(disk.array("textFieldTombstones")),
            now = nowMs,
        )
        val written = ch.fasrv.fanotes.desk.writeNoteTextFieldsAndTombstones(payload, merged.fields, merged.tombstones)
        payload.put("textFields", written.fields["textFields"])
        payload.put("textFieldTombstones", written.fields["textFieldTombstones"])
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

    /**
     * A Markdown note with the given text, from a file another app shared. The name is numbered when taken; a
     * FaNotes payload inside the text is not carried over (the note starts without ink).
     */
    fun importMarkdownNote(directory: String, fileName: String, text: String, now: String = isoNow(), paper: String = "dots"): String {
        val folder = directory.trim('/')
        val stem = nextFreeLeaf(folder, safeNoteName(fileName.substringBeforeLast('.').ifBlank { "Geteilte Notiz" }), ".md")
        val path = if (folder.isEmpty()) "$stem.md" else "$folder/$stem.md"
        val body = stripFamdPayload(text).let { if (it.isBlank()) "# $stem\n" else it }
        val document = newInkDocument(stem, paper, now)
        val note = OpenNote(path, NoteKind.MARKDOWN, stem, body, document, emptyFamdPayload(now), emptyList(), UUID.randomUUID().toString())
        save(note, document, body, now)
        return path
    }

    /** Creates `Unbenannte Notiz`, then `Unbenannte Notiz 2`, the way the desktop vault does. */
    fun createUniqueMarkdown(directory: String, preferred: String = "Unbenannte Notiz", now: String = isoNow(), paper: String = "dots"): String {
        val stem = nextFreeLeaf(directory, safeNoteName(preferred), ".md")
        return createMarkdown(directory, stem, now, paper)
    }

    /** Creates `Neuer Ordner`, then `Neuer Ordner 2`, inside the chosen folder. */
    fun createUniqueFolder(directory: String, preferred: String = "Neuer Ordner") {
        val stem = nextFreeLeaf(directory, safeNoteName(preferred), "")
        createFolder(directory, stem)
    }

    /**
     * A note stem is one family: `.md`/`.markdown` text, a `.pdf` and the shared `.famd` sidecar.
     * A plain Markdown note may have no `.famd` yet (it is only written once ink or boxes exist), so
     * the text file itself must also block a PDF of the same name, and the other way round.
     */
    private fun noteFamilyTaken(path: String): Boolean =
        listOf(FAMD_EXTENSION, ".md", ".markdown", ".pdf").any { extension ->
            val sibling = companionPath(path, extension)
            sibling != path && io.exists(sibling)
        }

    private fun nextFreeLeaf(directory: String, stem: String, extension: String): String {
        fun taken(name: String): Boolean {
            val leaf = name + extension
            val folder = directory.trim('/')
            val path = if (folder.isEmpty()) leaf else "$folder/$leaf"
            if (io.exists(path)) return true
            // A PDF and a Markdown note of one name would share one .famd (desktop `companionNameTaken`).
            return (extension == ".md" || extension == ".pdf") && noteFamilyTaken(path)
        }
        if (!taken(stem)) return stem
        var index = 2
        while (taken("$stem $index")) index += 1
        return "$stem $index"
    }

    fun createFolder(directory: String, title: String) {
        val name = safeNoteName(title)
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$name/.keep" else "$folder/$name/.keep"
        io.write(path, ByteArray(0))
    }

    /** Imports a PDF into a folder, numbering the stem the way the desktop book import does. */
    fun importUniquePdf(directory: String, fileName: String, bytes: ByteArray): String {
        val preferred = safeNoteName(fileName.substringBeforeLast('.').ifBlank { "Buch" })
        val stem = nextFreeLeaf(directory, preferred, ".pdf")
        return importPdf(directory, "$stem.pdf", bytes)
    }

    fun importPdf(directory: String, fileName: String, bytes: ByteArray): String {
        val stem = safeNoteName(fileName.substringBeforeLast('.').ifBlank { "Document" })
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$stem.pdf" else "$folder/$stem.pdf"
        if (io.exists(path) || noteFamilyTaken(path)) throw IllegalStateException("A note named $stem already exists")
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

    private fun worksheetTitle(fileName: String): String {
        val base = fileName.substringAfterLast('/').substringAfterLast('\\')
        return safeNoteName(base.substringBeforeLast('.').ifBlank { "Arbeitsblatt" })
    }

    /** Writes image or PDF bytes and the desktop worksheet JSON. It does not create a note. */
    fun storeWorksheet(fileName: String, bytes: ByteArray, mime: String = ""): StoredWorksheet {
        val error = worksheetImportError(fileName, mime, bytes)
        if (error != null) throw IllegalArgumentException(error)
        val format = worksheetFileFormat(fileName, mime) ?: throw IllegalArgumentException(WORKSHEET_FORMAT_UNSUPPORTED)
        val id = UUID.randomUUID().toString()
        val title = worksheetTitle(fileName)
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
        // Check the name before anything is stored: a taken name must not leave a worksheet file behind, and a note
        // must not take the `.famd` of a PDF of the same name.
        val title = worksheetTitle(fileName)
        val folder = directory.trim('/')
        val path = if (folder.isEmpty()) "$title.md" else "$folder/$title.md"
        if (io.exists(path) || io.exists(companionPath(path, FAMD_EXTENSION))) throw IllegalStateException("A note named $title already exists")
        val stored = storeWorksheet(fileName, bytes, mime)
        val id = stored.id
        val now = isoNow()
        val body = "# $title\n\n<!-- fanotes-worksheet:$id -->\n"
        val document = newInkDocument(title, paper, now)
        val note = OpenNote(path, NoteKind.MARKDOWN, title, body, document, emptyFamdPayload(now), listOf(id), UUID.randomUUID().toString())
        try {
            save(note, document, body, now)
        } catch (error: Exception) {
            runCatching { deleteWorksheet(id) }
            throw error
        }
        return path
    }

    fun importImageWorksheet(directory: String, fileName: String, bytes: ByteArray, mime: String): String =
        importWorksheetNote(directory, fileName, bytes, mime, "blank")

    fun rename(path: String, title: String): String {
        val parent = path.substringBeforeLast('/', "")
        val folder = io.list(parent).any { it.directory && it.path.trim('/') == path.trim('/') }
        val next = renamedVaultPath(path, title, folder)
        if (next == path) return path
        if (io.exists(next) || (!folder && companionDestinationTaken(path, next))) {
            throw IllegalArgumentException("An diesem Ort existiert bereits ein Eintrag mit diesem Namen.")
        }
        io.move(path, next)
        if (!folder) moveCompanions(path, next)
        return next
    }

    /** A taken `.famd` or `.md` beside the new name would split one note across two files. */
    private fun companionDestinationTaken(path: String, next: String): Boolean {
        val extension = extensionOf(path).ifBlank { ".md" }
        val companionExt = if (extension == FAMD_EXTENSION) ".md" else FAMD_EXTENSION
        if (io.exists(companionPath(next, companionExt))) return true
        return extension == ".pdf" && io.exists(companionPath(next, ".md"))
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

    /**
     * The other files of one note, as the desktop's `companionPaths`: a `.famd` belongs to its `.md` or `.markdown`
     * prose; prose and a PDF belong to one `.famd`. A same-name `.md` beside a PDF is another note.
     */
    private fun companionFiles(path: String): List<String> = when (extensionOf(path)) {
        FAMD_EXTENSION -> listOf(".md", ".markdown").map { companionPath(path, it) }
        ".md", ".markdown", ".pdf" -> listOf(companionPath(path, FAMD_EXTENSION))
        else -> emptyList()
    }

    private fun moveCompanions(path: String, next: String) {
        for (companion in companionFiles(path)) {
            if (!io.exists(companion)) continue
            io.move(companion, companionPath(next, extensionOf(companion)))
        }
    }

    fun delete(path: String) {
        io.delete(path)
        for (companion in companionFiles(path)) if (io.exists(companion)) io.delete(companion)
    }

    /**
     * Moves a note or folder into `.fanotes/trash`. The ink asset moves with it.
     * Worksheet files stay, because another note can still point at them.
     */
    fun trashEntry(path: String, id: String, now: String): TrashItem {
        val normalized = normalize(path)
        if (normalized == ".fanotes" || normalized.startsWith(".fanotes/")) {
            throw IllegalArgumentException("Dieser Eintrag kann nicht in den Papierkorb.")
        }
        val bundle = trashBundle(id)
        if (io.exists(bundle) || io.exists(TRASH_INDEX) && readTrashIndex(io).any { it.id == id }) {
            throw IllegalArgumentException("Der Papierkorb-Eintrag existiert schon.")
        }
        val folder = isDirectory(normalized)
        io.mkdir(bundle)
        if (folder) {
            val inside = io.walkFiles().map { it.path }.filter { it == normalized || it.startsWith("$normalized/") }
            if (inside.isEmpty() && !io.exists(normalized)) throw IllegalArgumentException("Der Eintrag wurde nicht gefunden.")
            val assets = referencedAssets(inside)
            val destParent = if (normalized.contains('/')) "$bundle/${normalized.substringBeforeLast('/')}" else bundle
            if (destParent != bundle) io.mkdir(destParent)
            io.move(normalized, "$bundle/$normalized")
            moveAside(assets, bundle)
        } else {
            val files = noteFiles(normalized)
            if (files.isEmpty()) throw IllegalArgumentException("Der Eintrag wurde nicht gefunden.")
            moveAside(files + referencedAssets(files), bundle)
        }
        val item = TrashItem(id, normalized, folder, now, titleOf(normalized))
        writeTrashIndex(io, readTrashIndex(io) + item)
        return item
    }

    fun listTrash(): List<TrashItem> = listTrashItems(io)

    /** Puts the entry back. A taken name becomes `Name 2`. Returns the restored path. */
    fun restoreTrash(id: String): String {
        val items = readTrashIndex(io)
        val item = items.find { it.id == id } ?: throw IllegalArgumentException("Der Eintrag ist nicht mehr im Papierkorb.")
        val bundle = trashBundle(id)
        val files = io.walkFiles().map { it.path }.filter { it.startsWith("$bundle/") }.map { it.removePrefix("$bundle/") }.sorted()
        val restored = restoredVaultPath(item.path, item.folder) { io.exists(it) }
        if (files.isEmpty()) {
            if (!item.folder) throw IllegalArgumentException("Der Papierkorb-Eintrag ist leer.")
            io.mkdir(restored)
        } else {
            for (file in files) {
                val dest = remapRestoredFile(item.path, restored, file)
                val parent = dest.substringBeforeLast('/', "")
                if (parent.isNotEmpty()) io.mkdir(parent)
                io.move("$bundle/$file", dest)
            }
        }
        if (io.exists(bundle)) io.delete(bundle)
        writeTrashIndex(io, items.filter { it.id != id })
        return restored
    }

    fun purgeTrash(id: String) {
        val bundle = trashBundle(id)
        if (io.exists(bundle)) io.delete(bundle)
        writeTrashIndex(io, readTrashIndex(io).filter { it.id != id })
    }

    fun emptyTrash() {
        for (item in readTrashIndex(io)) {
            val bundle = trashBundle(item.id)
            if (io.exists(bundle)) io.delete(bundle)
        }
        writeTrashIndex(io, emptyList())
    }

    /** A new note with its own ink id and its own worksheet files. */
    fun duplicateNote(path: String, now: String = isoNow()): String {
        val normalized = normalize(path)
        if (!io.exists(normalized) && !io.exists(companionPath(normalized, FAMD_EXTENSION))) {
            throw IllegalArgumentException("Die Notiz wurde nicht gefunden.")
        }
        val note = readNote(normalized)
        if (note.inkTooLarge) throw IllegalStateException(INK_TOO_LARGE_MESSAGE)
        if (note.kind == NoteKind.PDF) throw IllegalArgumentException(PDF_DUPLICATE_REFUSED)
        val parent = normalized.substringBeforeLast('/', "")
        val extension = if (note.kind == NoteKind.PDF) ".pdf" else ".md"
        val stem = duplicateLeaf(parent, note.title, extension)
        val newPath = if (parent.isEmpty()) "$stem$extension" else "$parent/$stem$extension"
        if (note.kind == NoteKind.PDF) {
            val bytes = io.read(normalized) ?: throw IllegalArgumentException("Die Notiz wurde nicht gefunden.")
            io.write(newPath, bytes)
        }
        val inkId = UUID.randomUUID().toString()
        val body = copyWorksheets(withFreshInkId(note.markdown, inkId))
        val payload = (note.payload.deepCopy() as JsonValue.Obj).also {
            it.put("pageStats", null)
            it.put("noteBackups", null)
            val links = ch.fasrv.fanotes.desk.parseNoteLinkMarks(it).map { link ->
                link.copy(
                    id = "nl-${UUID.randomUUID().toString().replace("-", "").take(12)}",
                    sourcePath = newPath,
                )
            }
            if (links.isEmpty()) it.put("noteLinks", null) else it.put("noteLinks", ch.fasrv.fanotes.desk.noteLinksJson(links))
        }
        val copy = OpenNote(
            newPath,
            note.kind,
            stem,
            body,
            note.document,
            payload,
            worksheetIdsFromMarkdown(body),
            inkId,
        )
        save(copy, note.document, body, now)
        return newPath
    }

    private fun duplicateLeaf(directory: String, title: String, extension: String): String {
        val preferred = duplicatePreferredStem(title)
        var stem = nextFreeLeaf(directory, preferred, extension)
        if (extension != ".pdf") return stem
        var index = 2
        while (io.exists(companionPath(joinLeaf(directory, "$stem$extension"), FAMD_EXTENSION))) {
            stem = nextFreeLeaf(directory, "$preferred $index", extension)
            index += 1
            if (index > 10_000) throw IllegalArgumentException("Es konnte kein eindeutiger Name erzeugt werden.")
        }
        return stem
    }

    private fun joinLeaf(directory: String, leaf: String): String {
        val folder = directory.trim('/')
        return if (folder.isEmpty()) leaf else "$folder/$leaf"
    }

    private fun moveAside(files: List<String>, bundle: String) {
        for (file in files.distinct()) {
            if (!io.exists(file)) continue
            val dest = "$bundle/$file"
            val parent = dest.substringBeforeLast('/', "")
            if (parent.isNotEmpty()) io.mkdir(parent)
            io.move(file, dest)
        }
    }

    private fun noteFiles(path: String): List<String> = (listOf(path) + companionFiles(path)).distinct().filter { io.exists(it) }

    private fun referencedAssets(files: List<String>): List<String> {
        val found = linkedSetOf<String>()
        for (file in files) {
            if (extensionOf(file) !in setOf(".md", ".markdown", ".famd")) continue
            val text = io.read(file)?.decodeToString() ?: continue
            val id = noteInkId(text) ?: continue
            val asset = ".fanotes/assets/$id.json"
            if (io.exists(asset)) found += asset
        }
        return found.toList()
    }

    private fun withFreshInkId(markdown: String, id: String): String {
        val current = noteInkId(markdown) ?: return ch.fasrv.fanotes.famd.attachNoteInk(markdown, id)
        return markdown.replaceFirst(
            Regex("""<!--\s*fanotes-ink:${Regex.escape(current)}\s*-->"""),
            "<!-- fanotes-ink:$id -->",
        )
    }

    private fun copyWorksheets(markdown: String): String {
        val copied = linkedMapOf<String, String>()
        for (id in worksheetIdsFromMarkdown(markdown).distinct()) {
            val recordPath = worksheetRecordPath(id) ?: continue
            val raw = io.read(recordPath)?.decodeToString() ?: continue
            val obj = (runCatching { parseJson(raw) }.getOrNull() as? JsonValue.Obj)?.deepCopy() as? JsonValue.Obj ?: continue
            val source = ch.fasrv.fanotes.famd.safeWorksheetSource(id, obj.string("sourceRelativePath")) ?: continue
            val bytes = io.read(source) ?: continue
            val newId = UUID.randomUUID().toString()
            val extension = source.substringAfterLast('.', "")
            val newSource = ".fanotes/worksheets/$newId.$extension"
            if (ch.fasrv.fanotes.famd.safeWorksheetSource(newId, newSource) == null) continue
            val newRecord = worksheetRecordPath(newId) ?: continue
            obj.put("id", jsonString(newId))
            obj.put("sourceRelativePath", jsonString(newSource))
            obj.put("dataRelativePath", jsonString(newRecord))
            io.write(newSource, bytes)
            io.write(newRecord, obj.stringify().encodeToByteArray())
            copied[id] = newId
        }
        if (copied.isEmpty()) return markdown
        return Regex("""<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->""").replace(markdown) { match ->
            val next = copied[match.groupValues[1]] ?: return@replace match.value
            "<!-- fanotes-worksheet:$next -->"
        }
    }

    private fun writeInkAsset(id: String, ink: JsonValue.Obj) {
        io.write(".fanotes/assets/$id.json", ink.stringify().encodeToByteArray())
    }

    private fun buildTree(directory: String, includeFiles: Boolean): List<VaultNode> {
        return io.list(directory)
            .filter { !it.path.substringAfterLast('/').startsWith(".") }
            .mapNotNull { entry ->
                val name = entry.path.substringAfterLast('/')
                if (entry.directory && StoryFiles.isStoryFolder(entry.path)) {
                    VaultNode(name.removeSuffix(".story").removeSuffix(".STORY"), entry.path, NoteKind.STORY, entry.mtimeMs)
                } else if (entry.directory) {
                    VaultNode(name, entry.path, NoteKind.FOLDER, entry.mtimeMs, buildTree(entry.path, includeFiles))
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
                        else -> if (includeFiles) fileKindOf(name)?.let { VaultNode(name, entry.path, it, entry.mtimeMs) } else null
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
    val story = folder && path.endsWith(".story", ignoreCase = true)
    val kept = path.substringAfterLast('/').let { leafName -> leafName.lastIndexOf('.').let { dot -> if (dot <= 0) "" else leafName.substring(dot) } }
    // A typed extension that repeats the file's own is dropped; a media file keeps its own extension, never `.famd`.
    val stemInput = when {
        story -> trimmed.replace(Regex("""\.story$""", RegexOption.IGNORE_CASE), "")
        folder -> trimmed
        else -> trimmed.replace(Regex("""\.(md|markdown|pdf)$""", RegexOption.IGNORE_CASE), "")
            .let { if (kept.isNotEmpty() && it.endsWith(kept, ignoreCase = true) && it.length > kept.length) it.dropLast(kept.length) else it }
    }
    val stem = safeNoteName(stemInput)
    val leaf = when {
        story -> "$stem.story"
        folder -> stem
        else -> stem + kept.ifBlank { ".md" }
    }
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

private val untitledNoteTitle = Regex("""^Untitled(?: note)?(?: (\d+))?$""")
private val conflictNoteTitle = Regex("""^(.*?) \(Konflikt (.+) (\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})\)$""")

/**
 * Display title only. The stored file name stays unchanged.
 * Desktop names such as "Untitled note" use [untitled]. A conflict copy shows a normal clock.
 */
fun displayNoteTitle(title: String, untitled: String): String {
    val conflict = conflictNoteTitle.matchEntire(title)
    if (conflict != null) {
        val stem = localizedUntitled(conflict.groupValues[1], untitled)
        val device = conflict.groupValues[2]
        val year = conflict.groupValues[3]
        val month = conflict.groupValues[4].toIntOrNull() ?: return title
        val day = conflict.groupValues[5].toIntOrNull() ?: return title
        val hour = conflict.groupValues[6]
        val minute = conflict.groupValues[7]
        return "$stem (Konflikt $device $day.$month.$year $hour:$minute)"
    }
    return localizedUntitled(title, untitled)
}

private fun localizedUntitled(title: String, untitled: String): String {
    val match = untitledNoteTitle.matchEntire(title) ?: return title
    val number = match.groupValues[1]
    return if (number.isBlank()) untitled else "$untitled $number"
}

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

    override fun readHead(path: String, maxBytes: Int): VaultHead? {
        val target = resolve(path)
        if (!Files.isRegularFile(target)) return null
        return Files.newInputStream(target).use { readHeadFrom(it, maxBytes, Files.size(target)) }
    }

    override fun write(path: String, bytes: ByteArray) {
        val target = resolve(path)
        Files.createDirectories(target.parent)
        // Not "<name>.<uuid>.tmp": a long name plus the suffix passes the 255-byte name limit.
        val temp = target.resolveSibling(".${UUID.randomUUID()}.tmp")
        Files.write(temp, bytes)
        try {
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    override fun isReadOnly(path: String): Boolean {
        val target = resolve(path)
        if (!Files.isRegularFile(target)) return false
        // The mode bits decide (desktop: `(mode & 0o222) === 0`); `isWritable` is the fallback off POSIX file systems.
        val bits = try {
            Files.getPosixFilePermissions(target)
        } catch (_: Exception) {
            return !Files.isWritable(target)
        }
        val writeBits = setOf(
            java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
            java.nio.file.attribute.PosixFilePermission.GROUP_WRITE,
            java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE,
        )
        return bits.none { it in writeBits } || !Files.isWritable(target)
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

    override fun mkdir(path: String) {
        Files.createDirectories(resolve(path))
    }

    override fun exists(path: String) = Files.exists(resolve(path))

    override fun size(path: String): Long {
        val target = resolve(path)
        return if (Files.isRegularFile(target)) target.toFile().length() else -1L
    }

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
            }.collect(java.util.stream.Collectors.toList()) // Stream.toList() is API 34
        }
    }

    override fun walkFiles(): List<VaultEntry> {
        if (!Files.isDirectory(root)) throw java.nio.file.NoSuchFileException(root.toString())
        return Files.walk(root).use { stream ->
            stream.filter { Files.isRegularFile(it) }.map { file ->
                val relative = file.relativeTo(root).toString().replace('\\', '/')
                VaultEntry(relative, false, Files.size(file), Files.getLastModifiedTime(file).toMillis())
            }.collect(java.util.stream.Collectors.toList())
        }
    }

    private fun resolve(path: String): Path {
        val normal = normalize(path)
        val target = root.resolve(normal).normalize()
        if (!target.startsWith(root)) throw IllegalArgumentException("Path escapes the vault")
        return target
    }
}
