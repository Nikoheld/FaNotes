// Regression check: handwriting stays where it was written and never flickers.
// Bug B1 (desktop): ink "bugs to somewhere else" while or after writing, and
// strokes appear, vanish and come back.
//
// Real Chromium over raw CDP (no Playwright needed), driving the web build
// with pen, mouse and touch input. A recorder in the page notes every input
// sample in paper coordinates (before the app sees it), and after every
// rendered frame composites the board's canvases under each recorded point:
// - flicker: a point that was painted goes blank in a later frame while its
//   stroke still exists;
// - jump: a point is still blank after a grace period, or ink shows up more
//   than a few pixels away from every point that was written;
// - hidden: at the end of each step a screenshot must show every point dark
//   (a layer stacked over the ink only shows up there).
// Sessions: a Markdown note (lines, a sheet that moves under a stroke, mouse,
// touch, quick strokes, page growth down/up/left, the window bottom, scroll,
// zoom, undo/redo, erase, a sync pull, autosave, keyboard mode and typing,
// sidebar, window size, display scale, note switch), a PDF note, a worksheet
// and a page of handwriting only. Pen samples get predicted events the way
// Chromium's predictor adds them on real hardware.
// The beautify scenario switches the handwriting beautifier on and checks the
// live board: only the finished line moves (bounded), no flicker while it
// settles, one undo restores the originals.
// Set FANOTES_SKIP_BROWSER=1 to skip, FANOTES_CHROMIUM to pick the browser,
// INK_STABLE_ONLY=markdown,pdf,worksheet,ink to run some sessions,
// INK_STABLE_DIST=<dir> to reuse a build, INK_STABLE_SHOTS=<dir> for
// screenshots, INK_STABLE_VERBOSE=1 for detail.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- Part 1: the causes found, as plain logic (no browser) ----------------
{
  const { createServer } = await import('vite')
  const ssr = await createServer({ root, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
  try {
    const { classifyInkJumpAppend, isInkCorridorLeap } = await ssr.ssrLoadModule('/src/lib/inkSampleMap.ts')
    const { continueLiveWriteStroke, growPageAroundLiveMark } = await ssr.ssrLoadModule('/src/lib/paperGrow.ts')

    // A stroke written up across the top 5 % of the page (on a long note or a
    // PDF that edge is in the middle of the writing) keeps every sample.
    let last = { x: 0.4, y: 0.07 }
    for (let y = 0.068; y > 0.02; y -= 0.002) {
      const next = { x: 0.4 + (0.07 - y), y }
      assert.equal(classifyInkJumpAppend(last, next, 5), 'append', `a pen step into the top band at y=${y.toFixed(3)} was dropped`)
      last = next
    }
    // A ghost sample that lands in the band from far below is still a leap.
    assert.equal(isInkCorridorLeap({ x: 0.5, y: 0.3 }, { x: 0.5, y: 0.01 }), true)
    assert.equal(isInkCorridorLeap({ x: 0.3, y: 0.09 }, { x: 0.3, y: 0.01 }), true)
    assert.equal(isInkCorridorLeap({ x: 0.3, y: 0.06 }, { x: 0.3, y: 0.0 }), true)

    // The page grows up around the pen however often it already grew there.
    const page = { width: 1000, height: 1600 }
    const painted = { width: 1000, height: 1600 }
    assert.equal(growPageAroundLiveMark(page, { x: 0.5, y: 0.05 }, painted).padY, 144, 'pen near the top pads the top')
    const afterTwoPads = continueLiveWriteStroke({
      last: { x: 0.5, y: 0.004 },
      current: { x: 0.5, y: -0.003 },
      page: { ...page, originX: 0, originY: 288 },
      painted,
      existingCount: 3,
    })
    assert.ok(afterTwoPads.grew && afterTwoPads.grown.padY > 0, 'a page that already grew up twice must grow again under the pen (ink above the edge is not painted)')
    // A PDF never pads above or left of its pages: they would not move with the pad.
    const pdf = growPageAroundLiveMark(page, { x: 0.01, y: 0.02 }, painted, false)
    assert.equal(pdf.padX, 0)
    assert.equal(pdf.padY, 0)
    assert.ok(growPageAroundLiveMark(page, { x: 0.5, y: 0.99 }, painted, false).height > page.height, 'a PDF still grows down')
  } finally {
    await ssr.close()
  }

  const { readFileSync } = await import('node:fs')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.doesNotMatch(board, /paperSurfaceCacheRef/, 'pen samples must not reuse a paper rect kept for the stroke')
  assert.match(board, /const readOriginSurface = useCallback\(\(el: HTMLElement\) => \{[\s\S]{0,200}getBoundingClientRect\(\)/)
  assert.match(board, /minEdgeGrow: !originEl\?\.classList\.contains\('is-pdf-note'\)/)
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /const attachNoteInk = [\s\S]{0,400}const separator = content && !content\.endsWith\('\\n'\) \? '\\n' : ''/, 'the ink marker adds no blank line to the note')
  const styles = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const disabled = styles.match(/\.worksheet-layer\.is-disabled \{([^}]*)\}/)?.[1] ?? ''
  assert.match(disabled, /z-index:\s*auto/, 'in pen mode the worksheet must not stack over the ink')
  console.log('ink-stable: logic ok')
}

const chromiumCandidates = [process.env.FANOTES_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean)
const chromium = chromiumCandidates.find((path) => existsSync(path))
if (process.env.FANOTES_SKIP_BROWSER === '1' || !chromium) {
  console.log('ink-stable: browser part skipped (no chromium)')
  process.exit(0)
}
const only = process.env.INK_STABLE_ONLY ? new Set(process.env.INK_STABLE_ONLY.split(',')) : null
const verbose = process.env.INK_STABLE_VERBOSE === '1'

const freePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

// 8-bit RGB/RGBA PNG (what Page.captureScreenshot returns) to RGBA pixels.
const decodePng = (buffer) => {
  let offset = 8
  let width = 0; let height = 0; let channels = 4
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      if (body[8] !== 8 || ![2, 6].includes(body[9])) throw new Error('unsupported PNG')
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const line = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = value
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = v & 255
    }
    for (let x = 0; x < width; x += 1) {
      out[(y * width + x) * 4] = line[x * channels]
      out[(y * width + x) * 4 + 1] = line[x * channels + 1]
      out[(y * width + x) * 4 + 2] = line[x * channels + 2]
      out[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    prev.set(line)
  }
  return { width, height, data: out }
}

// The production build, as the desktop app ships it (dev mode differs: React
// StrictMode effects, and the dependency optimizer reloads the page mid-run).
const { build, preview } = await import('vite')
const dist = process.env.INK_STABLE_DIST || mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'fanotes-ink-stable-web-'))
if (!process.env.INK_STABLE_DIST || !existsSync(join(dist, 'index.html'))) {
  await build({ root, logLevel: 'error', build: { outDir: dist, emptyOutDir: true, reportCompressedSize: false } })
}
const server = await preview({
  root,
  logLevel: 'error',
  build: { outDir: dist },
  preview: { host: '127.0.0.1', port: Number(process.env.INK_STABLE_PORT) || await freePort(), strictPort: false },
})
const appUrl = `http://127.0.0.1:${server.httpServer.address().port}/?web`

// ---- page-side recorder ----------------------------------------------------
// Installed before the app's own scripts, so its capture listeners run first
// and see the paper where it was when the pen touched it.
const recorderSource = () => {
  const state = {
    armed: false,
    sel: '.unified-paper',
    strokes: [],
    current: null,
    frames: 0,
    issues: [],
    lostAt: new Map(),
    scratch: null,
    maskCanvas: null,
    hold: 0,
  }
  window.__ink = state
  // The web build has no vault watcher. Stand in for one, so a "remote" write
  // can be announced the way the desktop watcher announces a sync pull.
  let api
  const vaultCallbacks = new Set()
  const written = new Map()
  Object.defineProperty(window, 'fanotes', {
    configurable: true,
    get: () => api,
    set: (value) => {
      if (!value || value.__inkStable) { api = value; return }
      const writeFile = value.writeFile?.bind(value)
      api = Object.assign(Object.create(value), {
        __inkStable: true,
        writeFile: writeFile ? async (path, content) => { written.set(path, content); return writeFile(path, content) } : undefined,
        onVaultChanged: value.onVaultChanged ?? ((callback) => { vaultCallbacks.add(callback); return () => vaultCallbacks.delete(callback) }),
      })
    },
  })
  state.remoteEdit = async (path, edit) => {
    const before = written.get(path)
    if (!before || !api?.writeFile) return false
    const next = edit(before)
    await Object.getPrototypeOf(api).writeFile.call(Object.getPrototypeOf(api), path, next)
    for (const callback of vaultCallbacks) callback({ added: [], removed: [], changed: [path] })
    return true
  }
  const paper = () => document.querySelector(state.sel)
  // Paper frame: the sheet's box plus its content origin (a pad grown above or
  // left of the first ink moves the box but not the writing).
  const frame = () => {
    const el = paper()
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const sx = rect.width / Math.max(1, el.offsetWidth)
    const sy = rect.height / Math.max(1, el.offsetHeight)
    // A PDF page or worksheet page is its own anchor: ink belongs to the page.
    const pin = state.anchor ? el.querySelector(state.anchor) : null
    if (pin) {
      // Page-relative: a page zoom re-lays the page out bigger instead of scaling it.
      const box = pin.getBoundingClientRect()
      const unit = Math.max(1, box.width) / 1000
      return { el, rect, sx: unit, sy: unit, left: box.left, top: box.top }
    }
    const ox = parseFloat(el.style.getPropertyValue('--text-origin-x')) || 0
    const oy = parseFloat(el.style.getPropertyValue('--text-origin-y')) || 0
    return { el, rect, sx, sy, left: rect.left + ox * sx, top: rect.top + oy * sy }
  }
  state.frameOf = frame
  // Stroke bookkeeping from the driver: gone (erased/undone), unsure (in a
  // transition the check cannot judge), or back (redo: must show again).
  state.mark = (ids, patch) => {
    // A stroke the eraser cut stays out of judgement for good (only its gap is known).
    const all = ids === 'all' ? state.strokes.filter((stroke) => !stroke.erased) : ids === 'last' ? state.strokes.slice(-1) : state.strokes.filter((stroke) => ids.includes(stroke.id))
    const now = performance.now()
    for (const stroke of all) {
      Object.assign(stroke, patch)
      if (patch.fresh) for (const p of stroke.points) { p.seen = false; p.missFrames = 0; p.t = now + (patch.fresh === true ? 0 : patch.fresh) }
    }
    return all.map((stroke) => stroke.id)
  }
  const local = (event) => {
    const f = frame()
    if (!f) return null
    return { x: (event.clientX - f.left) / f.sx, y: (event.clientY - f.top) / f.sy, t: performance.now() }
  }
  const onDown = (event) => {
    if (!state.armed || state.paused) return
    // Only contacts on the sheet are ink; a click on a tab or button is not.
    if (!(event.target instanceof Element) || !event.target.closest('.lw-canvas-surface')) return
    if (event.target.closest('button, [role="button"], input, .note-tab')) return
    // Keyboard mode: a click places the caret, it does not ink.
    if (!document.querySelector('.lw-tablet-canvas-live.is-input-active')) return
    const p = local(event)
    if (!p) return
    state.current = { id: state.strokes.length, points: [p], gone: false, unsure: false, type: event.pointerType, label: state.label }
    state.strokes.push(state.current)
  }
  const onMove = (event) => {
    if (!state.armed || !state.current || !event.buttons) return
    const samples = event.getCoalescedEvents?.() ?? [event]
    for (const sample of (samples.length ? samples : [event])) {
      const p = local(sample)
      if (p) state.current.points.push(p)
    }
  }
  const onUp = () => {
    state.current = null
  }
  // Chromium's own predictor only runs for real devices. Stand in for it on
  // pen and touch: extrapolate the last motion a few milliseconds ahead, with
  // the overshoot a real predictor shows at a turn.
  const history = []
  const track = (event) => {
    if (event.pointerType === 'mouse') return
    history.push({ x: event.clientX, y: event.clientY, t: event.timeStamp })
    if (history.length > 4) history.shift()
  }
  window.addEventListener('pointerdown', (event) => { history.length = 0; track(event) }, true)
  window.addEventListener('pointermove', (event) => {
    for (const sample of event.getCoalescedEvents?.() ?? [event]) track(sample)
  }, true)
  const nativePredicted = PointerEvent.prototype.getPredictedEvents
  PointerEvent.prototype.getPredictedEvents = function getPredictedEvents() {
    const real = nativePredicted ? nativePredicted.call(this) : []
    if (real.length || state.predict === false || this.type !== 'pointermove' || this.pointerType === 'mouse' || history.length < 2) return real
    const a = history.at(-2); const b = history.at(-1)
    const dt = Math.max(1, b.t - a.t)
    const vx = (b.x - a.x) / dt; const vy = (b.y - a.y) / dt
    const out = []
    for (const ahead of [8, 16, 24]) {
      out.push(new PointerEvent('pointermove', {
        clientX: b.x + vx * ahead * 1.4, clientY: b.y + vy * ahead * 1.4, pointerId: this.pointerId,
        pointerType: this.pointerType, pressure: this.pressure, buttons: this.buttons, isPrimary: this.isPrimary,
      }))
    }
    return out
  }
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)

  const isInk = (data, i) => {
    const a = data[i + 3]
    if (a < 110) return false
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2]
    // Ink is dark (pen) or strongly coloured; paper dots and ruling are light grey.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    return lum < 120 || sat > 90
  }
  const visibleCanvases = (el) => {
    const out = []
    for (const canvas of el.querySelectorAll('canvas.lw-tablet-canvas')) {
      if (!canvas.width || !canvas.height) continue
      let node = canvas
      let hidden = false
      while (node && node !== el.parentElement) {
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) { hidden = true; break }
        node = node.parentElement
      }
      if (!hidden) out.push(canvas)
    }
    return out
  }
  const check = () => {
    if (!state.armed) return
    state.frames += 1
    const f = frame()
    if (!f) return
    const { el, sx, sy } = f
    const rect = { left: f.left, top: f.top }
    const view = (el.closest('.unified-note-view') ?? document.documentElement).getBoundingClientRect()
    const vx0 = Math.max(0, view.left); const vy0 = Math.max(0, view.top)
    const vx1 = Math.min(innerWidth, view.right); const vy1 = Math.min(innerHeight, view.bottom)
    const now = performance.now()
    const live = state.strokes.filter((stroke) => !stroke.gone)
    if (!live.length) return
    // Region of interest: every recorded point, in client px.
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
    for (const stroke of state.strokes) {
      for (const p of stroke.points) {
        const cx = rect.left + p.x * sx; const cy = rect.top + p.y * sy
        x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy)
      }
    }
    const pad = 60
    x0 = Math.max(vx0, Math.floor(x0 - pad)); y0 = Math.max(vy0, Math.floor(y0 - pad))
    x1 = Math.min(vx1, Math.ceil(x1 + pad)); y1 = Math.min(vy1, Math.ceil(y1 + pad))
    if (x1 - x0 < 2 || y1 - y0 < 2) return
    const w = Math.ceil(x1 - x0); const h = Math.ceil(y1 - y0)
    const scratch = state.scratch ??= document.createElement('canvas')
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h }
    const ctx = scratch.getContext('2d', { willReadFrequently: true })
    ctx.clearRect(0, 0, w, h)
    for (const canvas of visibleCanvases(el)) {
      const cr = canvas.getBoundingClientRect()
      if (cr.width <= 0 || cr.height <= 0) continue
      const kx = canvas.width / cr.width; const ky = canvas.height / cr.height
      // Map the ROI (client px) into this canvas' bitmap.
      ctx.drawImage(canvas, (x0 - cr.left) * kx, (y0 - cr.top) * ky, w * kx, h * ky, 0, 0, w, h)
    }
    const data = ctx.getImageData(0, 0, w, h).data
    const inkNear = (cx, cy, r) => {
      const px = Math.round(cx - x0); const py = Math.round(cy - y0)
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const qx = px + dx; const qy = py + dy
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue
          if (isInk(data, (qy * w + qx) * 4)) return true
        }
      }
      return false
    }
    const grace = state.grace ?? 70
    let lost = 0
    let missing = 0
    const lostSamples = []
    for (const stroke of live) {
      if (stroke.unsure) continue
      for (let i = 0; i < stroke.points.length; i += 1) {
        const p = stroke.points[i]
        const cx = rect.left + p.x * sx; const cy = rect.top + p.y * sy
        if (cx < vx0 + 4 || cy < vy0 + 4 || cx > vx1 - 4 || cy > vy1 - 4) { p.out = true; continue }
        const on = inkNear(cx, cy, 4)
        if (on) {
          p.seen = true
          p.missFrames = 0
        } else if (p.seen && !p.out) {
          lost += 1
          if (lostSamples.length < 4) lostSamples.push({ stroke: stroke.id, i, x: Math.round(cx), y: Math.round(cy) })
        } else if (now - p.t > grace) {
          p.missFrames = (p.missFrames ?? 0) + 1
          if (p.missFrames > 2) {
            missing += 1
            if (lostSamples.length < 6) {
              let near = null
              for (let r = 5; r <= 24 && near === null; r += 1) if (inkNear(cx, cy, r)) near = r
              lostSamples.push({ miss: true, stroke: stroke.id, i, n: stroke.points.length, x: Math.round(cx), y: Math.round(cy), nearestInk: near })
            }
          }
        }
        p.out = false
      }
    }
    // Stray ink: draw a mask of where ink may be (every recorded point, generously wide).
    const mask = state.maskCanvas ??= document.createElement('canvas')
    if (mask.width !== w || mask.height !== h) { mask.width = w; mask.height = h }
    const m = mask.getContext('2d', { willReadFrequently: true })
    m.clearRect(0, 0, w, h)
    m.strokeStyle = '#000'; m.fillStyle = '#000'
    m.lineCap = 'round'; m.lineJoin = 'round'
    const tol = (state.tolerance ?? 7)
    m.lineWidth = tol * 2 * Math.max(1, sx)
    for (const stroke of state.strokes) {
      if (stroke.gone && !stroke.unsure) continue
      m.beginPath()
      stroke.points.forEach((p, i) => {
        const cx = rect.left + p.x * sx - x0; const cy = rect.top + p.y * sy - y0
        if (i === 0) m.moveTo(cx, cy)
        else m.lineTo(cx, cy)
      })
      if (stroke.points.length === 1) m.lineTo(rect.left + stroke.points[0].x * sx - x0 + 0.1, rect.top + stroke.points[0].y * sy - y0)
      m.stroke()
    }
    const md = m.getImageData(0, 0, w, h).data
    let stray = 0
    let ahead = 0
    let strayAt = null
    const tipPoint = state.current?.points.at(-1)
    const tip = tipPoint ? { x: rect.left + tipPoint.x * sx, y: rect.top + tipPoint.y * sy } : null
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4
        if (md[i + 3] > 0) continue
        if (isInk(data, i)) {
          // Ahead of the live pen tip: a predicted sample (the app keeps it short).
          if (tip && Math.hypot(x + x0 - tip.x, y + y0 - tip.y) < (state.predictReach ?? 18)) { ahead += 1; continue }
          stray += 1
          if (!strayAt || strayAt.length < 4) (strayAt ??= []).push({ x: x + x0, y: y + y0 })
        }
      }
    }
    // Layout changes of the sheet, for the failure report.
    const layoutSig = `${Math.round(el.offsetWidth)}x${Math.round(el.offsetHeight)} anchor ${Math.round(f.top)} origin ${el.style.getPropertyValue('--text-origin-y') || '0'} page ${el.style.getPropertyValue('--ink-page-height')} kids ${[...el.children].map((c) => Math.round(c.offsetHeight)).join(',')}`
    if (layoutSig !== state.lastLayoutSig) {
      state.lastLayoutSig = layoutSig
      ;(state.layoutLog ??= []).push(`${state.frames}${state.current ? '*' : ''} ${layoutSig}`)
      if (state.layoutLog.length > 40) state.layoutLog.shift()
    }
    let strayLayer
    if (strayAt && stray > (state.strayAllow ?? 2)) {
      // Which layer holds it: the live (in-progress) layer or the saved one.
      const probe = state.probe ??= document.createElement('canvas')
      probe.width = 1; probe.height = 1
      const p = probe.getContext('2d', { willReadFrequently: true })
      strayLayer = visibleCanvases(el).filter((canvas) => {
        const cr = canvas.getBoundingClientRect()
        p.clearRect(0, 0, 1, 1)
        p.drawImage(canvas, (strayAt[0].x - cr.left) * canvas.width / cr.width, (strayAt[0].y - cr.top) * canvas.height / cr.height, 1, 1, 0, 0, 1, 1)
        return p.getImageData(0, 0, 1, 1).data[3] > 60
      }).map((canvas) => (canvas.classList.contains('lw-tablet-canvas-live') ? 'live' : 'committed'))
    }
    const canvasInfo = visibleCanvases(el).map((canvas) => `${canvas.classList.contains('lw-tablet-canvas-live') ? 'L' : 'C'} top ${Math.round(canvas.getBoundingClientRect().top)} css ${canvas.style.top} h ${canvas.style.height} bitmap ${canvas.width}x${canvas.height}`).join(' ; ')
    const prevCanvasInfo = state.prevCanvasInfo
    state.prevCanvasInfo = canvasInfo
    if (lost || missing || stray > (state.strayAllow ?? 2)) {
      state.issues.push({ canvasInfo, prevCanvasInfo, strayLayer, penDown: Boolean(state.current), frame: state.frames, at: Math.round(now), label: state.label, lost, missing, stray, strayAt, lostSamples })
    }
  }
  const loop = () => {
    requestAnimationFrame(loop)
    // Run after this frame's rendering, so the sample is what reached the screen.
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      try { check() } catch (error) { state.issues.push({ error: String(error?.stack ?? error) }) }
    }
    channel.port2.postMessage(0)
  }
  requestAnimationFrame(loop)
}

// A small multi-page PDF (A4 pages with one line of text each).
const buildPdf = (count) => {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < count; i += 1) {
    const stream = `BT /F1 18 Tf 60 780 Td (Seite ${i + 1}) Tj ET`
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// ---- Chromium over CDP -------------------------------------------------------
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'fanotes-ink-stable-'))
const fixtures = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'fanotes-ink-stable-files-'))
const pdfPath = join(fixtures, 'Skript.pdf')
writeFileSync(pdfPath, buildPdf(8))
const sheetPath = join(fixtures, 'Blatt.pdf')
writeFileSync(sheetPath, buildPdf(2))
const chrome = spawn(chromium, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1280,900', '--lang=de-CH', '--accept-lang=de-CH,de', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
const browserWs = await new Promise((resolve, reject) => {
  let stderr = ''
  const timer = setTimeout(() => reject(new Error(`chromium did not start\n${stderr}`)), 30_000)
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk
    const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
    if (match) { clearTimeout(timer); resolve(match[1]) }
  })
  chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chromium exited ${code}\n${stderr}`)) })
})
const debugPort = new URL(browserWs).port

const failures = []
const summary = []
let ws
try {
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const pageTarget = target.find((entry) => entry.type === 'page')
  ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const pageErrors = []
  const nextFile = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    } else if (message.method === 'Page.fileChooserOpened') {
      const file = nextFile.shift()
      if (file) void call('DOM.setFileInputFiles', { files: [file], backendNodeId: message.params.backendNodeId }).catch(() => {})
    } else if (message.method === 'Runtime.consoleAPICalled' && process.env.INK_STABLE_CONSOLE) {
      const text = message.params.args.map((arg) => arg.value ?? arg.description).join(' ')
      if (text.includes(process.env.INK_STABLE_CONSOLE)) console.log(text)
    } else if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('websocket failed')))
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const send = (method, params = {}) => {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
  }
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression: typeof expression === 'function' ? `(${expression})()` : expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result.value
  }
  const shot = async (name) => {
    if (!process.env.INK_STABLE_SHOTS) return
    const { data } = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(process.env.INK_STABLE_SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (expression, timeout = 30_000) => {
    const end = Date.now() + timeout
    for (;;) {
      if (await evaluate(expression)) return
      if (Date.now() > end) {
        throw new Error(`timeout waiting for ${expression}`)
      }
      await sleep(150)
    }
  }
  const rectOf = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  const mouse = (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !extra.buttons ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1, ...extra })
  const click = async (selector) => {
    const r = await rectOf(selector)
    if (!r) throw new Error(`no ${selector}`)
    await mouse('mouseMoved', r.x + r.w / 2, r.y + r.h / 2)
    await mouse('mousePressed', r.x + r.w / 2, r.y + r.h / 2)
    await mouse('mouseReleased', r.x + r.w / 2, r.y + r.h / 2)
  }
  const clickText = async (pattern) => {
    const r = await evaluate(`(() => { const el = [...document.querySelectorAll('button, [role="button"]')].find((node) => ${pattern}.test(node.textContent ?? '')); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    if (!r) return false
    await mouse('mouseMoved', r.x, r.y)
    await mouse('mousePressed', r.x, r.y)
    await mouse('mouseReleased', r.x, r.y)
    return true
  }
  const clickTitle = async (pattern) => {
    const r = await evaluate(`(() => { const el = [...document.querySelectorAll('button[title], button[aria-label]')].find((node) => ${pattern}.test(node.getAttribute('title') ?? node.getAttribute('aria-label') ?? '') && node.getBoundingClientRect().width > 0); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    if (!r) return false
    await mouse('mouseMoved', r.x, r.y)
    await mouse('mousePressed', r.x, r.y)
    await mouse('mouseReleased', r.x, r.y)
    return true
  }
  const clickUntil = async (selector, expression, tries = 6) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      await click(selector).catch(() => {})
      try { await waitFor(expression, 8_000); return } catch { /* again */ }
    }
    await shot('click-until')
    throw new Error(`clicking ${selector} never gave ${expression}`)
  }
  const key = async (keyName, code, keyCode, modifiers = 0, text) => {
    await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, text })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
  const ctrl = (letter) => key(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), 2)
  const typeText = async (text) => {
    for (const part of text.split(/(\n)/)) {
      if (part === '\n') await key('Enter', 'Enter', 13, 0, '\r')
      else if (part) await call('Input.insertText', { text: part })
      await sleep(20)
    }
  }

  // Pointer input. One stroke = down, moves, up; `pace` dispatches several
  // moves per frame without waiting so Chromium coalesces them like a real pen.
  const stroke = async (points, { type = 'pen', perFrame = 2, frameMs = 16, onMove } = {}) => {
    const [first, ...rest] = points
    if (type === 'touch') {
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x, y: first.y, id: 1, radiusX: 4, radiusY: 4, force: 0.5 }] })
      for (let i = 0; i < rest.length; i += 1) {
        const p = rest[i]
        send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 0.5 }] })
        if ((i + 1) % perFrame === 0) { await sleep(frameMs); await onMove?.(i) }
      }
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return
    }
    const pen = type === 'pen' ? { pointerType: 'pen', force: 0.5, tiltX: 10, tiltY: -5 } : {}
    await mouse('mouseMoved', first.x, first.y, pen.pointerType ? { pointerType: 'pen' } : {})
    await mouse('mousePressed', first.x, first.y, { ...pen, buttons: 1 })
    for (let i = 0; i < rest.length; i += 1) {
      const p = rest[i]
      send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, ...pen })
      if ((i + 1) % perFrame === 0) { await sleep(frameMs); await onMove?.(i) }
    }
    const last = points.at(-1)
    await mouse('mouseReleased', last.x, last.y, { ...pen, buttons: 0 })
  }
  // A handwriting-like line: loops along a baseline.
  const writing = (x, y, width, { step = 3, height = 14 } = {}) => {
    const out = []
    for (let s = 0; s <= width; s += step) {
      out.push({ x: x + s + Math.sin(s / 7) * 4, y: y - Math.abs(Math.sin(s / 11)) * height + Math.cos(s / 5) * 2 })
    }
    return out
  }

  const arm = (label, extra = {}) => evaluate(`(() => { const s = window.__ink; s.armed = true; s.label = ${JSON.stringify(label)}; Object.assign(s, ${JSON.stringify(extra)}); return true })()`)
  const relabel = (label) => evaluate(`(window.__ink.label = ${JSON.stringify(label)}, true)`)
  const resetRecorder = () => evaluate(`(() => { const s = window.__ink; s.strokes = []; s.issues = []; s.current = null; s.frames = 0; return true })()`)
  const markGone = (filter) => evaluate(`(() => { for (const s of window.__ink.strokes) if ((${filter})(s)) s.gone = true; return true })()`)
  const takeIssues = async (scenario) => {
    const result = await evaluate(`(() => { const s = window.__ink; const out = { frames: s.frames, issues: s.issues.splice(0), strokes: s.strokes.length, points: s.strokes.reduce((n, k) => n + k.points.length, 0), layout: (s.layoutLog ?? []).splice(0) }; return out })()`)
    if (verbose) console.log(scenario, 'layout:', result.layout.join(' | '))
    // What reached the screen: every written point must be dark there too
    // (a layer above the ink, or ink never composited, shows up only here).
    const expected = await evaluate(`(() => {
      const s = window.__ink; const f = s.frameOf(); if (!f) return []
      const view = (f.el.closest('.unified-note-view') ?? document.documentElement).getBoundingClientRect()
      const out = []
      for (const stroke of s.strokes) {
        if (stroke.gone || stroke.unsure) continue
        stroke.points.forEach((p, i) => {
          if (i % 3) return
          const x = f.left + p.x * f.sx; const y = f.top + p.y * f.sy
          if (x < view.left + 6 || y < view.top + 6 || x > view.right - 6 || y > view.bottom - 6) return
          const hit = document.elementFromPoint(x, y)
          if (hit && hit.closest('header, .worksheet-toolbar, .lw-pen-pointer, [role="dialog"], .toast, .app-toast')) return
          out.push([x, y, stroke.id])
        })
      }
      return out
    })()`)
    if (expected.length) {
      const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const png = decodePng(Buffer.from(data, 'base64'))
      const scale = png.width / 1280 > 0 ? png.width / (await evaluate('innerWidth')) : 1
      let unseen = 0
      const unseenAt = []
      for (const [x, y, id] of expected) {
        let dark = false
        const r = Math.ceil(4 * scale)
        for (let dy = -r; dy <= r && !dark; dy += 1) {
          for (let dx = -r; dx <= r && !dark; dx += 1) {
            const px = Math.round(x * scale) + dx; const py = Math.round(y * scale) + dy
            if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue
            const i = (py * png.width + px) * 4
            const lum = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]
            const sat = Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) - Math.min(png.data[i], png.data[i + 1], png.data[i + 2])
            if (lum < 120 || sat > 90) dark = true
          }
        }
        if (!dark) {
          unseen += 1
          if (unseenAt.length < 4) unseenAt.push({ x: Math.round(x), y: Math.round(y), stroke: id })
        }
      }
      if (unseen > Math.max(2, expected.length * 0.02)) result.issues.push({ label: `${scenario} (screen)`, hidden: unseen, of: expected.length, hiddenAt: unseenAt })
    }
    const bad = result.issues.filter((issue) => issue.error || issue.lost || issue.missing || issue.stray > 2 || issue.hidden)
    // A stroke that already failed is reported once; later scenarios judge their own ink.
    if (bad.length) await evaluate(`(() => { for (const s of window.__ink.strokes) if (s.points.some((p) => (p.missFrames ?? 0) > 2 || (p.seen && p.out === false && false))) s.unsure = true; return true })()`)
    summary.push({ scenario, frames: result.frames, strokes: result.strokes, points: result.points, badFrames: bad.length })
    if (bad.length) {
      const kinds = {
        flicker: bad.filter((i) => i.lost).length,
        missing: bad.filter((i) => i.missing).length,
        stray: bad.filter((i) => i.stray > 2).length,
        error: bad.filter((i) => i.error).length,
        hidden: bad.filter((i) => i.hidden).length,
      }
      const worst = bad.reduce((top, issue) => ((issue.lost ?? 0) + (issue.missing ?? 0) + (issue.stray ?? 0) + (issue.hidden ?? 0) > (top.lost ?? 0) + (top.missing ?? 0) + (top.stray ?? 0) + (top.hidden ?? 0) ? issue : top), bad[0])
      failures.push({ scenario, kinds, worst, first: bad.slice(0, verbose ? 12 : 3) })
    }
    if (process.env.INK_STABLE_UNTIL && scenario.includes(process.env.INK_STABLE_UNTIL)) throw Object.assign(new Error('stop'), { stop: true })
    return result
  }

  await call('Page.enable')
  await call('Runtime.enable')
  await call('DOM.enable')
  await call('Page.setInterceptFileChooserDialog', { enabled: true })
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1.5, mobile: false })
  await call('Emulation.setLocaleOverride', { locale: 'de-CH' }).catch(() => {})
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(${recorderSource})()` })
  await call('Page.navigate', { url: appUrl })
  await waitFor(`Boolean(document.querySelector('.first-run-continue, .pdf-import-button'))`, 120_000)
  for (let step = 0; step < 6 && await evaluate(`Boolean(document.querySelector('.first-run-continue'))`); step += 1) {
    await click('.first-run-continue')
    await sleep(900)
  }
  await waitFor(`Boolean(document.querySelector('button[aria-label="Neue Notiz"], button[aria-label="New note"]'))`, 60_000)
  // The welcome note opens once the vault is loaded; a note made before that is not opened.
  await waitFor(`Boolean(document.querySelector('.note-tab'))`, 60_000).catch(() => {})
  await sleep(800)

  const scenarios = {}

  // Markdown note: text, then the inline paper with pen strokes.
  scenarios.markdown = async () => {
    await clickUntil('button[aria-label="Neue Notiz"], button[aria-label="New note"]', `Boolean(document.querySelector('.cm-content'))`)
    await sleep(500)
    await click('.cm-content')
    await typeText('# Titel\n\nText der Notiz.\nZweite Zeile.')
    await sleep(600)
    await ctrl('d')
    await waitFor(`Boolean(document.querySelector('.unified-paper canvas.lw-tablet-canvas-live.is-input-active'))`)
    await sleep(800)
    await resetRecorder()
    await arm('md-lines', { anchor: null })
    const paper = await rectOf('.unified-paper')
    for (let line = 0; line < 4; line += 1) {
      await stroke(writing(paper.x + 120, paper.y + 120 + line * 40, 360))
      await sleep(120)
    }
    await sleep(500)
    await shot('md-lines')
    await takeIssues('markdown: pen lines')

    // The sheet moves under a stroke with no scroll and no resize of the
    // sheet itself (a bar appearing above the note, a sidebar animating).
    await relabel('md-shift')
    await stroke(writing(paper.x + 120, paper.y + 300, 360), {
      onMove: async (i) => {
        if (i === 41) await evaluate(`(document.querySelector('.editor-stage').style.paddingTop = '40px', true)`)
      },
    })
    await sleep(300)
    await evaluate(`(document.querySelector('.editor-stage').style.paddingTop = '', true)`)
    await sleep(400)
    await takeIssues('markdown: sheet moves under a stroke')

    // Mouse, then touch. A mouse within 850 ms of the pen is its echo and is ignored.
    await sleep(1000)
    await relabel('md-mouse')
    await stroke(writing(paper.x + 520, paper.y + 120, 200), { type: 'mouse' })
    await sleep(300)
    await takeIssues('markdown: mouse')
    const touchDraws = !(await evaluate(`Boolean(window.__fanotesSettings?.penOnly)`))
    if (touchDraws) {
      await relabel('md-touch')
      await stroke(writing(paper.x + 520, paper.y + 200, 200), { type: 'touch' })
      await sleep(300)
      await takeIssues('markdown: touch')
    }

    // Many quick strokes in a row (pen-up/pen-down hand-off).
    await relabel('md-burst')
    for (let i = 0; i < 12; i += 1) {
      const x = paper.x + 120 + i * 30
      await stroke([{ x, y: paper.y + 300 }, { x: x + 8, y: paper.y + 285 }, { x: x + 14, y: paper.y + 300 }, { x: x + 20, y: paper.y + 288 }], { perFrame: 1 })
    }
    await sleep(400)
    await takeIssues('markdown: quick strokes')

    // Across the sheet's bottom edge: the page grows under the pen.
    await relabel('md-grow')
    const scrollPaperBottomTo = (y) => evaluate(`(() => { const paper = document.querySelector('.unified-paper'); const view = paper.closest('.unified-note-view'); view.scrollTop += paper.getBoundingClientRect().bottom - ${y}; return true })()`)
    await scrollPaperBottomTo(640)
    await sleep(400)
    let now = await rectOf('.unified-paper')
    for (let i = 0; i < 3; i += 1) {
      const x = now.x + 140 + i * 120
      const pts = []
      for (let k = 0; k <= 60; k += 1) pts.push({ x: x + Math.sin(k / 4) * 12, y: now.y + now.h - 60 + k * 3 })
      await stroke(pts)
      await sleep(200)
      await scrollPaperBottomTo(640)
      await sleep(300)
      now = await rectOf('.unified-paper')
    }
    await sleep(600)
    await shot('md-grow')
    await takeIssues('markdown: page grows under the pen')

    // Up past the sheet's top edge and left past its left edge: the page
    // grows a pad there and the camera follows so nothing visibly moves.
    await relabel('md-grow-up')
    await evaluate('(window.__inkDebug = true, true)')
    await evaluate(`(() => { const paper = document.querySelector('.unified-paper'); const view = paper.closest('.unified-note-view'); view.scrollTop += paper.getBoundingClientRect().top - 330; view.scrollLeft += paper.getBoundingClientRect().left - 560; return true })()`)
    await sleep(500)
    now = await rectOf('.unified-paper')
    for (let i = 0; i < 3; i += 1) {
      const pts = []
      for (let k = 0; k <= 60; k += 1) pts.push({ x: now.x + 80 + i * 90 + Math.sin(k / 4) * 10, y: now.y + 90 - k * 3 })
      await stroke(pts)
      await sleep(250)
    }
    await evaluate('(window.__inkDebug = false, true)')
    await relabel('md-grow-left')
    now = await rectOf('.unified-paper')
    for (let i = 0; i < 2; i += 1) {
      const pts = []
      for (let k = 0; k <= 60; k += 1) pts.push({ x: now.x + 90 - k * 3, y: now.y + 200 + i * 60 + Math.sin(k / 4) * 10 })
      await stroke(pts)
      await sleep(250)
    }
    await sleep(600)
    await shot('md-grow-up')
    await takeIssues('markdown: page grows up and left under the pen')

    // Down toward the window's bottom, where the note scrolls along.
    await relabel('md-autoscroll')
    for (let i = 0; i < 2; i += 1) {
      const pts = []
      for (let k = 0; k <= 80; k += 1) pts.push({ x: 520 + i * 160 + Math.sin(k / 5) * 10, y: 700 + k * 2.4 })
      await stroke(pts, { perFrame: 1 })
      await sleep(250)
    }
    await sleep(600)
    await shot('md-autoscroll')
    await takeIssues('markdown: write at the window bottom')

    // Scroll, then write; zoom, then write.
    await relabel('md-scroll')
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 0, deltaY: 160 })
    await sleep(500)
    now = await rectOf('.unified-paper')
    await stroke(writing(700, 400, 240))
    await sleep(300)
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 0, deltaY: -160 })
    await sleep(500)
    await takeIssues('markdown: scroll between strokes')
    await relabel('md-zoom')
    await evaluate(`window.__ink.mark('all', { unsure: true })`)
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 0, deltaY: -120, modifiers: 2 })
    await sleep(900)
    await evaluate(`window.__ink.mark('all', { unsure: false, fresh: true })`)
    await sleep(200)
    await stroke(writing(640, 300, 200))
    await sleep(300)
    await shot('md-zoom')
    await evaluate(`window.__ink.mark('all', { unsure: true })`)
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 0, deltaY: 120, modifiers: 2 })
    await sleep(900)
    await evaluate(`window.__ink.mark('all', { unsure: false, fresh: true })`)
    await sleep(400)
    await takeIssues('markdown: zoom between strokes')

    // Undo and redo the last stroke.
    await relabel('md-undo')
    const lastId = await evaluate(`window.__ink.mark('last', { unsure: true })[0]`)
    await ctrl('z')
    await sleep(400)
    await evaluate(`window.__ink.mark([${lastId}], { unsure: false, gone: true })`)
    await sleep(300)
    await evaluate(`window.__ink.mark([${lastId}], { unsure: true, gone: false })`)
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 10 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 10 })
    await sleep(400)
    await evaluate(`window.__ink.mark([${lastId}], { unsure: false, fresh: true })`)
    await sleep(300)
    await shot('md-undo')
    await takeIssues('markdown: undo and redo')

    // Erase across one stroke: that stroke is cut, every other one stays.
    await relabel('md-erase')
    const target = await evaluate(`(() => { const s = window.__ink; const f = s.frameOf(); const live = s.strokes.filter((k) => !k.gone && k.points.length > 20); for (const k of live.reverse()) { const p = k.points[Math.floor(k.points.length / 2)]; const x = f.left + p.x * f.sx; const y = f.top + p.y * f.sy; if (y > 200 && y < 820 && x > 330 && x < 1200) return { id: k.id, x, y } } return null })()`)
    if (target && await clickTitle('/^Radierer/')) {
      await sleep(300)
      await evaluate(`window.__ink.mark([${target.id}], { unsure: true, erased: true })`)
      // The eraser's own path is not ink.
      await evaluate('(window.__ink.paused = true, true)')
      await stroke([{ x: target.x, y: target.y - 18 }, { x: target.x + 1, y: target.y - 6 }, { x: target.x + 2, y: target.y + 6 }, { x: target.x + 3, y: target.y + 18 }], { perFrame: 1 })
      await evaluate('(window.__ink.paused = false, true)')
      await sleep(500)
      assert.ok(await clickTitle('/^(Handschrift schreiben|Write)/'), 'the pen tool button is there')
      await sleep(300)
      await takeIssues('markdown: erase one stroke')
    } else if (verbose) console.log('erase skipped', target)

    // A sync pull rewrites the open note (here: a line added to its text).
    await relabel('md-remote')
    const notePath = await evaluate(`document.querySelector('.note-tab.active')?.getAttribute('title')`)
    await sleep(1500)
    const pulled = notePath && await evaluate(`window.__ink.remoteEdit(${JSON.stringify(notePath)}, (content) => { const at = content.indexOf('\\n<!-- fanotes-'); return at < 0 ? content + '\\nVom Handy ergänzt.\\n' : content.slice(0, at) + '\\nVom Handy ergänzt.\\n' + content.slice(at) })`)
    await sleep(2500)
    if (verbose) console.log('remote pull', notePath, pulled, await evaluate(`[...document.querySelectorAll('.cm-line')].some((line) => /Vom Handy/.test(line.textContent))`))
    await takeIssues('markdown: a sync pull rewrites the note')

    // Autosave runs while the pen keeps writing.
    await relabel('md-autosave')
    now = await rectOf('.unified-paper')
    for (let i = 0; i < 4; i += 1) {
      await stroke(writing(now.x + 140, now.y + 340 + i * 26, 300))
      await sleep(500)
    }
    await sleep(1200)
    await takeIssues('markdown: autosave between strokes')

    // Pen -> keyboard -> pen: the saved ink stays on the sheet the whole time.
    await relabel('md-mode')
    await ctrl('d')
    await sleep(900)
    await shot('md-keyboard')
    await takeIssues('markdown: switch to keyboard')

    // Type above the ink: the text reflows, the ink stays on its paper spot.
    await relabel('md-type')
    await evaluate(`(() => { const line = [...document.querySelectorAll('.cm-line')].find((el) => /Text der Notiz/.test(el.textContent)); if (!line) return false; const r = line.getBoundingClientRect(); window.__typeAt = { x: r.left + 4, y: r.top + r.height / 2 }; return true })()`)
    const at = await evaluate('window.__typeAt')
    if (at) {
      await mouse('mouseMoved', at.x, at.y)
      await mouse('mousePressed', at.x, at.y)
      await mouse('mouseReleased', at.x, at.y)
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
      for (let i = 0; i < 3; i += 1) {
        await typeText(`Neue Zeile ${i} mit etwas mehr Text darin\n`)
        await sleep(250)
      }
      await sleep(900)
    }
    await shot('md-type')
    await takeIssues('markdown: type above the ink')
    await relabel('md-mode-back')
    await ctrl('d')
    await sleep(900)
    await takeIssues('markdown: back to the pen')

    // Window and sidebar changes move the sheet; the ink moves with it.
    await relabel('md-sidebar')
    const collapse = await evaluate(`Boolean(document.querySelector('button[aria-label="Seitenleiste einklappen"], button[aria-label="Collapse sidebar"]'))`)
    if (collapse) {
      await click('button[aria-label="Seitenleiste einklappen"], button[aria-label="Collapse sidebar"]')
      await sleep(900)
      await shot('md-sidebar')
      now = await rectOf('.unified-paper')
      await stroke(writing(500, 380, 220))
      await sleep(300)
      await takeIssues('markdown: sidebar collapsed')
      await click('button[aria-label="Seitenleiste ausklappen"], button[aria-label="Expand sidebar"], button[aria-label="Seitenleiste einblenden"]').catch(() => {})
      await sleep(900)
      await takeIssues('markdown: sidebar back')
    }
    await relabel('md-resize')
    await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1.5, mobile: false })
    await sleep(700)
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1.5, mobile: false })
    await sleep(700)
    await takeIssues('markdown: window resize')
    await relabel('md-dpr')
    await evaluate(`window.__ink.mark('all', { unsure: true })`)
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1.25, mobile: false })
    await sleep(120)
    await evaluate(`window.__ink.mark('all', { unsure: false, fresh: 80 })`)
    await sleep(700)
    await stroke(writing(560, 440, 200))
    await sleep(300)
    await evaluate(`window.__ink.mark('all', { unsure: true })`)
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1.5, mobile: false })
    await sleep(120)
    await evaluate(`window.__ink.mark('all', { unsure: false, fresh: 80 })`)
    await sleep(700)
    await shot('md-dpr')
    await takeIssues('markdown: display scale change')

    // Another note and back: the ink comes back once, in place.
    await relabel('md-switch')
    const tabs = await evaluate(`[...document.querySelectorAll('.note-tab')].map((tab) => tab.getAttribute('title') ?? tab.textContent)`)
    if (tabs.length > 1) {
      await evaluate(`(window.__ink.armed = false, true)`)
      await click('.note-tab:not(.active)')
      await sleep(1200)
      await evaluate(`window.__ink.mark('all', { fresh: 450 })`)
      await evaluate(`(window.__ink.armed = true, true)`)
      await click('.note-tab:not(.active)')
      await sleep(1500)
      await shot('md-switch')
      await takeIssues('markdown: switch notes and back')
    }
  }

  const penMode = async () => {
    if (await evaluate(`Boolean(document.querySelector('.unified-paper canvas.lw-tablet-canvas-live.is-input-active'))`)) return
    await ctrl('d')
    await waitFor(`Boolean(document.querySelector('.unified-paper canvas.lw-tablet-canvas-live.is-input-active'))`)
    await sleep(700)
  }
  const scrollView = (dy) => evaluate(`(() => { const view = document.querySelector('.unified-note-view'); view.scrollTop += ${dy}; return view.scrollTop })()`)
  const lines = async (x, y, count, { gap = 34, width = 300, ...options } = {}) => {
    for (let line = 0; line < count; line += 1) {
      await stroke(writing(x, y + line * gap, width), options)
      await sleep(90)
    }
  }

  // A PDF note: write on the first page (moving up and down across it), on a
  // later page, while scrolling between pages, and after a zoom.
  scenarios.pdf = async () => {
    await evaluate(`(window.__ink.armed = false, true)`)
    nextFile.push(pdfPath)
    await click('button[aria-label="PDF importieren"], button[aria-label="Import PDF"]')
    await waitFor(`Boolean(document.querySelector('[data-pdf-page="3"]'))`, 60_000)
    await sleep(1500)
    await penMode()
    await resetRecorder()
    await arm('pdf-page1', { anchor: '[data-pdf-page="1"]' })
    const paper = await rectOf('.unified-paper')
    const first = await rectOf('[data-pdf-page="1"]')
    const top = Math.max(first.y, 160) + 60
    // Ink in the middle of the page first: it must stay on its spot of the
    // page when the next lines go near the page's top edge.
    await stroke(writing(first.x + 120, top + 330, 260))
    await sleep(200)
    await lines(Math.max(first.x, paper.x) + 80, top, 6, { gap: 40 })
    // Strokes that run up the page.
    for (let i = 0; i < 3; i += 1) {
      const pts = []
      for (let k = 0; k <= 50; k += 1) pts.push({ x: first.x + 420 + i * 40 + Math.sin(k / 4) * 8, y: top + 260 - k * 4 })
      await stroke(pts)
      await sleep(100)
    }
    await sleep(500)
    await shot('pdf-page1')
    await takeIssues('pdf: write on page 1')
    await relabel('pdf-scroll')
    for (let i = 0; i < 6; i += 1) {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 0, deltaY: 400 })
      await sleep(120)
    }
    await sleep(600)
    await lines(first.x + 100, 300, 4)
    await sleep(300)
    for (let i = 0; i < 6; i += 1) {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 0, deltaY: -400 })
      await sleep(120)
    }
    await sleep(800)
    await shot('pdf-scroll')
    await takeIssues('pdf: scroll between pages')
    await relabel('pdf-zoom')
    await evaluate(`window.__ink.mark('all', { unsure: true })`)
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 400, deltaX: 0, deltaY: -240, modifiers: 2 })
    await sleep(1000)
    await evaluate(`window.__ink.mark('all', { unsure: false, fresh: true })`)
    await sleep(200)
    await shot('pdf-zoom')
    await lines(first.x + 140, 520, 2)
    await sleep(400)
    await evaluate(`window.__ink.mark('all', { unsure: true })`)
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 400, deltaX: 0, deltaY: 240, modifiers: 2 })
    await sleep(1000)
    await evaluate(`window.__ink.mark('all', { unsure: false, fresh: true })`)
    await sleep(400)
    await takeIssues('pdf: zoom between strokes')
    await relabel('pdf-mode')
    await ctrl('d')
    await sleep(900)
    await takeIssues('pdf: switch to keyboard')
    await penMode()
  }

  // A worksheet in a note.
  scenarios.worksheet = async () => {
    await evaluate(`(window.__ink.armed = false, true)`)
    await clickUntil('button[aria-label="Neue Notiz"], button[aria-label="New note"]', `Boolean(document.querySelector('.cm-content'))`)
    await sleep(500)
    nextFile.push(sheetPath)
    const before = await evaluate(`document.querySelectorAll('.unified-paper.has-worksheet, .worksheet-layer').length`)
    await click('button[aria-label="Arbeitsblatt importieren"], button[aria-label="Import worksheet"]')
    await sleep(600)
    await clickText('/In aktuelle Notiz|Into this note|current note/i')
    await waitFor(`document.querySelectorAll('.unified-paper.has-worksheet, .worksheet-layer').length > ${before}`, 30_000).catch(() => {})
    await sleep(1500)
    await penMode()
    // Pen mode keeps the sheet under the ink and its Entfernen button on top.
    assert.ok(await evaluate(`(() => { const button = document.querySelector('.worksheet-remove'); if (!button) return true; const r = button.getBoundingClientRect(); return Boolean(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.worksheet-remove')) })()`), 'Entfernen on the worksheet stays clickable in pen mode')
    await resetRecorder()
    await arm('sheet', { anchor: '.worksheet-page' })
    const paper = await rectOf('.unified-paper')
    const y0 = Math.max(paper.y, 140) + 120
    await lines(paper.x + 140, y0, 1, { gap: 38 })
    await lines(paper.x + 140, y0 + 38, 4, { gap: 38 })
    // The first save writes the note's ink marker: the sheet must not move.
    await sleep(2500)
    await scrollView(500)
    await sleep(500)
    await lines(paper.x + 160, 420, 3, { gap: 38 })
    await sleep(500)
    await shot('worksheet')
    await takeIssues('worksheet: write on the sheet')
  }

  // A page with only handwriting, written full like a real page.
  scenarios.ink = async () => {
    await evaluate(`(window.__ink.armed = false, true)`)
    await clickUntil('button[aria-label="Neue Notiz"], button[aria-label="New note"]', `Boolean(document.querySelector('.cm-content'))`)
    await sleep(500)
    await penMode()
    await resetRecorder()
    await arm('ink-page', { anchor: null })
    const paper = await rectOf('.unified-paper')
    const x0 = paper.x + 60
    for (let row = 0; row < 14; row += 1) {
      for (let word = 0; word < 4; word += 1) {
        await stroke(writing(x0 + word * 150, 200 + row * 46, 110, { step: 6 }), { perFrame: 4 })
      }
      if (row === 9) await scrollView(260)
    }
    await sleep(600)
    await shot('ink-page')
    await takeIssues('ink page: a full page of writing')
    await relabel('ink-scroll')
    for (const dy of [600, -300, 900, -1200]) {
      await scrollView(dy)
      await sleep(250)
    }
    await sleep(500)
    await takeIssues('ink page: scroll around')
    await relabel('ink-undo')
    for (let i = 0; i < 3; i += 1) {
      const id = await evaluate(`window.__ink.strokes.filter((s) => !s.gone).at(-1).id`)
      await evaluate(`window.__ink.mark([${id}], { unsure: true })`)
      await ctrl('z')
      await sleep(300)
      await evaluate(`window.__ink.mark([${id}], { unsure: false, gone: true })`)
    }
    await sleep(400)
    await takeIssues('ink page: undo')
  }

  // Beautifier ON in the live board: only the line just finished moves, within
  // bounds; no flicker while it settles; one undo restores the originals.
  scenarios.beautify = async () => {
    await evaluate(`(window.__ink.armed = false, true)`)
    await clickUntil('button[aria-label="Neue Notiz"], button[aria-label="New note"]', `Boolean(document.querySelector('.cm-content'))`)
    await sleep(500)
    await penMode()
    await evaluate('(window.__beautifyTest = true, true)')
    // The flag is read on render; a stroke-free repaint picks it up.
    await sleep(300)
    const paper = await rectOf('.unified-paper')
    const letters = (x0, base, slope) => {
      const out = []
      for (let i = 0; i < 7; i += 1) {
        const x = x0 + i * 26
        const b = base + (slope * i * 26) / 150
        const h = 16 + (i % 2 ? 3 : -2)
        const pts = []
        if (i % 3 === 0) for (let k = 0; k <= 24; k += 1) pts.push({ x: x + 6 + 6 * Math.cos((k / 24) * Math.PI * 2), y: b - h / 2 + (h / 2) * Math.sin((k / 24) * Math.PI * 2) })
        else if (i % 3 === 1) for (let k = 0; k <= 12; k += 1) pts.push({ x: x + k * 1.2, y: b - h + (k <= 6 ? (k / 6) * h : ((12 - k) / 6) * h) })
        else for (let k = 0; k <= 12; k += 1) pts.push({ x, y: b - h * 1.4 + (k / 12) * h * 1.4 })
        out.push(pts.map((p) => ({ x: p.x + Math.sin(p.y * 7) * 0.3, y: p.y })))
      }
      return out
    }
    const read = () => evaluate(`(() => JSON.stringify({ page: window.__beautifyPage(), strokes: window.__beautifyStrokes().map((s) => s.points.map((p) => [p.x * window.__beautifyPage().width, p.y * window.__beautifyPage().height, p.pressure])) }))()`).then(JSON.parse)
    const sameStrokes = (a, b) => a.length === b.length && a.every((s, i) => s.length === b[i].length && s.every((p, k) => Math.abs(p[0] - b[i][k][0]) < 1e-6 && Math.abs(p[1] - b[i][k][1]) < 1e-6 && p[2] === b[i][k][2]))
    if (verbose) console.log('beautify paper', JSON.stringify(paper), await evaluate('JSON.stringify([!!window.__beautifyStrokes, document.querySelectorAll(".unified-paper").length, document.querySelectorAll("canvas.lw-tablet-canvas-live.is-input-active").length])'))
    const y1 = Math.max(paper.y, 140) + 150
    const y2 = y1 + 90
    const x0 = paper.x + 80
    // Line one, then wait for its idle beautify and settle.
    for (const pts of letters(x0, y1, 8)) await stroke(pts, { perFrame: 2 })
    await sleep(1300)
    const afterOne = await read()
    assert.equal(afterOne.strokes.length, 7, 'line one is on the page')
    // Page-side sampler: composite of the board's canvases over two bands, per frame.
    await evaluate(`(() => {
      const el = document.querySelector('.unified-paper')
      const scratch = document.createElement('canvas')
      window.__bs = { frames: [], run: false }
      const band = (cv, ctx, x, y, w, h) => {
        scratch.width = w; scratch.height = h
        ctx.clearRect(0, 0, w, h)
        for (const canvas of el.querySelectorAll('canvas.lw-tablet-canvas')) {
          if (!canvas.width || !canvas.height) continue
          const cs = getComputedStyle(canvas)
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue
          const r = canvas.getBoundingClientRect()
          const kx = canvas.width / r.width; const ky = canvas.height / r.height
          ctx.drawImage(canvas, (x - r.left) * kx, (y - r.top) * ky, w * kx, h * ky, 0, 0, w, h)
        }
        const d = ctx.getImageData(0, 0, w, h).data
        let n = 0; let hash = 0
        for (let i = 0; i < d.length; i += 4) { const ink = d[i + 3] >= 110 && (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) < 120; if (ink) { n += 1; hash = (hash * 31 + (i >> 2)) | 0 } }
        return { n, hash }
      }
      const ctx = scratch.getContext('2d', { willReadFrequently: true })
      window.__bs.start = (a, b) => {
        window.__bs.frames = []; window.__bs.run = true
        const tick = () => {
          if (!window.__bs.run) return
          window.__bs.frames.push({ t: performance.now(), a: band(null, ctx, a.x, a.y, a.w, a.h), b: band(null, ctx, b.x, b.y, b.w, b.h) })
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }
      window.__bs.stop = () => { window.__bs.run = false; return window.__bs.frames }
    })()`)
    // Band A covers line one, band B line two (client px, generous margins).
    const bandA = { x: Math.floor(x0 - 20), y: Math.floor(y1 - 50), w: 260, h: 80 }
    const bandB = { x: Math.floor(x0 - 20), y: Math.floor(y2 - 50), w: 260, h: 80 }
    const parts = letters(x0, y2, -7)
    for (let i = 0; i < parts.length; i += 1) {
      if (i === parts.length - 1) await evaluate(`(window.__bs.start(${JSON.stringify(bandA)}, ${JSON.stringify(bandB)}), true)`)
      await stroke(parts[i], { perFrame: 2 })
    }
    const rawTwo = await read()
    await sleep(1400)
    const frames = await evaluate('window.__bs.stop()')
    const afterTwo = await read()
    assert.equal(afterTwo.strokes.length, 14)
    const mm = afterTwo.page.width / 210
    const W = afterTwo.page.width
    // 1. The earlier line is untouched; the new line moved, within bounds.
    assert.ok(sameStrokes(afterOne.strokes, rawTwo.strokes.slice(0, 7)) && sameStrokes(afterOne.strokes, afterTwo.strokes.slice(0, 7)), 'line one does not move again')
    assert.ok(!sameStrokes(rawTwo.strokes.slice(7), afterTwo.strokes.slice(7)), 'the finished line was beautified')
    const step = Math.round((W * 7.5) / 210)
    let worst = 0
    afterTwo.strokes.slice(7).forEach((s, i) => s.forEach((p, k) => {
      const o = rawTwo.strokes[7 + i][k]
      worst = Math.max(worst, Math.hypot(p[0] - o[0], p[1] - o[1]))
    }))
    assert.ok(worst <= 0.25 * step + 0.6 * mm + 1e-6, `line two moved ${worst.toFixed(2)} page px (limit ${(0.25 * step + 0.6 * mm).toFixed(2)})`)
    assert.ok(worst > 0.05, 'the move is real')
    // 2. Settle: ink never disappears, the other line's pixels never change.
    assert.ok(frames.length >= 5, `sampled ${frames.length} frames`)
    const aHashes = new Set(frames.map((f) => f.a.hash))
    assert.equal(aHashes.size, 1, `line one pixels changed during the settle (${aHashes.size} variants)`)
    const bMax = Math.max(...frames.map((f) => f.b.n))
    const settled = frames.filter((f) => f.t >= frames[0].t)
    // Line two is being written until the first sampled frame; every frame after it holds its ink.
    const bMin = Math.min(...settled.slice(2).map((f) => f.b.n))
    assert.ok(bMin >= bMax * 0.8, `line two flickered: ink pixels fell from ${bMax} to ${bMin}`)
    // 3. One undo restores the original strokes of line two, in the live board.
    await ctrl('z')
    await sleep(500)
    const undone = await read()
    assert.ok(sameStrokes(undone.strokes, rawTwo.strokes), 'a single undo restores the original strokes')
    await ctrl('z')
    await sleep(400)
    assert.equal((await read()).strokes.length, 13, 'the next undo removes only the last stroke')
    await evaluate('(window.__beautifyTest = false, true)')
  }

  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.has(name)) continue
    const started = Date.now()
    try {
      await run()
    } catch (error) {
      if (!error?.stop) failures.push({ scenario: name, error: String(error?.stack ?? error) })
    }
    if (verbose) console.log(`${name}: ${Date.now() - started} ms`)
  }
  if (pageErrors.length) failures.push({ scenario: 'page errors', errors: pageErrors.slice(0, 5) })
} finally {
  ws?.close()
  const exited = new Promise((resolve) => chrome.once('exit', resolve))
  chrome.kill('SIGTERM')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
  await new Promise((resolve) => server.httpServer.close(resolve))
  for (const dir of [profile, fixtures, ...(process.env.INK_STABLE_DIST ? [] : [dist])]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* temp dir */ }
  }
}

for (const row of summary) console.log(`${row.badFrames ? 'FAIL' : 'ok  '} ${row.scenario}: ${row.frames} frames, ${row.strokes} strokes, ${row.points} points, ${row.badFrames} bad frames`)
if (failures.length) {
  for (const failure of failures) console.error(JSON.stringify({ ...failure, first: failure.first?.slice(0, 1) }).slice(0, 1600))
  assert.fail(`ink-stable: ${failures.length} scenario(s) flickered or moved ink`)
}
console.log('ink-stable ok')
