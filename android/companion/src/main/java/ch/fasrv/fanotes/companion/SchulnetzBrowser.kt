package ch.fasrv.fanotes.companion

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import ch.fasrv.fanotes.schulnetz.SessionProblem
import ch.fasrv.fanotes.schulnetz.classifySchulnetzPage
import ch.fasrv.fanotes.schulnetz.cookieNames
import ch.fasrv.fanotes.schulnetz.isForcedLogoutUrl
import ch.fasrv.fanotes.schulnetz.isMicrosoftLoginHost
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
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
    private val main = Handler(Looper.getMainLooper())
    private val generation = AtomicInteger()
    private var web: WebView? = null
    private var pending: Slot? = null

    fun load(url: String): LoadedPage {
        check(Looper.myLooper() != Looper.getMainLooper()) { "Schulnetz-Seiten werden ausserhalb des UI-Threads geladen." }
        if (isForcedLogoutUrl(url)) {
            log.info("refused logout url=${redactSchulnetzSecrets(url)}")
            return LoadedPage(url, url, 0, "", "logout-blocked")
        }
        val page = if (url.contains("scheduler_processor.php") || url.lowercase().contains(".ics")) fetchDocument(url) else navigate(url)
        log.info(describe(url, page))
        return page
    }

    private fun navigate(url: String): LoadedPage {
        val slot = open(url)
        main.post {
            if (slot.generation != generation.get()) return@post
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
              var gen = ${slot.generation};
              fetch(target, {credentials:'include', redirect:'follow', headers:{'Accept':'text/xml,text/calendar,text/plain,*/*'}})
                .then(function(r){ return r.text().then(function(body){ return {status:r.status, url:r.url, body:body}; }); })
                .then(function(x){ window.FanotesHtml.deliverFetch(String(gen), String(x.status), String(x.url), String(x.body)); })
                .catch(function(e){ window.FanotesHtml.fail(String(gen), String(e && e.message || e)); });
            })()
        """.trimIndent()
        main.post {
            if (slot.generation != generation.get()) return@post
            ensure().evaluateJavascript(script, null)
        }
        val fetched = await(slot, url)
        if (fetched.error != null && fetched.body.isBlank()) return navigate(url)
        return fetched
    }

    private fun open(url: String): Slot {
        val slot = Slot(generation.incrementAndGet(), url)
        pending = slot
        return slot
    }

    private fun await(slot: Slot, url: String): LoadedPage {
        if (!slot.latch.await(25, TimeUnit.SECONDS)) {
            main.post { if (generation.get() == slot.generation) web?.stopLoading() }
            return LoadedPage(url, slot.finalUrl.ifBlank { url }, slot.status, "", "timeout")
        }
        return slot.page ?: LoadedPage(url, url, 0, "", "empty")
    }

    private fun finish(slot: Slot, page: LoadedPage) {
        if (slot.generation != generation.get()) return
        if (!slot.done.compareAndSet(false, true)) return
        slot.page = page
        slot.latch.countDown()
        main.post { CookieManager.getInstance().flush() }
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
            val pause = if (slot.requested.contains("pageid=22202")) 1600L else 350L
            main.postDelayed({
                if (slot.generation != generation.get() || slot.bumps.get() != token || slot.done.get()) return@postDelayed
                view.evaluateJavascript(CAPTURE_JS.replace("GEN", slot.generation.toString()), null)
            }, pause)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensure(): WebView {
        web?.let { return it }
        val created = WebView(app)
        prepareWebView(created)
        created.addJavascriptInterface(Bridge(), "FanotesHtml")
        web = created
        return created
    }

    private fun currentUrl(): String {
        val latch = CountDownLatch(1)
        val box = arrayOf("")
        main.post {
            box[0] = web?.url.orEmpty()
            latch.countDown()
        }
        latch.await(2, TimeUnit.SECONDS)
        return box[0]
    }

    private fun describe(requested: String, page: LoadedPage): String {
        val names = runCatching { cookieNames(CookieManager.getInstance().getCookie(page.finalUrl.ifBlank { requested }).orEmpty()) }.getOrDefault(emptyList())
        val classified = classifySchulnetzPage(page.finalUrl.ifBlank { requested }, page.body)
        return "load status=${page.status} rule=${classified.rule} class=${classified.problem} bytes=${page.body.length} family=${localAddressFamily()} cookieNames=${names.joinToString("|")} error=${page.error.orEmpty()} url=${redactSchulnetzSecrets(requested)} final=${redactSchulnetzSecrets(page.finalUrl)}"
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

        private fun same(gen: String): Boolean = pending?.generation?.toString() == gen
    }

    private class Slot(val generation: Int, val requested: String) {
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
