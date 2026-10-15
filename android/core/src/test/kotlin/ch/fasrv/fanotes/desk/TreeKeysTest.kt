package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TreeKeysTest {
    private val tree = listOf(
        TreeKeyNode(
            "Schule",
            folder = true,
            children = listOf(
                TreeKeyNode("Schule/Mathe.md", folder = false),
                TreeKeyNode(
                    "Schule/Physik",
                    folder = true,
                    children = listOf(TreeKeyNode("Schule/Physik/Blatt.md", folder = false)),
                ),
            ),
        ),
        TreeKeyNode("Chemie.md", folder = false),
    )

    @Test
    fun arrowsWalkVisibleRowsAndOpenOrCloseFolders() {
        val collapsed = applyTreeKey(tree, emptySet(), null, "down")
        assertEquals("Schule", collapsed.focus)
        val opened = applyTreeKey(tree, emptySet(), "Schule", "right")
        assertEquals(setOf("Schule"), opened.expanded)
        val visible = setOf("Schule")
        assertEquals(
            listOf("Schule", "Schule/Mathe.md", "Schule/Physik", "Chemie.md"),
            visibleTreePaths(tree, visible),
        )
        assertEquals("Schule/Mathe.md", applyTreeKey(tree, visible, "Schule", "right").focus)
        assertEquals("Schule", applyTreeKey(tree, visible, "Schule/Mathe.md", "left").focus)
        assertEquals(emptySet(), applyTreeKey(tree, visible, "Schule", "left").expanded)
        val deep = setOf("Schule", "Schule/Physik")
        assertEquals("Chemie.md", applyTreeKey(tree, deep, "Schule/Physik/Blatt.md", "down").focus)
        assertEquals("Schule", applyTreeKey(tree, deep, "Chemie.md", "home").focus)
        assertEquals("Chemie.md", applyTreeKey(tree, deep, "Schule", "end").focus)
    }

    @Test
    fun renameDeleteAndShiftEnterUseTheFocusedRow() {
        assertEquals(TreeKeyAction.RENAME, applyTreeKey(tree, setOf("Schule"), "Schule/Mathe.md", "rename").action)
        assertEquals(TreeKeyAction.DELETE, applyTreeKey(tree, emptySet(), "Chemie.md", "delete").action)
        assertEquals(TreeKeyAction.OPEN_SPLIT, applyTreeKey(tree, emptySet(), "Chemie.md", "split").action)
        assertNull(applyTreeKey(tree, setOf("Schule"), "Schule", "split").action)
        assertEquals(TreeKeyAction.OPEN, applyTreeKey(tree, emptySet(), "Chemie.md", "open").action)
        assertEquals(emptySet(), applyTreeKey(tree, setOf("Schule"), "Schule", "open").expanded)
    }
}
