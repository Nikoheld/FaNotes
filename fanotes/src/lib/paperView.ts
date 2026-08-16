export const VIEW_ZOOM_MIN = 0.45
export const VIEW_ZOOM_MAX = 3.25
export const VIEW_ZOOM_STEP = 0.12
export const VIEW_ZOOM_SPEED_MIN = 1
export const VIEW_ZOOM_SPEED_MAX = 10
export const VIEW_ZOOM_SPEED_DEFAULT = 5
export const VIEW_ROTATE_STEP = 15

export type PaperViewSnapshot = {
  zoom: number
  rotation: number
  pan: { x: number; y: number }
}

export const defaultPaperView = (): PaperViewSnapshot => ({
  zoom: 1,
  rotation: 0,
  pan: { x: 0, y: 0 },
})

export const clampViewZoom = (value: number) => (
  Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, Math.round(value * 1000) / 1000))
)

export const clampViewZoomSpeed = (value: number) => (
  Math.min(VIEW_ZOOM_SPEED_MAX, Math.max(VIEW_ZOOM_SPEED_MIN, Math.round(Number(value) || VIEW_ZOOM_SPEED_DEFAULT)))
)

/** Map the 1–10 setting onto wheel sensitivity. 5 is the previous default. */
export const zoomSensitivityFromSpeed = (speed: number) => {
  const level = clampViewZoomSpeed(speed)
  return 0.28 + (level - 1) * (1.72 / 9)
}

export const zoomFactorFromWheel = (deltaY: number, deltaMode: number, speed: number) => {
  let dy = deltaY
  if (deltaMode === 1) dy *= 16
  if (deltaMode === 2) dy *= 800
  const clamped = Math.max(-420, Math.min(420, dy))
  return Math.exp(-clamped * 0.00095 * zoomSensitivityFromSpeed(speed))
}

export const zoomStepFromSpeed = (speed: number) => (
  Math.round(VIEW_ZOOM_STEP * zoomSensitivityFromSpeed(speed) * 1000) / 1000
)

let sharedZoomSpeed = VIEW_ZOOM_SPEED_DEFAULT
export const readSharedZoomSpeed = () => sharedZoomSpeed
export const writeSharedZoomSpeed = (value: number) => {
  sharedZoomSpeed = clampViewZoomSpeed(value)
}

export const normalizeRotation = (value: number) => {
  const wrapped = ((value % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

export const isPaperViewActive = (view: PaperViewSnapshot) => (
  view.zoom !== 1 || view.rotation !== 0 || view.pan.x !== 0 || view.pan.y !== 0
)

/**
 * Layers that must inherit the sheet zoom. Never assign `zoom: 1` / `zoom: ''`
 * here — Chromium's inherited `zoom` then stays at 1× and only the paper
 * background grows, leaving markdown at the original size.
 */
const SHEET_LAYER_SELECTOR = '.editor-pane, .worksheet-layer, .lw-canvas-surface, .lw-drawing-board, .paper-ruling'
const TEXT_ZOOM_SELECTOR = '.editor-pane'

const clearInlineViewStyle = (element: HTMLElement | null) => {
  if (!element) return
  element.style.removeProperty('zoom')
  element.style.removeProperty('transform')
  element.style.removeProperty('transform-origin')
  element.style.removeProperty('will-change')
  element.style.removeProperty('--view-zoom')
  element.classList.remove('is-view-transformed', 'is-view-zoomed')
}

/** Prefer the dedicated plane so ruling, text and ink share one zoom node. */
export const resolvePaperViewTarget = (
  paper: HTMLElement | null,
  noteView: HTMLElement | null = null,
) => (
  (paper?.closest('.paper-sheet-plane') as HTMLElement | null)
  ?? noteView?.querySelector<HTMLElement>('.paper-sheet-plane')
  ?? paper
)

/**
 * Apply sheet zoom/pan/rotate without GPU-stretching a 1× bitmap.
 *
 * Chromium rasterizes `transform: scale()` layers at layout size, then stretches
 * them — markdown text becomes unreadable. CSS `zoom` raises the raster scale
 * so fonts stay sharp. Pan/rotate stay on `transform` in pre-zoom units.
 *
 * Zoom is applied to the sheet plane so ruling, ink and type stay one sheet.
 * The text column gets the same specified zoom (CodeMirror often ignores
 * inheritance). Never assign `style.zoom = ''` — that specifies zoom:1 and
 * freezes markdown while the ruling still grows.
 */
export const applyPaperViewToElements = (
  paper: HTMLElement | null,
  noteView: HTMLElement | null,
  view: PaperViewSnapshot,
) => {
  const active = isPaperViewActive(view)
  const zoom = Math.max(0.01, view.zoom)
  const target = resolvePaperViewTarget(paper, noteView)
  if (target) {
    if (zoom === 1) target.style.removeProperty('zoom')
    else target.style.zoom = String(zoom)
    target.style.setProperty('--view-zoom', String(zoom))
    target.style.transform = view.rotation ? `rotate(${view.rotation}deg)` : ''
    target.style.transformOrigin = 'center center'
    // Never promote the sheet to a low-res compositor bitmap.
    target.style.willChange = 'auto'
    target.classList.toggle('is-view-transformed', active)
    target.classList.toggle('is-view-zoomed', zoom !== 1)
  }
  if (paper && paper !== target) {
    clearInlineViewStyle(paper)
    paper.style.setProperty('--view-zoom', String(zoom))
    paper.classList.toggle('is-view-transformed', active)
    paper.classList.toggle('is-view-zoomed', zoom !== 1)
  }
  const sheet = paper ?? target
  sheet?.querySelectorAll<HTMLElement>(SHEET_LAYER_SELECTOR).forEach((element) => {
    element.style.removeProperty('transform')
    element.style.removeProperty('transform-origin')
    element.style.removeProperty('will-change')
    element.style.removeProperty('--view-zoom')
    // CodeMirror can ignore inherited zoom. Pin the same specified value on
    // the text column only — never zoom:'' / 1, that freezes markdown at 1×.
    if (element.matches(TEXT_ZOOM_SELECTOR)) {
      if (zoom === 1) element.style.removeProperty('zoom')
      else element.style.zoom = String(zoom)
    } else {
      element.style.removeProperty('zoom')
    }
  })
  if (noteView) {
    noteView.classList.toggle('is-view-transformed', active)
    noteView.classList.toggle('is-view-zoomed', zoom !== 1)
  }
}

export const clearPaperViewFromElements = (
  paper: HTMLElement | null,
  noteView: HTMLElement | null,
  extra?: HTMLElement | null,
) => {
  const plane = resolvePaperViewTarget(paper, noteView)
  if (plane && plane !== paper) clearInlineViewStyle(plane)
  clearInlineViewStyle(paper)
  paper?.querySelectorAll<HTMLElement>(SHEET_LAYER_SELECTOR).forEach((element) => {
    clearInlineViewStyle(element)
  })
  if (noteView && noteView !== paper && noteView !== plane) {
    noteView.classList.remove('is-view-transformed', 'is-view-zoomed')
  }
  clearInlineViewStyle(extra ?? null)
}

export const zoomAroundPoint = (
  view: PaperViewSnapshot,
  nextZoom: number,
): PaperViewSnapshot => (
  nextZoom === view.zoom ? view : { zoom: nextZoom, rotation: view.rotation, pan: { x: 0, y: 0 } }
)

type PaperAnchor = {
  clientX: number
  clientY: number
  relX: number
  relY: number
}

/** Remember the paper point under the cursor before CSS zoom changes layout. */
export const capturePaperAnchor = (
  scroller: HTMLElement,
  paper: HTMLElement | null,
  origin?: { x: number; y: number },
): PaperAnchor => {
  const scrollerRect = scroller.getBoundingClientRect()
  const clientX = origin?.x ?? scrollerRect.left + scrollerRect.width / 2
  const clientY = origin?.y ?? scrollerRect.top + scrollerRect.height / 2
  const paperRect = paper?.getBoundingClientRect()
  if (!paperRect || paperRect.width < 1 || paperRect.height < 1) {
    return {
      clientX,
      clientY,
      relX: scrollerRect.width > 0 ? (clientX - scrollerRect.left + scroller.scrollLeft) / Math.max(1, scroller.scrollWidth) : 0.5,
      relY: scrollerRect.height > 0 ? (clientY - scrollerRect.top + scroller.scrollTop) / Math.max(1, scroller.scrollHeight) : 0.5,
    }
  }
  return {
    clientX,
    clientY,
    relX: (clientX - paperRect.left) / paperRect.width,
    relY: (clientY - paperRect.top) / paperRect.height,
  }
}

/** After zoom, scroll so the captured paper point is still under the cursor. */
export const restorePaperAnchor = (scroller: HTMLElement, paper: HTMLElement | null, anchor: PaperAnchor) => {
  if (!paper) return
  const next = paper.getBoundingClientRect()
  if (next.width < 1 || next.height < 1) return
  const pointX = next.left + anchor.relX * next.width
  const pointY = next.top + anchor.relY * next.height
  scroller.scrollLeft += pointX - anchor.clientX
  scroller.scrollTop += pointY - anchor.clientY
}

/** Keep the cursor (or viewport centre) on the same paper point after CSS zoom. */
export const scrollViewportToZoomPoint = (
  scroller: HTMLElement,
  previousZoom: number,
  nextZoom: number,
  origin?: { x: number; y: number },
) => {
  if (previousZoom <= 0 || nextZoom <= 0 || previousZoom === nextZoom) return
  const paper = scroller.querySelector<HTMLElement>('.paper-sheet-plane, .unified-paper')
  const anchor = capturePaperAnchor(scroller, paper, origin)
  restorePaperAnchor(scroller, paper, anchor)
}

type SharedViewListener = (view: PaperViewSnapshot) => void
let sharedPaperView = defaultPaperView()
const sharedPaperViewListeners = new Set<SharedViewListener>()

export const readSharedPaperView = () => sharedPaperView

export const writeSharedPaperView = (view: PaperViewSnapshot) => {
  sharedPaperView = view
  sharedPaperViewListeners.forEach((listener) => listener(view))
}

export const subscribeSharedPaperView = (listener: SharedViewListener) => {
  sharedPaperViewListeners.add(listener)
  return () => { sharedPaperViewListeners.delete(listener) }
}
