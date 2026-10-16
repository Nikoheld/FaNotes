package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VaultOverviewTest {
    @Test
    fun foldersKeepNestedNotesAndLooseRootNotesBecomeAllgemein() {
        val day = Instant.parse("2026-10-15T12:00:00Z").toEpochMilli()
        val tree = listOf(
            VaultNode(
                "Mathe",
                "Mathe",
                NoteKind.FOLDER,
                0L,
                listOf(
                    VaultNode("Alt", "Mathe/Alt.md", NoteKind.MARKDOWN, day - 86_400_000L),
                    VaultNode("Algebra", "Mathe/Algebra.md", NoteKind.MARKDOWN, day),
                    VaultNode("Buch", "Mathe/Buch.pdf", NoteKind.PDF, day),
                    VaultNode(
                        "Uebung",
                        "Mathe/Uebung",
                        NoteKind.FOLDER,
                        0L,
                        listOf(VaultNode("Blatt", "Mathe/Uebung/Blatt.md", NoteKind.MARKDOWN, day + 1_000L)),
                    ),
                ),
            ),
            VaultNode("Lose", "Lose.md", NoteKind.MARKDOWN, day - 2_000L),
        )
        val picture = vaultOverview(tree, mapOf("Mathe" to "#2a6f97"))
        assertEquals(4, picture.noteCount)
        assertEquals(5, sidebarFileCount(tree))
        assertEquals("5 Notizen", sidebarFileLabel(5))
        assertEquals("1 Notiz", sidebarFileLabel(1))
        assertEquals("0 Notizen", sidebarFileLabel(0))
        assertEquals(34, SIDEBAR_FOOTER_DP)
        assertEquals(14, SIDEBAR_HEADER_PAD_TOP_DP)
        assertEquals(12, SIDEBAR_HEADER_PAD_X_DP)
        assertEquals(14, SIDEBAR_VAULT_SP)
        assertEquals(600, SIDEBAR_VAULT_WEIGHT)
        assertEquals(-0.02f, SIDEBAR_VAULT_TRACKING)
        assertEquals(30, SIDEBAR_ACTION_DP)
        assertEquals(6, SIDEBAR_ACTION_RADIUS_DP)
        assertEquals(34, SIDEBAR_PDF_MIN_DP)
        assertEquals(30, SIDEBAR_SEARCH_DP)
        assertEquals(6, SIDEBAR_SEARCH_RADIUS_DP)
        assertEquals(13, SIDEBAR_SEARCH_SP)
        assertEquals(21, SIDEBAR_SEARCH_CLEAR_DP)
        assertEquals("panel-hover", sidebarSearchFill(true))
        assertEquals("clear", sidebarSearchFill(false))
        assertEquals(22, TAG_FILTER_HEIGHT_DP)
        assertEquals(0.16f, TAG_FILTER_ACTIVE_BORDER_ALPHA)
        assertEquals("panel-active", tagFilterFill(true))
        assertEquals("panel", tagFilterFill(false))
        assertEquals(7, TREE_WRAP_PAD_X_DP)
        assertEquals(1, picture.topFolders)
        assertEquals(listOf("Mathe", "Uebung", "Allgemein"), picture.folders.map { it.name })
        val mathe = picture.folders.first()
        assertEquals(3, mathe.noteCount)
        assertEquals("Blatt", mathe.latestTitle)
        assertEquals("Mathe/Uebung/Blatt.md", mathe.latestPath)
        assertEquals(1, mathe.subfolders)
        assertEquals("#2a6f97", mathe.color)
        assertEquals(257, mathe.hue)
        assertEquals(174, picture.folders[1].hue)
        assertEquals("1 Unterordner", overviewSubfolderLabel(1))
        assertNull(overviewSubfolderLabel(0))
        assertEquals("Blatt", overviewLatestLabel(mathe))
        assertEquals("Mathe: Blatt öffnen", overviewActionLabel(mathe))
        assertEquals("1 Ordner · 4 Notizen", overviewStatsLine(1, 4))
        assertEquals("1 Ordner · 1 Notiz", overviewStatsLine(1, 1))
        assertEquals("15. Okt.", overviewModifiedLabel(day, ZoneOffset.UTC))
        assertEquals("—", overviewModifiedLabel(0L))
        assertEquals("Mathe / Uebung", overviewPathParent("Mathe/Uebung/Blatt.md"))
        assertEquals("Vault", overviewPathParent("Lose.md"))
        assertEquals(listOf("c", "a", "b"), overviewRecent(listOf("a", "b", "a", "c")))
        assertEquals("Blatt", overviewRecentTitle("Mathe/Uebung/Blatt.md"))
    }
}
