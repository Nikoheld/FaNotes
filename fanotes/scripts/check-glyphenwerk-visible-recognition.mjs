import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const glyphenWerkRoot = path.resolve(appRoot, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-glyphenwerk-visible-'))
const output = path.join(temporary, 'glyphenwerk')
const profile = path.join(temporary, 'profile')
let server
let chromium

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.woff2', 'font/woff2'],
])

try {
  await build({
    root: glyphenWerkRoot,
    logLevel: 'error',
    build: { outDir: output, emptyOutDir: true },
  })
  fs.writeFileSync(path.join(temporary, 'index.html'), `<!doctype html>
<html><body style="margin:0"><iframe id="glyph" src="/glyphenwerk/index.html?embedded=1&view=test" style="width:1200px;height:900px;border:0"></iframe>
<script>
  window.lastRequest = null
  window.addEventListener('message', (event) => {
    const frame = document.querySelector('#glyph')
    if (event.source !== frame.contentWindow || !event.data || event.data.schemaVersion !== 1) return
    if (event.data.type === 'glyphenwerk:ready') {
      frame.contentWindow.postMessage({ type: 'glyphenwerk:navigate', schemaVersion: 1, view: 'test' }, '*')
      return
    }
    if (event.data.type !== 'glyphenwerk:recognize-neural') return
    window.lastRequest = event.data
    frame.contentWindow.postMessage({
      type: 'glyphenwerk:neural-result',
      schemaVersion: 1,
      requestId: event.data.requestId,
      text: 'T',
      confidence: 88,
      lineCount: 1,
      wordCount: 0,
      knownWordRatio: 0,
      personalizedCharacters: 1,
      personalizedSource: 'personalized',
      personalizedConfidence: 82,
    }, '*')
  })
</script></body></html>`)

  server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      .replace(/^\/+|\.\./gu, '') || 'index.html'
    const target = path.join(temporary, relative)
    if (!target.startsWith(temporary) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Type', mime.get(path.extname(target)) ?? 'application/octet-stream')
    fs.createReadStream(target).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=512', `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 240 && !fs.existsSync(portFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(fs.existsSync(portFile), stderr)
  const debugPort = fs.readFileSync(portFile, 'utf8').split(/\r?\n/u)[0]
  let page
  for (let attempt = 0; attempt < 120 && !page; attempt += 1) {
    const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json()).catch(() => [])
    page = pages.find((entry) => entry.type === 'page' && entry.url === `http://127.0.0.1:${port}/`)
    if (!page) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(page?.webSocketDebuggerUrl, stderr)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  await call('Runtime.enable')

  let canvasBox
  for (let attempt = 0; attempt < 120; attempt += 1) {
    canvasBox = await evaluate(`(() => {
      const frame = document.querySelector('#glyph')
      const canvas = frame?.contentDocument?.querySelector('.test-canvas-stage .drawing-canvas')
      if (!canvas) return null
      const frameBox = frame.getBoundingClientRect()
      const box = canvas.getBoundingClientRect()
      return { left: frameBox.left + box.left, top: frameBox.top + box.top, width: box.width, height: box.height }
    })()`)
    if (canvasBox?.width > 300) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(canvasBox?.width > 300, 'Der echte GlyphenWerk-Test-Canvas wurde nicht sichtbar.')

  const penStroke = async (points) => {
    const mapped = points.map(([x, y]) => ({
      x: canvasBox.left + canvasBox.width * x,
      y: canvasBox.top + canvasBox.height * y,
    }))
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...mapped[0], button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: .58 })
    for (const point of mapped.slice(1)) {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1, pointerType: 'pen', force: .62 })
    }
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mapped.at(-1), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 })
  }
  await penStroke([[.35, .28], [.5, .28], [.65, .28]])
  await penStroke([[.5, .28], [.5, .48], [.5, .7]])

  let visible
  for (let attempt = 0; attempt < 160; attempt += 1) {
    visible = await evaluate(`(() => {
      const child = document.querySelector('#glyph').contentDocument
      return {
        result: child.querySelector('.recognized-expression')?.textContent?.trim() ?? '',
        mode: child.querySelector('.automatic-mode-pill')?.textContent?.trim() ?? '',
        reason: child.querySelector('.text-context-format code')?.textContent?.trim() ?? '',
        request: window.lastRequest,
      }
    })()`)
    if (visible.result === 'T' && /neuronale Satzanalyse/u.test(visible.reason)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(visible.result, 'T', JSON.stringify(visible))
  assert.match(visible.mode, /Text/u, JSON.stringify(visible))
  assert.match(visible.reason, /neuronale Satzanalyse/u, 'Das persönliche Ergebnis wurde vom sichtbaren Test-Tab verworfen.')
  assert.ok(Number.isSafeInteger(visible.request?.textCharacterCountHint), 'Die echte Brücke überträgt keinen Zeichenanzahl-Hinweis.')
  if (visible.request?.textCharacterHint !== undefined) {
    assert.match(visible.request.textCharacterHint, /^\p{L}+$/u, 'Die echte Brücke überträgt einen ungültigen Buchstabenhinweis.')
  }
  socket.close()
  console.log('Sichtbarer GlyphenWerk-Test: Ein persönlich bestätigtes T überstimmt eine Basisantwort ohne Wortbeleg.')
} finally {
  if (chromium && chromium.exitCode === null) {
    const closed = new Promise((resolve) => chromium.once('close', resolve))
    chromium.kill('SIGTERM')
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
}
