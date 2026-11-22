package ch.fasrv.fanotes

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import ch.fasrv.fanotes.sync.OpenStoryGate
import ch.fasrv.fanotes.vault.StoryFiles
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.normalize
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * The writing mode ("Schreiben") on Android: the same editor as the desktop
 * and web app, loaded from the APK's assets into a WebView. Story files are
 * read and written through [StoryBridge] with the desktop's path rules.
 */
class WritingActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    /** The import dialog's file input (DOCX, Markdown, text). */
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        fileCallback?.onReceiveValue(if (uri == null) emptyArray() else arrayOf(uri))
        fileCallback = null
    }

    @Volatile private var gate: OpenStoryGate? = null
    /** The renderer died (memory pressure, or a crash in the shared WebView process): only destroy() is allowed. */
    private var webGone = false
    private val storyListener: (List<String>, List<String>) -> Unit = { written, _ -> notifyWritten(written) }

    /**
     * The open story: sync leaves everything in it alone except the scenes and story.json while the
     * editor reports that it has nothing unsaved (OpenStoryGate); released on close.
     */
    private fun holdStory(path: String) {
        val graph = (application as FaNotesApplication).graph
        releaseStory()
        val next = OpenStoryGate(path)
        gate = next
        graph.openStories = graph.openStories + next
        synchronized(graph.remoteListeners) { graph.remoteListeners += storyListener }
        // The page reported to the previous gate and sends only changes: ask it to report again.
        web.evaluateJavascript("window.fanotesReportBusy && window.fanotesReportBusy()", null)
    }

    private fun releaseStory() {
        val graph = (application as FaNotesApplication).graph
        gate?.let { graph.openStories = graph.openStories - it }
        synchronized(graph.remoteListeners) { graph.remoteListeners -= storyListener }
        gate = null
    }

    /** Sync wrote files: the editor reads and merges the ones of the open story (on the main thread). */
    private fun notifyWritten(written: List<String>) {
        val files = gate?.liveFiles(written).orEmpty()
        if (files.isEmpty()) return
        val json = JSONObject.quote(JSONArray(files).toString())
        runOnUiThread {
            if (!isDestroyed && !webGone) web.evaluateJavascript("window.fanotesStoryWritten && window.fanotesStoryWritten($json)", null)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openCount += 1
        val graph = (application as FaNotesApplication).graph
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.settings.mediaPlaybackRequiresUserGesture = true
        web.webViewClient = AssetClient(this, onPageLoading = { gate?.reset() }, onGone = ::rendererGone)
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(emptyArray())
                fileCallback = callback
                pickFile.launch(arrayOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/markdown", "text/plain", "application/octet-stream"))
                return true
            }
        }
        intent.getStringExtra(EXTRA_PATH)?.let { holdStory(it) }
        web.addJavascriptInterface(StoryBridge(graph.vault, onSaved = { graph.engine.notifyLocalChange() }, onClose = { runOnUiThread { finish() } }, onCreated = { path -> runOnUiThread { holdStory(path) } }, onBusy = { busy -> gate?.report(busy) }), "FaNotesAndroid")
        // Edge-to-edge (targetSdk 36): keep the editor out from under the status bar, the gesture bar, a cutout and the keyboard.
        val container = android.widget.FrameLayout(this)
        container.addView(web, android.widget.FrameLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT))
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                    androidx.core.view.WindowInsetsCompat.Type.displayCutout() or
                    androidx.core.view.WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            androidx.core.view.WindowInsetsCompat.CONSUMED
        }
        setContentView(container)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            // The editor saves and then calls close(); a second press while it saves is ignored.
            override fun handleOnBackPressed() { if (webGone) finish() else web.evaluateJavascript("window.dispatchEvent(new Event('fanotes-writing-close'))", null) }
        })
        if (savedInstanceState == null) web.loadUrl(startUrl(intent)) else web.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!webGone) web.saveState(outState)
    }

    override fun onPause() {
        // The page saves on visibilitychange; pausing the WebView fires it.
        if (!webGone) web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (!webGone) web.onResume()
    }

    /**
     * Without this the system kills the whole app when the renderer goes (the recognition host shares it). What the
     * editor saved is on disk; the writing mode closes and can be opened again.
     */
    private fun rendererGone() {
        if (webGone) return
        webGone = true
        releaseStory()
        android.widget.Toast.makeText(this, ch.fasrv.fanotes.desk.ChromeText.ui(RENDERER_GONE), android.widget.Toast.LENGTH_LONG).show()
        finish()
    }

    override fun onDestroy() {
        openCount = (openCount - 1).coerceAtLeast(0)
        val graph = (application as FaNotesApplication).graph
        releaseStory()
        graph.engine.notifyLocalChange()
        web.destroy()
        super.onDestroy()
    }

    private fun startUrl(intent: Intent): String {
        val lang = if (Locale.getDefault().language == "de") "de" else "en"
        val builder = Uri.parse("$ORIGIN/writing.html").buildUpon().appendQueryParameter("lang", lang)
        intent.getStringExtra(EXTRA_PATH)?.let { builder.appendQueryParameter("path", it) }
        intent.getStringExtra(EXTRA_CREATE)?.let { builder.appendQueryParameter("create", it) }
        intent.getStringExtra(EXTRA_IMPORT)?.let { builder.appendQueryParameter("import", it) }
        return builder.build().toString()
    }

    /** Serves `https://writing.fanotes.local/…` from `assets/writing/`; nothing else is loaded. */
    private class AssetClient(private val context: Context, private val onPageLoading: () -> Unit, private val onGone: () -> Unit) : WebViewClient() {
        /** A (re)loading page has not reported its editor state: everything waits again. */
        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) { onPageLoading() }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            onGone()
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.scheme != "https" || url.host != HOST) return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), null)
            val path = (url.path ?: "/").trimStart('/').ifEmpty { "writing.html" }
            if (path.split('/').any { it == ".." || it.isEmpty() }) return WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), null)
            return try {
                WebResourceResponse(mimeOf(path), if (mimeOf(path).startsWith("text") || path.endsWith(".js")) "utf-8" else null, context.assets.open("writing/$path"))
            } catch (_: java.io.IOException) {
                // A build without the web bundle: a readable page instead of the WebView's raw error.
                if (path.endsWith(".html")) {
                    val lang = if (Locale.getDefault().language == "de") "de" else "en"
                    WebResourceResponse("text/html", "utf-8", ch.fasrv.fanotes.desk.bundleMissingPage(lang).byteInputStream())
                } else {
                    WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), null)
                }
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != HOST

        private fun mimeOf(path: String) = when (path.substringAfterLast('.').lowercase(Locale.ROOT)) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "txt", "words" -> "text/plain"
            "ttf" -> "font/ttf"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "wasm" -> "application/wasm"
            else -> "application/octet-stream"
        }
    }

    companion object {
        private const val HOST = "writing.fanotes.local"
        private const val ORIGIN = "https://$HOST"
        private const val EXTRA_PATH = "path"
        private const val EXTRA_CREATE = "create"
        private const val EXTRA_IMPORT = "import"

        /** Writing windows alive in this process (main thread); a share then must not clear them off the task. */
        @Volatile internal var openCount = 0
        const val RENDERER_GONE = "Der Schreibmodus wurde vom System beendet. Gespeichertes bleibt erhalten; öffne ihn erneut."

        fun intent(context: Context, storyPath: String): Intent = Intent(context, WritingActivity::class.java).putExtra(EXTRA_PATH, storyPath)
        fun createIntent(context: Context, parentFolder: String): Intent = Intent(context, WritingActivity::class.java).putExtra(EXTRA_CREATE, parentFolder)
        fun importIntent(context: Context, parentFolder: String): Intent = Intent(context, WritingActivity::class.java).putExtra(EXTRA_IMPORT, parentFolder)
    }
}

/**
 * `window.FaNotesAndroid` for the writing mode. Every method returns a JSON
 * envelope `{ ok, value }` or `{ ok: false, error }`; paths are checked by
 * [StoryFiles] (story files only), except [readFile] and [listNotes], which
 * only read Markdown notes for linking.
 */
class StoryBridge(private val vault: VaultIo, private val onSaved: () -> Unit, private val onClose: () -> Unit, private val onCreated: (String) -> Unit = {}, private val onBusy: (Boolean) -> Unit = {}) {
    private fun ok(value: Any?) = JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL).toString()
    private fun fail(error: Throwable) = JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    private inline fun guard(block: () -> Any?): String = try { ok(block()) } catch (error: Throwable) { fail(error) }

    @JavascriptInterface fun storyRead(path: String): String = guard { StoryFiles.read(vault, path) }
    @JavascriptInterface fun storyWrite(path: String, content: String): String = guard { StoryFiles.write(vault, path, content); null }
    @JavascriptInterface fun storyList(storyPath: String): String = guard { JSONArray(StoryFiles.list(vault, storyPath)) }
    @JavascriptInterface fun storyCreate(parent: String, name: String): String = guard { StoryFiles.create(vault, parent, name).also(onCreated) }

    @JavascriptInterface fun readFile(path: String): String = guard {
        val clean = normalize(path)
        require(clean.endsWith(".md", ignoreCase = true) || clean.endsWith(".markdown", ignoreCase = true)) { "Nur Notizen können verknüpft werden." }
        (vault.read(clean) ?: error("Die Notiz wurde nicht gefunden.")).toString(Charsets.UTF_8)
    }

    @JavascriptInterface fun listNotes(): String = guard {
        JSONArray(vault.walkFiles()
            .filter { (it.path.endsWith(".md", true) || it.path.endsWith(".markdown", true)) && !it.path.split('/').any { part -> part.startsWith('.') } && !it.path.contains(".story/") }
            .take(20_000)
            .map { JSONObject().put("path", it.path).put("name", it.path.substringAfterLast('/').substringBeforeLast('.')) })
    }

    /** An export (PDF, DOCX, EPUB…) is written next to the story folder under a free name. */
    @JavascriptInterface fun saveExport(storyPath: String, fileName: String, base64: String): String = guard {
        val story = StoryFiles.checkFolder(storyPath)
        val parent = story.substringBeforeLast('/', "")
        val clean = fileName.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), " ").trim().ifEmpty { "Export" }
        val stem = clean.substringBeforeLast('.')
        val extension = clean.substringAfterLast('.', "")
        require(extension.lowercase(Locale.ROOT) in setOf("pdf", "docx", "epub", "md", "txt")) { "Unbekanntes Exportformat." }
        fun at(name: String) = if (parent.isEmpty()) name else "$parent/$name"
        var target = at(clean)
        var index = 2
        while (vault.exists(target)) target = at("$stem $index.$extension").also { index++ }
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        require(bytes.size <= 200 * 1024 * 1024) { "Der Export ist zu gross." }
        vault.write(target, bytes)
        onSaved()
        target
    }

    @JavascriptInterface fun saved(@Suppress("UNUSED_PARAMETER") pathsJson: String) = onSaved()
    /** The editor holds unsaved text or is saving (true), or is clean (false). A page that never reports counts as busy. */
    @JavascriptInterface fun storyBusy(busy: Boolean) = onBusy(busy)
    @JavascriptInterface fun close() = onClose()
}
