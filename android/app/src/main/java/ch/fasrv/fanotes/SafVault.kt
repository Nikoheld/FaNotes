package ch.fasrv.fanotes

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import ch.fasrv.fanotes.vault.VaultEntry
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.normalize

/** User-selected vault. Paths stay the same forward-slash shape the desktop syncs. */
class SafVault(private val context: Context, private val tree: Uri) : VaultIo {
    private val root: DocumentFile
        get() = DocumentFile.fromTreeUri(context, tree) ?: error("The selected folder is not available")

    override fun read(path: String): ByteArray? {
        val file = locate(normalize(path), create = false) ?: return null
        if (!file.isFile) return null
        return context.contentResolver.openInputStream(file.uri)?.use { it.readBytes() }
    }

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

    override fun exists(path: String): Boolean = locate(normalize(path), create = false) != null

    override fun mtime(path: String): Long = locate(normalize(path), create = false)?.lastModified() ?: 0L

    override fun list(directory: String): List<VaultEntry> {
        val dir = if (directory.isBlank()) root else locate(normalize(directory), create = false) ?: return emptyList()
        if (!dir.isDirectory) return emptyList()
        return queryChildren(DocumentsContract.getDocumentId(dir.uri), directory.trim('/')).map { it.entry }
    }

    private class Child(val entry: VaultEntry, val documentId: String)

    /** One cursor query per directory instead of several binder calls per child. */
    private fun queryChildren(documentId: String, prefix: String): List<Child> {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val cursor = context.contentResolver.query(childrenUri, projection, null, null, null)
            ?: throw java.io.IOException("Der Ordner konnte nicht gelesen werden.")
        val result = ArrayList<Child>()
        cursor.use {
            while (it.moveToNext()) {
                val name = it.getString(1)?.takeIf { n -> n.isNotEmpty() } ?: continue
                val isDir = it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
                val size = if (isDir || it.isNull(3)) 0L else it.getLong(3)
                val modified = if (it.isNull(4)) 0L else it.getLong(4)
                val path = if (prefix.isEmpty()) name else "$prefix/$name"
                result += Child(VaultEntry(path, isDir, size, modified), it.getString(0))
            }
        }
        return result
    }

    override fun walkFiles(): List<VaultEntry> {
        if (!root.exists() || !root.isDirectory) throw java.io.IOException("Der Ordner konnte nicht gelesen werden.")
        val found = mutableListOf<VaultEntry>()
        fun visit(documentId: String, prefix: String) {
            for (child in queryChildren(documentId, prefix)) {
                if (child.entry.directory) visit(child.documentId, child.entry.path) else found += child.entry
            }
        }
        visit(DocumentsContract.getDocumentId(root.uri), "")
        return found
    }

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
