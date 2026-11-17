package ch.fasrv.fanotes.vault

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StoryFilesTest {
    private fun vault() = DirectoryVault(Files.createTempDirectory("story"))

    @Test
    fun `reads and writes only inside a story folder`() {
        val io = vault()
        StoryFiles.write(io, "Schule/Roman.story/story.json", "{\"a\":1}")
        StoryFiles.write(io, "Schule/Roman.story/scenes/abc123def.json", "{}")
        StoryFiles.write(io, "Schule/Roman.story/bible/characters/abcdef12.json", "{\"name\":\"Mila\"}")
        assertEquals("{\"a\":1}", StoryFiles.read(io, "Schule/Roman.story/story.json"))
        assertNull(StoryFiles.read(io, "Schule/Roman.story/scenes/missing01.json"))
        for (bad in listOf("Schule/Notiz.md", "Roman.story/../x.json", "Roman.story/a/b/c/d/e.json", "Roman.story/x.txt", "Roman.story/.hidden.json", "/etc/Roman.story/x.json", "Roman.story/a b.json")) {
            assertFailsWith<IllegalArgumentException>(bad) { StoryFiles.write(io, bad, "{}") }
        }
        assertFailsWith<IllegalArgumentException> { StoryFiles.write(io, "Roman.story/big.json", "x".repeat(StoryFiles.MAX_FILE_BYTES + 1)) }
    }

    @Test
    fun `lists files relative to the story and creates free names`() {
        val io = vault()
        StoryFiles.write(io, "Roman.story/story.json", "{}")
        StoryFiles.write(io, "Roman.story/scenes/abc123def.json", "{}")
        StoryFiles.write(io, "Roman.story/snapshots/abc123def/20261115T153012Z-dev1.json", "{}")
        io.write("Roman.story/scenes/.tmp-x.json", "{}".toByteArray())
        assertEquals(listOf("scenes/abc123def.json", "snapshots/abc123def/20261115T153012Z-dev1.json", "story.json"), StoryFiles.list(io, "Roman.story"))
        assertEquals("Ordner/Roman.story", StoryFiles.create(io, "Ordner", "Roman"))
        assertEquals("Ordner/Roman 2.story", StoryFiles.create(io, "Ordner", "Roman.story"))
        assertEquals("Geschichte.story", StoryFiles.create(io, "", "../"))
        assertTrue(StoryFiles.isStoryFolder("Ordner/Roman 2.story"))
        assertFailsWith<IllegalArgumentException> { StoryFiles.list(io, "Ordner") }
    }
}
