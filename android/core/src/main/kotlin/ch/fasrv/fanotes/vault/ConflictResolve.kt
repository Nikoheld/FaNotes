package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.isMarkdownConflictPath
import ch.fasrv.fanotes.desk.resolveMarkdownConflict

/**
 * Applies the choice made in the conflict review. [path] is the note under its own name (the server copy), [copyPath]
 * the conflict copy that holds this device's version. The files are handled as bytes: a conflict can be a PDF or an
 * image, and a text round trip would damage those. Throws when the choice cannot be applied, so nothing is dropped
 * silently and the conflict stays listed.
 */
fun resolveConflictFiles(io: VaultIo, path: String, copyPath: String, choice: String) {
    when (choice) {
        "remote" -> io.delete(copyPath)
        "local" -> {
            val local = io.read(copyPath) ?: throw IllegalStateException("Die lokale Fassung fehlt.")
            io.write(path, local)
            io.delete(copyPath)
        }
        "both" -> {
            if (!isMarkdownConflictPath(path)) throw IllegalArgumentException("Nur Markdown-Notizen lassen sich zusammenführen.")
            val remote = io.read(path)?.decodeToString() ?: throw IllegalStateException("Die Serverfassung fehlt.")
            val local = io.read(copyPath)?.decodeToString() ?: throw IllegalStateException("Die lokale Fassung fehlt.")
            io.write(path, resolveMarkdownConflict(remote, local, "both").encodeToByteArray())
            io.delete(copyPath)
        }
        else -> throw IllegalArgumentException("Unbekannte Konfliktlösung.")
    }
}
