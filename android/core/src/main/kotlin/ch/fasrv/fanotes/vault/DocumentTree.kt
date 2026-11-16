package ch.fasrv.fanotes.vault

import java.io.IOException
import java.io.InputStream

/** One child row of a document directory, as the provider reports it. */
class DocumentChild(
    val id: String,
    val name: String,
    val directory: Boolean,
    /** False for a directory and for a document without a MIME type. */
    val file: Boolean,
    val size: Long,
    val mtimeMs: Long,
)

/** What read-only access to a document provider needs: one listing call per directory, one stream per document. */
interface DocumentSource {
    /** Every child of the directory in a single query. Throws [IOException] when it cannot be read. */
    fun children(directoryId: String): List<DocumentChild>

    /** The document's bytes, or null when it is gone. */
    fun open(documentId: String): InputStream?
}

/**
 * Read-only view of a document tree (the Storage Access Framework on Android), in vault paths with
 * forward slashes. It is stateless on purpose: a cached id could point at another file after an
 * outside rename, so nothing is remembered between calls.
 *
 * Cost per call, in provider queries:
 * - [list] of a path: one listing per path segment plus one for the directory itself.
 * - [list] of an [VaultEntry] from an earlier listing: one.
 * - [read] and [readHead] of a path: one listing per segment, then the open.
 * - [readHead] of an entry from an earlier listing: the open only.
 * - [walkFiles]: one listing per directory.
 *
 * `DocumentFile.findFile` asks the provider for the name of every sibling it looks at, which made
 * one read of a note in a 1,000 file folder cost hundreds of calls. A listing returns all names at once.
 */
class DocumentTree(private val source: DocumentSource, private val rootId: String) {
    fun list(path: String): List<VaultEntry> {
        val prefix = path.trim('/')
        if (prefix.isEmpty()) return entries(rootId, "")
        val directory = find(prefix)?.takeIf { it.directory } ?: return emptyList()
        return entries(directory.id, prefix)
    }

    fun list(directory: VaultEntry): List<VaultEntry> {
        val handle = directory.handle ?: return list(directory.path)
        return try {
            entries(handle, directory.path.trim('/'))
        } catch (_: IOException) {
            // The handle went stale (renamed or removed since the listing): the path decides.
            list(directory.path)
        }
    }

    fun walkFiles(): List<VaultEntry> {
        val found = ArrayList<VaultEntry>()
        fun visit(directoryId: String, prefix: String) {
            for (child in source.children(directoryId)) {
                val entry = entryOf(child, prefix)
                if (child.directory) visit(child.id, entry.path) else found += entry
            }
        }
        visit(rootId, "")
        return found
    }

    /** The document at [path], or null. Costs one listing per segment. */
    fun find(path: String): DocumentChild? {
        val parts = path.trim('/').split('/')
        var directoryId = rootId
        var current: DocumentChild? = null
        for ((index, part) in parts.withIndex()) {
            val child = source.children(directoryId).firstOrNull { it.name == part } ?: return null
            if (index < parts.lastIndex && !child.directory) return null
            current = child
            directoryId = child.id
        }
        return current
    }

    fun read(path: String): ByteArray? {
        val child = find(path)?.takeIf { it.file } ?: return null
        return source.open(child.id)?.use { it.readBytes() }
    }

    fun readHead(path: String, maxBytes: Int): VaultHead? {
        val child = find(path)?.takeIf { it.file } ?: return null
        return source.open(child.id)?.use { readHeadFrom(it, maxBytes, child.size) }
    }

    /** Opens by the entry's handle without a path lookup; an unusable handle falls back to the path. */
    fun readHead(entry: VaultEntry, maxBytes: Int): VaultHead? {
        if (entry.directory) return null
        val handle = entry.handle ?: return readHead(entry.path, maxBytes)
        val stream = try {
            source.open(handle)
        } catch (_: IOException) {
            null
        } ?: return readHead(entry.path, maxBytes)
        return stream.use { readHeadFrom(it, maxBytes, entry.size) }
    }

    private fun entries(directoryId: String, prefix: String): List<VaultEntry> =
        source.children(directoryId).map { entryOf(it, prefix) }

    private fun entryOf(child: DocumentChild, prefix: String) = VaultEntry(
        path = if (prefix.isEmpty()) child.name else "$prefix/${child.name}",
        directory = child.directory,
        size = if (child.file) child.size else 0L,
        mtimeMs = child.mtimeMs,
        handle = child.id,
    )
}
