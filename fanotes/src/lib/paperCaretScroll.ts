export const PAPER_VIEW_SCROLLER_SELECTOR = '.paper-view, .unified-note-view'
export const EDITOR_LAYER_SCROLLER_SELECTOR = '.cm-scroller, .cm-editor, .markdown-editor, .editor-pane'

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
  layers.forEach((layer) => {
    layer.scrollTop = 0
    layer.scrollLeft = 0
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
    layer.scrollTop = 0
    layer.scrollLeft = 0
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
 * scrollTop. Returning true here swallows the default so glyphs stay
 * glued to the ruling; only the paper viewport may move.
 */
export const lockPaperEditorScrollIfNeeded = (
  editorRoot: HTMLElement | null,
  caret: { top: number; bottom: number; left: number; right: number } | null,
) => {
  if (!editorRoot?.closest('.unified-paper, .paper-view')) return false
  applyPaperArrowNavigation(editorRoot, caret)
  return true
}

const readCaretCoords = (
  view: {
    coordsAtPos: (pos: number) => { top: number; bottom: number; left: number; right: number } | null
  },
  pos: number,
) => {
  try {
    return view.coordsAtPos(pos)
  } catch {
    // CodeMirror forbids layout reads during ViewUpdate.
    return null
  }
}

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
  range: { head: number },
): boolean => {
  if (!view.dom?.closest('.unified-paper, .paper-view')) return false
  lockPaperEditorLayerScroll(view.dom)
  const caret = readCaretCoords(view, range.head)
  if (caret) {
    const paper = resolvePaperCaretScroller(view.dom)
    if (paper) keepCaretVisibleInPaperScroller(paper, caret)
    return true
  }
  view.requestMeasure?.({
    key: 'fanotes-paper-scroll',
    read: (nextView) => (nextView as typeof view).coordsAtPos(range.head),
    write: (nextCaret, nextView) => {
      lockPaperEditorScrollIfNeeded((nextView as typeof view).dom, nextCaret as typeof caret)
    },
  })
  return true
}
