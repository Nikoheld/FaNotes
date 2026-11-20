package ch.fasrv.fanotes.famd

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.sync.isSyncablePath
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.NoteStore
import ch.fasrv.fanotes.vault.VaultNode
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Desktop "Leere Seiten daneben" stores blank side pages of a PDF note in
 * `.fanotes/pdf-side/<pdf>.famd` (fixture written by the desktop serializer,
 * fanotes/src/lib/pdfSidePages.ts). Android shows no side pages, but must read
 * such a vault without errors and never lose or rewrite that file.
 */
class PdfSidePagesCompatTest {
    private val fixture: String =
        requireNotNull(javaClass.getResourceAsStream("/famd/pdf-side-pages.famd")).use { it.readBytes().decodeToString() }
    private val sidePath = ".fanotes/pdf-side/Biologie/Blatt.pdf.famd"

    @Test
    fun parsesTheSideCompanionAsAnOrdinaryFamd() {
        val parsed = parseFamd(fixture)
        val payload = assertNotNull(parsed.payload)
        assertEquals(FAMD_SCHEMA, payload.string("schema"))
        val store = assertNotNull(payload.obj("ink"))
        assertEquals("fanotes-pdf-side-pages", store.string("kind"))
        val pages = assertNotNull(store.array("ink")).items.map { it as JsonValue.Obj }
        assertEquals(listOf(1, 3), pages.map { (it["page"] as JsonValue.Num).value.toInt() })
        assertTrue(inkHasMarks(payload), "the blank-note check sees the side ink")
    }

    @Test
    fun syncKeepsTheBytesAndCountsTheFileAsContent() {
        val bytes = fixture.encodeToByteArray()
        assertTrue(isSyncablePath(sidePath))
        assertEquals(NoteSyncKind.PRESENT, noteSyncKind(sidePath, bytes))
        assertContentEquals(bytes, canonicalSyncBytes(sidePath, bytes))
        assertNotNull(identitySyncBytes(sidePath, bytes))
        // An Android rewrite of the payload (the serializer every save uses) keeps the side pages whole.
        val rewritten = serializeFamd(parseFamd(fixture).markdown, parseFamd(fixture).payload!!)
        assertEquals(fixture, rewritten)
    }

    @Test
    fun theVaultTreeHidesItAndNoteSavesLeaveItAlone() {
        val root = Files.createTempDirectory("fanotes-pdf-side")
        val vault = DirectoryVault(root)
        vault.write("Biologie/Blatt.pdf", "%PDF-1.4\n%%EOF\n".encodeToByteArray())
        vault.write(sidePath, fixture.encodeToByteArray())
        vault.write("Biologie/Notiz.md", "# Notiz\n".encodeToByteArray())
        val store = NoteStore(vault)
        val paths = mutableListOf<String>()
        fun walk(nodes: List<VaultNode>) {
            nodes.forEach { node -> paths.add(node.path); walk(node.children) }
        }
        walk(store.tree())
        assertTrue(paths.contains("Biologie/Blatt.pdf"), "the PDF note is listed: $paths")
        assertTrue(paths.none { it.startsWith(".fanotes") || it.contains("pdf-side") }, "side pages stay hidden: $paths")
        val note = store.readNote("Biologie/Notiz.md")
        store.save(note, note.document, "# Notiz\n\nAndroid")
        assertEquals(fixture, vault.read(sidePath)!!.decodeToString())
    }
}
