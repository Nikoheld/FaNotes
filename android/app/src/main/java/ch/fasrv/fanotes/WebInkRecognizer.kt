package ch.fasrv.fanotes

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.recognition.ConversionResult
import ch.fasrv.fanotes.recognition.InkRecognitionEngine
import ch.fasrv.fanotes.recognition.MathCheckOutcome
import ch.fasrv.fanotes.recognition.MathCheckResult
import ch.fasrv.fanotes.recognition.MathReading
import ch.fasrv.fanotes.recognition.MathSolverResult
import ch.fasrv.fanotes.recognition.MathStepReading
import ch.fasrv.fanotes.recognition.RecognitionCodec
import ch.fasrv.fanotes.recognition.RecognitionHostException
import ch.fasrv.fanotes.recognition.RecognitionPage
import ch.fasrv.fanotes.recognition.RecognitionPreference
import ch.fasrv.fanotes.recognition.TranscriptEntry
import ch.fasrv.fanotes.recognition.hostValue
import ch.fasrv.fanotes.recognition.pagePayload
import ch.fasrv.fanotes.recognition.parseCheckOutcome
import ch.fasrv.fanotes.recognition.parseCheckResult
import ch.fasrv.fanotes.recognition.parseConversion
import ch.fasrv.fanotes.recognition.parseMathReading
import ch.fasrv.fanotes.recognition.parseSolverResult
import ch.fasrv.fanotes.recognition.parseTranscript
import ch.fasrv.fanotes.recognition.solvePayload
import ch.fasrv.fanotes.recognition.verifyPayload
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The desktop recognizers in a headless WebView (`assets/writing/recognition.html`, built from
 * `fanotes/src/recognitionHost`), with the ONNX line model in [OnnxInkModel].
 *
 * The WebView exists only while recognition is used: it is created on the first request and
 * destroyed after three idle minutes, so app start, note opening and plain writing never pay
 * for it. Requests run one at a time; a cancelled request stops the page's model calls and waits
 * briefly for the page to settle, so the next request starts clean.
 */
class WebInkRecognizer(
    context: Context,
    private val models: InkModelStore,
    private val onnx: OnnxInkModel,
) : InkRecognitionEngine {
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val mutex = Mutex()
    private val ids = AtomicInteger(1)
    private val payloads = ConcurrentHashMap<Int, String>()
    private val answers = ConcurrentHashMap<Int, CompletableDeferred<String>>()
    @Volatile private var stopModel = false
    private var web: WebView? = null
    private var ready: CompletableDeferred<Unit>? = null
    private val release = Runnable { destroy() }

    /** False in builds made without Node (no web bundle): recognition then reports it is missing. */
    val bundled: Boolean by lazy {
        runCatching { appContext.assets.list("writing")?.contains("recognition.html") == true }.getOrDefault(false)
    }

    override val neuralInstalled: Boolean get() = models.installed

    override suspend fun recognize(page: RecognitionPage, mode: RecognitionPreference, lastMode: String): ConversionResult =
        parseConversion(call("recognize", pagePayload(page, mapOf("mode" to mode.id, "lastMode" to lastMode)), RECOGNIZE_TIMEOUT_MS))

    override suspend fun transcribe(page: RecognitionPage, mode: RecognitionPreference, lastMode: String): List<TranscriptEntry> =
        parseTranscript(call("transcribe", pagePayload(page, mapOf("mode" to mode.id, "lastMode" to lastMode)), TRANSCRIBE_TIMEOUT_MS))

    override suspend fun readMath(page: RecognitionPage): MathReading =
        parseMathReading(call("readMath", pagePayload(page), RECOGNIZE_TIMEOUT_MS))

    override suspend fun solve(input: String, action: String, variable: String?): MathSolverResult =
        parseSolverResult(call("solve", solvePayload(input, action, variable), SOLVE_TIMEOUT_MS))

    override suspend fun checkSteps(page: RecognitionPage): MathCheckOutcome =
        parseCheckOutcome(call("checkSteps", pagePayload(page), RECOGNIZE_TIMEOUT_MS))

    override suspend fun verifyLines(lines: List<MathStepReading>): MathCheckResult =
        parseCheckResult(call("verifyLines", verifyPayload(lines), SOLVE_TIMEOUT_MS))

    /** Loads the page and the glyph model ahead of a conversion (opening the conversion panel). */
    suspend fun warm() {
        runCatching { call("warm", "{}", RECOGNIZE_TIMEOUT_MS) }
    }

    private suspend fun call(method: String, payload: String, timeoutMs: Long): JsonValue = mutex.withLock {
        if (!bundled) throw RecognitionHostException("Die Handschrifterkennung ist in diesem Build nicht enthalten.")
        main.removeCallbacks(release)
        val id = ids.getAndIncrement()
        val answer = CompletableDeferred<String>()
        answers[id] = answer
        payloads[id] = payload
        stopModel = false
        try {
            withTimeout(timeoutMs) {
                withContext(Dispatchers.Main) {
                    val view = ensureWebView()
                    try {
                        ready?.await()
                    } catch (error: RecognitionHostException) {
                        destroy()
                        throw error
                    }
                    view.evaluateJavascript("window.FaNotesRecognition&&window.FaNotesRecognition.call($id,${escapeJson(method)})", null)
                }
                hostValue(answer.await())
            }
        } catch (error: CancellationException) {
            // Refuse the page's further model calls and let the running flow finish before the next.
            stopModel = true
            val settled = withContext(NonCancellable) { withTimeoutOrNull(SETTLE_MS) { answer.await() } }
            if (settled == null) withContext(NonCancellable + Dispatchers.Main) { destroy() }
            if (error is TimeoutCancellationException) throw RecognitionHostException("Die Handschrifterkennung hat zu lange gebraucht und wurde abgebrochen.")
            throw error
        } finally {
            answers.remove(id)
            payloads.remove(id)
            main.postDelayed(release, IDLE_MS)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebView(): WebView {
        web?.let { return it }
        val loaded = CompletableDeferred<Unit>()
        ready = loaded
        val view = WebView(appContext)
        view.settings.javaScriptEnabled = true
        // IndexedDB holds the glyph recognizer's (empty) personal store, as in the desktop renderer.
        view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.webViewClient = HostClient()
        view.addJavascriptInterface(Bridge(loaded), "FaNotesRecognitionHost")
        view.loadUrl("$ORIGIN/recognition.html")
        web = view
        return view
    }

    /** Frees the page and the model session (idle timer, model removal, memory pressure). */
    fun destroy() {
        main.removeCallbacks(release)
        val view = web ?: return
        web = null
        ready?.cancel()
        ready = null
        answers.values.forEach { it.complete("{\"ok\":false,\"error\":\"Die Handschrifterkennung wurde beendet.\"}") }
        view.removeJavascriptInterface("FaNotesRecognitionHost")
        view.destroy()
        onnx.release()
    }

    private inner class Bridge(private val loaded: CompletableDeferred<Unit>) {
        @JavascriptInterface fun ready() {
            loaded.complete(Unit)
        }

        @JavascriptInterface fun payload(id: Int): String = payloads.remove(id) ?: "{}"

        @JavascriptInterface fun result(id: Int, json: String) {
            answers[id]?.complete(json)
        }

        /** Runs one line image through the ONNX model; called synchronously by `recognizeInkLine`. */
        @JavascriptInterface fun infer(image: String, width: Int, height: Int, threads: Int, model: String): String = try {
            when {
                stopModel -> failure("Die Handschrifterkennung wurde abgebrochen.")
                model != "base" -> failure("Es ist kein persönliches Handschriftmodell installiert.")
                else -> {
                    val output = onnx.run(RecognitionCodec.base64ToFloats(image), width, height, threads.coerceIn(1, OnnxInkModel.defaultThreads()))
                    "{\"ok\":true,\"value\":{\"logits\":\"${RecognitionCodec.floatsToBase64(output.logits)}\",\"dims\":[${output.dims.joinToString(",")}]}}"
                }
            }
        } catch (error: Throwable) {
            failure((error.cause ?: error).message ?: "Die native Stifterkennung ist fehlgeschlagen.")
        }

        private fun failure(message: String) = "{\"ok\":false,\"error\":${escapeJson(message)}}"
    }

    /** Serves `https://recognition.fanotes.local/…`: the bundle from assets, `ocr/fanotes-ink/` from the model store. */
    private inner class HostClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.scheme != "https" || url.host != HOST) return refused(403)
            val path = (url.path ?: "/").trimStart('/').ifEmpty { "recognition.html" }
            if (path.split('/').any { it == ".." || it.isEmpty() }) return refused(404)
            if (path.startsWith(MODEL_PREFIX)) {
                val name = path.removePrefix(MODEL_PREFIX)
                if (name == "manifest.json") return WebResourceResponse("application/json", "utf-8", models.manifestText.byteInputStream())
                val file = models.servedFile(name) ?: return refused(404)
                return WebResourceResponse("application/octet-stream", null, file.inputStream())
            }
            return try {
                val mime = mimeOf(path)
                WebResourceResponse(mime, if (mime.startsWith("text") || mime == "application/json") "utf-8" else null, appContext.assets.open("writing/$path"))
            } catch (_: java.io.IOException) {
                refused(404)
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
            if (request.isForMainFrame) ready?.completeExceptionally(RecognitionHostException("Die Handschrifterkennung konnte nicht geladen werden."))
        }

        /** A killed renderer (memory pressure) must not take the app with it; the next request starts a new page. */
        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            if (web === view) {
                web = null
                ready = null
                answers.values.forEach { it.complete("{\"ok\":false,\"error\":\"Die Handschrifterkennung wurde vom System beendet.\"}") }
                view.destroy()
                onnx.release()
            }
            return true
        }

        private fun refused(code: Int) = WebResourceResponse("text/plain", "utf-8", code, if (code == 403) "Forbidden" else "Not found", emptyMap(), null)

        private fun mimeOf(path: String) = when (path.substringAfterLast('.').lowercase(Locale.ROOT)) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "txt", "words" -> "text/plain"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "wasm" -> "application/wasm"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            else -> "application/octet-stream"
        }
    }

    companion object {
        private const val HOST = "recognition.fanotes.local"
        private const val ORIGIN = "https://$HOST"
        private const val MODEL_PREFIX = "ocr/fanotes-ink/"
        private const val IDLE_MS = 180_000L
        private const val SETTLE_MS = 10_000L
        private const val RECOGNIZE_TIMEOUT_MS = 120_000L
        private const val TRANSCRIBE_TIMEOUT_MS = 300_000L
        private const val SOLVE_TIMEOUT_MS = 20_000L
    }
}
