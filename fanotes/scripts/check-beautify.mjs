// Handwriting beautifier: bounded, shape-preserving, text-only, undoable.
// Synthetic handwriting only. BEAUTIFY_SHOTS=<dir> writes before.png / after.png.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const lib = await server.ssrLoadModule('/src/lib/inkBeautify.ts')
const { createInkReadbackContext, drawInkStroke } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { beautifyInk, smoothStrokePoints, beautifyPaperStep, blendStrokePoints } = lib

const W = 900
const H = 1200
const MM = W / 210
const STEP = beautifyPaperStep('lines', 0, W)
assert.equal(STEP, 32)

let seed = 7
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5 }

/** Polyline in px -> stroke with ~0.4 mm sampling and 0.12 mm pen jitter. */
const stroke = (poly, { jitter = 0.12, extra = {} } = {}) => {
  const pts = []
  for (let i = 0; i < poly.length - 1; i += 1) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[i + 1]
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / (0.4 * MM)))
    for (let k = 0; k < n; k += 1) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
  }
  pts.push(poly.at(-1))
  return {
    points: pts.map(([x, y], i) => ({
      x: (x + rnd() * jitter * MM * 2) / W, y: (y + rnd() * jitter * MM * 2) / H, t: i * 8,
      pressure: 0.5 + rnd() * 0.12, tiltX: 0, tiltY: 0, pointerType: 'pen',
    })),
    baseWidth: 3.5, pressureEnabled: true, color: '#202333', purpose: 'handwriting', brush: 'fineliner', colorEffect: 'solid', opacity: 1, ...extra,
  }
}
const arc = (cx, cy, rx, ry, a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, i) => {
  const a = a0 + ((a1 - a0) * i) / n
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
})
const letterO = (x, base, h) => stroke(arc(x, base - h / 2, h * 0.38, h / 2, 0, Math.PI * 2))
const letterV = (x, base, h) => stroke([[x, base - h], [x + h * 0.3, base], [x + h * 0.6, base - h]])
const letterL = (x, base, h) => stroke([[x, base - h * 1.5], [x, base]])
const dot = (x, y) => stroke([[x, y], [x + 0.2, y + 0.1], [x + 0.1, y + 0.2]], { jitter: 0 })

/** A word of 6 letters on a baseline that drifts `slopePx` over its length. */
const word = (x0, base, { slopePx = 0, h = 15, scatter = 0, kinds = [letterO, letterV, letterL] } = {}) => {
  const out = []
  for (let i = 0; i < 6; i += 1) {
    const x = x0 + i * 22
    const b = base + (slopePx * (i * 22)) / 132
    const hh = h * (1 + scatter * (i % 2 ? 0.25 : -0.2))
    out.push(kinds[i % kinds.length](x, b, hh))
  }
  return out
}

const maxMove = (a, b, W2 = W, H2 = H) => Math.max(...a.points.map((p, i) => Math.hypot((b[i].x - p.x) * W2, (b[i].y - p.y) * H2)))
const rough = (pts) => { let s = 0; for (let i = 1; i < pts.length - 1; i += 1) s += Math.hypot((pts[i - 1].x + pts[i + 1].x) / 2 * W - pts[i].x * W, (pts[i - 1].y + pts[i + 1].y) / 2 * H - pts[i].y * H); return s / pts.length }
const opts = (strength = 'medium', paperStep = STEP) => ({ pageWidth: W, pageHeight: H, strength, paperStep })
const clone = (v) => JSON.parse(JSON.stringify(v))
const bottomsOf = (strokes, result) => strokes.map((s, i) => Math.max(...(result?.points[i] ?? s.points).map((p) => p.y * H)))
const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1]

try {
  // 1. Smoothing: bounded (0.6 mm medium, 0.3 mm subtle), calmer, pressure bounded.
  for (const [strength, bound] of [['medium', 0.6], ['subtle', 0.3]]) {
    const s = letterO(100, 200, 40)
    const out = smoothStrokePoints(s.points, W, H, strength)
    assert.equal(out.length, s.points.length)
    assert.ok(maxMove(s, out) <= bound * MM + 1e-6, `${strength}: ink moved ${(maxMove(s, out) / MM).toFixed(3)} mm`)
    assert.ok(rough(out) < rough(s.points) * (strength === 'medium' ? 0.8 : 0.9), `${strength}: jitter must drop`)
    const dp = Math.max(...out.map((p, i) => Math.abs(p.pressure - s.points[i].pressure)))
    assert.ok(dp <= 0.081, 'pressure change stays small')
    assert.ok(out.every((p) => p.pressure >= 0 && p.pressure <= 1))
    assert.equal(out[0].x, s.points[0].x)
    assert.equal(out.at(-1).y, s.points.at(-1).y, 'end points stay')
  }
  // Same strength, a far smaller and a long stroke alike: never above the bound.
  for (let k = 0; k < 20; k += 1) {
    const s = stroke(arc(300, 300, 20 + k * 5, 15 + k * 3, 0, 5), { jitter: 0.4 })
    assert.ok(maxMove(s, smoothStrokePoints(s.points, W, H, 'medium')) <= 0.6 * MM + 1e-6)
  }

  // 2. Corners, dots and endpoints are kept; 'v' is not rounded.
  const v = letterV(100, 200, 20)
  const vOut = smoothStrokePoints(v.points, W, H, 'medium')
  const tip = (pts) => pts.reduce((m, p) => (p.y > m.y ? p : m))
  const tipIn = tip(v.points)
  const tipOut = tip(vOut)
  assert.ok(Math.hypot((tipOut.x - tipIn.x) * W, (tipOut.y - tipIn.y) * H) < 0.05 * MM, 'the tip of a v stays where it was')
  assert.ok(Math.abs(tipOut.y * H - 200) < 0.3 * MM + 0.2 * MM, 'the v keeps its depth')
  const d = dot(120, 120)
  assert.deepEqual(smoothStrokePoints(d.points, W, H, 'medium'), d.points, 'dots stay')
  const w = stroke([[100, 100], [110, 130], [120, 100], [130, 130], [140, 100]], { jitter: 0 })
  const wOut = smoothStrokePoints(w.points, W, H, 'medium')
  for (const [cx, cy] of [[110, 130], [120, 100], [130, 130]]) {
    const near = (pts) => pts.reduce((m, p) => (Math.hypot(p.x * W - cx, p.y * H - cy) < Math.hypot(m.x * W - cx, m.y * H - cy) ? p : m))
    const p = near(wOut)
    assert.ok(Math.hypot(p.x * W - cx, p.y * H - cy) < 0.4, 'w vertices stay sharp')
  }
  const digit = stroke([[100, 100], [120, 100], [100, 130], [125, 130]], { jitter: 0 }) // z/2-like zigzag
  const dOut = smoothStrokePoints(digit.points, W, H, 'medium')
  assert.ok(maxMove(digit, dOut) < 0.1 * MM, 'a polyline made only of corners is not rounded')

  // 3. Baseline: slanted word within tolerance lands on the paper line; far-off stays.
  const near = word(100, STEP * 10 + 5, { slopePx: 5, scatter: 0.1 })
  const nearOut = beautifyInk(near, opts())
  const nearBase = med(bottomsOf(near, nearOut))
  assert.ok(Math.abs(nearBase - STEP * 10) < 1.2, `baseline snapped to the paper line (got ${nearBase - STEP * 10})`)
  const slope = (res, src) => {
    const bs = bottomsOf(src, res)
    return (bs[4] - bs[1]) / (4 * 22 - 1 * 22)
  }
  const slopeIn = (bottomsOf(near, null)[4] - bottomsOf(near, null)[1]) / 66
  assert.ok(Math.abs(slope(nearOut, near)) < Math.abs(slopeIn) * 0.8, 'slant is reduced')
  nearOut.points.forEach((pts, i) => { if (pts) assert.ok(maxMove(near[i], pts) <= 0.25 * STEP + 0.6 * MM + 1e-6, 'line move bounded') })
  const far = word(100, STEP * 10 + 16, { slopePx: 0 }) // half a line away: ambiguous
  const farOut = beautifyInk(far, opts())
  assert.ok(Math.abs(med(bottomsOf(far, farOut)) - med(bottomsOf(far, null))) < 0.7 * MM, 'baseline outside the tolerance is left alone')
  const blankOut = beautifyInk(word(100, STEP * 10 + 5), opts('medium', null))
  assert.ok(Math.abs(med(bottomsOf(word(100, 0), null))) >= 0, 'sanity')
  assert.ok(Math.abs(med(bottomsOf(near, blankOut)) - med(bottomsOf(near, null))) < 1.2 * MM, 'no paper rows: no snapping')

  // Heights move towards the median, by a few percent only.
  const uneven = word(100, STEP * 10, { scatter: 1, kinds: [letterO, letterV] })
  const unevenOut = beautifyInk(uneven, opts())
  const heightOf = (s, r, i) => { const pts = r?.points[i] ?? s.points; return Math.max(...pts.map((p) => p.y * H)) - Math.min(...pts.map((p) => p.y * H)) }
  const spreadBefore = Math.max(...uneven.map((s, i) => heightOf(s, null, i))) - Math.min(...uneven.map((s, i) => heightOf(s, null, i)))
  const spreadAfter = Math.max(...uneven.map((s, i) => heightOf(s, unevenOut, i))) - Math.min(...uneven.map((s, i) => heightOf(s, unevenOut, i)))
  assert.ok(spreadAfter < spreadBefore, 'letter heights come closer')
  uneven.forEach((s, i) => assert.ok(Math.abs(heightOf(s, unevenOut, i) / heightOf(s, null, i) - 1) < 0.06, 'scale stays within a few percent'))

  // 4. Drawings, highlighter, stamps, math guard: untouched.
  const circle = stroke(arc(400, 600, 120, 110, 0, Math.PI * 2, 80))
  assert.equal(beautifyInk([circle], opts()).changed, 0, 'a big shape is a drawing')
  const art = word(100, 400).map((s) => ({ ...s, purpose: 'art', brush: 'pencil' }))
  assert.equal(beautifyInk(art, opts()).changed, 0, 'art ink is untouched')
  const hl = word(100, 400).map((s) => ({ ...s, brush: 'highlighter', opacity: 0.4 }))
  assert.equal(beautifyInk(hl, opts()).changed, 0, 'highlighter is untouched')
  const stamp = word(100, 400).map((s) => ({ ...s, figureId: 'triangle' }))
  assert.equal(beautifyInk(stamp, opts()).changed, 0, 'math stamps are untouched')
  const frame = stroke([[50, 300], [700, 300], [700, 380], [50, 380], [50, 300]])
  assert.equal(beautifyInk([frame, ...word(100, 340)], opts()).points[0], null, 'a frame around text stays')
  const mixed = [...word(100, STEP * 10 + 4, { slopePx: 4 }), circle]
  assert.equal(beautifyInk(mixed, opts()).points.at(-1), null, 'a drawing next to text stays')
  // A tall row of overlapping squiggles is no text row.
  const doodle = Array.from({ length: 8 }, (_, i) => stroke(arc(300 + i * 5, 800, 30, 90, 0, 6)))
  assert.equal(beautifyInk(doodle, opts()).changed, 0, 'an oversized row is ambiguous')

  // 5. Pure + undo: inputs are never mutated; the snapshot swap restores the originals.
  const originals = word(100, STEP * 12 + 6, { slopePx: 4, scatter: 0.6 })
  const frozen = clone(originals)
  const res = beautifyInk(originals, opts())
  assert.ok(res.changed > 0)
  assert.deepEqual(clone(originals), frozen, 'beautify must not mutate the originals')
  const undoStack = []
  let page = originals.slice()
  const before = page.slice()
  undoStack.push(before)
  page = before.map((s, i) => (res.points[i] ? { ...s, points: res.points[i] } : s))
  assert.notDeepEqual(clone(page), frozen)
  page = undoStack.pop().slice()
  assert.deepEqual(clone(page), frozen, 'undo restores the original strokes exactly')
  // Blend endpoints (settle animation) hit both ends exactly.
  const i0 = blendStrokePoints(originals[0].points, res.points[0] ?? originals[0].points, 0)
  assert.deepEqual(i0.map((p) => [p.x, p.y]), originals[0].points.map((p) => [p.x, p.y]))
  // Idempotent enough: a second pass over beautified ink stays within the bounds of the first.
  const again = beautifyInk(originals.map((s, i) => (res.points[i] ? { ...s, points: res.points[i] } : s)), opts())
  again.points.forEach((pts, i) => { if (pts) assert.ok(maxMove({ points: res.points[i] ?? originals[i].points }, pts) <= 0.25 * STEP + 0.6 * MM) })

  // 6. Cost: a 200-stroke page runs far below a frame budget per line.
  const page200 = Array.from({ length: 7 }, (_, r) => word(100, STEP * (3 + r) + 4, { slopePx: 3 })).flat()
  const t0 = performance.now()
  for (let k = 0; k < 20; k += 1) beautifyInk(page200, opts())
  const perRun = (performance.now() - t0) / 20
  console.log(`beautify ${page200.length} strokes: ${perRun.toFixed(2)} ms`)
  assert.ok(perRun < 40, 'beautifying a screenful of words stays cheap')

  // 7. Wiring: runs after pen-up, one undo step, never from the pointer-move hot path.
  const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
  const flush = board.slice(board.indexOf('const flushBeautify'), board.indexOf('const queueBeautify'))
  assert.ok(/undoRef\.current\.push\(before\)/.test(flush) && /redoRef\.current = \[\]/.test(flush), 'one undo step')
  assert.ok(/BEAUTIFY|600\)/.test(board) && board.includes('queueBeautify(activeStroke)'), 'queued at pen-up')
  const move = board.slice(board.indexOf('const appendPointerEvent'), board.indexOf('const commitPendingSolverTap'))
  assert.ok(!/Beautify/.test(move), 'no beautify work while the pen is down')

  if (process.env.BEAUTIFY_SHOTS) {
    mkdirSync(process.env.BEAUTIFY_SHOTS, { recursive: true })
    seed = 11
    const sample = [
      ...word(80, STEP * 4 + 5, { slopePx: 7, scatter: 0.7 }), ...word(240, STEP * 4 + 5, { slopePx: 7, scatter: 0.7 }),
      ...word(80, STEP * 6 + 3, { slopePx: -5, scatter: 0.8 }), ...word(240, STEP * 6 + 3, { slopePx: -5, scatter: 0.8 }),
    ]
    const result = beautifyInk(sample, opts('subtle'))
    const after = sample.map((s, i) => (result.points[i] ? { ...s, points: result.points[i] } : s))
    const { deflateSync } = await import('node:zlib')
    const render = (strokes, name) => {
      const surface = createInkReadbackContext(380, 110)
      // Paper rows under the ink, then the strokes at 1:1 on a 2x canvas crop.
      const image = surface.getImageData
      void image
      const ctx = surface.context
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      for (const s of strokes) drawInkStroke(ctx, s, W, H, 0.68, 1, W, W, s.points.length)
      return surface.getImageData()
    }
    const png = (img, rows, file) => {
      const crc = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
      const c32 = (b) => { let c = 0xffffffff; for (const x of b) c = crc[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
      const raw = Buffer.alloc((1 + img.width * 3) * img.height)
      for (let y = 0; y < img.height; y += 1) {
        const o = y * (1 + img.width * 3)
        const onRow = rows.some((r) => Math.abs(y - r) < 0.5)
        for (let x = 0; x < img.width; x += 1) {
          const i = (y * img.width + x) * 4
          const a = img.data[i + 3] / 255
          const bg = onRow ? 205 : 251
          for (let c = 0; c < 3; c += 1) raw[o + 1 + x * 3 + c] = Math.round(bg * (1 - a) + img.data[i + c] * a)
        }
      }
      const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const cc = Buffer.alloc(4); cc.writeUInt32BE(c32(b)); return Buffer.concat([l, b, cc]) }
      const ih = Buffer.alloc(13); ih.writeUInt32BE(img.width, 0); ih.writeUInt32BE(img.height, 4); ih[8] = 8; ih[9] = 2
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
    }
    const { writeFileSync } = await import('node:fs')
    const rows = [STEP * 4 - 100, STEP * 5 - 100, STEP * 6 - 100, STEP * 7 - 100].map((r) => r)
    void rows
    for (const [name, strokes] of [['before', sample], ['after', after]]) {
      const shifted = strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, y: p.y - 100 / H, x: p.x })) }))
      writeFileSync(`${process.env.BEAUTIFY_SHOTS}/${name}.png`, png(render(shifted), [STEP * 4 - 100, STEP * 5 - 100, STEP * 6 - 100, STEP * 7 - 100], name))
    }
  }
  console.log('beautify checks passed')
} finally {
  await server.close()
}
