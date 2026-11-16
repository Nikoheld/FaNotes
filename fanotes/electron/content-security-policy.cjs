'use strict'

// Content-Security-Policy and isolation headers of the app window, kept apart from
// main.cjs so scripts/check-csp-delivery.cjs can run exactly this code under Electron.
//
// Delivery: `session.webRequest.onHeadersReceived` adds the headers to every response
// of the session. Checked on Electron 43: the handler runs for file:// documents (also
// inside app.asar, which is how the packaged app loads), for the Vite dev server and for
// documents of a privileged custom scheme, and the policy is enforced on all three
// (inline script and eval blocked). The Electron docs say a header cannot be set for
// file://, but they are out of date here. A <meta http-equiv> copy is therefore not needed
// and is deliberately absent from index.html: the same bundle is the web app, whose own
// nginx policy allows `http://localhost:*` (LM Studio) and would be cut down by a copy of
// this one. scripts/check-csp-delivery.cjs verifies every load path again after an
// Electron upgrade, so a regression shows up there instead of as a silently missing CSP.
//
// Known looseness, kept on purpose: `blob:` in script-src is used by the TrOCR runtime
// (it imports a checksum-verified module from a blob URL) and 'unsafe-inline' in style-src
// by React and CodeMirror inline styles.

/** The sources the page may connect to. The dev server also needs its websocket and local APIs. */
const connectSources = (devServer) => (devServer
  ? "'self' fanotes-model: https://fanotes.fasrv.ch ws://127.0.0.1:* ws://localhost:* ws://[::1]:* http://127.0.0.1:* http://localhost:*"
  : "'self' fanotes-model: https://fanotes.fasrv.ch")

/**
 * The policy as a header value.
 * - `frame-src 'self'` has no `data:`: the OneNote page is shown through `srcdoc`, which this does
 *   not restrict, and any other `data:` frame stays blocked (see the live check).
 * - `glyphenWerkFrame`: the bundled GlyphenWerk page may be framed by the app itself.
 */
function buildContentSecurityPolicy({ devServer = false, glyphenWerkFrame = false } = {}) {
  return [
    "default-src 'self'",
    "script-src 'self' blob: 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src ${connectSources(devServer)}`,
    "media-src 'self' data: blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    glyphenWerkFrame ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
  ].join('; ')
}

/** The response headers with the policy and the isolation headers added (replacing a header of the same spelling). */
function applySecurityHeaders(details, { devServer = false } = {}) {
  const glyphenWerkFrame = /\/glyphenwerk\//iu.test(details.url)
  return {
    ...(details.responseHeaders ?? {}),
    'Content-Security-Policy': [buildContentSecurityPolicy({ devServer, glyphenWerkFrame })],
    'Cross-Origin-Opener-Policy': ['same-origin'],
    'Cross-Origin-Embedder-Policy': ['require-corp'],
    'Cross-Origin-Resource-Policy': ['same-origin'],
  }
}

/** Installs the headers on a session. `isDevServer` is asked per response because the dev URL is read from the environment. */
function installSecurityHeaders(electronSession, { isDevServer = () => false } = {}) {
  electronSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: applySecurityHeaders(details, { devServer: isDevServer() }) })
  })
}

module.exports = { applySecurityHeaders, buildContentSecurityPolicy, installSecurityHeaders }
