package ch.fasrv.fanotes.companion

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import ch.fasrv.fanotes.schulnetz.SessionProblem
import ch.fasrv.fanotes.schulnetz.bridgeCallAllowed
import ch.fasrv.fanotes.schulnetz.classifySchulnetzPage
import ch.fasrv.fanotes.schulnetz.cookieNames
import ch.fasrv.fanotes.schulnetz.isForcedLogoutUrl
import ch.fasrv.fanotes.schulnetz.isMicrosoftLoginHost
import ch.fasrv.fanotes.schulnetz.newBridgeNonce
import ch.fasrv.fanotes.schulnetz.pageToken
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import ch.fasrv.fanotes.schulnetz.tableCount
import ch.fasrv.fanotes.schulnetz.webReadAllowed
import org.json.JSONObject
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.NetworkInterface
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

data class LoadedPage(
    val requestedUrl: String,
    val finalUrl: String,
    val status: Int,
    val body: String,
    val error: String? = null,
    val note: String = "",
)

/**
 * One WebView for every schulNetz read. The session cookie is IP-bound, so pages
 * must use the same WebView stack as the login instead of a second HTTP client.
 */
class SchulnetzBrowser(context: Context, private val log: SchulnetzLog) {
    private val app = context.applicationContext
    private val webHandler = Handler(Looper.getMainLooper())
    private val generation = AtomicInteger()
    private var web: WebView? = null
    internal var webViewFactory: (Context) -> WebView = { WebView(it) }
    @Volatile private var pending: Slot? = null

    fun load(url: String): LoadedPage {
        val started = System.nanoTime()
        val mainThread = Looper.myLooper() == Looper.getMainLooper()
        val kind = if (url.contains("pageid=22202")) "stundenplan" else "page"
        log.info("load begin kind=$kind page=${pageToken(url)} mainThread=$mainThread thread=${Thread.currentThread().name}")
        if (isForcedLogoutUrl(url)) {
            log.info("refused logout page=${pageToken(url)}")
            return LoadedPage(url, url, 0, "", "logout-blocked")
        }
        if (mainThread) {
            log.info("load end kind=$kind error=main-thread durationMs=0 timeout=false cancelled=true mainThread=true")
            return LoadedPage(url, url, 0, "", "main-thread")
        }
        val page = if (url.contains("scheduler_processor.php") || url.lowercase().contains(".ics")) fetchDocument(url) else navigate(url)
        val duration = (System.nanoTime() - started) / 1_000_000
        val timedOut = page.error == "timeout"
        val cancelled = page.error == "cancelled" || page.error == "render-process-gone" || page.error == "main-thread"
        log.info("load end kind=$kind page=${pageToken(page.finalUrl.ifBlank { url })} status=${page.status} bytes=${page.body.length} tables=${tableCount(page.body)} durationMs=$duration timeout=$timedOut cancelled=$cancelled mainThread=false error=${page.error.orEmpty()}")
        log.info(describe(url, page))
        return page
    }

    private fun navigate(url: String): LoadedPage {
        val slot = open(url)
        webHandler.post {
            if (slot.generation != generation.get() || slot.done.get()) return@post
            val view = ensure()
            view.webViewClient = client(slot, url)
            view.loadUrl(url)
        }
        return await(slot, url)
    }

    private fun fetchDocument(url: String): LoadedPage {
        val target = runCatching { URI(url) }.getOrNull()
        val origin = if (target?.host.isNullOrBlank()) url else "https://${target.host}/aksa/"
        val current = currentUrl()
        val currentHost = runCatching { URI(current).host }.getOrNull()
        if (!currentHost.equals(target?.host, true)) {
            val landed = navigate(origin)
            val problem = classifySchulnetzPage(landed.finalUrl, landed.body).problem
            if (problem != SessionProblem.NONE) return landed
        }
        val slot = open(url)
        val quoted = JSONObject.quote(url)
        val script = """
            (function(){
              var target = $quoted;
              var gen = ${JSONObject.quote(slot.nonce)};
              fetch(target, {credentials:'include', redirect:'follow', headers:{'Accept':'text/xml,text/calendar,text/plain,*/*'}})
                .then(function(r){ return r.text().then(function(body){ return {status:r.status, url:r.url, body:body}; }); })
                .then(function(x){ window.FanotesHtml.deliverFetch(String(gen), String(x.status), String(x.url), String(x.body)); })
                .catch(function(e){ window.FanotesHtml.fail(String(gen), String(e && e.message || e)); });
            })()
        """.trimIndent()
        webHandler.post {
            if (slot.generation != generation.get() || slot.done.get()) return@post
            ensure().evaluateJavascript(script, null)
        }
        val fetched = await(slot, url)
        if (fetched.error != null && fetched.error != "cancelled" && fetched.body.isBlank()) return navigate(url)
        return fetched
    }

    @Synchronized
    private fun open(url: String): Slot {
        pending?.let { old ->
            if (old.done.compareAndSet(false, true)) {
                old.page = LoadedPage(old.requested, old.finalUrl.ifBlank { old.requested }, old.status, "", "cancelled")
                old.latch.countDown()
                log.info("load cancelled page=${pageToken(old.requested)}")
            }
        }
        val slot = Slot(generation.incrementAndGet(), url, newBridgeNonce())
        pending = slot
        return slot
    }

    private fun budget(url: String): Long = if (url.contains("pageid=22202")) 12L else 25L

    private fun await(slot: Slot, url: String): LoadedPage {
        val completed = try {
            slot.latch.await(budget(url), TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            cancel(slot, "cancelled")
            throw e
        }
        if (!completed) cancel(slot, "timeout")
        return slot.page ?: LoadedPage(url, url, 0, "", "empty")
    }

    @Synchronized
    private fun cancel(slot: Slot, reason: String) {
        if (!slot.done.compareAndSet(false, true)) return
        slot.page = LoadedPage(slot.requested, slot.finalUrl.ifBlank { slot.requested }, slot.status, "", reason)
        slot.latch.countDown()
        webHandler.post { if (generation.get() == slot.generation) web?.stopLoading() }
        log.info("load $reason page=${pageToken(slot.requested)}")
    }

    @Synchronized
    private fun finish(slot: Slot, page: LoadedPage) {
        if (slot.generation != generation.get()) return
        if (!slot.done.compareAndSet(false, true)) return
        slot.page = page
        slot.latch.countDown()
        webHandler.post { CookieManager.getInstance().flush() }
    }

    internal fun hasPendingLoad(): Boolean = pending?.done?.get() == false

    /** Cancel queued work before destroying the browser on its owning thread. */
    @Synchronized
    internal fun dispose() {
        pending?.let { cancel(it, "cancelled") }
        generation.incrementAndGet()
        pending = null
        webHandler.post {
            web?.let { view ->
                web = null
                view.stopLoading()
                view.destroy()
            }
        }
    }

    private fun client(slot: Slot, requested: String) = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val target = request.url?.toString().orEmpty()
            if (isForcedLogoutUrl(target)) {
                log.info("blocked logout navigation url=${redactSchulnetzSecrets(target)}")
                finish(slot, LoadedPage(requested, target, 0, "", "logout-blocked"))
                return true
            }
            if (!navigationAllowed(target)) {
                log.info("blocked navigation url=${redactSchulnetzSecrets(target)}")
                finish(slot, LoadedPage(requested, target, 0, "", "navigation-blocked"))
                return true
            }
            return false
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (request.isForMainFrame) slot.status = errorResponse.statusCode
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                slot.error = error.description?.toString() ?: "network"
                log.info("main-frame error status=${error.errorCode} url=${redactSchulnetzSecrets(request.url?.toString().orEmpty())}")
            }
        }

        override fun onPageFinished(view: WebView, finished: String) {
            if (slot.generation != generation.get() || slot.done.get()) return
            slot.finalUrl = finished
            val token = slot.bumps.incrementAndGet()
            val timetable = slot.requested.contains("pageid=22202")
            if (timetable && token > 3) {
                log.info("stundenplan navigation cancelled after=$token")
                view.stopLoading()
                finish(slot, LoadedPage(slot.requested, finished, slot.status, "", "cancelled"))
                return
            }
            val pause = if (timetable) 1600L else 350L
            webHandler.postDelayed({
                if (slot.generation != generation.get() || slot.done.get()) return@postDelayed
                if (slot.bumps.get() != token) return@postDelayed
                view.evaluateJavascript(CAPTURE_JS.replace("GEN", slot.nonce), null)
            }, pause)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            log.info("render process gone crashed=${detail.didCrash()} page=${pageToken(slot.requested)}")
            finish(slot, LoadedPage(slot.requested, slot.finalUrl.ifBlank { slot.requested }, 0, "", "render-process-gone"))
            webHandler.post {
                if (web === view) {
                    web = null
                    view.destroy()
                }
            }
            return true
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensure(): WebView {
        check(Looper.myLooper() == Looper.getMainLooper())
        web?.let { return it }
        val created = webViewFactory(app)
        prepareWebView(created)
        created.addJavascriptInterface(Bridge(), "FanotesHtml")
        web = created
        return created
    }

    private fun currentUrl(): String {
        if (Looper.myLooper() == Looper.getMainLooper()) return web?.url.orEmpty()
        val latch = CountDownLatch(1)
        val box = arrayOf("")
        webHandler.post {
            box[0] = web?.url.orEmpty()
            latch.countDown()
        }
        latch.await(2, TimeUnit.SECONDS)
        return box[0]
    }

    private fun describe(requested: String, page: LoadedPage): String {
        val names = runCatching { cookieNames(CookieManager.getInstance().getCookie(page.finalUrl.ifBlank { requested }).orEmpty()) }.getOrDefault(emptyList())
        val classified = classifySchulnetzPage(page.finalUrl.ifBlank { requested }, page.body)
        return "load status=${page.status} rule=${classified.rule} class=${classified.problem} bytes=${page.body.length} tables=${tableCount(page.body)} family=${localAddressFamily()} cookieNames=${names.joinToString("|")} error=${page.error.orEmpty()} page=${pageToken(requested)} final=${pageToken(page.finalUrl)}"
    }

    private inner class Bridge {
        private val buffer = StringBuilder()

        @JavascriptInterface
        fun begin(gen: String) {
            if (!same(gen)) return
            buffer.setLength(0)
        }

        @JavascriptInterface
        fun chunk(gen: String, part: String) {
            if (!same(gen)) return
            buffer.append(part)
        }

        @JavascriptInterface
        fun note(gen: String, value: String) {
            if (!same(gen)) return
            pending?.note = value
        }

        @JavascriptInterface
        fun endHtml(gen: String) {
            val slot = pending ?: return
            if (!same(gen)) return
            finish(slot, LoadedPage(slot.requested, slot.finalUrl.ifBlank { slot.requested }, slot.status, buffer.toString(), slot.error, slot.note))
        }

        @JavascriptInterface
        fun deliverFetch(gen: String, status: String, finalUrl: String, body: String) {
            val slot = pending ?: return
            if (!same(gen)) return
            finish(slot, LoadedPage(slot.requested, finalUrl, status.toIntOrNull() ?: 0, body, null))
        }

        @JavascriptInterface
        fun fail(gen: String, message: String) {
            val slot = pending ?: return
            if (!same(gen)) return
            log.info("capture failed ${redactSchulnetzSecrets(message)}")
            finish(slot, LoadedPage(slot.requested, slot.finalUrl.ifBlank { slot.requested }, slot.status, buffer.toString(), message))
        }

        private fun same(gen: String): Boolean {
            val slot = pending ?: return false
            val page = slot.finalUrl.ifBlank { slot.requested }
            return bridgeCallAllowed(gen, slot.nonce, page)
        }
    }

    private class Slot(val generation: Int, val requested: String, val nonce: String) {
        val latch = CountDownLatch(1)
        val done = AtomicBoolean(false)
        val bumps = AtomicInteger()
        @Volatile var status: Int = 200
        @Volatile var finalUrl: String = ""
        @Volatile var error: String? = null
        @Volatile var note: String = ""
        @Volatile var page: LoadedPage? = null
    }

    companion object {
        private const val CAPTURE_JS = """
            (function(){
              try {
                var html = document.documentElement ? document.documentElement.outerHTML : '';
                var note = '';
                try {
                  function z(n){ return (n < 10 ? '0' : '') + n; }
                  function fmt(d){
                    if (!d || !d.getFullYear) return String(d || '');
                    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
                  }
                  var found = '';
                  var scripts = document.getElementsByTagName('script');
                  for (var s = 0; s < scripts.length; s++) {
                    var source = scripts[s].text || '';
                    var match = source.match(/scheduler_processor\.php\?[^"'\\\s<]+/);
                    if (match) { found = match[0]; break; }
                  }
                  var events = [];
                  if (window.scheduler && scheduler.getEvents) {
                    var list = scheduler.getEvents();
                    for (var j = 0; j < list.length; j++) {
                      var ev = list[j];
                      events.push({id:String(ev.id || ''), start:fmt(ev.start_date), end:fmt(ev.end_date), text:String(ev.text || ''), room:String(ev.zimmerkuerzel || ev.room || ''), teacher:String(ev.lehrerkuerzelname || '')});
                    }
                  }
                  note = JSON.stringify({url: found, events: events});
                } catch (ignore) { note = ''; }
                window.FanotesHtml.note('GEN', note);
                var size = 80000;
                var n = Math.max(1, Math.ceil(html.length / size));
                window.FanotesHtml.begin('GEN');
                for (var i = 0; i < n; i++) window.FanotesHtml.chunk('GEN', html.substring(i * size, (i + 1) * size));
                window.FanotesHtml.endHtml('GEN');
              } catch (e) {
                window.FanotesHtml.fail('GEN', String(e && e.message || e));
              }
            })()
        """

        fun localAddressFamily(): String = runCatching {
            var v4 = false
            var v6 = false
            val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            for (iface in interfaces) {
                if (!iface.isUp || iface.isLoopback) continue
                for (address in iface.inetAddresses) {
                    if (address.isLoopbackAddress || address.isLinkLocalAddress) continue
                    if (address is Inet4Address) v4 = true
                    if (address is Inet6Address) v6 = true
                }
            }
            when {
                v4 && v6 -> "dual"
                v6 -> "ipv6"
                v4 -> "ipv4"
                else -> "unknown"
            }
        }.getOrDefault("unknown")

        private fun navigationAllowed(target: String): Boolean {
            if (webReadAllowed(target)) return true
            val host = runCatching { URI(target).host }.getOrNull()?.lowercase().orEmpty()
            return isMicrosoftLoginHost(host)
        }
    }
}
