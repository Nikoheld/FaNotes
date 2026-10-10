// drawInkStroke on a real Chromium canvas against the Rust viewport raster,
// brush by brush: same strokes, same paint space, compared pixel by pixel.
import { createServer as createViteServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const probeHtml = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Raster parity</title></head>
<body>
  <script type="module">
    import { drawInkStroke } from '/src/lib/inkStrokePaint.ts'
    import { rasterizeInkStrokes } from '/src/lib/viewportRaster.ts'
    const W = 480
    const H = 360
    const star = 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z'
    const wave = (n, y = 0.5, amp = 0.18) => Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1)
      return { x: 0.12 + 0.76 * t, y: y + Math.sin(t * Math.PI * 2.2) * amp, pressure: 0.25 + 0.6 * Math.abs(Math.sin(t * 5)) }
    })
    const art = (brush, extra = {}) => ({ points: wave(36), baseWidth: 12, pressureEnabled: true, color: '#3a7bd5', purpose: 'art', brush, colorEffect: 'solid', opacity: 1, textureSeed: 11, ...extra })
    const cases = [
      { name: 'handwriting', stroke: { points: wave(48, 0.5, 0.25), baseWidth: 3.5, pressureEnabled: true, color: '#202333', purpose: 'handwriting' } },
      { name: 'handwriting-constant', stroke: { points: wave(48, 0.5, 0.25), baseWidth: 3.5, pressureEnabled: false, color: '#202333', purpose: 'handwriting' } },
      { name: 'fineliner', stroke: art('fineliner') },
      { name: 'pencil', stroke: art('pencil') },
      { name: 'marker', stroke: art('marker') },
      { name: 'paintbrush', stroke: art('paintbrush') },
      { name: 'calligraphy', stroke: art('calligraphy') },
      { name: 'highlighter', stroke: art('highlighter', { pressureEnabled: false, baseWidth: 22, color: '#f5d33d' }) },
      { name: 'watercolor', stroke: art('watercolor') },
      { name: 'spray', stroke: art('spray', { baseWidth: 20 }) },
      { name: 'translucent', stroke: art('fineliner', { opacity: 0.45 }) },
      { name: 'rainbow', stroke: art('fineliner', { colorEffect: 'rainbow', baseWidth: 16 }) },
      { name: 'neon', stroke: art('fineliner', { colorEffect: 'neon', baseWidth: 8 }) },
      { name: 'stamp', stroke: { points: [{ x: 0.5, y: 0.5, pressure: 0.5 }], baseWidth: 120, pressureEnabled: true, color: '#d35400', purpose: 'art', symbolId: 'star', symbolRotation: 18 } },
      { name: 'dot', stroke: { points: [{ x: 0.4, y: 0.4, pressure: 0.7 }], baseWidth: 9, pressureEnabled: true, color: '#202333', purpose: 'handwriting' } },
    ]
    const results = []
    for (const { name, stroke } of cases) {
      for (const smoothing of [0, 0.55]) {
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const context = canvas.getContext('2d')
        drawInkStroke(context, { ...stroke, symbolPaths: stroke.symbolId ? [star] : undefined }, W, H, smoothing, 1, W, W)
        const js = context.getImageData(0, 0, W, H).data
        const rs = rasterizeInkStrokes([stroke], W, H, { layoutWidth: W, smoothing, symbols: [{ id: 'star', paths: [star] }] }).data
        let both = 0
        let either = 0
        let jsCount = 0
        let rsCount = 0
        let alphaDiff = 0
        let colorDiff = 0
        for (let i = 0; i < js.length; i += 4) {
          const a = js[i + 3] >= 64
          const b = rs[i + 3] >= 64
          if (a) jsCount += 1
          if (b) rsCount += 1
          if (a || b) either += 1
          if (a && b) {
            both += 1
            colorDiff += (Math.abs(js[i] - rs[i]) + Math.abs(js[i + 1] - rs[i + 1]) + Math.abs(js[i + 2] - rs[i + 2])) / 3
          }
          alphaDiff += Math.abs(js[i + 3] - rs[i + 3])
        }
        results.push({
          name,
          smoothing,
          iou: either ? both / either : 1,
          jsCount,
          rsCount,
          meanAlphaDiff: alphaDiff / (W * H),
          meanColorDiff: both ? colorDiff / both : 0,
        })
      }
    }
    window.__parity = results
    window.__parityReady = true
  </script>
</body></html>
`

const vite = await createViteServer({
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'raster-parity-probe',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === '/raster-parity' || request.url === '/raster-parity/') {
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

/**
 * Shape agreement per case (measured: 0.97–0.996 for pens and brushes). Spray
 * particles are sub-pixel discs and the neon glow is a box-blur approximation
 * of the canvas Gaussian, so their masks share a little less.
 */
const MIN_IOU = { spray: 0.78, neon: 0.92, dot: 0.9 }
const MIN_IOU_DEFAULT = 0.95
const MAX_COLOR_DIFF = 8

let chromium
try {
  await vite.listen()
  const address = vite.httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const targetUrl = `http://127.0.0.1:${port}/raster-parity`
  const debugPort = 21_000 + Math.floor(Math.random() * 10_000)
  const profile = mkdtempSync(join(tmpdir(), 'fanotes-raster-chrome-'))
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
  const readyDeadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < readyDeadline) {
    ready = await cdp.evaluate('Boolean(window.__parityReady)')
    if (ready) break
    await wait(100)
  }
  if (!ready) throw new Error('Raster parity probe did not become ready.')
  const results = await cdp.evaluate('window.__parity')
  const failures = []
  for (const result of results) {
    const minIou = MIN_IOU[result.name] ?? MIN_IOU_DEFAULT
    const row = `${result.name.padEnd(22)} smoothing ${result.smoothing}  iou ${result.iou.toFixed(3)}  canvas ${String(result.jsCount).padStart(6)}  raster ${String(result.rsCount).padStart(6)}  color Δ ${result.meanColorDiff.toFixed(1)}`
    console.log(row)
    if (!(result.jsCount > 0 && result.rsCount > 0)) failures.push(`${result.name}: one painter drew nothing`)
    if (result.iou < minIou) failures.push(`${result.name} (smoothing ${result.smoothing}): mask overlap ${result.iou.toFixed(3)} < ${minIou}`)
    if (result.meanColorDiff > MAX_COLOR_DIFF) failures.push(`${result.name} (smoothing ${result.smoothing}): color drift ${result.meanColorDiff.toFixed(1)} > ${MAX_COLOR_DIFF}`)
  }
  if (failures.length) throw new Error(failures.join('\n'))
  console.log('viewport-raster-browser ok')
  socket.close()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
} finally {
  chromium?.kill('SIGTERM')
  await vite.close()
  process.exit(process.exitCode ?? 0)
}
