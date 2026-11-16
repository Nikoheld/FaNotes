package ch.fasrv.fanotes.vault

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VaultHeadTest {
    /** Hands out a few bytes per read, like a pipe or a slow provider. */
    private class Trickle(private val bytes: ByteArray, private val step: Int) : InputStream() {
        private var at = 0
        override fun read(): Int = if (at < bytes.size) bytes[at++].toInt() and 0xff else -1
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (at >= bytes.size) return -1
            val count = minOf(step, length, bytes.size - at)
            System.arraycopy(bytes, at, buffer, offset, count)
            at += count
            return count
        }
    }

    private fun data(size: Int) = ByteArray(size) { (it % 251).toByte() }

    @Test
    fun readsExactlyTheCapAndNoticesMore() {
        for (size in listOf(0, 1, 99, 100, 101, 70_000, 200_000)) {
            for (hint in listOf(-1L, size.toLong(), 5L, 1_000_000L)) {
                val head = readHeadFrom(ByteArrayInputStream(data(size)), 100, hint)
                assertEquals(size <= 100, head.complete, "size $size, hint $hint")
                assertContentEquals(data(size).copyOf(minOf(size, 100)), head.bytes, "size $size, hint $hint")
            }
        }
    }

    @Test
    fun aStreamThatTricklesIsStillReadToTheCap() {
        val head = readHeadFrom(Trickle(data(300_000), 7), 200_000)
        assertFalse(head.complete)
        assertEquals(200_000, head.bytes.size)
        assertContentEquals(data(300_000).copyOf(200_000), head.bytes)
        val whole = readHeadFrom(Trickle(data(1000), 3), 5000, 1000)
        assertTrue(whole.complete)
        assertContentEquals(data(1000), whole.bytes)
    }

    @Test
    fun aCapOfZeroOnlyProbesTheFile() {
        val some = readHeadFrom(ByteArrayInputStream(data(5)), 0)
        assertFalse(some.complete)
        assertEquals(0, some.bytes.size)
        assertTrue(readHeadFrom(ByteArrayInputStream(ByteArray(0)), 0).complete)
    }

    @Test
    fun theDirectoryVaultReadsAHeadAndAnEntryHeadAndReportsMissingFiles() {
        val root = Files.createTempDirectory("fanotes-head")
        try {
            val vault = DirectoryVault(root)
            vault.write("a/b.md", data(500))
            val head = vault.readHead("a/b.md", 100)!!
            assertFalse(head.complete)
            assertContentEquals(data(500).copyOf(100), head.bytes)
            val entry = vault.list("a").single()
            assertNull(entry.handle, "a plain directory has no handles")
            assertTrue(vault.readHead(entry, 1000)!!.complete)
            assertNull(vault.readHead("a/missing.md", 10))
            assertNull(vault.readHead("a", 10), "a directory is not a file")
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    /** A vault that does not override readHead, so the interface default is what runs. */
    private object ReadOnly : VaultIo {
        override fun read(path: String): ByteArray? = if (path == "x") ByteArray(300) { 1 } else null
        override fun write(path: String, bytes: ByteArray) { error("unused") }
        override fun delete(path: String) { error("unused") }
        override fun move(from: String, to: String) { error("unused") }
        override fun exists(path: String) = true
        override fun mtime(path: String) = 0L
        override fun list(directory: String): List<VaultEntry> = emptyList()
        override fun walkFiles(): List<VaultEntry> = emptyList()
        override fun mkdir(path: String) { error("unused") }
    }

    @Test
    fun theInterfaceDefaultCutsAFullRead() {
        val cut = ReadOnly.readHead("x", 100)!!
        assertFalse(cut.complete)
        assertEquals(100, cut.bytes.size)
        assertTrue(ReadOnly.readHead("x", 300)!!.complete)
        assertNull(ReadOnly.readHead("missing", 10))
        assertEquals(300, ReadOnly.readHead(VaultEntry("x", false, 300, 0), 1000)!!.bytes.size, "an entry reads by its path by default")
        assertTrue(ReadOnly.list(VaultEntry("d", true, 0, 0)).isEmpty(), "a directory entry lists by its path by default")
    }
}
