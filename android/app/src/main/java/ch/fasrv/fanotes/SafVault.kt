package ch.fasrv.fanotes

import android.content.Context
import android.net.Uri
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
        val file = locate(normalize(from), create = false) ?: return
        val name = normalize(to).substringAfterLast('/')
        if (name.isEmpty() || !file.renameTo(name)) error("Umbenennen ist fehlgeschlagen.")
    }

    override fun exists(path: String): Boolean = locate(normalize(path), create = false) != null

    override fun mtime(path: String): Long = locate(normalize(path), create = false)?.lastModified() ?: 0L

    override fun list(directory: String): List<VaultEntry> {
        val dir = if (directory.isBlank()) root else locate(normalize(directory), create = false) ?: return emptyList()
        if (!dir.isDirectory) return emptyList()
        val prefix = directory.trim('/')
        return dir.listFiles().map { child ->
            val name = child.name ?: return@map child.let { VaultEntry("", false, 0, 0) }
            val path = if (prefix.isEmpty()) name else "$prefix/$name"
            VaultEntry(path, child.isDirectory, if (child.isFile) child.length() else 0L, child.lastModified())
        }.filter { it.path.isNotEmpty() }
    }

    override fun walkFiles(): List<VaultEntry> {
        val found = mutableListOf<VaultEntry>()
        fun visit(directory: String) {
            for (entry in list(directory)) {
                if (entry.directory) visit(entry.path) else found += entry
            }
        }
        visit("")
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
