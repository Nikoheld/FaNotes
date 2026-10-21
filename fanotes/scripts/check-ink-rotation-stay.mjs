// A turned sheet's client rect is the axis-aligned box of the rotated paper.
// Mapping pen fractions of that box through paper width × height squashes
// handwriting: the stroke leaves the pen and a square lands as a shear.
// Chromium measures the rect; the mapper must recover the paper point.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { mapClientToPaperPoint } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

/** The pre-fix mapper: AABB fractions times the paper, then a paper-space rotate. */
const mapThroughAxisBox = (clientX, clientY, surface, rotation) => {
  const paperW = surface.offsetWidth
  const paperH = surface.offsetHeight
  const visualX = (clientX - surface.left) / surface.width
  const visualY = (clientY - surface.top) / surface.height
  const rad = (-rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = (visualX - 0.5) * paperW
  const dy = (visualY - 0.5) * paperH
  return {
    x: (dx * cos - dy * sin + paperW / 2) / paperW,
    y: (dx * sin + dy * cos + paperH / 2) / paperH,
  }
}

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0}
#scroller{width:880px;height:640px;overflow:auto}
#plane{padding:80px;width:max-content;transform-origin:center center}
#paper{position:relative;width:900px;height:1273px;background:#fff}
.mark{position:absolute;width:1px;height:1px;background:#00f}
</style>
<div id="scroller"><div id="plane"><article id="paper"></article></div></div>
<script>
const paper = document.getElementById('paper')
const plane = document.getElementById('plane')
const scroller = document.getElementById('scroller')
const points = [[0.2,0.2],[0.8,0.2],[0.2,0.8],[0.8,0.8],[0.5,0.5],[0.95,0.05],[0.08,0.92]]
for (const [x,y] of points) {
  const mark = document.createElement('div')
  mark.className = 'mark'
  mark.dataset.x = String(x)
  mark.dataset.y = String(y)
  mark.style.left = (x * 900) + 'px'
  mark.style.top = (y * 1273) + 'px'
  paper.appendChild(mark)
}
window.__frame = async (zoom, rotation, scrollTop, scrollLeft) => {
  plane.style.zoom = zoom === 1 ? '' : String(zoom)
  if (rotation) {
    plane.style.transform = 'rotate(' + rotation + 'deg)'
    plane.style.transformOrigin = 'center center'
  } else plane.style.removeProperty('transform')
  scroller.scrollTop = scrollTop
  scroller.scrollLeft = scrollLeft
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const rect = paper.getBoundingClientRect()
  const marks = [...paper.querySelectorAll('.mark')].map((mark) => {
    const box = mark.getBoundingClientRect()
    return { x: Number(mark.dataset.x), y: Number(mark.dataset.y), clientX: box.left, clientY: box.top }
  })
  return {
    surface: {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      offsetWidth: paper.offsetWidth, offsetHeight: paper.offsetHeight,
    },
    marks,
  }
}
</script>`

const dir = join(tmpdir(), `ink-rotation-stay-${process.pid}`)
mkdirSync(dir, { recursive: true })
const htmlPath = join(dir, 'fixture.html')
writeFileSync(htmlPath, html)

const chrome = spawn('/usr/bin/chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  '--force-device-scale-factor=1', '--window-size=1100,760',
  `--user-data-dir=${join(dir, 'profile')}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`chromium debug port missing\n${stderr}`)), 15000)
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
    const match = stderr.match(/127\.0\.0\.1:(\d+)\//)
    if (match) { clearTimeout(timer); resolve(match[1]) }
  })
  chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chromium exited ${code}\n${stderr}`)) })
})

try {
  const url = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`file://${htmlPath}`)}`
  let response = await fetch(url, { method: 'PUT' })
  if (!response.ok) response = await fetch(url)
  if (!response.ok) throw new Error(`json/new ${response.status}`)
  const page = await response.json()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('websocket failed')))
  })
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails))
    return result.result.result.value
  }
  await call('Page.enable')

  const cases = [
    [1, 0, 0, 0],
    [1, 15, 0, 0],
    [1, 90, 120, 40],
    [1, 180, 0, 0],
    [1, -30, 80, 20],
    [2.5, 0, 200, 60],
    [2.5, 15, 240, 30],
    [2.5, 90, 300, 80],
    [2.5, -15, 100, 10],
  ]
  const report = []
  for (const [zoom, rotation, scrollTop, scrollLeft] of cases) {
    const frame = await evaluate(`window.__frame(${zoom}, ${rotation}, ${scrollTop}, ${scrollLeft})`)
    assert.equal(frame.surface.offsetWidth, 900)
    assert.equal(frame.surface.offsetHeight, 1273)
    let worst = 0
    let oldWorst = 0
    const square = []
    for (const mark of frame.marks) {
      const mapped = mapClientToPaperPoint({
        clientX: mark.clientX,
        clientY: mark.clientY,
        pressure: 0.6,
        pointerType: 'pen',
        timeStamp: 10,
      }, frame.surface, rotation)
      assert.ok(mapped, `pen on a turned sheet must map (zoom ${zoom}, ${rotation}°)`)
      const err = Math.hypot(mapped.x - mark.x, mapped.y - mark.y)
      worst = Math.max(worst, err)
      const old = mapThroughAxisBox(mark.clientX, mark.clientY, frame.surface, rotation)
      oldWorst = Math.max(oldWorst, Math.hypot(old.x - mark.x, old.y - mark.y))
      if (mark.x === 0.2 || mark.x === 0.8) square.push(mapped)
    }
    assert.ok(worst < 0.004, `ink left the paper point by ${worst} at zoom ${zoom}, ${rotation}°`)
    if (rotation % 180 !== 0) {
      assert.ok(oldWorst > 0.05, `sanity: the axis-box map must squash this turn (got ${oldWorst})`)
    }
    // The four corners of a paper square must stay a square in stored 0–1.
    const width = Math.abs(square[1].x - square[0].x)
    const height = Math.abs(square[2].y - square[0].y)
    assert.ok(Math.abs(width - 0.6) < 0.004 && Math.abs(height - 0.6) < 0.004, `square squashed to ${width}×${height}`)
    const entry = { zoom, rotation, scrollTop, worst: Math.round(worst * 1e6) / 1e6, oldWorst: Math.round(oldWorst * 1e4) / 1e4 }
    if (zoom === 1 && rotation === 15) {
      entry.square = frame.marks.filter((mark) => mark.x === 0.2 || mark.x === 0.8).map((mark) => {
        const mapped = mapClientToPaperPoint({
          clientX: mark.clientX, clientY: mark.clientY, pressure: 0.6, pointerType: 'pen', timeStamp: 10,
        }, frame.surface, rotation)
        const old = mapThroughAxisBox(mark.clientX, mark.clientY, frame.surface, rotation)
        return { paper: [mark.x, mark.y], fixed: [mapped.x, mapped.y], old: [old.x, old.y] }
      })
    }
    report.push(entry)
  }
  console.log(JSON.stringify(report, null, 2))
  console.log('ink-rotation-stay ok')
  ws.close()
} finally {
  chrome.kill('SIGTERM')
  await server.close()
}
