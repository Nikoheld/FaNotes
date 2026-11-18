package ch.fasrv.fanotes

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import ch.fasrv.fanotes.vault.INCOMING_MAX_BYTES
import ch.fasrv.fanotes.vault.INCOMING_MAX_FILES
import java.io.File
import java.util.UUID

/**
 * Receives "Teilen" (`ACTION_SEND`, `ACTION_SEND_MULTIPLE`) and "Öffnen mit" (`ACTION_VIEW`) from other apps: a PDF
 * from mail, Teams or the browser, photos, Markdown or text. It copies what it was handed into the app cache while it
 * holds the read grant, then hands the copies to the one [MainActivity] (no second editor in the other app's task)
 * and closes. [MainActivity] turns them into notes ([FaNotesViewModel.importIncoming]).
 */
class ShareIntakeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val source = intent
        if (source == null || savedInstanceState != null) {
            finish()
            return
        }
        Thread({
            val handoff = runCatching { copyIncoming(source) }.getOrNull()
            runOnUiThread {
                if (handoff != null) {
                    runCatching { startActivity(handoff) }
                }
                finish()
            }
        }, "fanotes-share-intake").start()
    }

    private fun copyIncoming(source: Intent): Intent? {
        val uris = when (source.action) {
            Intent.ACTION_VIEW -> listOfNotNull(source.data)
            Intent.ACTION_SEND -> listOfNotNull(streamExtra(source))
            Intent.ACTION_SEND_MULTIPLE -> streamListExtra(source)
            else -> emptyList()
        }.take(INCOMING_MAX_FILES)
        val text = if (source.action == Intent.ACTION_SEND && uris.isEmpty()) source.getStringExtra(Intent.EXTRA_TEXT) else null
        if (uris.isEmpty() && text.isNullOrBlank()) return null
        val folder = File(cacheDir, INCOMING_DIR).apply { mkdirs() }
        val paths = ArrayList<String>()
        val names = ArrayList<String>()
        val mimes = ArrayList<String>()
        for (uri in uris) {
            val name = displayName(uri)
            val mime = contentResolver.getType(uri) ?: source.type.orEmpty()
            val copy = File(folder, UUID.randomUUID().toString())
            val ok = runCatching { copyCapped(uri, copy) }.getOrDefault(false)
            if (!ok) copy.delete()
            // An empty path marks a file that was too large or unreadable; the summary counts it.
            paths += if (ok) copy.path else ""
            names += name.orEmpty()
            mimes += mime
        }
        return Intent(this, MainActivity::class.java).apply {
            action = ACTION_IMPORT
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putStringArrayListExtra(EXTRA_PATHS, paths)
            putStringArrayListExtra(EXTRA_NAMES, names)
            putStringArrayListExtra(EXTRA_MIMES, mimes)
            if (!text.isNullOrBlank()) {
                putExtra(EXTRA_TEXT, text.take(200_000))
                putExtra(EXTRA_SUBJECT, source.getStringExtra(Intent.EXTRA_SUBJECT))
            }
        }
    }

    private fun copyCapped(uri: Uri, target: File): Boolean {
        val input = contentResolver.openInputStream(uri) ?: return false
        input.use { stream ->
            target.outputStream().use { out ->
                val buffer = ByteArray(256 * 1024)
                var total = 0L
                while (true) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > INCOMING_MAX_BYTES) return false
                    out.write(buffer, 0, read)
                }
            }
        }
        return true
    }

    private fun displayName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/')

    @Suppress("DEPRECATION")
    private fun streamExtra(source: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) source.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else source.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamListExtra(source: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) source.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else source.getParcelableArrayListExtra(Intent.EXTRA_STREAM))
            .orEmpty()

    companion object {
        const val ACTION_IMPORT = "ch.fasrv.fanotes.action.IMPORT_SHARED"
        const val EXTRA_PATHS = "ch.fasrv.fanotes.extra.SHARED_PATHS"
        const val EXTRA_NAMES = "ch.fasrv.fanotes.extra.SHARED_NAMES"
        const val EXTRA_MIMES = "ch.fasrv.fanotes.extra.SHARED_MIMES"
        const val EXTRA_TEXT = "ch.fasrv.fanotes.extra.SHARED_TEXT"
        const val EXTRA_SUBJECT = "ch.fasrv.fanotes.extra.SHARED_SUBJECT"
        const val INCOMING_DIR = "incoming"
    }
}
