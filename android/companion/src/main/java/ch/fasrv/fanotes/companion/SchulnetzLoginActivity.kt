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
import ch.fasrv.fanotes.desk.themePalette
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
        val explicit = intent.getStringExtra(EXTRA_URL).orEmpty()
        if (!viewOnly && !graph.consumeOauthPermit()) {
            graph.schulnetzLog.info("visible login activity refused reason=oauth-not-permitted")
            finish(); return
        }
        val prefs = graph.deskPrefs()
        setContent {
            var loading by remember { mutableStateOf(true) }
            var pageError by remember { mutableStateOf<String?>(null) }
            CompanionTheme(themePalette(prefs.theme, isSystemInDarkTheme()), prefs.accent, prefs.amoled) {
                val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
                SideEffect {
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        isAppearanceLightStatusBars = !dark
                        isAppearanceLightNavigationBars = !dark
                    }
                }
                BackHandler { val web = webView; if (web?.canGoBack() == true) web.goBack() else finish() }
                Scaffold(topBar = {
                    TopAppBar(title = { Text(if (viewOnly) t(R.string.school_session) else t(R.string.connect_schulnetz), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        navigationIcon = { ActionIcon(Icons.Outlined.Close, t(R.string.close_school_sign_in)) { finish() } })
                }) { padding ->
                    Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
                        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                        pageError?.let { message ->
                            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                                InfoBanner(t(R.string.could_not_open_schulnetz), message, t(R.string.try_again), true) {
                                    pageError = null
                                    loading = true
                                    webView?.reload()
                                }
                            }
                        }
                        AndroidView(factory = { context -> WebView(context).also { web ->
                            webView = web
                            prepareWebView(web)
                            web.webViewClient = object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !loginWebViewAllowed(request.url.toString(), base)
                                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                                    val target = request.url?.toString().orEmpty()
                                    if (!schulnetzActionBlocked(target)) return null
                                    return WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0)))
                                }
                                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { loading = true; pageError = null }
                                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                                    if (request.isForMainFrame) {
                                        loading = false
                                        pageError = t(R.string.school_page_failed)
                                    }
                                }
                                override fun onPageFinished(view: WebView, url: String) {
                                    loading = false
                                    view.evaluateJavascript(HTML_JS) { raw ->
                                        val html = decodeJsString(raw)
                                        if (!viewOnly && isLoggedInLanding(url, html)) {
                                            SchulnetzLoginBridge.landingUrl = url
                                            SchulnetzLoginBridge.landingHtml = html
                                            CookieManager.getInstance().flush()
                                            setResult(RESULT_OK); finish()
                                        }
                                    }
                                }
                            }
                            web.loadUrl(if (viewOnly && explicit.isNotBlank()) explicit else webLoginUrl(base))
                        } }, modifier = Modifier.fillMaxSize())
                    }
                }
            }
        }
    }
    override fun onDestroy() { webView?.destroy(); webView = null; super.onDestroy() }
    companion object {
        const val EXTRA_BASE = "base"; const val EXTRA_HOST = "host"; const val EXTRA_URL = "url"; const val EXTRA_VIEW = "view"
        private const val HTML_JS = "(function(){return document.documentElement?document.documentElement.outerHTML:''})()"
    }
}
object SchulnetzLoginBridge { var landingUrl = ""; var landingHtml = "" }
internal fun prepareWebView(web: WebView) {
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
