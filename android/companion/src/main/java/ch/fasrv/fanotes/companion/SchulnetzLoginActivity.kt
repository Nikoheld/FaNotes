package ch.fasrv.fanotes.companion

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_USER_AGENT
import ch.fasrv.fanotes.schulnetz.authorizationCodeFromUrl
import ch.fasrv.fanotes.schulnetz.loginWebViewAllowed

/** Microsoft login inside a WebView so the authorization code can be read. Read-only pages only. */
class SchulnetzLoginActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL)
        val host = intent.getStringExtra(EXTRA_HOST).orEmpty()
        if (url.isNullOrBlank() || host.isBlank()) {
            finish()
            return
        }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val close = Button(this).apply {
            text = "Abbrechen"
            setOnClickListener { finish() }
        }
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.settings.userAgentString = SCHULNETZ_USER_AGENT
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                consider(request.url.toString(), host)

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                consider(url, host)
            }
        }
        root.addView(close, LinearLayout.LayoutParams(MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(web, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)
        if (!consider(url, host)) web.loadUrl(url)
    }

    private fun consider(url: String?, host: String): Boolean {
        if (url.isNullOrBlank()) return false
        val code = authorizationCodeFromUrl(url)
        if (code != null) {
            setResult(RESULT_OK, Intent().putExtra(EXTRA_CODE, code.first).putExtra(EXTRA_STATE, code.second))
            finish()
            return true
        }
        return !loginWebViewAllowed(url, host)
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_HOST = "host"
        const val EXTRA_CODE = "code"
        const val EXTRA_STATE = "state"
    }
}
