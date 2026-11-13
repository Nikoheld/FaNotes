@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import android.content.Context
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.compose.foundation.background
import androidx.compose.ui.Alignment
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.schulnetz.*

/** The school site owns the page. Kanti+ only draws the bar around it. */
class SchulnetzLoginActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLanguage.wrap(newBase))
    }

    private var webView: WebView? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val base = intent.getStringExtra(EXTRA_BASE).orEmpty()
        val host = intent.getStringExtra(EXTRA_HOST).orEmpty()
        if (base.isBlank() || host.isBlank()) { finish(); return }
        val graph = (application as CompanionApplication).graph
        val viewOnly = intent.getBooleanExtra(EXTRA_VIEW, false)
        // The connection's own cookie jar; TAM intranet pages instead of Schulnetz ones.
        val slot = intent.getStringExtra(EXTRA_SLOT).orEmpty()
        val tam = SchoolProvider.of(intent.getStringExtra(EXTRA_PROVIDER)) == SchoolProvider.TAM
        if (!SchoolCookies.isolated(slot)) {
            graph.schulnetzLog.info("visible login activity refused reason=no-webview-profiles")
            if (tam) graph.finishTamLogin(false) else graph.finishVisibleLogin(null)
            finish(); return
        }
        val explicit = intent.getStringExtra(EXTRA_URL).orEmpty()
        if (!viewOnly && savedInstanceState?.getBoolean(STATE_PERMITTED) != true && !graph.consumeOauthPermit()) {
            graph.schulnetzLog.info("visible login activity refused reason=oauth-not-permitted")
            finish(); return
        }
        val prefs = graph.deskPrefs()
        val reduced = systemReducesMotion(contentResolver)
        setContent {
            var loading by remember { mutableStateOf(true) }
            var pageError by remember { mutableStateOf<String?>(null) }
            // Back goes inside the WebView only while it has history; otherwise the system handles it.
            var canGoBack by remember { mutableStateOf(false) }
            CompanionTheme(themeId = prefs.theme, systemDark = isSystemInDarkTheme(), accent = prefs.accent, amoled = prefs.amoled, reducedMotion = reduced) {
                val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
                SideEffect {
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        isAppearanceLightStatusBars = !dark
                        isAppearanceLightNavigationBars = !dark
                    }
                }
                BackHandler(enabled = canGoBack) { webView?.takeIf { it.canGoBack() }?.goBack() }
                Scaffold(containerColor = MaterialTheme.colorScheme.background, topBar = {
                    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            ActionIcon(Icons.Outlined.Close, t(R.string.close_school_sign_in)) { finish() }
                            Column(Modifier.weight(1f).padding(start = 4.dp)) {
                                Text(if (viewOnly) t(R.string.school_session) else if (tam) t(R.string.connect_tam) else t(R.string.connect_schulnetz), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), trackColor = LocalCompanionSemantics.current.sunken)
                        else HorizontalDivider(color = LocalCompanionSemantics.current.hairline)
                    }
                }) { padding ->
                    Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
                        pageError?.let { message ->
                            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                                InfoBanner(t(R.string.could_not_open_schulnetz), message, t(R.string.try_again), true, onAction = {
                                    pageError = null
                                    loading = true
                                    webView?.reload()
                                })
                            }
                        }
                        AndroidView(factory = { context -> WebView(context).also { web ->
                            webView = web
                            SchoolCookies.bind(web, slot)
                            prepareWebView(web, slot)
                            web.webViewClient = object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
                                    if (tam) !tamLoginWebViewAllowed(request.url.toString()) else !loginWebViewAllowed(request.url.toString(), base)
                                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                                    val target = request.url?.toString().orEmpty()
                                    if (!(if (tam) tamActionBlocked(target) else schulnetzActionBlocked(target))) return null
                                    return WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0)))
                                }
                                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { loading = true; pageError = null; canGoBack = view.canGoBack() }
                                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) { canGoBack = view.canGoBack() }
                                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                                    if (request.isForMainFrame) {
                                        loading = false
                                        pageError = t(R.string.school_page_failed)
                                    }
                                }
                                override fun onPageFinished(view: WebView, url: String) {
                                    if (webView !== view || isDestroyed || isFinishing) return
                                    loading = false
                                    canGoBack = view.canGoBack()
                                    view.evaluateJavascript(HTML_JS) { raw ->
                                        val html = decodeJsString(raw)
                                        val done = if (tam) tamSignedIn(url, html, base) else isLoggedInLanding(url, html)
                                        if (webView === view && !isFinishing && !isDestroyed && !viewOnly && done) {
                                            SchulnetzLoginBridge.landingUrl = url
                                            SchulnetzLoginBridge.landingHtml = html
                                            SchulnetzLoginBridge.provider = if (tam) SchoolProvider.TAM.wire else SchoolProvider.SCHULNETZ.wire
                                            runCatching { SchoolCookies.manager(slot).flush() }
                                            setResult(RESULT_OK); finish()
                                        }
                                    }
                                }
                            }
                            web.loadUrl(if (viewOnly && explicit.isNotBlank()) explicit else if (tam) base else webLoginUrl(base))
                        } }, modifier = Modifier.fillMaxSize())
                    }
                }
            }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(STATE_PERMITTED, true)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        val view = webView
        webView = null
        view?.stopLoading()
        view?.destroy()
        super.onDestroy()
    }
    companion object {
        private const val STATE_PERMITTED = "login-permitted"
        const val EXTRA_BASE = "base"; const val EXTRA_HOST = "host"; const val EXTRA_URL = "url"; const val EXTRA_VIEW = "view"
        const val EXTRA_SLOT = "slot"; const val EXTRA_PROVIDER = "provider"
        private const val HTML_JS = "(function(){return document.documentElement?document.documentElement.outerHTML:''})()"
    }
}
object SchulnetzLoginBridge { var landingUrl = ""; var landingHtml = ""; var provider = "" }
internal fun prepareWebView(web: WebView, slot: String = ch.fasrv.fanotes.schulnetz.PRIMARY_SLOT) {
    val cookies = SchoolCookies.manager(slot)
    cookies.setAcceptCookie(true)
    cookies.setAcceptThirdPartyCookies(web, true)
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
