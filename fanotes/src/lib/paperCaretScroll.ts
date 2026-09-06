import {
  applyStayPutOp,
  liveWriteStayPut,
  originPadDelta,
  type StayPutOp,
  type StayPutState,
} from './noteCanvas'

export const PAPER_VIEW_SCROLLER_SELECTOR = '.paper-view, .unified-note-view'
export const EDITOR_LAYER_SCROLLER_SELECTOR = '.cm-scroller, .cm-editor, .markdown-editor, .editor-pane'

const WRITE_PAGE_EDITOR_SELECTOR = '.unified-paper, .paper-view'

export const isWritePageEditor = (element: { closest: (selector: string) => unknown } | null) => (
  Boolean(element?.closest(WRITE_PAGE_EDITOR_SELECTOR))
)

/**
 * Nested write-page editor layers cannot keep an independent scroll offset.
 * `overflow: clip` is the CSS barrier; this freeze is the JS barrier so
 * CodeMirror `scrollIntoView` / compositor pulses cannot stick a non-zero
 * scrollTop. Assignment is ignored — this is not a later lock-to-zero.
 */
export const sealNestedEditorScroll = <T extends { scrollTop: number; scrollLeft: number }>(layer: T): T => {
  const freeze = (prop: 'scrollTop' | 'scrollLeft') => {
    try {
      Object.defineProperty(layer, prop, {
        configurable: true,
        enumerable: true,
        get: () => 0,
        set: () => undefined,
      })
    } catch {
      layer[prop] = 0
    }
  }
  freeze('scrollTop')
  freeze('scrollLeft')
  return layer
}

export const editorIsOnWritePage = (element: HTMLElement | null) => isWritePageEditor(element)

export const resolvePaperCaretScroller = (
  from: { closest: (selector: string) => HTMLElement | null } | null,
) => (
  from?.closest('.paper-view')
  ?? from?.closest('.unified-note-view')
  ?? null
)

export const isIndependentEditorLayer = (element: HTMLElement | null) => {
  if (!element) return false
  if (element.classList.contains('paper-view') || element.classList.contains('unified-note-view')) return false
  return Boolean(
    element.classList.contains('cm-scroller')
    || element.classList.contains('cm-editor')
    || element.classList.contains('markdown-editor')
    || element.classList.contains('editor-pane')
    || element.closest(EDITOR_LAYER_SCROLLER_SELECTOR),
  )
}

const collectEditorScrollLayers = (editorRoot: HTMLElement) => {
  const layers: HTMLElement[] = []
  const seen = new Set<HTMLElement>()
  const push = (layer: HTMLElement | null) => {
    if (!layer || seen.has(layer)) return
    if (layer.classList.contains('paper-view') || layer.classList.contains('unified-note-view')) return
    seen.add(layer)
    layers.push(layer)
  }
  push(editorRoot.closest('.editor-pane') as HTMLElement | null)
  push(editorRoot.closest('.markdown-editor') as HTMLElement | null)
  push(editorRoot)
  editorRoot.querySelectorAll<HTMLElement>(EDITOR_LAYER_SCROLLER_SELECTOR).forEach((layer) => push(layer))
  return layers
}

export const lockPaperEditorLayerScroll = (editorRoot: HTMLElement | null) => {
  if (!editorRoot) return [] as HTMLElement[]
  const layers = collectEditorScrollLayers(editorRoot)
  const onWritePage = isWritePageEditor(editorRoot)
  layers.forEach((layer) => {
    if (onWritePage) sealNestedEditorScroll(layer)
    else {
      layer.scrollTop = 0
      layer.scrollLeft = 0
    }
  })
  return layers
}

/** Extra rAF locks after a fling so compositor momentum cannot leave glyphs offset. */
export const PAPER_EDITOR_FLING_HOLD_FRAMES = 16

export type NestedScrollPulse = {
  scrollTop: number
  scrollLeft?: number
}

export const tickPaperEditorScrollHold = (
  editorRoot: HTMLElement | null,
  remainingFrames: number,
) => {
  const layers = lockPaperEditorLayerScroll(editorRoot)
  return {
    layers,
    remainingFrames: Math.max(0, remainingFrames - 1),
  }
}

export const tickPaperViewportEditorScrollHold = (
  paperScroller: HTMLElement | null,
  remainingFrames: number,
) => {
  const layers = lockPaperViewportEditorScroll(paperScroller)
  return {
    layers,
    remainingFrames: Math.max(0, remainingFrames - 1),
  }
}

/**
 * Fast-scroll case: compositor applies several nested scrollTops in a burst.
 * Each pulse is locked immediately so only the paper scroller may stay offset.
 */
export const lockPaperEditorScrollBurst = (
  editorRoot: HTMLElement | null,
  pulses: readonly NestedScrollPulse[],
) => {
  if (!editorRoot) return [] as Array<{ editorTop: number; layerTops: number[] }>
  const samples: Array<{ editorTop: number; layerTops: number[] }> = []
  let remaining = PAPER_EDITOR_FLING_HOLD_FRAMES
  for (const pulse of pulses) {
    collectEditorScrollLayers(editorRoot).forEach((layer) => {
      layer.scrollTop = pulse.scrollTop
      layer.scrollLeft = pulse.scrollLeft ?? 0
    })
    const tick = tickPaperEditorScrollHold(editorRoot, remaining)
    remaining = tick.remainingFrames
    samples.push({
      editorTop: editorRoot.scrollTop,
      layerTops: tick.layers.map((layer) => layer.scrollTop),
    })
  }
  while (remaining > 0) {
    const tick = tickPaperEditorScrollHold(editorRoot, remaining)
    remaining = tick.remainingFrames
    samples.push({
      editorTop: editorRoot.scrollTop,
      layerTops: tick.layers.map((layer) => layer.scrollTop),
    })
  }
  return samples
}

export const lockPaperViewportScrollBurst = (
  paperScroller: HTMLElement | null,
  pulses: readonly NestedScrollPulse[],
) => {
  if (!paperScroller) return [] as Array<{ paperTop: number; layerTops: number[] }>
  const samples: Array<{ paperTop: number; layerTops: number[] }> = []
  const paperTop = paperScroller.scrollTop
  let remaining = PAPER_EDITOR_FLING_HOLD_FRAMES
  for (const pulse of pulses) {
    paperScroller.querySelectorAll<HTMLElement>(EDITOR_LAYER_SCROLLER_SELECTOR).forEach((layer) => {
      if (!isIndependentEditorLayer(layer)) return
      layer.scrollTop = pulse.scrollTop
      layer.scrollLeft = pulse.scrollLeft ?? 0
    })
    const tick = tickPaperViewportEditorScrollHold(paperScroller, remaining)
    remaining = tick.remainingFrames
    samples.push({
      paperTop: paperScroller.scrollTop,
      layerTops: tick.layers.map((layer) => layer.scrollTop),
    })
  }
  while (remaining > 0) {
    const tick = tickPaperViewportEditorScrollHold(paperScroller, remaining)
    remaining = tick.remainingFrames
    samples.push({
      paperTop: paperScroller.scrollTop,
      layerTops: tick.layers.map((layer) => layer.scrollTop),
    })
  }
  if (paperScroller.scrollTop !== paperTop) paperScroller.scrollTop = paperTop
  return samples
}

/** Paper viewport scroll must not leave glyphs sliding in a nested editor scroller. */
export const lockPaperViewportEditorScroll = (paperScroller: HTMLElement | null) => {
  if (!paperScroller) return [] as HTMLElement[]
  if (!paperScroller.classList.contains('paper-view') && !paperScroller.classList.contains('unified-note-view')) {
    return [] as HTMLElement[]
  }
  const locked: HTMLElement[] = []
  paperScroller.querySelectorAll<HTMLElement>(EDITOR_LAYER_SCROLLER_SELECTOR).forEach((layer) => {
    if (!isIndependentEditorLayer(layer)) return
    sealNestedEditorScroll(layer)
    locked.push(layer)
  })
  return locked
}

/**
 * Fast paper-viewport pan: zero independent editor-layer scroll on every tick.
 * Do not follow the caret — that fights a burst of pan jumps and shifts glyphs.
 */
/** Nested editor-layer scroll that moves glyphs off the paper camera. */
export const GHOST_TEXT_SLIP_PX = 2

export type GhostTextLayout = {
  paperX: number
  paperY: number
  camX: number
  camY: number
  padX: number
  padY: number
  editorX: number
  editorY: number
}

export type GhostTextSample = GhostTextLayout & {
  visualX: number
  visualY: number
}

export const readIndependentEditorLayerScroll = (from: HTMLElement | null) => {
  let x = 0
  let y = 0
  const seen = new Set<HTMLElement>()
  const add = (layer: HTMLElement | null) => {
    if (!layer || seen.has(layer) || !isIndependentEditorLayer(layer)) return
    seen.add(layer)
    x += Number(layer.scrollLeft) || 0
    y += Number(layer.scrollTop) || 0
  }
  if (from) {
    collectEditorScrollLayers(from).forEach(add)
    let current: HTMLElement | null = from
    while (current) {
      add(current)
      current = current.parentElement
    }
  }
  return { x, y }
}

export const readTextOriginPad = (paper: HTMLElement | null) => {
  const x = Number.parseFloat(paper?.style?.getPropertyValue('--text-origin-x') || '')
  const y = Number.parseFloat(paper?.style?.getPropertyValue('--text-origin-y') || '')
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  }
}

/** Visual CSS px of a glyph after origin pad, paper camera, and nested editor scroll. */
export const glyphVisualFromPaper = (layout: GhostTextLayout) => ({
  x: layout.paperX + layout.padX - layout.camX - layout.editorX,
  y: layout.paperY + layout.padY - layout.camY - layout.editorY,
})

/** Expected visual if only the paper camera moved — no nested editor slip. */
export const glyphExpectedVisual = (layout: GhostTextLayout) => ({
  x: layout.paperX + layout.padX - layout.camX,
  y: layout.paperY + layout.padY - layout.camY,
})

export const editorLayerCausesSlip = (editorX: number, editorY: number) => (
  Math.abs(editorX) > GHOST_TEXT_SLIP_PX || Math.abs(editorY) > GHOST_TEXT_SLIP_PX
)

export const sampleGhostTextLayout = (input: {
  paperX: number
  paperY: number
  camX: number
  camY: number
  padX?: number
  padY?: number
  editorX: number
  editorY: number
  visualX?: number
  visualY?: number
}): GhostTextSample => {
  const layout: GhostTextLayout = {
    paperX: input.paperX,
    paperY: input.paperY,
    camX: input.camX,
    camY: input.camY,
    padX: input.padX ?? 0,
    padY: input.padY ?? 0,
    editorX: input.editorX,
    editorY: input.editorY,
  }
  const visual = glyphVisualFromPaper(layout)
  return {
    ...layout,
    visualX: Number.isFinite(input.visualX) ? input.visualX as number : visual.x,
    visualY: Number.isFinite(input.visualY) ? input.visualY as number : visual.y,
  }
}

/**
 * Slip: nested editor-layer scroll or origin/camera mismatch moves the glyph.
 * Snap-back: the same paper pixel later matches the camera-compensated expected
 * position again (ghost text that went away and came back).
 */
export const classifyGhostTextMotion = (
  previous: GhostTextSample | null | undefined,
  next: GhostTextSample,
) => {
  const expected = glyphExpectedVisual(next)
  const dx = next.visualX - expected.x
  const dy = next.visualY - expected.y
  const slip = editorLayerCausesSlip(next.editorX, next.editorY)
    || Math.hypot(dx, dy) > GHOST_TEXT_SLIP_PX
  const samePaper = Boolean(
    previous
    && Math.abs(previous.paperX - next.paperX) < 1e-6
    && Math.abs(previous.paperY - next.paperY) < 1e-6,
  )
  const previousExpected = previous ? glyphExpectedVisual(previous) : null
  const previousSlip = Boolean(
    previous
    && (
      editorLayerCausesSlip(previous.editorX, previous.editorY)
      || Math.hypot(previous.visualX - previousExpected!.x, previous.visualY - previousExpected!.y) > GHOST_TEXT_SLIP_PX
    ),
  )
  const back = previousSlip && samePaper && !slip
  return {
    slip,
    back,
    dx,
    dy,
    expectedX: expected.x,
    expectedY: expected.y,
  }
}

export const observeGhostTextSequence = (
  frames: Array<Parameters<typeof sampleGhostTextLayout>[0]>,
) => {
  let previous: GhostTextSample | null = null
  return frames.map((frame) => {
    const sample = sampleGhostTextLayout(frame)
    const motion = classifyGhostTextMotion(previous, sample)
    previous = sample
    return { sample, ...motion }
  })
}

/** Restore the held paper camera and zero nested editor scroll after a grow. */
export const pinPaperViewportAfterExtentGrow = (
  paperScroller: HTMLElement | null,
  camera: { x: number; y: number },
) => lockPaperViewportScrollStayPut(paperScroller, {
  scrollLeft: camera.x,
  scrollTop: camera.y,
})

/**
 * One live stay-put step on the write page: closed reducer + nested-editor
 * seal + camera pin. Pad and camera cannot desync; nested scroll cannot stick.
 */
export const applyLiveStayPutStep = (
  state: StayPutState,
  op: StayPutOp,
  paperScroller: HTMLElement | null = null,
): StayPutState => {
  const next = applyStayPutOp(state, { ...op, lockEditor: true })
  if (paperScroller) pinPaperViewportAfterExtentGrow(paperScroller, { x: next.camX, y: next.camY })
  return next
}

export const applyLiveWriteStayPut = (
  state: StayPutState,
  live: Parameters<typeof liveWriteStayPut>[1],
  paperScroller: HTMLElement | null = null,
): StayPutState => {
  const next = liveWriteStayPut(state, live)
  if (paperScroller) pinPaperViewportAfterExtentGrow(paperScroller, { x: next.camX, y: next.camY })
  return next
}

/**
 * Double-rAF canvas/surface flush after autoexpand. Fast enough to catch the
 * next vsync without a repeating timer that would drain the battery.
 */
export const VISUAL_GROW_REFRESH_FRAMES = 2
export const PAPER_COMPOSITOR_REFRESH_ATTR = 'data-fanotes-visual-gen'
export const PAPER_CANVAS_SURFACE_REFRESH_ATTR = 'data-fanotes-canvas-gen'

export type PaperCanvasPaintContext = {
  setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void
  clearRect: (x: number, y: number, w: number, h: number) => void
}

export type PaperCanvasBacking = {
  width: number
  height: number
  getContext?: (id: '2d', options?: { alpha?: boolean }) => PaperCanvasPaintContext | null
  style?: { transform?: string }
}

export type PaperCanvasSurfaceHost = {
  style?: { transform?: string; width?: string; height?: string }
  offsetWidth?: number
  offsetHeight?: number
  getAttribute?: (name: string) => string | null
  setAttribute?: (name: string, value: string) => void
  querySelectorAll?: (selector: string) => ArrayLike<PaperCanvasBacking | Element>
}

export type VisualGrowCanvasTarget = {
  surface?: PaperCanvasSurfaceHost | null
  canvases?: Array<PaperCanvasBacking | null | undefined>
}

/** Force a layer invalidation. This alone does not snap slipped glyphs. */
export const forcePaperCompositorRefresh = (root: HTMLElement | null) => {
  if (!root) return 0
  void root.offsetWidth
  void root.offsetHeight
  const current = Number.parseInt(root.getAttribute?.(PAPER_COMPOSITOR_REFRESH_ATTR) || '0', 10)
  const next = (Number.isFinite(current) ? current : 0) + 1
  root.setAttribute?.(PAPER_COMPOSITOR_REFRESH_ATTR, String(next))
  const plane = (
    typeof root.querySelector === 'function'
      ? root.querySelector('.paper-sheet-plane, .unified-paper')
      : null
  ) as HTMLElement | null
  if (plane?.style) {
    const prev = plane.style.transform
    plane.style.transform = prev ? `${prev} translateZ(0)` : 'translateZ(0)'
    void plane.offsetHeight
    plane.style.transform = prev
  }
  return next
}

export const paperCompositorRefreshGen = (root: HTMLElement | null) => {
  const current = Number.parseInt(root?.getAttribute?.(PAPER_COMPOSITOR_REFRESH_ATTR) || '0', 10)
  return Number.isFinite(current) ? current : 0
}

export const collectPaperCanvasSurfaces = (
  surface: PaperCanvasSurfaceHost | null,
  canvases: Array<PaperCanvasBacking | null | undefined> = [],
): PaperCanvasBacking[] => {
  const found: PaperCanvasBacking[] = []
  const seen = new Set<unknown>()
  const push = (canvas: PaperCanvasBacking | null | undefined) => {
    if (!canvas || seen.has(canvas) || typeof canvas.width !== 'number') return
    seen.add(canvas)
    found.push(canvas)
  }
  canvases.forEach(push)
  const listed = surface?.querySelectorAll?.('canvas')
  if (listed) {
    for (let index = 0; index < listed.length; index += 1) {
      push(listed[index] as PaperCanvasBacking)
    }
  }
  return found
}

/**
 * Same class of canvas mutation as erasing leftover ghost ink: paint the
 * backing store so sibling typed glyphs re-composite at the paper camera.
 */
export const paintPaperCanvasSurfaceUpdate = (canvas: PaperCanvasBacking | null) => {
  if (!canvas) return false
  const width = Number(canvas.width)
  const height = Number(canvas.height)
  if (!(width > 0) || !(height > 0)) return false
  const ctx = typeof canvas.getContext === 'function'
    ? canvas.getContext('2d', { alpha: true })
    : null
  if (!ctx) return false
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const painted = ctx as PaperCanvasPaintContext & {
    getImageData?: (sx: number, sy: number, sw: number, sh: number) => { data: ArrayLike<number>; width: number; height: number }
    putImageData?: (image: unknown, dx: number, dy: number) => void
  }
  if (typeof painted.getImageData === 'function' && typeof painted.putImageData === 'function') {
    try {
      const pixel = painted.getImageData(0, 0, 1, 1)
      painted.putImageData(pixel, 0, 0)
      return true
    } catch {
      // Tainted or mock canvas — a 1px clear still dirties the layer.
    }
  }
  ctx.clearRect(0, 0, 1, 1)
  return true
}

/** Canvas/surface visual update. Skipping this leaves the grow slip. */
export const refreshPaperCanvasSurface = (
  surface: PaperCanvasSurfaceHost | null,
  canvases: Array<PaperCanvasBacking | null | undefined> = [],
) => {
  const targets = collectPaperCanvasSurfaces(surface, canvases)
  if (targets.length === 0) return 0
  void surface?.offsetWidth
  void surface?.offsetHeight
  if (surface?.style) {
    const prev = surface.style.transform || ''
    surface.style.transform = prev ? `${prev} translateZ(0)` : 'translateZ(0)'
    void surface.offsetHeight
    surface.style.transform = prev
  }
  let painted = 0
  for (const canvas of targets) {
    if (paintPaperCanvasSurfaceUpdate(canvas)) painted += 1
  }
  if (painted === 0) return 0
  if (!surface?.setAttribute) return painted
  const current = Number.parseInt(surface.getAttribute?.(PAPER_CANVAS_SURFACE_REFRESH_ATTR) || '0', 10)
  const next = (Number.isFinite(current) ? current : 0) + 1
  surface.setAttribute(PAPER_CANVAS_SURFACE_REFRESH_ATTR, String(next))
  return next
}

export const paperCanvasSurfaceRefreshGen = (surface: PaperCanvasSurfaceHost | null) => {
  const current = Number.parseInt(surface?.getAttribute?.(PAPER_CANVAS_SURFACE_REFRESH_ATTR) || '0', 10)
  return Number.isFinite(current) ? current : 0
}

/**
 * Compositor-generation-only never zeros a height-delta slip. The live grow
 * path must paint the canvas/surface (the same update as erase-ghost-ink).
 */
export const growCompositorVisualOffset = (heightDelta: number, _compositorRefreshed = false) => (
  !Number.isFinite(heightDelta) || heightDelta === 0 ? { x: 0, y: 0 } : { x: 0, y: heightDelta }
)

export const growCanvasSurfaceVisualOffset = (heightDelta: number, canvasUpdated: boolean) => (
  canvasUpdated || !Number.isFinite(heightDelta) || heightDelta === 0
    ? { x: 0, y: 0 }
    : { x: 0, y: heightDelta }
)

export const sampleVisualAfterGrowRefresh = (
  previous: GhostTextSample | null,
  layout: GhostTextLayout,
  canvasUpdated: boolean,
  heightDelta = 0,
): GhostTextSample => {
  const expected = glyphExpectedVisual(layout)
  const offset = growCanvasSurfaceVisualOffset(heightDelta, canvasUpdated || !previous)
  return sampleGhostTextLayout({
    ...layout,
    visualX: expected.x - offset.x,
    visualY: expected.y - offset.y,
  })
}

/** Pin camera, compositor bump, and the canvas/surface paint that snaps glyphs. */
export const applyVisualGrowCorrection = (
  paperScroller: HTMLElement | null,
  camera: { x: number; y: number },
  canvasTarget: VisualGrowCanvasTarget | null = null,
) => {
  if (paperScroller) pinPaperViewportAfterExtentGrow(paperScroller, camera)
  const compositorGen = paperScroller ? forcePaperCompositorRefresh(paperScroller) : 0
  const canvasGen = refreshPaperCanvasSurface(
    canvasTarget?.surface ?? null,
    canvasTarget?.canvases ?? [],
  )
  return {
    compositorGen,
    canvasGen,
    canvasUpdated: canvasGen > 0,
  }
}

export type VisualGrowOp = {
  width: number
  height: number
  padX: number
  padY: number
  camX: number
  camY: number
  grew: boolean
}

export type VisualGrowPenEvent = {
  kind?: string
  pageW?: number
  pageH?: number
  padX?: number
  padY?: number
  camX?: number
  camY?: number
  grew?: boolean
}

export const visualGrowOpsFromBugEvents = (events: VisualGrowPenEvent[]): VisualGrowOp[] => {
  const ops: VisualGrowOp[] = []
  for (const event of events) {
    if (event?.kind !== 'pen') continue
    if (![event.pageW, event.pageH, event.camX, event.camY].every((value) => Number.isFinite(value))) continue
    ops.push({
      width: Number(event.pageW),
      height: Number(event.pageH),
      padX: Number(event.padX) || 0,
      padY: Number(event.padY) || 0,
      camX: Number(event.camX),
      camY: Number(event.camY),
      grew: event.grew === true,
    })
  }
  return ops
}

export type VisualGrowState = {
  stay: StayPutState
  sample: GhostTextSample | null
  refreshGen: number
  canvasGen: number
}

export const REPORT_VISUAL_GROW_GLYPH = { paperX: 86, paperY: 78 }

export const emptyVisualGrowState = (start: {
  width: number
  height: number
  padX: number
  padY: number
  camX: number
  camY: number
}): VisualGrowState => {
  const layout: GhostTextLayout = {
    paperX: REPORT_VISUAL_GROW_GLYPH.paperX,
    paperY: REPORT_VISUAL_GROW_GLYPH.paperY,
    camX: start.camX,
    camY: start.camY,
    padX: start.padX,
    padY: start.padY,
    editorX: 0,
    editorY: 0,
  }
  return {
    stay: {
      paperX: 0,
      paperY: 0,
      camX: start.camX,
      camY: start.camY,
      width: start.width,
      height: start.height,
      originX: start.padX,
      originY: start.padY,
      editorX: 0,
      editorY: 0,
    },
    sample: sampleGhostTextLayout({
      ...layout,
      visualX: glyphExpectedVisual(layout).x,
      visualY: glyphExpectedVisual(layout).y,
    }),
    refreshGen: 0,
    canvasGen: 0,
  }
}

/**
 * One live autoexpand step: stay-put reducer, camera pin, canvas/surface
 * visual update. Skipping that canvas/surface paint leaves the height-delta
 * slip; a compositor-generation bump alone is not enough.
 */
export const applyVisualGrowOp = (
  state: VisualGrowState,
  op: VisualGrowOp,
  paperScroller: HTMLElement | null = null,
  canvasTarget: VisualGrowCanvasTarget | null = null,
) => {
  const stay = liveWriteStayPut(state.stay, {
    grown: {
      width: op.width,
      height: op.height,
      padX: originPadDelta(state.stay.originX, op.padX),
      padY: originPadDelta(state.stay.originY, op.padY),
    },
    camX: op.camX,
    camY: op.camY,
  })
  const correction = op.grew
    ? applyVisualGrowCorrection(paperScroller, { x: stay.camX, y: stay.camY }, canvasTarget)
    : {
      compositorGen: state.refreshGen,
      canvasGen: 0,
      canvasUpdated: false,
    }
  if (!op.grew && paperScroller) {
    pinPaperViewportAfterExtentGrow(paperScroller, { x: stay.camX, y: stay.camY })
  }
  const canvasUpdated = !op.grew || correction.canvasUpdated
  const layout: GhostTextLayout = {
    paperX: REPORT_VISUAL_GROW_GLYPH.paperX,
    paperY: REPORT_VISUAL_GROW_GLYPH.paperY,
    camX: stay.camX,
    camY: stay.camY,
    padX: stay.originX,
    padY: stay.originY,
    editorX: stay.editorX,
    editorY: stay.editorY,
  }
  const sample = sampleVisualAfterGrowRefresh(
    state.sample,
    layout,
    canvasUpdated,
    op.grew ? op.height - state.stay.height : 0,
  )
  const motion = classifyGhostTextMotion(state.sample, sample)
  return {
    stay,
    sample,
    refreshGen: paperScroller ? paperCompositorRefreshGen(paperScroller) : correction.compositorGen,
    canvasGen: canvasUpdated && op.grew ? state.canvasGen + 1 : state.canvasGen,
    canvasUpdated,
    slip: motion.slip,
    back: motion.back,
    expectedX: motion.expectedX,
    expectedY: motion.expectedY,
    grew: op.grew,
  }
}

export const schedulePaperVisualGrowRefresh = (
  scheduleFrame: (callback: () => void) => number,
  paperScroller: HTMLElement | null,
  camera: { x: number; y: number },
  remaining = VISUAL_GROW_REFRESH_FRAMES,
  canvasTarget: VisualGrowCanvasTarget | null = null,
) => {
  if (remaining <= 0) return 0
  if (!paperScroller && !canvasTarget?.surface && !(canvasTarget?.canvases?.length)) return 0
  return scheduleFrame(() => {
    applyVisualGrowCorrection(paperScroller, camera, canvasTarget)
    if (remaining > 1) {
      schedulePaperVisualGrowRefresh(scheduleFrame, paperScroller, camera, remaining - 1, canvasTarget)
    }
  })
}

export const lockPaperViewportScrollStayPut = (
  paperScroller: HTMLElement | null,
  requested?: { scrollTop?: number; scrollLeft?: number },
) => {
  if (!paperScroller) {
    return {
      paperScroller: null,
      lockedLayers: [] as HTMLElement[],
      paperScrollTop: 0,
      paperScrollLeft: 0,
    }
  }
  if (requested && Number.isFinite(requested.scrollTop)) paperScroller.scrollTop = requested.scrollTop as number
  if (requested && Number.isFinite(requested.scrollLeft)) paperScroller.scrollLeft = requested.scrollLeft as number
  const viewportLocked = lockPaperViewportEditorScroll(paperScroller)
  const locked = viewportLocked.length ? viewportLocked : lockPaperEditorLayerScroll(paperScroller)
  return {
    paperScroller,
    lockedLayers: locked,
    paperScrollTop: paperScroller.scrollTop,
    paperScrollLeft: paperScroller.scrollLeft,
  }
}

/** Sample nested-editor slip, lock the paper viewport, then sample snap-back. */
export const captureGhostTextAroundLock = (
  paperScroller: HTMLElement | null,
  editorRoot: HTMLElement | null,
  glyph: { x: number; y: number } = { x: 0, y: 0 },
) => {
  const pad = readTextOriginPad(
    paperScroller?.querySelector?.('.unified-paper') as HTMLElement | null
    ?? paperScroller,
  )
  const camBefore = {
    x: paperScroller?.scrollLeft ?? 0,
    y: paperScroller?.scrollTop ?? 0,
  }
  const editorBefore = readIndependentEditorLayerScroll(editorRoot ?? paperScroller)
  const before = sampleGhostTextLayout({
    paperX: glyph.x,
    paperY: glyph.y,
    camX: camBefore.x,
    camY: camBefore.y,
    padX: pad.x,
    padY: pad.y,
    editorX: editorBefore.x,
    editorY: editorBefore.y,
  })
  const locked = lockPaperViewportScrollStayPut(paperScroller)
  const editorAfter = readIndependentEditorLayerScroll(editorRoot ?? paperScroller)
  const after = sampleGhostTextLayout({
    paperX: glyph.x,
    paperY: glyph.y,
    camX: locked.paperScrollLeft,
    camY: locked.paperScrollTop,
    padX: pad.x,
    padY: pad.y,
    editorX: editorAfter.x,
    editorY: editorAfter.y,
  })
  return {
    locked,
    before,
    after,
    slip: classifyGhostTextMotion(null, before),
    back: classifyGhostTextMotion(before, after),
  }
}

export const ghostTextDiagnosticFields = (
  sample: GhostTextSample,
  motion: { slip: boolean; back: boolean },
) => ({
  visualX: sample.visualX,
  visualY: sample.visualY,
  paperX: sample.paperX,
  paperY: sample.paperY,
  camX: sample.camX,
  camY: sample.camY,
  padX: sample.padX,
  padY: sample.padY,
  edX: sample.editorX,
  edY: sample.editorY,
  slip: motion.slip,
  back: motion.back,
})

export const keepCaretVisibleInPaperScroller = (
  scroller: HTMLElement,
  caret: { top: number; bottom: number; left: number; right: number },
) => {
  const bounds = scroller.getBoundingClientRect()
  let dy = 0
  let dx = 0
  if (caret.bottom > bounds.bottom - 8) dy = caret.bottom - (bounds.bottom - 8)
  else if (caret.top < bounds.top + 8) dy = caret.top - (bounds.top + 8)
  if (caret.right > bounds.right - 8) dx = caret.right - (bounds.right - 8)
  else if (caret.left < bounds.left + 8) dx = caret.left - (bounds.left + 8)
  if (dy) scroller.scrollTop += dy
  if (dx) scroller.scrollLeft += dx
  return { dx, dy }
}

export const applyPaperArrowNavigation = (
  editorRoot: HTMLElement,
  caret: { top: number; bottom: number; left: number; right: number } | null,
) => {
  const locked = lockPaperEditorLayerScroll(editorRoot)
  const paper = resolvePaperCaretScroller(editorRoot)
  if (paper && caret) keepCaretVisibleInPaperScroller(paper, caret)
  return {
    paperScroller: paper,
    lockedLayers: locked,
    editorScrollTop: editorRoot.scrollTop,
    editorScrollLeft: editorRoot.scrollLeft,
  }
}

/**
 * CodeMirror `measure()` calls `scrollIntoView` on `.cm-scroller` after
 * plugins update. `overflow: hidden` does not block that programmatic
 * scrollTop. Lock nested editor layers only — pan-to-caret here fights a
 * user paper pan when the sheet grows (typed text slides while scrolling).
 * Keyboard caret follow stays on arrow navigation.
 */
export const lockPaperEditorScrollIfNeeded = (
  editorRoot: HTMLElement | null,
  _caret?: { top: number; bottom: number; left: number; right: number } | null,
) => {
  if (!editorRoot?.closest('.unified-paper, .paper-view')) return false
  lockPaperEditorLayerScroll(editorRoot)
  return true
}

/**
 * Swallow CodeMirror's scroll-into-view. Pan-to-caret here fights the paper
 * camera (typed text slides up/down while scrolling). Keyboard caret follow
 * stays on selection/doc updates via lockPaperEditorScrollIfNeeded.
 */
export const handlePaperEditorScroll = (
  view: {
    dom: HTMLElement
    coordsAtPos: (pos: number) => { top: number; bottom: number; left: number; right: number } | null
    requestMeasure?: (measurement: {
      key?: string
      read: (view: unknown) => unknown
      write?: (measure: unknown, view: unknown) => void
    }) => void
  },
  _range?: { head: number },
): boolean => {
  if (!view.dom?.closest('.unified-paper, .paper-view')) return false
  lockPaperEditorLayerScroll(view.dom)
  return true
}
