package ch.fasrv.fanotes

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import ch.fasrv.fanotes.vault.DocumentChild
import ch.fasrv.fanotes.vault.DocumentSource
import ch.fasrv.fanotes.vault.DocumentTree
import ch.fasrv.fanotes.vault.VaultEntry
import ch.fasrv.fanotes.vault.VaultHead
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.normalize

/** User-selected vault. Paths stay the same forward-slash shape the desktop syncs. */
class SafVault(private val context: Context, private val tree: Uri) : VaultIo {
    private val root: DocumentFile
        get() = DocumentFile.fromTreeUri(context, tree) ?: error("The selected folder is not available")

    /**
     * Reading goes by document id: one cursor query lists a directory (name, type, size and time of
     * every child at once) and a file opens by its id. `DocumentFile.findFile` asked the provider for
     * the name of each sibling it looked at, which is hundreds of binder calls per file in a big folder.
     * Writing, moving and deleting still use the [DocumentFile] path in [locate].
     */
    private val documents: DocumentTree by lazy {
        DocumentTree(
            object : DocumentSource {
                override fun children(directoryId: String): List<DocumentChild> = queryChildren(directoryId)

                override fun open(documentId: String): java.io.InputStream? = try {
                    context.contentResolver.openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, documentId))
                } catch (_: java.io.FileNotFoundException) {
                    null
                }
            },
            DocumentsContract.getDocumentId(root.uri),
        )
    }

    private fun queryChildren(directoryId: String): List<DocumentChild> {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, directoryId)
        val cursor = try {
            context.contentResolver.query(childrenUri, CHILD_COLUMNS, null, null, null)
        } catch (error: RuntimeException) {
            throw java.io.IOException("Der Ordner konnte nicht gelesen werden.", error)
        } ?: throw java.io.IOException("Der Ordner konnte nicht gelesen werden.")
        val children = ArrayList<DocumentChild>()
        cursor.use {
            while (it.moveToNext()) {
                val id = it.getString(0) ?: continue
                val name = it.getString(1)?.takeIf { value -> value.isNotEmpty() } ?: continue
                val mime = it.getString(2)
                val directory = mime == DocumentsContract.Document.MIME_TYPE_DIR
                val file = !directory && !mime.isNullOrEmpty()
                val size = if (!file || it.isNull(3)) 0L else it.getLong(3)
                val modified = if (it.isNull(4)) 0L else it.getLong(4)
                children += DocumentChild(id, name, directory, file, size, modified)
            }
        }
        return children
    }

    override fun read(path: String): ByteArray? = documents.read(normalize(path))

    override fun readHead(path: String, maxBytes: Int): VaultHead? = documents.readHead(normalize(path), maxBytes)

    override fun readHead(entry: VaultEntry, maxBytes: Int): VaultHead? = documents.readHead(entry, maxBytes)

    override fun write(path: String, bytes: ByteArray) {
        val file = locate(normalize(path), create = true) ?: error("Could not create $path")
        context.contentResolver.openOutputStream(file.uri, "wt")?.use { it.write(bytes) }
            ?: error("Could not write $path")
    }

    override fun delete(path: String) {
        locate(normalize(path), create = false)?.delete()
    }

    override fun move(from: String, to: String) {
        val source = locate(normalize(from), create = false) ?: return
        val target = normalize(to)
        val targetName = target.substringAfterLast('/')
        if (targetName.isEmpty()) error("Verschieben ist fehlgeschlagen.")
        val targetParentPath = target.substringBeforeLast('/', "")
        val targetParent = if (targetParentPath.isEmpty()) root else {
            locate(targetParentPath, create = false) ?: error("Der Zielordner wurde nicht gefunden.")
        }
        val sourceParent = source.parentFile ?: root
        if (sourceParent.uri == targetParent.uri) {
            if (source.name != targetName && !source.renameTo(targetName)) error("Umbenennen ist fehlgeschlagen.")
            return
        }
        DocumentsContract.moveDocument(
            context.contentResolver,
            source.uri,
            sourceParent.uri,
            targetParent.uri,
        ) ?: error("Verschieben ist fehlgeschlagen.")
        if (source.name == targetName) return
        val moved = targetParent.findFile(source.name ?: return) ?: error("Verschieben ist fehlgeschlagen.")
        if (!moved.renameTo(targetName)) error("Umbenennen ist fehlgeschlagen.")
    }

    override fun mkdir(path: String) {
        var current = root
        for (part in normalize(path).split('/')) {
            val child = current.findFile(part)
            current = when {
                child == null -> current.createDirectory(part) ?: error("Der Ordner konnte nicht erstellt werden.")
                child.isDirectory -> child
                else -> error("An diesem Ort liegt schon eine Datei.")
            }
        }
    }

    override fun exists(path: String): Boolean = documents.find(normalize(path)) != null

    override fun mtime(path: String): Long = documents.find(normalize(path))?.mtimeMs ?: 0L

    override fun size(path: String): Long = documents.find(normalize(path))?.takeIf { it.file }?.size ?: -1L

    override fun list(directory: String): List<VaultEntry> =
        documents.list(if (directory.isBlank()) "" else normalize(directory))

    override fun list(directory: VaultEntry): List<VaultEntry> = documents.list(directory)

    /** One listing per directory; the root being unreadable is an error, not an empty vault. */
    override fun walkFiles(): List<VaultEntry> = documents.walkFiles()

    private fun locate(path: String, create: Boolean): DocumentFile? {
        var current = root
        val parts = path.split('/')
        for ((index, part) in parts.withIndex()) {
            val last = index == parts.lastIndex
            val child = current.findFile(part)
            current = when {
                child != null -> child
                !create -> return null
                !last -> current.createDirectory(part) ?: return null
                else -> current.createFile(mimeFor(part), part) ?: return null
            }
        }
        return current
    }

    fun documentUri(path: String): android.net.Uri? = locate(normalize(path), create = false)?.uri

    private companion object {
        val CHILD_COLUMNS = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
    }

    private fun mimeFor(name: String) = when (name.substringAfterLast('.', "").lowercase()) {
        "md", "markdown" -> "text/markdown"
        "pdf" -> "application/pdf"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> "application/octet-stream"
    }
}
