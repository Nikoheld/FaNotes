package ch.fasrv.fanotes

import android.content.Context
import ch.fasrv.fanotes.recognition.INK_MODEL_BASE_URL
import ch.fasrv.fanotes.recognition.InkModelFile
import ch.fasrv.fanotes.recognition.InkModelManifest
import ch.fasrv.fanotes.recognition.InkModelState
import ch.fasrv.fanotes.recognition.inkModelFileValid
import ch.fasrv.fanotes.recognition.parseInkModelManifest
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The desktop ink recognizer's files in app storage (`files/recognition/fanotes-ink/`), downloaded
 * on demand from the repository commit the APK pins ([INK_MODEL_BASE_URL]) and accepted only when
 * every file matches the size and SHA-256 of the manifest shipped in the APK. Nothing about the
 * writer's ink is sent anywhere; the download is the only network use of recognition.
 */
class InkModelStore(context: Context, private val scope: CoroutineScope) {
    private val appContext = context.applicationContext
    val directory: File = File(appContext.filesDir, "recognition/fanotes-ink")
    private val marker = File(directory, "verified.txt")
    val manifestText: String by lazy {
        appContext.assets.open("recognition/fanotes-ink-manifest.json").use { it.readBytes().decodeToString() }
    }
    val manifest: InkModelManifest by lazy { parseInkModelManifest(manifestText) }
    private val _state = MutableStateFlow<InkModelState>(InkModelState.Missing)
    val state: StateFlow<InkModelState> = _state
    private var job: Job? = null

    /** Cheap check for app start: the digest was verified when the files arrived. */
    fun refresh() {
        scope.launch(Dispatchers.IO) {
            if (job?.isActive == true) return@launch
            _state.value = if (installedQuickly()) InkModelState.Installed(manifest.version, manifest.totalBytes) else InkModelState.Missing
        }
    }

    val installed: Boolean get() = _state.value is InkModelState.Installed

    fun modelFile(): File? = if (installed) File(directory, manifest.model.file) else null

    /** A file the recognition WebView may read: only the manifest's own files, once verified. */
    fun servedFile(name: String): File? {
        if (!installed) return null
        val entry = manifest.files.firstOrNull { it.file == name } ?: return null
        return File(directory, entry.file).takeIf { it.isFile && it.length() == entry.size }
    }

    private fun markerText() = manifest.files.joinToString("\n") { "${it.file} ${it.size} ${it.sha256}" }

    private fun installedQuickly(): Boolean =
        marker.isFile && marker.readText() == markerText() && manifest.files.all { inkModelFileValid(directory, it, checkDigest = false) }

    fun download() {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) {
            try {
                directory.mkdirs()
                marker.delete()
                val total = manifest.totalBytes
                var done = 0L
                _state.value = InkModelState.Downloading(0, total)
                for (entry in manifest.files) {
                    if (inkModelFileValid(directory, entry)) {
                        done += entry.size
                        _state.value = InkModelState.Downloading(done, total)
                        continue
                    }
                    fetch(entry) { read -> _state.value = InkModelState.Downloading(done + read, total) }
                    done += entry.size
                }
                _state.value = InkModelState.Verifying
                if (!manifest.files.all { inkModelFileValid(directory, it) }) throw IOException("Das heruntergeladene Handschriftmodell hat die Integritätsprüfung nicht bestanden.")
                marker.writeText(markerText())
                _state.value = InkModelState.Installed(manifest.version, total)
            } catch (error: kotlinx.coroutines.CancellationException) {
                _state.value = InkModelState.Missing
                throw error
            } catch (error: Exception) {
                val fallback = "Das Handschriftmodell konnte nicht geladen werden."
                _state.value = InkModelState.Failed(ch.fasrv.fanotes.desk.userVisibleFailure(error, fallback) ?: fallback)
            }
        }
    }

    fun cancel() {
        job?.cancel()
    }

    suspend fun remove(onRemoved: () -> Unit = {}) {
        job?.cancel()
        withContext(Dispatchers.IO) {
            directory.deleteRecursively()
        }
        _state.value = InkModelState.Missing
        onRemoved()
    }

    private suspend fun fetch(entry: InkModelFile, progress: (Long) -> Unit) {
        val client = okhttp3.OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
        val request = okhttp3.Request.Builder().url(INK_MODEL_BASE_URL + entry.file).get().build()
        val part = File(directory, "${entry.file}.part")
        client.newCall(request).execute().use { response ->
            // Like `assertModelDownloadUrl` on the desktop: a redirect must stay on the host we asked.
            if (response.request.url.host != request.url.host || !response.request.url.isHttps) throw IOException("Unsicheres Downloadziel abgelehnt.")
            if (!response.isSuccessful) throw IOException("Das Handschriftmodell ist nicht verfügbar (${response.code}).")
            val body = response.body ?: throw IOException("Das Handschriftmodell ist nicht verfügbar.")
            if (body.contentLength() > 0 && body.contentLength() != entry.size) throw IOException("Das Handschriftmodell ist unvollständig.")
            val digest = MessageDigest.getInstance("SHA-256")
            var read = 0L
            body.byteStream().use { input ->
                part.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var lastReport = 0L
                    while (true) {
                        kotlin.coroutines.coroutineContext.ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        read += count
                        if (read > entry.size) throw IOException("Das Handschriftmodell ist grösser als erwartet.")
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                        if (read - lastReport > 512 * 1024) {
                            lastReport = read
                            progress(read)
                        }
                    }
                }
            }
            val hex = digest.digest().joinToString("") { "%02x".format(it) }
            if (read != entry.size || hex != entry.sha256) {
                part.delete()
                throw IOException("Das Handschriftmodell hat die Integritätsprüfung nicht bestanden.")
            }
        }
        val target = File(directory, entry.file)
        target.delete()
        if (!part.renameTo(target)) throw IOException("Das Handschriftmodell konnte nicht gespeichert werden.")
    }
}
