import { createServer as createViteServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const probeHtml = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Zoom probe</title>
<style>
  html, body { margin: 0; }
  .paper-view { width: 800px; height: 600px; overflow: auto; }
  .paper-sheet-plane { width: max-content; margin: 0 auto; }
  .unified-paper { position: relative; width: 400px; height: 400px; background: #fff; }
  .paper-ruling { position: absolute; inset: 0; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Ccircle cx='14' cy='14' r='0.8' fill='black'/%3E%3C/svg%3E"); background-size: 28px 28px; }
  .editor-pane { position: relative; z-index: 1; font-size: 16px; padding: 20px; }
</style></head>
<body>
  <div class="paper-view unified-note-view">
    <div class="paper-sheet-plane">
      <article class="unified-paper">
        <div class="paper-ruling"></div>
        <div class="editor-pane">Zoom-Probe</div>
        <div class="lw-drawing-board"></div>
      </article>
    </div>
  </div>
  <script type="module">
    import { applyPaperViewToElements, readUsedSheetZoom } from '/src/lib/paperView.ts'
    const noteView = document.querySelector('.paper-view')
    const paper = document.querySelector('.unified-paper')
    const ruling = document.querySelector('.paper-ruling')
    const editor = document.querySelector('.editor-pane')
    const measure = () => {
      const rulingStyle = getComputedStyle(ruling)
      const editorStyle = getComputedStyle(editor)
      const used = readUsedSheetZoom(paper)
      const fontPx = Number.parseFloat(editorStyle.fontSize) || 0
      const tilePx = Number.parseFloat(String(rulingStyle.backgroundSize).split(' ')[0]) || 0
      return {
        planeZoom: readUsedSheetZoom(document.querySelector('.paper-sheet-plane')),
        rulingZoom: readUsedSheetZoom(ruling),
        editorZoom: readUsedSheetZoom(editor),
        editorInline: editor.style.zoom || '',
        rulingInline: ruling.style.zoom || '',
        rulingTile: rulingStyle.backgroundSize,
        editorFont: editorStyle.fontSize,
        visualFont: fontPx * used,
        visualTile: tilePx * used,
        paperWidth: paper.getBoundingClientRect().width,
        editorWidth: editor.getBoundingClientRect().width,
      }
    }
    window.__zoomBefore = measure()
    applyPaperViewToElements(paper, noteView, { zoom: 2, rotation: 0, pan: { x: 0, y: 0 } })
    window.__zoomAfter = measure()
    window.__zoomReady = true
  </script>
</body></html>
`

const vite = await createViteServer({
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'zoom-probe',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === '/zoom-probe' || request.url === '/zoom-probe/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(probeHtml)
          return
        }
        next()
      })
    },
  }],
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const createCdp = (socket) => {
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    evaluate(expression) {
      return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        .then((result) => {
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
          return result.result.value
        })
    },
  }
}

let chromium
try {
  await vite.listen()
  const address = vite.httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const targetUrl = `http://127.0.0.1:${port}/zoom-probe`
  const debugPort = 21_000 + Math.floor(Math.random() * 10_000)
  const profile = mkdtempSync(join(tmpdir(), 'fanotes-zoom-chrome-'))
  chromium = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, targetUrl,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  let socket
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (chromium.exitCode !== null) throw new Error(`Chromium exited ${chromium.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      const page = pages.find((candidate) => candidate.type === 'page')
      if (page?.webSocketDebuggerUrl) {
        socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
        break
      }
    } catch { /* still booting */ }
    await wait(80)
  }
  if (!socket) throw new Error('Chromium debugging did not become available.')

  const cdp = createCdp(socket)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  const readyDeadline = Date.now() + 10_000
  let ready = false
  while (Date.now() < readyDeadline) {
    ready = await cdp.evaluate('Boolean(window.__zoomReady)')
    if (ready) break
    await wait(80)
  }
  if (!ready) throw new Error('Zoom probe did not become ready.')
  const result = await cdp.evaluate('({ before: window.__zoomBefore, after: window.__zoomAfter })')
  console.log(JSON.stringify(result))
  const after = result.after
  if (after.planeZoom !== 2 || after.rulingZoom !== 2 || after.editorZoom !== 2) {
    throw new Error(`Layer zooms diverged: ${JSON.stringify(after)}`)
  }
  if (after.editorInline || after.rulingInline) {
    throw new Error(`Child specified its own zoom: ${JSON.stringify(after)}`)
  }
  const before = result.before
  if (after.paperWidth < before.paperWidth * 1.9 || after.paperWidth > before.paperWidth * 2.1) {
    throw new Error(`Sheet width did not double at 2×: ${JSON.stringify(result)}`)
  }
  if (after.visualFont < before.visualFont * 1.9 || after.visualTile < before.visualTile * 1.9) {
    throw new Error(`Visual font/tile did not grow with the camera: ${JSON.stringify(result)}`)
  }
  chromium.kill('SIGTERM')
  socket.close()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
} finally {
  chromium?.kill('SIGTERM')
  await vite.close()
  process.exit(process.exitCode ?? 0)
}
