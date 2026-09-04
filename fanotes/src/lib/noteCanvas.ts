/**
 * OneNote-like note canvas: one writable page that grows with ink/text,
 * plus a finite extra-paper scroll room that moves with that page.
 *
 * This is the live write/camera math. PaperView and DrawingBoard call these
 * functions. The extra room is the same paper, not a second dark stage, and
 * there is no nested A4 write-card.
 */

export const PAGE_START_WIDTH = 900
export const PAGE_START_HEIGHT = 1273

/** Extra writable paper past the last mark — OneNote blank at the end of the page. */
export const WRITE_MARGIN_X = 108
export const WRITE_MARGIN_Y = 144

/** Grow in the same chunks as the write margin so the page follows the pen. */
export const GROW_STEP_X = WRITE_MARGIN_X
export const GROW_STEP_Y = WRITE_MARGIN_Y

/**
 * Finite extra pan room past the write page. Far enough to pan, never unbounded.
 * Same paper as the page — not a dark stage / second surface.
 */
export const SCROLL_ROOM = 560

export const WRITE_CAP_WIDTH = PAGE_START_WIDTH * 20
export const WRITE_CAP_HEIGHT = PAGE_START_HEIGHT * 40

export const PAGE_BACKGROUND = '#fff'

export type CanvasBox = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type CanvasSize = {
  width: number
  height: number
}

export type CanvasPoint = {
  x: number
  y: number
}

export type CanvasViewport = {
  width: number
  height: number
}

const finitePositive = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0)

/** Painted paper box is the 0–1 space (pointer mapping). Ignore 0×0 first layout. */
export const paintedStayExtent = (source: number, painted = 0) => {
  const live = Number.isFinite(painted) && painted > 1 ? painted : 0
  const base = Number.isFinite(source) && source > 0 ? source : 0
  return Math.max(base, live)
}

/**
 * Camera room around the write page (`pageCanvasLayout` / `--paper-scroll-room`).
 * A painted box that is exactly the page plus `2*SCROLL_ROOM` is extra pan paper,
 * not a max-edge write-page grow — absorbing it remaps 0–1 and slides glyphs.
 */
export const isPaintedScrollRoomJump = (source: number, painted = 0) => {
  const src = finitePositive(source)
  const paint = Number.isFinite(painted) && painted > 1 ? painted : 0
  if (!(src > 1) || !(paint > src + 1)) return false
  return Math.abs(paint - src - 2 * SCROLL_ROOM) <= 1
}

/** 0–1 / CSS write-page extent. Camera-room overlays do not enlarge the page. */
export const writePageStayExtent = (source: number, painted = 0) => {
  if (isPaintedScrollRoomJump(source, painted)) return finitePositive(source)
  return paintedStayExtent(source, painted)
}

/**
 * Lift a 0–1 sample from a page+2·SCROLL_ROOM overlay onto the write page.
 * Extra room is origin-aligned at the max edges (same as absorbing the overlay
 * into source). Centered overlay padding would map near-left ink negative.
 */
export const overlaySampleOntoWritePage = <T extends { x: number; y: number }>(
  sample: T,
  page: CanvasSize,
  painted: { width?: number; height?: number } = {},
): T => {
  const pageW = finitePositive(page.width)
  const pageH = finitePositive(page.height)
  const paintW = Number.isFinite(painted.width) && Number(painted.width) > 1 ? Number(painted.width) : 0
  const paintH = Number.isFinite(painted.height) && Number(painted.height) > 1 ? Number(painted.height) : 0
  const liftX = isPaintedScrollRoomJump(pageW, paintW) && pageW > 0
  const liftY = isPaintedScrollRoomJump(pageH, paintH) && pageH > 0
  if (!liftX && !liftY) return sample
  return {
    ...sample,
    x: liftX ? sample.x * paintW / pageW : sample.x,
    y: liftY ? sample.y * paintH / pageH : sample.y,
  }
}

/** Grow the max edge so a 0–1 mark plus write margin still fits. Repeats at the new edge. */
export const growWriteExtent = (
  normalized: number | undefined,
  current: number,
  margin: number,
  step: number,
) => {
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return current
  if (!Number.isFinite(current) || current < 1) return current
  if (!Number.isFinite(margin) || !Number.isFinite(step) || step < 1) return current
  const needed = normalized * current + margin
  if (!(needed > current)) return current
  return Math.max(current, Math.ceil(needed / step) * step)
}

/** Extra origin pad when writing near or past the min edge (left or top). */
export const growWriteOrigin = (
  normalized: number | undefined,
  current: number,
  margin: number,
  step: number,
) => {
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return 0
  if (!Number.isFinite(current) || current < 1) return 0
  if (!Number.isFinite(margin) || !Number.isFinite(step) || step < 1) return 0
  const pixel = normalized * current
  if (pixel >= margin) return 0
  return Math.ceil((margin - pixel) / step) * step
}

export const paperMinEdgeGrows = (
  normalized: number | undefined,
  current: number,
  margin: number,
  step: number,
) => growWriteOrigin(normalized, current, margin, step) > 0

export type CanvasOrigin = {
  originX?: number
  originY?: number
}

/**
 * Grow the write page around a mark. Left/top pad and right/bottom extent both move.
 * `painted` is the CSS box DrawingBoard sees; never compare it to source px — a
 * viewport-filling sheet is already larger than source without having grown.
 * `originX`/`originY` are pads already applied — a long stroke that stays in
 * the top/left slack must not keep inserting the same margin.
 */
export const growPageFromMark = (
  extent: CanvasSize & CanvasOrigin,
  mark: { x?: number; y?: number },
  painted: { width?: number; height?: number } = {},
) => {
  const haveX = Math.max(0, Number.isFinite(extent.originX) ? Number(extent.originX) : 0)
  const haveY = Math.max(0, Number.isFinite(extent.originY) ? Number(extent.originY) : 0)
  const liveW = writePageStayExtent(extent.width, painted.width)
  const liveH = writePageStayExtent(extent.height, painted.height)
  const wantX = growWriteOrigin(mark.x, liveW, WRITE_MARGIN_X, GROW_STEP_X)
  const wantY = growWriteOrigin(mark.y, liveH, WRITE_MARGIN_Y, GROW_STEP_Y)
  const padX = Math.max(0, wantX - haveX)
  const padY = Math.max(0, wantY - haveY)
  const width = Math.max(
    growWriteExtent(mark.x, liveW, WRITE_MARGIN_X, GROW_STEP_X),
    liveW + padX,
    extent.width + padX,
  )
  const height = Math.max(
    growWriteExtent(mark.y, liveH, WRITE_MARGIN_Y, GROW_STEP_Y),
    liveH + padY,
    extent.height + padY,
  )
  return {
    width: Math.min(WRITE_CAP_WIDTH, Math.max(extent.width, width)),
    height: Math.min(WRITE_CAP_HEIGHT, Math.max(extent.height, height)),
    padX,
    padY,
  }
}

/** CSS write-page box: fill the viewport, then grow with source as you write. */
export const writePageLayoutSize = (
  source: CanvasSize,
  viewport: CanvasSize,
) => ({
  width: Math.max(Math.max(1, finitePositive(viewport.width) || 1), Math.max(1, finitePositive(source.width) || 1)),
  height: Math.max(Math.max(1, finitePositive(viewport.height) || 1), Math.max(1, finitePositive(source.height) || 1)),
})

/** Keep a 0–1 mark at the same page-pixel position after the page grows. */
export const keepMarkOnPage = (
  value: number,
  prevExtent: number,
  nextExtent: number,
  minPad = 0,
) => {
  if (!Number.isFinite(value) || !(prevExtent > 0) || !(nextExtent > 0)) return value
  const pad = Math.max(0, Number.isFinite(minPad) ? minPad : 0)
  if (Math.abs(nextExtent - prevExtent) < 1e-6 && pad === 0) return value
  return (value * prevExtent + pad) / nextExtent
}

const finiteOriginPx = (value: number) => Math.max(0, Number.isFinite(value) ? value : 0)

/** New min-edge pad this step. Bug-report `padX` is the cumulative origin. */
export const originPadDelta = (have: number, next: number) => (
  Math.max(0, finiteOriginPx(next) - finiteOriginPx(have))
)

/**
 * Markdown column offset after a min-edge grow. Must be `px`.
 * Vertical `margin-%` is of containing-block WIDTH, and `margin-top`
 * collapses out of `.unified-paper` — both slide existing text.
 */
export const textOriginCssPx = (originX: number, originY: number) => ({
  x: `${Math.round(finiteOriginPx(originX))}px`,
  y: `${Math.round(finiteOriginPx(originY))}px`,
})

/** Camera delta that keeps pre-grow paper pixels in view after a min-edge pad.
 * Origin is applied as CSS px, so the scroller must pan by that same CSS pad —
 * scaling pad by layout/source slides typed text on the ruling. */
export const paperOriginScrollDelta = (
  pad: number,
  _nextExtent?: number,
  _nextLayout?: number,
) => finiteOriginPx(pad)

/** How far the sheet’s content-space origin moved across a layout pass. */
export const paperSheetLayoutShift = (
  before: { x: number; y: number },
  after: { x: number; y: number },
) => ({
  x: (Number.isFinite(after.x) ? after.x : 0) - (Number.isFinite(before.x) ? before.x : 0),
  y: (Number.isFinite(after.y) ? after.y : 0) - (Number.isFinite(before.y) ? before.y : 0),
})

/** Camera after a write-page extent change. Max-edge grow (no new pad) must
 * not move the scroller — that slides typed text while the canvas extends.
 * If the sheet’s content-space origin also jumped, add that shift so glyphs
 * stay on the same viewport pixels. */
export const paperCameraAfterMaxEdgeGrow = (
  camera: { x: number; y: number },
  padX = 0,
  padY = 0,
  sheetShift: { x?: number; y?: number } = {},
) => ({
  x: (Number.isFinite(camera.x) ? camera.x : 0)
    + paperOriginScrollDelta(padX)
    + (Number.isFinite(sheetShift.x) ? Number(sheetShift.x) : 0),
  y: (Number.isFinite(camera.y) ? camera.y : 0)
    + paperOriginScrollDelta(padY)
    + (Number.isFinite(sheetShift.y) ? Number(sheetShift.y) : 0),
})

/**
 * Paper coords after one write op. The only legal change is a *new* origin
 * pad — pan, max-edge enlarge, overlay jump, and sheet-layout shift cannot
 * move typed text on the sheet.
 */
export const stayPutPaperAfterOp = (
  paper: { x: number; y: number },
  havePadX: number,
  havePadY: number,
  nextPadX: number,
  nextPadY: number,
) => ({
  x: paper.x + originPadDelta(havePadX, nextPadX),
  y: paper.y + originPadDelta(havePadY, nextPadY),
})

/** Live extent grow: hold the camera, add only new pad and sheet-origin jump. */
export const stayPutAfterExtentGrow = (
  camera: { x: number; y: number },
  padX = 0,
  padY = 0,
  sheetShift: { x?: number; y?: number } = {},
) => paperCameraAfterMaxEdgeGrow(camera, padX, padY, sheetShift)

export type StayPutState = {
  paperX: number
  paperY: number
  camX: number
  camY: number
  width: number
  height: number
  originX: number
  originY: number
  editorX: number
  editorY: number
}

export type StayPutOp = {
  camX?: number
  camY?: number
  width?: number
  height?: number
  padX?: number
  padY?: number
  editorX?: number
  editorY?: number
  sheetShift?: { x?: number; y?: number }
  paintedWidth?: number
  paintedHeight?: number
  lockEditor?: boolean
}

/** True only when paper X/Y changed by the new origin pad and nothing else. */
export const stayPutPaperMovedByPadOnly = (
  previous: StayPutState,
  next: StayPutState,
) => {
  const addX = originPadDelta(previous.originX, next.originX)
  const addY = originPadDelta(previous.originY, next.originY)
  return (
    Math.abs(next.paperX - previous.paperX - addX) < 1e-6
    && Math.abs(next.paperY - previous.paperY - addY) < 1e-6
  )
}

/**
 * One closed write/scroll/grow step. User camera is taken as-is when provided
 * (report pan already includes any pad pan). Live grow without a new camera
 * holds the current camera and adds only new pad + sheet shift. Overlay
 * painted boxes do not become write-page extent. lockEditor forces 0.
 */
export const applyStayPutOp = (state: StayPutState, op: StayPutOp): StayPutState => {
  const nextPadX = Math.max(0, op.padX ?? state.originX)
  const nextPadY = Math.max(0, op.padY ?? state.originY)
  const addX = originPadDelta(state.originX, nextPadX)
  const addY = originPadDelta(state.originY, nextPadY)
  const paper = stayPutPaperAfterOp(
    { x: state.paperX, y: state.paperY },
    state.originX,
    state.originY,
    nextPadX,
    nextPadY,
  )
  const width = writePageStayExtent(
    writePageStayExtent(state.width, op.width ?? state.width),
    op.paintedWidth ?? 0,
  )
  const height = writePageStayExtent(
    writePageStayExtent(state.height, op.height ?? state.height),
    op.paintedHeight ?? 0,
  )
  const hasUserCamera = Number.isFinite(op.camX) || Number.isFinite(op.camY)
  const fromCamera = {
    x: Number.isFinite(op.camX) ? Number(op.camX) : state.camX,
    y: Number.isFinite(op.camY) ? Number(op.camY) : state.camY,
  }
  const camera = stayPutAfterExtentGrow(
    fromCamera,
    hasUserCamera ? 0 : addX,
    hasUserCamera ? 0 : addY,
    op.sheetShift,
  )
  const lock = op.lockEditor === true
  return {
    paperX: paper.x,
    paperY: paper.y,
    camX: camera.x,
    camY: camera.y,
    width,
    height,
    originX: nextPadX,
    originY: nextPadY,
    editorX: lock ? 0 : (Number.isFinite(op.editorX) ? Number(op.editorX) : 0),
    editorY: lock ? 0 : (Number.isFinite(op.editorY) ? Number(op.editorY) : 0),
  }
}

export const reduceStayPutOps = (start: StayPutState, ops: StayPutOp[]) => {
  const frames = [] as StayPutState[]
  let state = start
  for (const op of ops) {
    state = applyStayPutOp(state, op)
    frames.push(state)
  }
  return { start, frames, end: state }
}

/**
 * Ink and typed text on the same paper pixels through a min-edge grow.
 * DrawingBoard remaps 0–1 ink, offsets the editor by `textOriginCssPx`,
 * and pans by `paperOriginScrollDelta`.
 */
export const markdownAndInkAfterMinEdgeGrow = (
  mark: { x: number; y: number },
  text: { x: number; y: number },
  prev: CanvasSize,
  next: CanvasSize & { padX: number; padY: number },
  layout: CanvasSize = next,
  prevLayout: CanvasSize = prev,
) => {
  const padX = finiteOriginPx(next.padX)
  const padY = finiteOriginPx(next.padY)
  const prevW = writePageStayExtent(prev.width, prevLayout.width)
  const prevH = writePageStayExtent(prev.height, prevLayout.height)
  const nextW = writePageStayExtent(prevW, paintedStayExtent(next.width, layout.width))
  const nextH = writePageStayExtent(prevH, paintedStayExtent(next.height, layout.height))
  const inkX = keepMarkOnPage(mark.x, prevW, nextW, padX) * nextW
  const inkY = keepMarkOnPage(mark.y, prevH, nextH, padY) * nextH
  const textX = text.x + padX
  const textY = text.y + padY
  const scrollX = paperOriginScrollDelta(padX, nextW, nextW)
  const scrollY = paperOriginScrollDelta(padY, nextH, nextH)
  return {
    origin: textOriginCssPx(padX, padY),
    inkX,
    inkY,
    textX,
    textY,
    scrollX,
    scrollY,
    visualInkX: inkX - scrollX,
    visualInkY: inkY - scrollY,
    visualTextX: textX - scrollX,
    visualTextY: textY - scrollY,
    prevInkX: mark.x * prev.width,
    prevInkY: mark.y * prev.height,
    prevTextX: text.x,
    prevTextY: text.y,
  }
}

/**
 * Stay-put through a continuing stroke: each sample may grow max-edge and
 * at most the remaining min-edge slack. Camera pans only by new pad.
 */
export const markdownAndInkAfterGrowSequence = (
  mark: { x: number; y: number },
  text: { x: number; y: number },
  start: CanvasSize,
  samples: { x: number; y: number }[],
  painted: CanvasSize = start,
) => {
  let page: CanvasSize & CanvasOrigin = { ...start, originX: 0, originY: 0 }
  let paintW = writePageStayExtent(start.width, painted.width)
  let paintH = writePageStayExtent(start.height, painted.height)
  let ink = { ...mark }
  let glyph = { ...text }
  let cameraX = 0
  let cameraY = 0
  const steps = samples.map((sample) => {
    const prevPaint = { width: paintW, height: paintH }
    const grown = growPageFromMark(page, sample, prevPaint)
    const nextPaint = {
      width: writePageStayExtent(paintW, grown.width),
      height: writePageStayExtent(paintH, grown.height),
      padX: grown.padX,
      padY: grown.padY,
    }
    const stay = markdownAndInkAfterMinEdgeGrow(ink, glyph, prevPaint, nextPaint, nextPaint, prevPaint)
    cameraX += stay.scrollX
    cameraY += stay.scrollY
    ink = {
      x: nextPaint.width > 0 ? stay.inkX / nextPaint.width : ink.x,
      y: nextPaint.height > 0 ? stay.inkY / nextPaint.height : ink.y,
    }
    glyph = { x: stay.textX, y: stay.textY }
    page = {
      width: grown.width,
      height: grown.height,
      originX: (page.originX ?? 0) + grown.padX,
      originY: (page.originY ?? 0) + grown.padY,
    }
    paintW = nextPaint.width
    paintH = nextPaint.height
    return {
      padX: grown.padX,
      padY: grown.padY,
      originX: page.originX ?? 0,
      originY: page.originY ?? 0,
      width: grown.width,
      height: grown.height,
      paintW,
      paintH,
      paperTextX: stay.textX,
      paperTextY: stay.textY,
      paperInkX: stay.inkX,
      paperInkY: stay.inkY,
      visualInkX: stay.inkX - cameraX,
      visualInkY: stay.inkY - cameraY,
      visualTextX: stay.textX - cameraX,
      visualTextY: stay.textY - cameraY,
    }
  })
  return {
    originInkX: mark.x * writePageStayExtent(start.width, painted.width),
    originInkY: mark.y * writePageStayExtent(start.height, painted.height),
    originTextX: text.x,
    originTextY: text.y,
    cameraX,
    cameraY,
    originX: page.originX ?? 0,
    originY: page.originY ?? 0,
    steps,
  }
}

/**
 * Paper-relative glyph after a user camera pan plus optional write-page grow.
 * Nested editor-layer scroll is extra and must be zero on the live path.
 * User camera does not change paper pixels — only origin-pad grow does.
 */
export const markdownGlyphAfterCameraAndGrow = (
  glyph: CanvasPoint,
  start: CanvasSize,
  steps: Array<{
    camX: number
    camY: number
    width: number
    height: number
    padX?: number
    padY?: number
    editorX?: number
    editorY?: number
  }>,
) => {
  const originPaperX = glyph.x
  const originPaperY = glyph.y
  let state: StayPutState = {
    paperX: glyph.x,
    paperY: glyph.y,
    camX: steps[0]?.camX ?? 0,
    camY: steps[0]?.camY ?? 0,
    width: start.width,
    height: start.height,
    originX: 0,
    originY: 0,
    editorX: 0,
    editorY: 0,
  }
  const frames = steps.map((step) => {
    state = applyStayPutOp(state, step)
    return {
      paperX: state.paperX,
      paperY: state.paperY,
      visualX: state.paperX - state.camX - state.editorX,
      visualY: state.paperY - state.camY - state.editorY,
      camX: state.camX,
      camY: state.camY,
      editorX: state.editorX,
      editorY: state.editorY,
      width: step.width,
      height: step.height,
      padX: state.originX,
      padY: state.originY,
    }
  })
  return { originPaperX, originPaperY, frames }
}

export const markPagePosition = (normalized: number, extent: number) => (
  Number.isFinite(normalized) && Number.isFinite(extent) ? normalized * extent : 0
)

/** Scroll range = content plus the same finite extra room on every side. */
export const canvasScrollBounds = (
  content: CanvasBox,
  room = SCROLL_ROOM,
): CanvasBox => {
  const extra = Math.max(0, Number.isFinite(room) ? room : 0)
  return {
    minX: (Number.isFinite(content.minX) ? content.minX : 0) - extra,
    minY: (Number.isFinite(content.minY) ? content.minY : 0) - extra,
    maxX: (Number.isFinite(content.maxX) ? content.maxX : 0) + extra,
    maxY: (Number.isFinite(content.maxY) ? content.maxY : 0) + extra,
  }
}

export const paperScrollPad = (bounds: CanvasBox) => ({
  left: Math.max(0, -(Number.isFinite(bounds.minX) ? bounds.minX : 0)),
  top: Math.max(0, -(Number.isFinite(bounds.minY) ? bounds.minY : 0)),
})

/** Clamp pan/scroll to the finite extra-paper range. Far offsets stop at the bound. */
export const clampCanvasScroll = (
  offset: { x: number; y: number },
  bounds: CanvasBox,
  viewport: CanvasViewport,
) => {
  const viewW = Math.max(0, viewport.width)
  const viewH = Math.max(0, viewport.height)
  const maxScrollX = Math.max(0, bounds.maxX - viewW)
  const maxScrollY = Math.max(0, bounds.maxY - viewH)
  const x = Number.isFinite(offset.x) ? offset.x : 0
  const y = Number.isFinite(offset.y) ? offset.y : 0
  return {
    x: Math.min(maxScrollX, Math.max(0, x)),
    y: Math.min(maxScrollY, Math.max(0, y)),
  }
}

export const writeExtentFromContent = (content: CanvasBox) => {
  const maxX = Math.max(0, Number.isFinite(content.maxX) ? content.maxX : 0) + WRITE_MARGIN_X
  const maxY = Math.max(0, Number.isFinite(content.maxY) ? content.maxY : 0) + WRITE_MARGIN_Y
  return {
    width: Math.min(WRITE_CAP_WIDTH, Math.max(PAGE_START_WIDTH, maxX)),
    height: Math.min(WRITE_CAP_HEIGHT, Math.max(WRITE_MARGIN_Y, maxY)),
  }
}

/** One write page at the origin, plus extra paper as scroll room on every side. */
export const pageCanvasLayout = (page: CanvasSize, room = SCROLL_ROOM) => {
  const pad = Math.max(0, Number.isFinite(room) ? room : 0)
  const width = Math.max(1, finitePositive(page.width) || 1)
  const height = Math.max(1, finitePositive(page.height) || 1)
  return {
    pad,
    page: { x: 0, y: 0, width, height },
    scroll: { x: -pad, y: -pad, width: width + pad * 2, height: height + pad * 2 },
  }
}

/**
 * Hit overlay must cover the write page. Covering the extra paper as well is
 * fine (writing in that blank grows the page). A 0×0 overlay falls back to the
 * page plus extra room so the pen still hits paper.
 */
export const inkOverlaySize = (
  overlay: CanvasSize,
  page: CanvasSize,
  plane: CanvasSize = { width: 0, height: 0 },
) => {
  const overlayW = finitePositive(overlay.width)
  const overlayH = finitePositive(overlay.height)
  const pageW = finitePositive(page.width)
  const pageH = finitePositive(page.height)
  const planeW = finitePositive(plane.width)
  const planeH = finitePositive(plane.height)
  const layout = pageW > 8 && pageH > 8 ? pageCanvasLayout({ width: pageW, height: pageH }) : null
  const minW = layout ? layout.page.width : 0
  const minH = layout ? layout.page.height : 0
  if (overlayW >= minW - 1 && overlayH >= minH - 1 && overlayW >= 8 && overlayH >= 8) {
    return { width: overlayW, height: overlayH }
  }
  if (planeW >= 8 && planeH >= 8) return { width: planeW, height: planeH }
  if (layout) return { width: layout.scroll.width, height: layout.scroll.height }
  if (overlayW >= 8 && overlayH >= 8) return { width: overlayW, height: overlayH }
  return { width: 0, height: 0 }
}

/**
 * Write-page box used for both pointer mapping and stroke paint.
 * Extra paper around the page (overlay / `--paper-scroll-room`) must not
 * become a second 0–1 space — that paints the line further up than the pen.
 */
export const markdownInkPageBox = (
  overlay: { left: number; top: number; width: number; height: number },
  paper: CanvasSize,
  plane: CanvasSize = { width: 0, height: 0 },
) => {
  const overlaySize = inkOverlaySize(overlay, paper, plane)
  const sheetW = finitePositive(paper.width) && paper.width > 8 ? paper.width : overlaySize.width
  const sheetH = finitePositive(paper.height) && paper.height > 8 ? paper.height : overlaySize.height
  const visualW = finitePositive(overlay.width)
  const visualH = finitePositive(overlay.height)
  const padX = visualW > sheetW + 8 ? (visualW - sheetW) / 2 : 0
  const padY = visualH > sheetH + 8 ? (visualH - sheetH) / 2 : 0
  return {
    overlaySize,
    padX,
    padY,
    page: {
      left: overlay.left + padX,
      top: overlay.top + padY,
      width: sheetW,
      height: sheetH,
      offsetWidth: sheetW,
      offsetHeight: sheetH,
    },
  }
}

/** Map a pointer onto the write page. Values may sit slightly outside 0–1 to grow it. */
export const mapClientToPage = (
  clientX: number,
  clientY: number,
  page: { left: number; top: number; width: number; height: number },
) => {
  if (!(page.width > 0) || !(page.height > 0)) return null
  const x = (clientX - page.left) / page.width
  const y = (clientY - page.top) / page.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

export const writePageSurface = (page: { x: number; y: number; width: number; height: number }) => ({
  x: page.x,
  y: page.y,
  width: page.width,
  height: page.height,
})

export const writeSurfaceIsPage = (
  surface: { x: number; y: number; width: number; height: number },
  page: { x: number; y: number; width: number; height: number },
) => (
  surface.x === page.x
  && surface.y === page.y
  && surface.width === page.width
  && surface.height === page.height
)

/** Visual (zoomed) paper rect in scroller coordinates. Does not add write margin. */
export const paperScrollBoundsFromVisualRect = (
  paper: { left: number; top: number; right: number; bottom: number },
  scroller: { left: number; top: number; scrollLeft: number; scrollTop: number },
): CanvasBox => {
  const minX = paper.left - scroller.left + scroller.scrollLeft
  const minY = paper.top - scroller.top + scroller.scrollTop
  const maxX = paper.right - scroller.left + scroller.scrollLeft
  const maxY = paper.bottom - scroller.top + scroller.scrollTop
  return {
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    maxX: Number.isFinite(maxX) ? maxX : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
  }
}

/** Names used by 0–1 ink storage, CSS extent, and older call sites. */
export const PAPER_SOURCE_WIDTH = PAGE_START_WIDTH
export const PAPER_SOURCE_HEIGHT = PAGE_START_HEIGHT
export const WRITE_SLACK_WIDTH = WRITE_MARGIN_X
export const WRITE_SLACK_HEIGHT = WRITE_MARGIN_Y
export const PAGE_GROW_STEP_WIDTH = GROW_STEP_X
export const PAGE_GROW_STEP_HEIGHT = GROW_STEP_Y
export const WRITE_MEMORY_CAP_WIDTH = WRITE_CAP_WIDTH
export const WRITE_MEMORY_CAP_HEIGHT = WRITE_CAP_HEIGHT
export const neededWriteExtent = growWriteExtent
export const neededWriteMinPad = growWriteOrigin
export const remapNormalizedAfterExtent = keepMarkOnPage
export const paperScrollBounds = canvasScrollBounds
export const clampPaperScrollOffset = clampCanvasScroll
export const paperSourceExtentFromContent = writeExtentFromContent
export const mapClientToOneCanvas = mapClientToPage
export const oneCanvasSurface = writePageSurface
export const writeSurfaceIsPlane = writeSurfaceIsPage
export const inkOverlayCoversStage = inkOverlaySize
