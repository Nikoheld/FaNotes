// Canvas renderer for FaNotes ink pages (paper and strokes), ported from the website viewer
// (fanotes-site/public/viewer/ink-render.js) which follows the .famd spec and fanotes/src/lib/inkStrokePaint.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InkDoc, PaperStyle } from './famd'

const SMOOTHING = 0.68
const MAX_PIXELS = 24 * 1024 * 1024
const MAX_SIDE = 16000
const HEX = /^#[\da-f]{6}$/iu
const EFFECTS: Record<string, [number, string][]> = {
  rainbow: [[0, '#ff4d6d'], [0.17, '#ffb13b'], [0.34, '#e9e34a'], [0.51, '#48ce87'], [0.68, '#3aa8ff'], [0.84, '#815cff'], [1, '#e84dba']],
  aurora: [[0, '#68f6ca'], [0.34, '#32b9ef'], [0.68, '#7968f4'], [1, '#e85bd2']],
  sunset: [[0, '#ffcf59'], [0.36, '#ff754e'], [0.68, '#d84dba'], [1, '#694ee8']],
  ocean: [[0, '#62ead5'], [0.36, '#1eb6db'], [0.7, '#2671df'], [1, '#4036a9']],
  gold: [[0, '#7c5013'], [0.24, '#f7d779'], [0.5, '#b27620'], [0.76, '#fff0a8'], [1, '#8b5914']],
  silver: [[0, '#59616d'], [0.24, '#f5f7fb'], [0.5, '#8b929d'], [0.76, '#ffffff'], [1, '#626975']],
  neon: [[0, '#45ffe6'], [0.34, '#5e8bff'], [0.68, '#db55ff'], [1, '#ff4ba8']],
}
interface Pass { w: number; a: number; j?: number; cap?: CanvasLineCap }
const BRUSH_PASSES: Record<string, Pass[]> = {
  fineliner: [{ w: 1, a: 1 }],
  pencil: [{ w: 0.72, a: 0.58 }, { w: 0.22, a: 0.2, j: 1.4 }, { w: 0.18, a: 0.14, j: 1.8 }],
  paintbrush: [{ w: 1.4, a: 0.16 }, { w: 0.92, a: 0.82 }],
  highlighter: [{ w: 1, a: 0.34 }],
  watercolor: [{ w: 1.48, a: 0.11 }, { w: 1.14, a: 0.17 }, { w: 0.78, a: 0.27 }],
  marker: [{ w: 1, a: 0.9 }],
  calligraphy: [{ w: 1, a: 1 }],
  spray: [{ w: 1, a: 1 }],
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const num = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : fallback }
const unit = (s: number) => { const v = Math.sin(s * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v) }

type Ctx = CanvasRenderingContext2D
interface P { px: number; py: number; pressure: number }
interface Stroke {
  points: { x: number; y: number; pressure: number }[]; baseWidth: number; pressureEnabled: boolean; color: string; colorEffect: string; brush: string; art: boolean
  opacity: number; seed: number; stamp: boolean; paths: string[]; rotation: number; figureLineWidth: number
}

const drawPaper = (ctx: Ctx, width: number, height: number, style: PaperStyle) => {
  ctx.save()
  ctx.fillStyle = '#fbfcff'
  ctx.fillRect(0, 0, width, height)
  if (style !== 'blank') {
    const scale = width / 900
    const step = (mm: number) => Math.max(2, Math.round(width * mm / 210))
    ctx.lineWidth = Math.max(1, scale * 0.7)
    const lines = (s: number, from: number, color: string) => {
      ctx.strokeStyle = color
      ctx.beginPath()
      for (let x = from; x <= width; x += s) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height) }
      for (let y = from; y <= height; y += s) { ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5) }
      ctx.stroke()
    }
    if (style === 'dots') {
      const ds = step(7.5)
      ctx.fillStyle = 'rgba(92, 107, 142, .28)'
      for (let y = ds; y < height; y += ds) {
        for (let x = ds; x < width; x += ds) {
          ctx.beginPath()
          ctx.arc(x, y, Math.max(0.8, scale * 1.05), 0, Math.PI * 2)
          ctx.fill()
        }
      }
    } else if (style === 'squares') lines(step(5), 0, 'rgba(92, 118, 168, .22)')
    else if (style === 'grid') lines(step(7.5), step(7.5), 'rgba(103, 116, 147, .145)')
    else if (style === 'lines') {
      const ls = step(7.5)
      ctx.strokeStyle = 'rgba(103, 116, 147, .145)'
      ctx.beginPath()
      for (let ly = ls; ly < height; ly += ls) { ctx.moveTo(0, ly + 0.5); ctx.lineTo(width, ly + 0.5) }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(210, 82, 105, .16)'
      ctx.beginPath()
      ctx.moveTo(ls * 1.65 + 0.5, 0)
      ctx.lineTo(ls * 1.65 + 0.5, height)
      ctx.stroke()
    } else if (style === 'millimeter') {
      lines(step(1), step(1), 'rgba(92, 118, 168, .1)')
      lines(step(5), step(5), 'rgba(72, 98, 148, .22)')
    }
  }
  ctx.restore()
}

const normalizeStroke = (raw: any): Stroke | null => {
  if (!raw || !Array.isArray(raw.points) || !raw.points.length) return null
  const art = raw.purpose === 'art'
  const points = raw.points.map((p: any) => {
    const pr = p && p.pressure
    return { x: clamp(Number(p && p.x) || 0, -4, 4), y: clamp(Number(p && p.y) || 0, -4, 4), pressure: pr === undefined || pr === null ? 0.5 : clamp(Number(pr) || 0.5, 0, 1) }
  })
  const brush = art && typeof raw.brush === 'string' && BRUSH_PASSES[raw.brush] ? raw.brush : 'fineliner'
  const paths: string[] = []
  for (const key of ['symbolPaths', 'figurePaths', 'graphPaths']) {
    if (Array.isArray(raw[key])) for (const d of raw[key]) if (typeof d === 'string' && d.length <= 8000 && /^[MLHVCSQTAZmlhvcsqtaz\d\s.,eE+-]+$/u.test(d)) paths.push(d)
  }
  return {
    points,
    baseWidth: clamp(num(raw.baseWidth, 4), 0.5, 64),
    pressureEnabled: raw.pressureEnabled !== false,
    color: typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color : '#1b1b1b',
    colorEffect: typeof raw.colorEffect === 'string' && EFFECTS[raw.colorEffect] ? raw.colorEffect : 'solid',
    brush,
    art,
    opacity: art ? clamp(num(raw.opacity, 1), 0.08, 1) : 1,
    seed: Math.round(clamp(Math.abs(Number(raw.textureSeed) || 1), 1, 2147483647)),
    stamp: paths.length > 0 && (typeof raw.symbolId === 'string' || typeof raw.figureId === 'string' || typeof raw.graphExpression === 'string' || Array.isArray(raw.graphPaths) || Array.isArray(raw.figurePaths)),
    paths,
    rotation: clamp(Number(raw.symbolRotation) || 0, -180, 180),
    figureLineWidth: Number(raw.figureLineWidth) > 0 ? Number(raw.figureLineWidth) : 0,
  }
}

const nibOf = (s: Stroke, a: P, b: P, scale: number) => {
  const p = (a.pressure + b.pressure) / 2
  const w = s.pressureEnabled ? s.baseWidth * (0.4 + Math.max(0.08, p) * 1.12) : s.baseWidth
  return Math.max(1, w * scale)
}

const segmentPath = (P_: P[], i: number, s: Stroke, scale: number, smoothing: number) => {
  const n = P_.length
  const nib = (j: number, k: number) => nibOf(s, P_[j], P_[k], scale)
  const pull = (j: number) => {
    const wanted = clamp(smoothing, 0, 1) * 0.85
    const leg = Math.hypot(P_[j + 1].px - P_[j].px, P_[j + 1].py - P_[j].py)
    const nibJ = Math.min(nib(Math.max(0, j - 1), j), nib(j, j + 1))
    if (leg <= 0.01 || nibJ <= 0) return wanted
    return Math.min(wanted, nibJ * 0.35 / leg)
  }
  const segEnd = (j: number) => {
    if (smoothing <= 0 || j >= n - 1) return { x: P_[j].px, y: P_[j].py }
    const k = pull(j) * 0.5
    return { x: P_[j].px + (P_[j + 1].px - P_[j].px) * k, y: P_[j].py + (P_[j + 1].py - P_[j].py) * k }
  }
  const start = i <= 1 ? { x: P_[0].px, y: P_[0].py } : segEnd(i - 1)
  const end = smoothing > 0 && i < n - 1 ? segEnd(i) : { x: P_[i].px, y: P_[i].py }
  return { start, end, curved: smoothing > 0 && i < n - 1 && Math.hypot(end.x - P_[i].px, end.y - P_[i].py) > 0.15 }
}

const strokePass = (ctx: Ctx, s: Stroke, P_: P[], scale: number, pass: Pass, paint: string | CanvasGradient, op: number) => {
  ctx.strokeStyle = paint
  ctx.fillStyle = paint
  ctx.lineCap = pass.cap || 'round'
  ctx.lineJoin = 'round'
  const n = P_.length
  const jitter = (idx: number, axis: number) => (pass.j ? (unit(s.seed + idx * 53 + (op || 0) * 2 + axis) - 0.5) * scale * pass.j : 0)
  if (n === 1) {
    const d = nibOf(s, P_[0], P_[0], scale) * pass.w
    ctx.beginPath()
    ctx.arc(P_[0].px, P_[0].py, d / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  for (let i = 1; i < n; i += 1) {
    if (Math.hypot(P_[i].px - P_[i - 1].px, P_[i].py - P_[i - 1].py) < 0.2) continue
    const seg = segmentPath(P_, i, s, scale, SMOOTHING)
    const jx = jitter(i, 0)
    const jy = jitter(i, 1)
    ctx.beginPath()
    ctx.moveTo(seg.start.x + jx, seg.start.y + jy)
    if (seg.curved) ctx.quadraticCurveTo(P_[i].px + jx, P_[i].py + jy, seg.end.x + jx, seg.end.y + jy)
    else ctx.lineTo(P_[i].px + jx, P_[i].py + jy)
    ctx.lineWidth = nibOf(s, P_[i - 1], P_[i], scale) * pass.w
    ctx.stroke()
  }
}

const calligraphy = (ctx: Ctx, s: Stroke, P_: P[], scale: number, paint: string | CanvasGradient) => {
  ctx.fillStyle = paint
  const ang = -0.22 * Math.PI
  const ux = Math.cos(ang)
  const uy = Math.sin(ang)
  if (P_.length === 1) {
    const nib = nibOf(s, P_[0], P_[0], scale)
    ctx.beginPath()
    ctx.ellipse(P_[0].px, P_[0].py, nib / 2, Math.max(0.5, nib * 0.16), ang, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  for (let i = 1; i < P_.length; i += 1) {
    const w = nibOf(s, P_[i - 1], P_[i], scale) / 2
    const hx = ux * w
    const hy = uy * w
    ctx.beginPath()
    ctx.moveTo(P_[i - 1].px + hx, P_[i - 1].py + hy)
    ctx.lineTo(P_[i].px + hx, P_[i].py + hy)
    ctx.lineTo(P_[i].px - hx, P_[i].py - hy)
    ctx.lineTo(P_[i - 1].px - hx, P_[i - 1].py - hy)
    ctx.closePath()
    ctx.fill()
  }
}

const spray = (ctx: Ctx, s: Stroke, P_: P[], scale: number, paint: string | CanvasGradient) => {
  ctx.fillStyle = paint
  const count = Math.round(clamp(s.baseWidth * 0.68, 6, 24))
  const segs: [P, P][] = P_.length === 1 ? [[P_[0], P_[0]]] : P_.slice(1).map((p, i) => [P_[i], p])
  segs.forEach((pair, idx) => {
    const radius = nibOf(s, pair[0], pair[1], scale) / 2
    for (let k = 0; k < count; k += 1) {
      const key = s.seed + idx * 1009 + k * 37
      const prog = unit(key + 1)
      const angle = unit(key + 2) * Math.PI * 2
      const spread = Math.sqrt(unit(key + 3)) * radius
      const cx = pair[0].px + (pair[1].px - pair[0].px) * prog + Math.cos(angle) * spread
      const cy = pair[0].py + (pair[1].py - pair[0].py) * prog + Math.sin(angle) * spread
      ctx.globalAlpha = s.opacity * (0.2 + unit(key + 5) * 0.5)
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(0.35, scale * (0.28 + unit(key + 4) * 0.62)), 0, Math.PI * 2)
      ctx.fill()
    }
  })
  ctx.globalAlpha = 1
}

const makePaint = (ctx: Ctx, s: Stroke, W: number, H: number): string | CanvasGradient => {
  const stops = EFFECTS[s.colorEffect]
  if (!stops) return s.color
  const g = ctx.createLinearGradient(0, 0.08 * H, W, 0.28 * H)
  for (const [at, color] of stops) g.addColorStop(at, color)
  return g
}

const drawStamp = (ctx: Ctx, s: Stroke, P_: P[], scale: number) => {
  const k = s.baseWidth * scale / 24
  ctx.save()
  ctx.globalAlpha = s.opacity
  ctx.translate(P_[0].px, P_[0].py)
  ctx.rotate(s.rotation * Math.PI / 180)
  ctx.scale(k, k)
  ctx.translate(-12, -12)
  ctx.strokeStyle = s.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = s.figureLineWidth ? s.figureLineWidth * 24 / s.baseWidth : 1.75
  for (const d of s.paths) { try { ctx.stroke(new Path2D(d)) } catch { /* skip bad path data */ } }
  ctx.restore()
}

type Scratch = (w: number, h: number) => HTMLCanvasElement

const drawStroke = (ctx: Ctx, s: Stroke, W: number, H: number, scale: number, scratchFactory: Scratch) => {
  const P_: P[] = s.points.map((p) => ({ px: p.x * W, py: p.y * H, pressure: p.pressure }))
  if (s.stamp) { drawStamp(ctx, s, P_, scale); return }
  const passes = BRUSH_PASSES[s.brush]
  const translucent = s.art && s.brush !== 'spray' && (s.opacity < 0.999 || passes.some((p) => p.a * s.opacity < 0.999))
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (s.colorEffect === 'neon') { ctx.shadowColor = s.color; ctx.shadowBlur = Math.max(4, s.baseWidth * scale * 0.85) }
  if (s.brush === 'spray') spray(ctx, s, P_, scale, makePaint(ctx, s, W, H))
  else if (s.brush === 'calligraphy') calligraphy(ctx, s, P_, scale, makePaint(ctx, s, W, H))
  else if (!translucent) passes.forEach((pass, i) => strokePass(ctx, s, P_, scale, pass, makePaint(ctx, s, W, H), i))
  else {
    const maxNib = s.baseWidth * 1.6 * 1.6 * scale + 4
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    for (const p of P_) { minX = Math.min(minX, p.px); minY = Math.min(minY, p.py); maxX = Math.max(maxX, p.px); maxY = Math.max(maxY, p.py) }
    const ox = Math.max(0, Math.floor(minX - maxNib))
    const oy = Math.max(0, Math.floor(minY - maxNib))
    const sw = Math.min(Math.ceil(W), Math.ceil(maxX + maxNib)) - ox
    const sh = Math.min(Math.ceil(H), Math.ceil(maxY + maxNib)) - oy
    if (sw > 0 && sh > 0) {
      passes.forEach((pass, i) => {
        const scratch = scratchFactory(sw, sh)
        const sctx = scratch.getContext('2d') as Ctx
        sctx.clearRect(0, 0, sw, sh)
        sctx.translate(-ox, -oy)
        const opaque: Pass = { w: pass.w, a: 1, j: pass.j, cap: s.brush === 'highlighter' && !s.pressureEnabled ? 'butt' : 'round' }
        strokePass(sctx, s, P_.map((p) => ({ ...p })), scale, opaque, makePaint(sctx, s, W, H), i)
        ctx.globalAlpha = s.opacity * pass.a
        if (s.brush === 'highlighter') ctx.globalCompositeOperation = 'multiply'
        ctx.drawImage(scratch, 0, 0, sw, sh, ox, oy, sw, sh)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      })
    }
  }
  ctx.restore()
}

const knownPaper = (value: unknown): PaperStyle | null => (['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter'].includes(value as string) ? (value as PaperStyle) : null)

/** Paints paper and strokes of one drawing document into `canvas`; `cssWidth` is the displayed width in CSS px. */
export const renderPage = (canvas: HTMLCanvasElement, doc: InkDoc, options: { cssWidth?: number; paper?: PaperStyle | null; dpr?: number } = {}) => {
  const W0 = Number(doc.sourceWidth) > 0 ? Number(doc.sourceWidth) : 900
  const H0 = Number(doc.sourceHeight) > 0 ? Number(doc.sourceHeight) : 1273
  const cssWidth = options.cssWidth || W0
  const dpr = options.dpr || 1
  let wb = Math.max(1, Math.round(cssWidth * dpr))
  let hb = Math.max(1, Math.round(wb * H0 / W0))
  const shrink = Math.min(1, MAX_SIDE / Math.max(wb, hb), Math.sqrt(MAX_PIXELS / (wb * hb)))
  wb = Math.max(1, Math.round(wb * shrink))
  hb = Math.max(1, Math.round(hb * shrink))
  canvas.width = wb
  canvas.height = hb
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssWidth * H0 / W0}px`
  const ctx = canvas.getContext('2d') as Ctx
  // The payload's paperStyle (options.paper) wins over the drawing's own, as in the app.
  drawPaper(ctx, wb, hb, knownPaper(options.paper) || knownPaper(doc.paperStyle) || 'blank')
  const scale = wb / W0
  let scratch: HTMLCanvasElement | null = null
  const factory: Scratch = (w, h) => { scratch ||= document.createElement('canvas'); scratch.width = w; scratch.height = h; return scratch }
  let count = 0
  for (const raw of Array.isArray(doc.strokes) ? doc.strokes : []) {
    const stroke = normalizeStroke(raw)
    if (!stroke) continue
    count += 1
    try { drawStroke(ctx, stroke, wb, hb, scale, factory) } catch { /* one bad stroke must not stop the page */ }
  }
  return { strokes: count, width: W0, height: H0 }
}
