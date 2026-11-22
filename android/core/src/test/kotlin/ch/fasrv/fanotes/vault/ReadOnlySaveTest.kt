package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.FILE_ERROR_READ_ONLY
import ch.fasrv.fanotes.desk.friendlyFileError
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ReadOnlySaveTest {
    @Test
    fun aReadOnlyNoteIsNotReplacedByASave() {
        val root = Files.createTempDirectory("fanotes-readonly")
        val store = NoteStore(DirectoryVault(root))
        val path = store.createMarkdown("", "Fest")
        val note = store.readNote(path)
        val file = root.resolve(path)
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("r--r--r--"))
        try {
            if (Files.isWritable(file)) return // running as root: the flag is not enforced
            val before = Files.readAllBytes(file)
            val error = assertFailsWith<java.nio.file.ReadOnlyFileSystemException> {
                store.save(note, note.document, note.markdown + "\nNeu")
            }
            assertEquals(FILE_ERROR_READ_ONLY, friendlyFileError(error, "x"))
            assertTrue(before.contentEquals(Files.readAllBytes(file)))
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"))
            store.save(note, note.document, note.markdown + "\nNeu")
            assertTrue(Files.readString(file).contains("Neu"))
        } finally {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"))
        }
    }
}
