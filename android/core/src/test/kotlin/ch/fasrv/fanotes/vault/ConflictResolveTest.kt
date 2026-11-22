package ch.fasrv.fanotes.vault

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConflictResolveTest {
    private fun vault() = DirectoryVault(Files.createTempDirectory("fanotes-conflict"))

    @Test
    fun keepingTheLocalVersionOfABinaryFileKeepsEveryByte() {
        val io = vault()
        val bytes = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x80.toByte(), 0xff.toByte(), 0xc3.toByte(), 0x00, 0x1b)
        io.write("Blatt.pdf", byteArrayOf(1, 2, 3))
        io.write("Blatt (Konflikt Tab 2026-11-22 10-00).pdf", bytes)
        resolveConflictFiles(io, "Blatt.pdf", "Blatt (Konflikt Tab 2026-11-22 10-00).pdf", "local")
        assertContentEquals(bytes, io.read("Blatt.pdf"))
        assertFalse(io.exists("Blatt (Konflikt Tab 2026-11-22 10-00).pdf"))
    }

    @Test
    fun mergingKeepsBothTextsAndRemovesTheCopy() {
        val io = vault()
        io.write("A.md", "Eins\n".encodeToByteArray())
        io.write("A (Konflikt Tab 2026-11-22 10-00).md", "Zwei\n".encodeToByteArray())
        resolveConflictFiles(io, "A.md", "A (Konflikt Tab 2026-11-22 10-00).md", "both")
        assertEquals("Eins\n\nZwei\n", io.read("A.md")!!.decodeToString())
        assertFalse(io.exists("A (Konflikt Tab 2026-11-22 10-00).md"))
    }

    @Test
    fun anUnmergeableFileIsNotReportedAsResolved() {
        val io = vault()
        io.write("B.png", byteArrayOf(1))
        io.write("B (Konflikt Tab 2026-11-22 10-00).png", byteArrayOf(2))
        assertFailsWith<IllegalArgumentException> { resolveConflictFiles(io, "B.png", "B (Konflikt Tab 2026-11-22 10-00).png", "both") }
        assertTrue(io.exists("B (Konflikt Tab 2026-11-22 10-00).png"))
        assertContentEquals(byteArrayOf(1), io.read("B.png"))
    }
}
