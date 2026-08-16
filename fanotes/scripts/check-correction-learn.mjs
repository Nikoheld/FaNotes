import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-correction-learn-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.wasm', 'application/wasm'],
])

let server
try {
  await build({
    root: appRoot,
    publicDir: path.join(appRoot, 'public'),
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(appRoot, 'scripts/fixtures/correction-learn-rerecognize-harness.ts'),
        formats: ['es'],
        fileName: () => 'harness.js',
      },
    },
  })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./harness.js"></script></body></html>')
  server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+|\.\./gu, '') || 'index.html'
    const target = path.join(output, relative)
    if (!target.startsWith(output) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end('Not found')
      return
    }
    response.setHeader('Content-Type', mime.get(path.extname(target)) ?? 'application/octet-stream')
    fs.createReadStream(target).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--no-first-run',
    `--js-flags=--max-old-space-size=${process.env.FANOTES_TEST_HEAP_MB || '768'}`,
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const activePortFile = path.join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 100 && !fs.existsSync(activePortFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(fs.existsSync(activePortFile), `Chromium-Debugging wurde nicht bereit: ${stderr}`)
  const debugPort = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/u)[0]
  let page
  for (let attempt = 0; attempt < 80 && !page; attempt += 1) {
    const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json()).catch(() => [])
    page = pages.find((entry) => (
      entry.type === 'page'
      && typeof entry.url === 'string'
      && entry.url.startsWith(`http://127.0.0.1:${port}/`)
    ))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(page?.webSocketDebuggerUrl, `Kein Chromium-Tab für die Lernprüfung: ${stderr}`)
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
  let state = null
  for (let attempt = 0; attempt < 240; attempt += 1) {
    state = await evaluate(`(() => ({ result: document.querySelector('#result')?.textContent ?? '', error: document.querySelector('#error')?.textContent ?? '' }))()`)
    if (state.result || state.error) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  socket.close()
  const chromiumClosed = new Promise((resolve) => chromium.once('close', resolve))
  chromium.kill('SIGTERM')
  await Promise.race([chromiumClosed, new Promise((resolve) => setTimeout(resolve, 2_000))])
  assert.equal(state?.error, '', state?.error)
  assert.ok(state?.result, `Kein Ergebnis der Korrektur-Lernprüfung: ${stderr.slice(-3000)}`)
  const result = JSON.parse(state.result)
  console.log(JSON.stringify(result))
  assert.ok(result.learnedSamples > 0, `Korrektur wurde nicht gelernt: ${JSON.stringify(result)}`)
  assert.notEqual(
    result.beforeText,
    result.correction,
    `Vor dem Lernen muss die Fusion den Zeilenfehler noch übernehmen: ${JSON.stringify(result)}`,
  )
  assert.equal(
    result.afterText,
    result.correction,
    `Nach dem Lernen muss dieselbe Tinte die Korrektur lesen: ${JSON.stringify(result)}`,
  )
  console.log('Korrektur-Lernprüfung erfolgreich: gelerntes GlyphenWerk verbessert die nächste Textablesung.')
} finally {
  server?.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
