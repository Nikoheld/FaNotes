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
    paper.style.zoom = zoom === 1 ? '' : String(zoom)
    const translateX = view.pan.x / zoom
    const translateY = view.pan.y / zoom
    const needsTransform = view.rotation !== 0 || translateX !== 0 || translateY !== 0
    paper.style.transform = needsTransform
      ? `translate(${translateX}px, ${translateY}px) rotate(${view.rotation}deg)`
      : ''
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
  origin: { x: number; y: number },
  originRect: DOMRect,
): PaperViewSnapshot => {
  const previous = view.zoom
  if (nextZoom === previous) return view
  const centerX = originRect.left + originRect.width / 2
  const centerY = originRect.top + originRect.height / 2
  const dx = origin.x - centerX
  const dy = origin.y - centerY
  const factor = nextZoom / previous
  return {
    zoom: nextZoom,
    rotation: view.rotation,
    pan: {
      x: view.pan.x + dx - dx * factor,
      y: view.pan.y + dy - dy * factor,
    },
  }
}
