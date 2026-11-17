package ch.fasrv.fanotes.vault

/** What changed in the vault tree between two scans. Folders are listed only by path. */
data class TreeChange(val added: List<String>, val removed: List<String>, val changed: List<String>) {
    val isEmpty: Boolean get() = added.isEmpty() && removed.isEmpty() && changed.isEmpty()
}

private fun signatures(nodes: List<VaultNode>, out: MutableMap<String, String> = LinkedHashMap()): Map<String, String> {
    for (node in nodes) {
        if (node.kind == NoteKind.FOLDER) {
            out[node.path] = "d"
            signatures(node.children, out)
        } else {
            out[node.path] = "f:${node.modifiedAt}"
        }
    }
    return out
}

fun diffTrees(previous: List<VaultNode>, next: List<VaultNode>): TreeChange {
    val before = signatures(previous)
    val after = signatures(next)
    return TreeChange(
        added = after.keys.filter { it !in before },
        removed = before.keys.filter { it !in after },
        changed = after.filter { (path, sig) -> before[path]?.let { it != sig } == true }.keys.toList(),
    )
}

/** Paths of non-folder entries in the tree. */
fun filePaths(tree: List<VaultNode>): Set<String> =
    signatures(tree).filterValues { it != "d" }.keys

/**
 * New-marks after a rescan: earlier marks of files that still exist stay, files that
 * arrived are added (unless [suppress] is set, e.g. FaNotes wrote them itself), and
 * [opened] notes lose their mark.
 */
fun updateArrivals(current: Set<String>, change: TreeChange, next: List<VaultNode>, opened: String?, suppress: Boolean): Set<String> {
    val files = filePaths(next)
    val result = current.filterTo(LinkedHashSet()) { it in files && it != opened }
    if (!suppress) change.added.filterTo(result) { it in files && it != opened }
    return result
}

/** The marked files plus all their parent folders, for drawing markers on folders too. */
fun withParentFolders(paths: Set<String>): Set<String> {
    val result = LinkedHashSet(paths)
    for (path in paths) {
        var cut = path.lastIndexOf('/')
        while (cut > 0) {
            result.add(path.substring(0, cut))
            cut = path.lastIndexOf('/', cut - 1)
        }
    }
    return result
}

/** German toast text, e.g. "3 neue Dateien in Physik", or null when nothing arrived. */
fun arrivalMessage(files: List<String>): String? {
    if (files.isEmpty()) return null
    val parents = files.map { it.substringBeforeLast('/', "") }.toSet()
    val where = parents.singleOrNull()?.takeIf { it.isNotEmpty() }?.substringAfterLast('/')?.let { " in $it" }.orEmpty()
    return if (files.size == 1) "1 neue Datei$where" else "${files.size} neue Dateien$where"
}
