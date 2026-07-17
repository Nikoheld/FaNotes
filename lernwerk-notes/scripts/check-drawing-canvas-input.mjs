import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(appRoot, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-drawing-input-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
const port = 9457
let chromium

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

try {
  await build({
    root: workspaceRoot,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(appRoot, 'scripts/fixtures/drawing-canvas-input-harness.tsx'),
        formats: ['es'],
        fileName: () => 'harness.js',
      },
    },
  })
  const css = fs.readdirSync(output).find((entry) => entry.endsWith('.css'))
  assert.ok(css, 'Der fokussierte Canvas-Build enthält kein Stylesheet.')
  fs.writeFileSync(
    path.join(output, 'index.html'),
    `<!doctype html><html><head><link rel="stylesheet" href="./${css}"></head><body><div id="root"></div><script type="module" src="./harness.js"></script></body></html>`,
  )

  chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    pathToFileURL(path.join(output, 'index.html')).href,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  chromium.stderr.on('data', (chunk) => { stderr += chunk })

  let pages
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
      if (pages.some((entry) => entry.type === 'page' && entry.url.includes('index.html'))) break
    } catch {}
    await wait(100)
  }
  const page = pages?.find((entry) => entry.type === 'page' && entry.url.includes('index.html'))
  assert.ok(page?.webSocketDebuggerUrl, `Chromium-Testseite fehlt: ${stderr}`)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let sequence = 0
  const pending = new Map()
  const runtimeErrors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const handler = pending.get(message.id)
    if (!handler) {
      if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
        runtimeErrors.push(message.params)
      }
      return
    }
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
  await call('Log.enable')
  let ready = false
  for (let attempt = 0; attempt < 80; attempt += 1) {
    ready = await evaluate(`Boolean(document.querySelector('#ready') && document.querySelector('.drawing-canvas'))`)
    if (ready) break
    await wait(50)
  }
  const renderDiagnostics = ready ? '' : JSON.stringify({
    html: await evaluate(`document.documentElement.outerHTML.slice(0, 1600)`),
    resources: await evaluate(`performance.getEntriesByType('resource').map((entry) => entry.name)`),
    runtimeErrors,
  })
  assert.equal(ready, true, `Die fokussierte DrawingCanvas-Testseite wurde nicht gerendert: ${renderDiagnostics}`)
  const geometry = await evaluate(`(() => {
    const canvas = document.querySelector('.drawing-canvas')
    const box = canvas.getBoundingClientRect()
    return {
      x: box.left + box.width * .45,
      y: box.top + box.height * .45,
      touchAction: getComputedStyle(canvas).touchAction,
      scrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }
  })()`)
  assert.match(geometry.touchAction, /^(?:manipulation|.*pan-y.*)$/u)
  assert.equal(geometry.scrollable, true)

  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: .55 })
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x + 34, y: geometry.y + 18, button: 'left', buttons: 1, pointerType: 'pen', force: .68 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x + 34, y: geometry.y + 18, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 })
  await wait(80)
  const state = JSON.parse(await evaluate(`document.querySelector('#state').textContent`))
  assert.equal(state.hasInk, true, 'Die Wacom-Pen-Eingabe wurde nicht als Tinte gespeichert.')
  assert.ok(state.pointCount >= 2, `Die Wacom-Linie enthält zu wenige Punkte: ${JSON.stringify(state)}`)

  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: 0, deltaY: 420 })
  await wait(120)
  assert.ok(await evaluate(`window.scrollY`) > 0, 'Das Trackpad kann nach einer Wacom-Eingabe nicht mehr scrollen.')
  socket.close()
  console.log('GlyphenWerk-Eingabetest: Wacom-Stift zeichnet; Trackpad scrollt danach weiterhin über derselben Canvas.')
} finally {
  if (chromium && chromium.exitCode === null) {
    const closed = new Promise((resolve) => chromium.once('close', resolve))
    chromium.kill('SIGTERM')
    await Promise.race([closed, wait(2_000)])
  }
  fs.rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  })
}
