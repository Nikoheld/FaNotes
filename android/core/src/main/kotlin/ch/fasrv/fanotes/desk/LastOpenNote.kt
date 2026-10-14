package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode

/**
 * Which note to reopen after a restart.
 * Ported from `fanotes/src/lib/lastOpenNote.ts`.
 */

fun collectNotePaths(nodes: List<VaultNode>): List<String> {
    val paths = mutableListOf<String>()
    fun walk(list: List<VaultNode>) {
        for (node in list) {
            if (node.kind == NoteKind.FOLDER) walk(node.children) else paths += node.path
        }
    }
    walk(nodes)
    return paths
}

/** Prefer the last opened path when it still exists; otherwise the fallback or the first note. */
fun chooseRestoredNote(savedPath: String?, treePaths: List<String>?, fallback: String? = null): String? {
    val paths = treePaths?.filter { it.isNotEmpty() } ?: emptyList()
    val saved = savedPath ?: ""
    if (saved.isNotEmpty() && saved in paths) return saved
    val next = fallback ?: ""
    if (next.isNotEmpty() && next in paths) return next
    return paths.firstOrNull()
}
