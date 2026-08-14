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

export const paperViewTransform = (view: PaperViewSnapshot) => (
  `translate(${view.pan.x}px, ${view.pan.y}px) rotate(${view.rotation}deg) scale(${view.zoom})`
)

export const applyPaperViewToElements = (
  paper: HTMLElement | null,
  noteView: HTMLElement | null,
  view: PaperViewSnapshot,
) => {
  const active = isPaperViewActive(view)
  const transform = paperViewTransform(view)
  if (paper) {
    paper.style.transform = active ? transform : ''
    paper.style.transformOrigin = 'center center'
    paper.classList.toggle('is-view-transformed', active)
  }
  if (noteView) noteView.classList.toggle('is-view-transformed', active)
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
