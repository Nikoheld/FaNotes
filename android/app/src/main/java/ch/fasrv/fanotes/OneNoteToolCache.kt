package ch.fasrv.fanotes

import android.content.Context
import java.io.File

/**
 * The OneNote importer execs the arm64 `one2html` and `7za` that the package
 * manager extracted into [android.content.pm.ApplicationInfo.nativeLibraryDir].
 * That directory is executable. Cache and asset copies are not, on Android 10+.
 */
internal object OneNoteToolCache {
    fun paths(context: Context): Pair<String, String>? {
        val dir = context.applicationInfo.nativeLibraryDir ?: return null
        val one2html = File(dir, "libone2html.so")
        val sevenZip = File(dir, "lib7za.so")
        if (!one2html.isFile || !sevenZip.isFile) return null
        return one2html.absolutePath to sevenZip.absolutePath
    }
}
