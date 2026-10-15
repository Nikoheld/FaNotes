package ch.fasrv.fanotes.desk

import kotlin.math.round
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class WorkspaceNavTest {
    @Test
    fun aSubfolderSitsBesideTheOpenNoteAndTheSplitSwaps() {
        assertEquals("", parentFolderOf("Mathe.md"))
        assertEquals("Schule", parentFolderOf("Schule/Mathe.md"))
        assertEquals("Schule/Unter", parentFolderOf("Schule/Unter/Blatt.md"))
        assertNull(swappedSplit(null, "B.md"))
        assertNull(swappedSplit("A.md", null))
        assertNull(swappedSplit("A.md", "A.md"))
        assertEquals("B.md" to "A.md", swappedSplit("A.md", "B.md"))
        assertEquals(emptyList(), parentFolders("Note.md"))
        assertEquals(listOf("Schule", "Schule/Unter"), parentFolders("Schule/Unter/Blatt.md"))
        assertEquals(setOf("Schule"), toggleExpandedFolder(emptySet(), "Schule"))
        assertEquals(emptySet(), toggleExpandedFolder(setOf("Schule"), "Schule"))
        assertEquals(setOf("Schule"), toggleExpandedFolder(setOf("Schule"), "Schule", forceOpen = true))
        assertEquals(setOf("Schule", "Schule/Unter"), revealExpandedFolders(setOf("Schule"), "Schule/Unter/Blatt.md"))
        assertEquals(setOf("Archiv", "Archiv/Alt"), remapExpandedFolders(setOf("Schule", "Schule/Alt"), "Schule", "Archiv"))
        assertEquals(setOf("Schule", "Schule/Unter"), parseExpandedFolders(expandedFoldersJson(listOf("Schule", "Schule/Unter", ""))))
        assertEquals(emptySet(), parseExpandedFolders("{"))
        assertEquals(emptySet(), parseExpandedFolders(null))
        assertEquals(
            listOf("Archiv", "Archiv/Alt", "Schule/Unter"),
            movableFolderTargets(listOf("Schule", "Archiv", "Archiv/Alt", "Schule/Unter"), "Schule/Mathe.md"),
        )
        assertEquals(
            listOf("Archiv"),
            movableFolderTargets(listOf("Schule", "Schule/Unter", "Archiv"), "Schule"),
        )
        val rows = listOf(
            TreeRowBox("Archiv", true, TreeBox(0f, 0f, 100f, 20f)),
            TreeRowBox("Archiv/A.md", false, TreeBox(0f, 20f, 100f, 40f)),
            TreeRowBox("Schule", true, TreeBox(0f, 40f, 100f, 60f)),
        )
        val list = TreeBox(0f, 0f, 100f, 80f)
        assertEquals("Archiv", resolveTreeDrop("Note.md", false, rows, 10f, 10f, list))
        assertEquals("Archiv", resolveTreeDrop("Note.md", false, rows, 10f, 30f, list))
        assertEquals("", resolveTreeDrop("Archiv/A.md", false, rows, 10f, 70f, list))
        assertNull(resolveTreeDrop("Archiv/A.md", false, rows, 10f, 10f, list))
        assertEquals("Archiv", resolveTreeDrop("Schule", true, rows, 10f, 30f, list))
        assertNull(resolveTreeDrop("Schule", true, rows, 10f, 50f, list))
        assertNull(resolveTreeDrop("Note.md", false, rows, 200f, 10f, list))
        assertEquals("", treeDropFolder("root", "ignored"))
        assertEquals("Archiv", treeDropFolder("folder", "Archiv"))
        assertEquals("Archiv", treeDropFolder("file", "Archiv/A.md"))
        val empty = listOf(TreeRowBox("Archiv", true, TreeBox(0f, 60f, 100f, 86f)))
        assertEquals("Archiv", resolveTreeDrop("Note.md", false, rows + empty, 12f, 70f, list))
    }

    @Test
    fun openOnTheRightKeepsTheCurrentNoteAndPicksAnotherTab() {
        val tabs = listOf("a.md", "b.md", "c.md")
        assertEquals("d.md", splitPanePath("d.md", "a.md", tabs, listOf("a.md", "c.md", "b.md")))
        assertEquals("b.md", splitPanePath("a.md", "a.md", tabs, listOf("a.md", "c.md", "b.md")))
        assertEquals("c.md", splitPanePath("a.md", "a.md", listOf("a.md", "c.md"), listOf("a.md", "b.md")))
        assertEquals("b.md", splitPanePath("a.md", "a.md", tabs, listOf("a.md")))
        assertNull(splitPanePath("a.md", "a.md", listOf("a.md"), listOf("a.md")))
        assertNull(splitPanePath("", "a.md", tabs, emptyList()))
        assertTrue(tabShowsUnsaved("a.md", "a.md", "b.md", activeDirty = true, splitDirty = false))
        assertTrue(tabShowsUnsaved("b.md", "a.md", "b.md", activeDirty = false, splitDirty = true))
        assertEquals(false, tabShowsUnsaved("a.md", "a.md", "a.md", activeDirty = false, splitDirty = true))
        assertEquals(false, tabShowsUnsaved("c.md", "a.md", "b.md", activeDirty = true, splitDirty = true))
        assertTrue(rowIsSplitCompanion("b.md", "a.md", "b.md"))
        assertEquals(false, rowIsSplitCompanion("a.md", "a.md", "a.md"))
        assertEquals(false, rowIsSplitCompanion("c.md", "a.md", "b.md"))
    }

    @Test
    fun visitedNotesWalkBackAndDropTheForwardTail() {
        var history = EMPTY_NOTE_TRAIL
        assertEquals(false, canGoBack(history))
        assertEquals(false, canGoForward(history))
        history = visitNote(history, "A.md")
        history = visitNote(history, "B.md")
        history = visitNote(history, "B.md")
        history = visitNote(history, "C.md")
        assertEquals(NoteTrail(listOf("A.md", "B.md", "C.md"), 2), history)
        assertEquals(true, canGoBack(history))
        assertEquals(false, canGoForward(history))

        var step = stepNoteHistory(history, -1)
        assertEquals("B.md", step.path)
        assertEquals(1, step.history.index)
        assertEquals(true, canGoForward(step.history))
        step = stepNoteHistory(history, -1) { path -> path != "B.md" }
        assertEquals("A.md", step.path)
        assertEquals(0, step.history.index)
        step = stepNoteHistory(step.history, 1) { path -> path != "B.md" }
        assertEquals("C.md", step.path)

        val branched = visitNote(NoteTrail(listOf("A.md", "B.md", "C.md"), 0), "D.md")
        assertEquals(NoteTrail(listOf("A.md", "D.md"), 1), branched)

        var long = EMPTY_NOTE_TRAIL
        repeat(NOTE_HISTORY_LIMIT + 25) { index -> long = visitNote(long, "n$index.md") }
        assertEquals(NOTE_HISTORY_LIMIT, long.entries.size)
        assertEquals(NOTE_HISTORY_LIMIT - 1, long.index)
        assertEquals("n${NOTE_HISTORY_LIMIT + 24}.md", long.entries[long.index])
        assertSame(long, visitNote(long, ""))
    }

    @Test
    fun renameFollowsAndTrashForgets() {
        val moved = remapNoteHistory(NoteTrail(listOf("Math/a.md", "Bio/b.md", "Math/c.md"), 2), "Math", "Maths")
        assertEquals(listOf("Maths/a.md", "Bio/b.md", "Maths/c.md"), moved.entries)
        val renamedOnto = remapNoteHistory(NoteTrail(listOf("a.md", "b.md", "a.md"), 2), "b.md", "a.md")
        assertEquals(NoteTrail(listOf("a.md"), 0), renamedOnto)
        val forgotten = forgetNoteHistory(NoteTrail(listOf("a.md", "T/x.md", "b.md", "T/y.md"), 2), "T")
        assertEquals(NoteTrail(listOf("a.md", "b.md"), 1), forgotten)
        val forgotCurrent = forgetNoteHistory(NoteTrail(listOf("a.md", "b.md"), 1), "b.md")
        assertEquals(NoteTrail(listOf("a.md"), 0), forgotCurrent)
        val current = NoteTrail(listOf("a.md"), 0)
        val stuck = stepNoteHistory(current, 1) { false }
        assertNull(stuck.path)
        assertSame(current, stuck.history)
    }

    @Test
    fun breadcrumbsStripTheNoteExtension() {
        assertEquals("Science/Notes/x.md", remapPath("Math/Notes/x.md", "Math", "Science"))
        assertNull(remapPath("Mathematics/x.md", "Math", "Science"))
        assertEquals(
            listOf(
                Breadcrumb("Math", "Math", false),
                Breadcrumb("Algebra", "Math/Algebra", false),
                Breadcrumb("Sets", "Math/Algebra/Sets.md", true),
            ),
            breadcrumbsFor("Math/Algebra/Sets.md"),
        )
        assertEquals(listOf(Breadcrumb("Welcome", "Welcome.md", true)), breadcrumbsFor("Welcome.md"))
    }

    @Test
    fun splitTracksSnapToDevicePixels() {
        assertEquals(SPLIT_MIN_RATIO, clampSplitRatio(0.05))
        assertEquals(SPLIT_MAX_RATIO, clampSplitRatio(0.95))
        assertEquals(DEFAULT_SPLIT_LAYOUT.ratio, clampSplitRatio(Double.NaN))
        val box = SplitBox(100.0, 50.0, 1000.0, 600.0)
        assertEquals(0.3, splitRatioFromPointer(box, SplitPointer(400.0, 0.0), SplitOrientation.COLUMNS))
        assertEquals(0.5, splitRatioFromPointer(box, SplitPointer(0.0, 350.0), SplitOrientation.ROWS))
        assertEquals(SPLIT_MAX_RATIO, splitRatioFromPointer(box, SplitPointer(5000.0, 0.0), SplitOrientation.COLUMNS))
        assertEquals(0.55, nudgeSplitRatio(0.5, 1))
        assertEquals(SPLIT_MIN_RATIO, nudgeSplitRatio(0.22, -1))
        assertEquals(529.0, splitFirstPaneSize(1064.0, 7.0, 0.5, 1.0))
        assertEquals(661.0, splitFirstPaneSize(1064.0, 7.0, 0.5, 1.25) * 1.25, 1e-9)
        assertEquals(528.5, splitFirstPaneSize(1064.0, 7.0, 0.5, 2.0))
        assertEquals(round(1057.0 * SPLIT_MAX_RATIO), splitFirstPaneSize(1064.0, 7.0, 5.0, 1.0))
        assertEquals(0.0, splitFirstPaneSize(Double.NaN, 7.0, 0.5, 0.0))
        assertEquals(9.0, snapToDevicePixels(7.0, 1.25) * 1.25, 1e-9)
        assertEquals(7.0, snapToDevicePixels(7.0, 1.0))
        assertEquals(SplitLayout(0.6, SplitOrientation.ROWS), normalizeSplitLayout(mapOf("ratio" to 0.6, "orientation" to "rows")))
        assertEquals(DEFAULT_SPLIT_LAYOUT, normalizeSplitLayout(mapOf("ratio" to "x", "orientation" to "diagonal")))
        assertEquals(DEFAULT_SPLIT_LAYOUT, normalizeSplitLayout(null))
        assertEquals(0.5, splitRatioFromSetting(null))
        assertEquals(0.35, splitRatioFromSetting("0.35"))
        assertEquals(SPLIT_MIN_RATIO, splitRatioFromSetting("0"))
        assertEquals(0.5, splitRatioFromSetting("halb"))
        assertEquals(0.55, splitDividerRatio(false, "right", 0.5))
        assertEquals(0.45, splitDividerRatio(false, "left", 0.5))
        assertEquals(null, splitDividerRatio(false, "up", 0.5))
        assertEquals(0.45, splitDividerRatio(true, "up", 0.5))
        assertEquals(0.55, splitDividerRatio(true, "down", 0.5))
        assertEquals(null, splitDividerRatio(true, "left", 0.5))
        assertEquals(SPLIT_MIN_RATIO, splitDividerRatio(false, "home", 0.5))
        assertEquals(SPLIT_MAX_RATIO, splitDividerRatio(true, "end", 0.5))
        assertEquals(0.5, splitDividerRatio(true, "enter", 0.72))
        assertEquals(null, splitDividerRatio(false, "a", 0.5))
    }

    @Test
    fun tabsPinReorderAndRememberClosed() {
        val tabs = listOf(DeskTab("a"), DeskTab("b", pinned = true), DeskTab("c"), DeskTab("d", pinned = true))
        assertEquals(listOf("b", "d", "a", "c"), sortPinnedFirst(tabs).map { it.path })
        val pinnedFirst = sortPinnedFirst(tabs)
        assertEquals(listOf("b", "d", "c", "a"), reorderTabs(pinnedFirst, "c", "a").map { it.path })
        assertEquals(listOf("b", "d", "c", "a"), reorderTabs(pinnedFirst, "a", null).map { it.path })
        assertSame(pinnedFirst, reorderTabs(pinnedFirst, "c", "b"))
        assertSame(pinnedFirst, reorderTabs(pinnedFirst, "b", "a"))
        assertSame(pinnedFirst, reorderTabs(pinnedFirst, "b", null))
        assertEquals(listOf("d", "b", "a", "c"), reorderTabs(pinnedFirst, "d", "b").map { it.path })
        val open = listOf(DeskTab("a"), DeskTab("b"), DeskTab("c"))
        assertEquals(listOf("b", "a", "c"), moveTab(open, "a", "b", "after").map { it.path })
        assertEquals(listOf("a", "c", "b"), moveTab(open, "c", "a", "after").map { it.path })
        assertEquals(listOf("b", "c", "a"), moveTab(open, "a", null, "after").map { it.path })
        assertEquals(listOf("b", "a", "c"), moveTab(open, "b", "a", "after").map { it.path })
        val mixed = listOf(DeskTab("a", pinned = true), DeskTab("b"), DeskTab("c"))
        assertSame(mixed, moveTab(mixed, "b", "a", "before"))
        assertEquals(listOf("a", "c", "b"), moveTab(mixed, "c", "b", "before").map { it.path })
        assertEquals(
            listOf("b" to true, "a" to false),
            togglePinnedTab(listOf(DeskTab("a"), DeskTab("b")), "b").map { it.path to it.pinned },
        )
        assertEquals(0, tabIndexForDigit(1, 3))
        assertEquals(2, tabIndexForDigit(3, 3))
        assertNull(tabIndexForDigit(4, 3))
        assertEquals(2, tabIndexForDigit(9, 3))
        assertNull(tabIndexForDigit(9, 0))
        assertEquals(listOf("c"), tabsToClose(pinnedFirst, "a", "others"))
        assertEquals(listOf("c"), tabsToClose(pinnedFirst, "a", "right"))
        assertEquals(emptyList(), tabsToClose(pinnedFirst, "c", "right"))
        assertEquals(emptyList(), tabsToClose(pinnedFirst, "zzz", "others"))
        var closed = emptyList<String>()
        repeat(CLOSED_TABS_LIMIT + 5) { index -> closed = rememberClosedTab(closed, "t$index") }
        assertEquals(CLOSED_TABS_LIMIT, closed.size)
        assertEquals("t${CLOSED_TABS_LIMIT + 4}", closed.first())
        assertEquals(listOf("b", "a"), rememberClosedTab(listOf("a", "b"), "b"))
    }

    @Test
    fun workspaceMemoryDropsMissingNotes() {
        val memory = normalizeWorkspaceMemory(
            mapOf(
                "tabs" to listOf("a", "b", "a", 7, ""),
                "pinned" to listOf("b", "zzz"),
                "active" to "a",
                "split" to "b",
            ),
        )
        assertEquals(WorkspaceMemory(listOf("a", "b"), listOf("b"), "a", "b"), memory)
        assertNull(normalizeWorkspaceMemory("nope"))
        assertNull(normalizeWorkspaceMemory(mapOf("tabs" to listOf("a"), "active" to "gone", "split" to "a"))?.active)
        val pruned = pruneWorkspaceMemory(
            WorkspaceMemory(listOf("a", "b", "c"), listOf("a", "c"), "c", "b"),
        ) { path -> path != "c" }
        assertEquals(WorkspaceMemory(listOf("a", "b"), listOf("a"), null, "b"), pruned)
        assertNull(pruneWorkspaceMemory(WorkspaceMemory(listOf("a"), emptyList(), "a", "a")) { true }.split)
        val stored = WorkspaceMemory(listOf("a", "b"), emptyList(), "a", "b")
        assertEquals(stored, parseWorkspaceMemory(workspaceMemoryJson(stored)))
        assertNull(parseWorkspaceMemory("{not json"))
        assertEquals("${WORKSPACE_STORAGE_PREFIX}default", workspaceStorageKey(""))
    }

    @Test
    fun quickSwitcherRanksRecentNotesThenFuzzyTitles() {
        assertEquals(SwitcherNote("Math/Algebra/Sets.md", "Sets", "Math › Algebra"), switcherNoteFor("Math/Algebra/Sets.md"))
        assertTrue(fuzzyScore("sets", "Sets") > fuzzyScore("sets", "Subsets and Extras"))
        assertTrue(fuzzyScore("alg", "Algebra") > fuzzyScore("alg", "Analog"))
        assertEquals(0, fuzzyScore("xyz", "Sets"))
        assertEquals(1, fuzzyScore("", "Anything"))
        assertTrue(fuzzyScore("ubung", "Übung") > 0)
        val paths = listOf("Math/Sets.md", "Bio/Cells.md", "Inbox/Untitled Note 2.md", "Welcome.md", "Inbox/Untitled Note.md")
        val recentFirst = rankSwitcherNotes(paths, "", listOf("Bio/Cells.md", "Welcome.md")).map { it.path }
        assertEquals(listOf("Bio/Cells.md", "Welcome.md"), recentFirst.take(2))
        assertEquals(listOf("Math/Sets.md", "Inbox/Untitled Note.md", "Inbox/Untitled Note 2.md"), recentFirst.drop(2))
        assertEquals("Inbox/Untitled Note 2.md", rankSwitcherNotes(paths, "un2").first().path)
        assertEquals("Bio/Cells.md", rankSwitcherNotes(paths, "cells").first().path)
        assertEquals(emptyList(), rankSwitcherNotes(paths, "zzzz"))
        assertEquals(2, rankSwitcherNotes(paths, "", emptyList(), 2).size)
        assertEquals("Math/Sets.md", rankSwitcherNotes(listOf("Sets/Intro.md", "Math/Sets.md"), "sets").first().path)
        assertEquals(
            listOf("Inbox/Note 2.md", "Inbox/Note 10.md"),
            rankSwitcherNotes(listOf("Inbox/Note 10.md", "Inbox/Note 2.md"), "").map { it.path },
        )
    }
}
