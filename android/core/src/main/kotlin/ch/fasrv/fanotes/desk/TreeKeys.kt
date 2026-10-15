package ch.fasrv.fanotes.desk

/**
 * Keyboard movement in the file tree, matching the desktop row keys:
 * arrows, Home, End, F2, Delete, Enter, and Shift+Enter.
 */
data class TreeKeyNode(
    val path: String,
    val folder: Boolean,
    val children: List<TreeKeyNode> = emptyList(),
)

enum class TreeKeyAction { OPEN, OPEN_SPLIT, RENAME, DELETE }

data class TreeKeyStep(
    val focus: String?,
    val expanded: Set<String>,
    val action: TreeKeyAction? = null,
)

fun visibleTreePaths(nodes: List<TreeKeyNode>, expanded: Set<String>): List<String> {
    val paths = ArrayList<String>()
    fun walk(list: List<TreeKeyNode>) {
        for (node in list) {
            paths += node.path
            if (node.folder && node.path in expanded) walk(node.children)
        }
    }
    walk(nodes)
    return paths
}

fun applyTreeKey(nodes: List<TreeKeyNode>, expanded: Set<String>, focus: String?, key: String): TreeKeyStep {
    val visible = visibleTreePaths(nodes, expanded)
    val index = visible.indexOf(focus ?: "")
    val current = if (index >= 0) focus else null
    val node = current?.let { findTreeNode(nodes, it) }
    return when (key) {
        "down" -> TreeKeyStep(moveTreeFocus(visible, index, 1), expanded)
        "up" -> TreeKeyStep(moveTreeFocus(visible, index, -1), expanded)
        "home" -> TreeKeyStep(visible.firstOrNull(), expanded)
        "end" -> TreeKeyStep(visible.lastOrNull(), expanded)
        "right" -> when {
            node == null -> TreeKeyStep(visible.firstOrNull(), expanded)
            !node.folder -> TreeKeyStep(current, expanded)
            node.path !in expanded -> TreeKeyStep(current, toggleExpandedFolder(expanded, node.path, true))
            else -> TreeKeyStep(visible[(index + 1).coerceAtMost(visible.lastIndex)], expanded)
        }
        "left" -> when {
            node == null -> TreeKeyStep(visible.firstOrNull(), expanded)
            node.folder && node.path in expanded -> TreeKeyStep(current, toggleExpandedFolder(expanded, node.path, false))
            else -> {
                val parent = parentFolderOf(node.path)
                TreeKeyStep(if (parent.isEmpty()) current else parent, expanded)
            }
        }
        "rename" -> TreeKeyStep(current, expanded, if (node == null) null else TreeKeyAction.RENAME)
        "delete" -> TreeKeyStep(current, expanded, if (node == null) null else TreeKeyAction.DELETE)
        "split" -> TreeKeyStep(current, expanded, if (node == null || node.folder) null else TreeKeyAction.OPEN_SPLIT)
        "open" -> when {
            node == null -> TreeKeyStep(visible.firstOrNull(), expanded)
            node.folder -> TreeKeyStep(current, toggleExpandedFolder(expanded, node.path))
            else -> TreeKeyStep(current, expanded, TreeKeyAction.OPEN)
        }
        else -> TreeKeyStep(current, expanded)
    }
}

private fun moveTreeFocus(visible: List<String>, index: Int, direction: Int): String? {
    if (visible.isEmpty()) return null
    if (index < 0) return if (direction < 0) visible.last() else visible.first()
    return visible[(index + direction).coerceIn(0, visible.lastIndex)]
}

private fun findTreeNode(nodes: List<TreeKeyNode>, path: String): TreeKeyNode? {
    for (node in nodes) {
        if (node.path == path) return node
        if (node.folder) findTreeNode(node.children, path)?.let { return it }
    }
    return null
}
