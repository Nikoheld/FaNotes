package ch.fasrv.fanotes

import android.content.Context
import java.io.File

/**
 * Copies the desktop OneNote sidecars out of assets so the importer can exec them.
 * The bytes stay the hash-checked linux `one2html` and `7za`. A device that cannot
 * run that ABI still gets the tool failure, not an empty-page import.
 */
internal object OneNoteToolCache {
    fun paths(context: Context): Pair<String, String>? {
        val dir = File(context.cacheDir, "onenote-tools")
        if (!dir.isDirectory && !dir.mkdirs()) return null
        val one2html = File(dir, "one2html")
        val sevenZip = File(dir, "7za")
        if (!extract(context, "one2html", one2html) || !extract(context, "7za", sevenZip)) return null
        return one2html.absolutePath to sevenZip.absolutePath
    }

    private fun extract(context: Context, asset: String, out: File): Boolean {
        return try {
            context.assets.open(asset).use { input ->
                val bytes = input.readBytes()
                if (!out.isFile || out.length() != bytes.size.toLong()) {
                    out.writeBytes(bytes)
                }
            }
            out.setReadable(true, true) && out.setExecutable(true, true)
        } catch (_: Exception) {
            false
        }
    }
}
