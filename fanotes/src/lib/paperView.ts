export const VIEW_ZOOM_MIN = 0.45
export const VIEW_ZOOM_MAX = 3.25
export const VIEW_ZOOM_STEP = 0.12
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
  Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, Math.round(value * 100) / 100))
)

export const normalizeRotation = (value: number) => {
  const wrapped = ((value % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

export const isPaperViewActive = (view: PaperViewSnapshot) => (
  view.zoom !== 1 || view.rotation !== 0 || view.pan.x !== 0 || view.pan.y !== 0
)

/**
 * Apply sheet zoom/pan/rotate without GPU-stretching a 1× bitmap.
 *
 * Chromium rasterizes `transform: scale()` layers at layout size, then stretches
 * them — markdown text becomes unreadable. CSS `zoom` raises the raster scale
 * so fonts stay sharp. Pan/rotate stay on `transform` in pre-zoom units.
 */
export const applyPaperViewToElements = (
  paper: HTMLElement | null,
  noteView: HTMLElement | null,
  view: PaperViewSnapshot,
) => {
  const active = isPaperViewActive(view)
  const zoom = Math.max(0.01, view.zoom)
  if (paper) {
    // One zoom for the whole sheet (text, ink, worksheets). CSS zoom keeps
    // markdown sharp; the viewport scrolls instead of a second pan-transform.
    paper.style.zoom = zoom === 1 ? '' : String(zoom)
    paper.style.transform = view.rotation ? `rotate(${view.rotation}deg)` : ''
    paper.style.transformOrigin = 'center center'
    // Never promote the sheet to a low-res compositor bitmap.
    paper.style.willChange = 'auto'
    paper.classList.toggle('is-view-transformed', active)
    paper.classList.toggle('is-view-zoomed', zoom !== 1)
    paper.querySelectorAll<HTMLElement>('.editor-pane, .worksheet-layer, .lw-canvas-surface, .lw-drawing-board').forEach((element) => {
      element.style.transform = ''
      element.style.transformOrigin = ''
      element.style.zoom = ''
      element.style.willChange = ''
    })
  }
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
  const clear = (element: HTMLElement | null) => {
    if (!element) return
    element.style.transform = ''
    element.style.transformOrigin = ''
    element.style.zoom = ''
    element.style.willChange = ''
    element.classList.remove('is-view-transformed', 'is-view-zoomed')
  }
  clear(paper)
  if (paper) {
    paper.querySelectorAll<HTMLElement>('.editor-pane, .worksheet-layer, .lw-canvas-surface, .lw-drawing-board').forEach((element) => {
      element.style.transform = ''
      element.style.transformOrigin = ''
      element.style.zoom = ''
      element.style.willChange = ''
    })
  }
  clear(noteView)
  clear(extra ?? null)
}

export const zoomAroundPoint = (
  view: PaperViewSnapshot,
  nextZoom: number,
): PaperViewSnapshot => (
  nextZoom === view.zoom ? view : { zoom: nextZoom, rotation: view.rotation, pan: { x: 0, y: 0 } }
)

/** Keep the cursor (or viewport centre) on the same paper point after CSS zoom. */
export const scrollViewportToZoomPoint = (
  scroller: HTMLElement,
  previousZoom: number,
  nextZoom: number,
  origin?: { x: number; y: number },
) => {
  if (previousZoom <= 0 || nextZoom <= 0 || previousZoom === nextZoom) return
  const rect = scroller.getBoundingClientRect()
  const pointX = origin?.x ?? rect.left + rect.width / 2
  const pointY = origin?.y ?? rect.top + rect.height / 2
  const contentX = (pointX - rect.left + scroller.scrollLeft) / previousZoom
  const contentY = (pointY - rect.top + scroller.scrollTop) / previousZoom
  scroller.scrollLeft = contentX * nextZoom - (pointX - rect.left)
  scroller.scrollTop = contentY * nextZoom - (pointY - rect.top)
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
