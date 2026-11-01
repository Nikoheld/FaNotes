package ch.fasrv.fanotes.companion

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_USER_AGENT
import ch.fasrv.fanotes.schulnetz.isLoggedInLanding
import ch.fasrv.fanotes.schulnetz.loginWebViewAllowed
import ch.fasrv.fanotes.schulnetz.webLoginUrl
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** Website login. The mobile authorize.php redirect is never opened. */
class SchulnetzLoginActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val base = intent.getStringExtra(EXTRA_BASE).orEmpty()
        val host = intent.getStringExtra(EXTRA_HOST).orEmpty()
        if (base.isBlank() || host.isBlank()) {
            finish()
            return
        }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(Button(this).apply {
            text = "Abbrechen"
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val web = WebView(this)
        prepareWebView(web)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !loginWebViewAllowed(request.url.toString(), base)

            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(HTML_JS) { raw ->
                    val html = decodeJsString(raw)
                    if (isLoggedInLanding(url, html)) {
                        SchulnetzLoginBridge.landingUrl = url
                        SchulnetzLoginBridge.landingHtml = html
                        CookieManager.getInstance().flush()
                        setResult(RESULT_OK)
                        finish()
                    }
                }
            }
        }
        root.addView(web, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)
        web.loadUrl(webLoginUrl(base))
    }

    companion object {
        const val EXTRA_BASE = "base"
        const val EXTRA_HOST = "host"
        const val EXTRA_URL = "url"
        private const val HTML_JS = "(function(){return document.documentElement?document.documentElement.outerHTML:''})()"
    }
}

object SchulnetzLoginBridge {
    var landingUrl: String = ""
    var landingHtml: String = ""
}

class SchulnetzSilentLogin(private val context: android.content.Context) {
    suspend fun await(baseUrl: String): Pair<String, String>? = suspendCancellableCoroutine { continuation ->
        val main = Handler(Looper.getMainLooper())
        main.post {
            val web = WebView(context.applicationContext)
            prepareWebView(web)
            var done = false
            fun finish(value: Pair<String, String>?) {
                if (done) return
                done = true
                web.stopLoading()
                web.destroy()
                if (continuation.isActive) continuation.resume(value)
            }
            continuation.invokeOnCancellation { main.post { finish(null) } }
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    !loginWebViewAllowed(request.url.toString(), baseUrl)

                override fun onPageFinished(view: WebView, url: String) {
                    view.evaluateJavascript("(function(){return document.documentElement?document.documentElement.outerHTML:''})()") { raw ->
                        val html = decodeJsString(raw)
                        if (isLoggedInLanding(url, html)) {
                            CookieManager.getInstance().flush()
                            finish(url to html)
                        } else if (html.contains("type=\"password\"") || html.contains("type='password'")) {
                            finish(null)
                        }
                    }
                }
            }
            web.loadUrl(webLoginUrl(baseUrl))
            main.postDelayed({ finish(null) }, 25_000)
        }
    }
}

private fun prepareWebView(web: WebView) {
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
    web.settings.javaScriptEnabled = true
    web.settings.domStorageEnabled = true
    web.settings.allowFileAccess = false
    web.settings.allowContentAccess = false
    web.settings.userAgentString = SCHULNETZ_USER_AGENT
}

internal fun decodeJsString(raw: String?): String {
    if (raw.isNullOrBlank() || raw == "null") return ""
    val parsed = runCatching { parseJson(raw) }.getOrNull()
    return (parsed as? JsonValue.Str)?.value ?: raw.trim().trim('"')
}
