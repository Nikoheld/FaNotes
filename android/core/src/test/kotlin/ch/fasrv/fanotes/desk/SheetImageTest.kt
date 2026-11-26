package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import ch.fasrv.fanotes.vault.DirectoryVault
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Floating worksheet pictures: the desktop clamp (#1465) and a record that survives a load and save. */
class SheetImageTest {
    private val record = """{"schemaVersion":1,"id":"abc","title":"Foto","kind":"image","mimeType":"image/png",
"sourceRelativePath":".fanotes/worksheets/abc.png","dataRelativePath":".fanotes/worksheets/abc.json",
"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z",
"textBoxes":[{"id":"b1","page":1,"x":0.1,"y":0.2,"width":0.3,"text":"Hallo","fontSize":16}],"highlights":[],
"placement":{"x":0.25,"y":3.5,"width":0.5},"aspect":0.75,"futureField":{"keep":[1,2,3]}}"""

    @Test
    fun clampMatchesTheDesktopValidator() {
        assertEquals(SheetImagePlacement(0.0, 0.0, 0.08), clampSheetPlacement(SheetImagePlacement(-1.0, -2.0, 0.0)))
        assertEquals(SheetImagePlacement(0.0, 2000.0, 1.0), clampSheetPlacement(SheetImagePlacement(5.0, 9999.0, 7.0)))
        val wide = clampSheetPlacement(SheetImagePlacement(0.9, 1.0, 0.4))
        assertEquals(0.6, wide.x, 1e-9)
        assertEquals(0.02, clampSheetAspect(0.0), 0.0)
        assertEquals(50.0, clampSheetAspect(1e9), 0.0)
        assertEquals(0.75, clampSheetAspect(null), 0.0)
        assertEquals(1.0 + 0.5 * 2.0, sheetImageBottom(SheetImagePlacement(0.0, 1.0, 0.5), 2.0), 1e-9)
    }

    @Test
    fun placementAndAspectAreReadFromTheRecord() {
        val root = parseJson(record) as JsonValue.Obj
        assertEquals(SheetImagePlacement(0.25, 3.5, 0.5), readSheetPlacement(root))
        assertEquals(0.75, readSheetAspect(root))
        val pdf = parseJson(record.replace("\"kind\":\"image\"", "\"kind\":\"pdf\"")) as JsonValue.Obj
        assertNull(readSheetPlacement(pdf))
        val none = parseJson("""{"kind":"image"}""") as JsonValue.Obj
        assertNull(readSheetPlacement(none))
        assertNull(readSheetAspect(none))
        val broken = parseJson("""{"kind":"image","placement":{"x":"a","y":1,"width":0.5}}""") as JsonValue.Obj
        assertNull(readSheetPlacement(broken))
    }

    @Test
    fun aPlacedPictureGetsItsPlacementAndDoesNotPushTheNextSheetDown() {
        val placed = SheetImagePlacement(0.25, 3.0, 0.5)
        val laid = layoutWorksheetPages(
            900.0,
            100.0,
            listOf(
                WorksheetPageSpec("a", 1, 0.75, placed),
                WorksheetPageSpec("b", 1, 1.0),
            ),
        )
        val a = laid.first { it.id == "a" }
        assertEquals(225.0, a.left, 1e-9)
        assertEquals(2700.0, a.top, 1e-9)
        assertEquals(450.0, a.width, 1e-9)
        assertEquals(337.5, a.height, 1e-9)
        assertTrue(a.captionTop < 0.0)
        // The block below starts where the stack starts, right under the text.
        val b = laid.first { it.id == "b" }
        assertEquals(100.0 + WORKSHEET_AFTER_TEXT + WORKSHEET_CAPTION, b.top, 1e-9)
    }

    @Test
    fun savingAWorksheetRecordKeepsPlacementAspectAndUnknownFields() {
        val vault = DirectoryVault(Files.createTempDirectory("fanotes-sheet-image"))
        val path = ".fanotes/worksheets/abc.json"
        vault.mkdir(".fanotes/worksheets")
        vault.write(path, record.encodeToByteArray())

        // Load, change what the app changes (a text box, then a move), save: the same steps as the view model.
        var root = parseJson(vault.read(path)!!.decodeToString()) as JsonValue.Obj
        root.array("textBoxes")!!.items.add(
            ch.fasrv.fanotes.json.jsonObject("id" to ch.fasrv.fanotes.json.jsonString("b2"), "page" to ch.fasrv.fanotes.json.jsonNumber(1.0)),
        )
        vault.write(path, root.stringify().encodeToByteArray())
        root = parseJson(vault.read(path)!!.decodeToString()) as JsonValue.Obj
        assertEquals(SheetImagePlacement(0.25, 3.5, 0.5), readSheetPlacement(root))
        assertEquals(0.75, readSheetAspect(root))

        val moved = movedSheetPlacement(readSheetPlacement(root)!!, 0.1, -10.0)
        writeSheetPlacement(root, moved, readSheetAspect(root))
        vault.write(path, root.stringify().encodeToByteArray())

        val after = parseJson(vault.read(path)!!.decodeToString()) as JsonValue.Obj
        assertEquals(SheetImagePlacement(0.35, 0.0, 0.5), readSheetPlacement(after))
        assertEquals(0.75, readSheetAspect(after))
        assertNotNull(after.obj("futureField"))
        assertEquals("Foto", after.string("title"))
        assertEquals(2, after.array("textBoxes")!!.items.size)
        assertEquals(listOf(1.0, 2.0, 3.0), after.obj("futureField")!!.array("keep")!!.items.map { (it as JsonValue.Num).value })
    }

    @Test
    fun resizeKeepsThePictureOnThePaper() {
        val grown = resizedSheetPlacement(SheetImagePlacement(0.8, 1.0, 0.1), 0.5)
        assertEquals(0.5, grown.width, 1e-9)
        assertEquals(0.5, grown.x, 1e-9)
    }
}
