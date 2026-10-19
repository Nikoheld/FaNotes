import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = process.argv[2]
if (!outDir) throw new Error('pass the directory for the screenshot')
mkdirSync(outDir, { recursive: true })

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  .replaceAll('</style', '<\\/style')
  .replaceAll('</script', '<\\/script')

const dir = join(tmpdir(), `fanotes-chrome-compact-${process.pid}-${Date.now()}`)
mkdirSync(dir, { recursive: true })
const htmlPath = join(dir, 'fixture.html')
const profile = join(dir, 'profile')
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
</style></head><body>
<div id="root">
  <div class="app-shell">
    <nav class="ribbon" aria-label="Hauptnavigation">
      <div class="ribbon-brand"><span>F</span><strong>FaNotes</strong></div>
      <button type="button" aria-label="Seitenleiste einblenden">Leiste</button>
    </nav>
    <div class="app-body">
      <main class="workspace">
        <div class="tabs-bar"><b>Notiz</b></div>
        <div class="editor-toolbar is-ink">
          <div class="toolbar-context">
            <div class="ink-toolbar-slot">
              <div class="lw-draw-toolbar is-docked-chrome">
                <div class="lw-pen-strip" data-ink-surface="pen-strip" aria-label="Marker">
                  <div class="lw-colors" aria-label="Zeichenfarbe">
                    <button type="button" aria-label="Zeichenfarbe #111111"></button>
                  </div>
                  <label class="lw-draw-range">
                    <span>Breite</span>
                    <input type="range" aria-label="Breite" min="0.75" max="42" value="2">
                    <output>2 px</output>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="editor-stage"><div class="editor-stage-main">note</div></div>
      </main>
    </div>
  </div>
</div>
<script>
window.__pageErrors = []
window.addEventListener('error', (event) => { window.__pageErrors.push(String(event.message)) })
</script>
</body></html>`
writeFileSync(htmlPath, html)

const chrome = spawn('/usr/bin/chromium', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disable-extensions',
  '--window-size=1280,800',
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`chromium debug port missing\n${stderr}`)), 15000)
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
    const match = stderr.match(/127\.0\.0\.1:(\d+)\//)
    if (match) {
      clearTimeout(timer)
      resolve(match[1])
    }
  })
  chrome.on('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`chromium exited ${code}\n${stderr}`))
  })
})

const openPage = async () => {
  const url = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`file://${htmlPath}`)}`
  let response = await fetch(url, { method: 'PUT' })
  if (!response.ok) response = await fetch(url, { method: 'GET' })
  if (!response.ok) throw new Error(`json/new ${response.status}`)
  return response.json()
}

try {
  const page = await openPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')))
  })
  let nextId = 0
  const pending = new Map()
  const pageErrors = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params?.exceptionDetails?.text || 'exception')
    }
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Runtime.evaluate', {
    expression: 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(0))))',
    awaitPromise: true,
  })
  const raw = await send('Runtime.evaluate', {
    expression: `(() => {
      const box = (selector) => {
        const node = document.querySelector(selector)
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, height: rect.height }
      }
      const shell = document.querySelector('.app-shell')
      const rows = getComputedStyle(shell).gridTemplateRows.trim().split(/\\s+/)
      return JSON.stringify({
        noteMeta: Boolean(document.querySelector('.note-meta-bar')),
        statusbar: Boolean(document.querySelector('.statusbar, footer.statusbar')),
        errors: window.__pageErrors,
        rows,
        viewport: innerHeight,
        shell: box('.app-shell'),
        ribbon: box('.ribbon'),
        body: box('.app-body'),
        strip: box('.lw-pen-strip[aria-label="Marker"]'),
        dock: box('.lw-draw-toolbar.is-docked-chrome'),
      })
    })()`,
    returnByValue: true,
  })
  if (raw.exceptionDetails) throw new Error(JSON.stringify(raw.exceptionDetails))
  const metrics = JSON.parse(raw.result.value)
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(join(outDir, 'chrome-compact.png'), Buffer.from(shot.data, 'base64'))
  ws.close()

  const round = (value) => Math.round(value)
  const report = {
    noteMeta: metrics.noteMeta,
    statusbar: metrics.statusbar,
    errors: [...metrics.errors, ...pageErrors],
    rows: metrics.rows.length,
    viewport: round(metrics.viewport),
    shell: round(metrics.shell.height),
    ribbon: round(metrics.ribbon.height),
    bodyBottom: round(metrics.body.bottom),
    shellBottom: round(metrics.shell.bottom),
    gap: round(metrics.body.top - metrics.ribbon.bottom),
    strip: round(metrics.strip.height),
    dock: round(metrics.dock.height),
  }
  console.log(JSON.stringify(report))
  assert.equal(report.noteMeta, false)
  assert.equal(report.statusbar, false)
  assert.deepEqual(report.errors, [])
  assert.equal(report.rows, 2)
  assert.ok(report.ribbon >= 30 && report.ribbon <= 34, JSON.stringify(report))
  assert.ok(Math.abs(report.ribbon + round(metrics.body.height) - report.shell) <= 1, JSON.stringify(report))
  assert.ok(Math.abs(report.bodyBottom - report.viewport) <= 1, JSON.stringify(report))
  assert.ok(Math.abs(report.shellBottom - report.viewport) <= 1, JSON.stringify(report))
  assert.ok(Math.abs(report.gap) <= 1, JSON.stringify(report))
  assert.ok(report.strip > 0 && report.strip <= 32, JSON.stringify(report))
  assert.ok(report.strip <= report.dock, JSON.stringify(report))
  assert.ok(report.dock <= 32, JSON.stringify(report))
  console.log('chrome-compact-launch ok')
} finally {
  if (chrome.exitCode === null) chrome.kill('SIGTERM')
  await new Promise((resolve) => {
    if (chrome.exitCode !== null) resolve()
    else {
      chrome.once('exit', resolve)
      setTimeout(() => {
        if (chrome.exitCode === null) chrome.kill('SIGKILL')
        resolve()
      }, 2000)
    }
  })
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })
  } catch {
    // A locked profile must not hide the layout result.
  }
}
