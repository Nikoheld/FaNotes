package ch.fasrv.fanotes.desk

import java.io.File
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Regression guard for a worksheet that stayed invisible on first load. The slices are decoded off the main
 * thread and assigned to `InkSurfaceView.backdrop` after the first frame; the setter has to ask for a redraw,
 * or the picture only shows once a scroll repaints the view. The view cannot run on the JVM, so this reads its source.
 */
class WorksheetRepaintTest {
    private fun surfaceSource(): String {
        val relative = "app/src/main/java/ch/fasrv/fanotes/InkSurfaceView.kt"
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, relative) }
            .firstOrNull { it.isFile }
        assertNotNull(file, "InkSurfaceView.kt is found from the module directory")
        return file.readText()
    }

    @Test
    fun assigningTheBackdropRepaintsTheView() {
        val source = surfaceSource()
        val start = source.indexOf("var backdrop: List<BackdropSlice>")
        assertTrue(start >= 0, "backdrop property exists")
        val setter = source.substring(start, source.indexOf("var onChanged", start))
        assertTrue(Regex("""\binvalidate\(\)""").containsMatchIn(setter), "the backdrop setter calls invalidate()")
    }
}
