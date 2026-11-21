'use strict'

// Electron main script for check-csp-delivery.cjs: loads synthetic pages over every way the
// app (or a future build of it) can serve a document and reports what the policy of
// electron/content-security-policy.cjs did to each. Uses a throw-away userData directory and
// pages written by the runner into CSP_PROBE_DIR; never touches a real profile.

const { app, BrowserWindow, protocol, session } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const probeDir = process.env.CSP_PROBE_DIR
const { installSecurityHeaders } = require(process.env.CSP_MODULE)
if (!probeDir || !path.isAbsolute(probeDir)) throw new Error('CSP_PROBE_DIR is required')

app.setPath('userData', path.join(probeDir, 'user-data'))
protocol.registerSchemesAsPrivileged([{ scheme: 'fanotes-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
// The windows are closed between scenarios; the process must stay up.
app.on('window-all-closed', () => {})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mime = (file) => (file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream')

async function run(label, url, { expectLoad = true } = {}) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  let failure = ''
  // Only the page itself: a frame that frame-src refuses is an expected result, reported through the violations.
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame) failure = `${code} ${description}` })
  await window.loadURL(url).catch((error) => { failure ||= String(error?.message ?? error).split(' ')[0] })
  await wait(900)
  let page = null
  if (!failure || !expectLoad) {
    page = await window.webContents.executeJavaScript(
      '({ inlineRan: window.__inlineRan === true, evalBlocked: window.__evalBlocked, violations: window.__violations || [], pwned: window.__pwned === true, workerState: window.__workerState || "none" })',
    ).catch(() => null)
  }
  const frames = window.webContents.mainFrame.frames.map((frame) => String(frame.url ?? ''))
  window.destroy()
  return { label, failure, ...page, frames }
}

app.whenReady().then(async () => {
  const results = []
  const withPolicy = (devServer) => {
    session.defaultSession.webRequest.onHeadersReceived(null)
    installSecurityHeaders(session.defaultSession, { isDevServer: () => devServer })
  }
  const plainDir = path.join(probeDir, 'pages')
  const pages = ['inline.html', 'frame-data.html', 'frame-srcdoc.html']

  // A document the policy must not touch inline script or eval in: the control proves the probe notices a missing policy.
  session.defaultSession.webRequest.onHeadersReceived(null)
  results.push(await run('control-without-policy', pathToFileURL(path.join(plainDir, 'inline.html')).href))

  withPolicy(false)
  for (const page of pages) results.push(await run(`file:${page}`, pathToFileURL(path.join(plainDir, page)).href))
  const asarDir = path.join(probeDir, 'pages.asar')
  if (fs.existsSync(asarDir)) {
    for (const page of pages) results.push(await run(`asar:${page}`, pathToFileURL(path.join(asarDir, page)).href))
  }

  // The same pages from a loopback web server, like the Vite dev server, with the dev variant of the policy.
  const server = http.createServer((request, response) => {
    const file = path.join(plainDir, path.basename(new URL(request.url, 'http://127.0.0.1').pathname))
    if (!fs.existsSync(file)) { response.statusCode = 404; response.end(); return }
    response.setHeader('Content-Type', mime(file))
    response.end(fs.readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  withPolicy(true)
  for (const page of pages) results.push(await run(`dev-server:${page}`, `http://127.0.0.1:${port}/${page}`))
  withPolicy(false)
  for (const page of pages) results.push(await run(`http:${page}`, `http://127.0.0.1:${port}/${page}`))
  server.close()

  // A privileged custom scheme as a document source (the app does not load its page this way today).
  protocol.handle('fanotes-app', (request) => {
    const file = path.join(plainDir, path.basename(new URL(request.url).pathname))
    if (!fs.existsSync(file)) return new Response(null, { status: 404 })
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': mime(file) } })
  })
  for (const page of pages) results.push(await run(`custom-scheme:${page}`, `fanotes-app://app/${page}`))

  process.stdout.write(`CSP_PROBE_RESULT ${JSON.stringify(results)}\n`)
  app.exit(0)
}).catch((error) => {
  process.stderr.write(`CSP probe failed: ${error?.stack ?? error}\n`)
  app.exit(1)
})
