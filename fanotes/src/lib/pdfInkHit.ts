/** Class on PdfNoteView while the pen overlay is active. */
export const PDF_INKING_CLASS = 'is-inking'
/** Top editor-bar slot for PDF page/zoom/search chrome (not an overlay on the page). */
export const PDF_TOOLBAR_SLOT_ID = 'fanotes-pdf-toolbar-slot'
/** Top editor-bar slot for docked ink tools, including Piktogramme on PDF+Stift. */
export const INK_TOOLBAR_SLOT_ID = 'fanotes-ink-toolbar-slot'

type ToolbarHostRoot = {
  getElementById?: (id: string) => { id?: string } | null
  querySelector?: (selector: string) => { id?: string } | null
} | null | undefined

/** Docked ink bar host. Pen mode on a PDF note uses this slot, never an empty PDF pager. */
export const resolveInkToolbarHost = <T extends { id?: string }>(root: ToolbarHostRoot) => {
  if (!root) return null
  const host = root.getElementById?.(INK_TOOLBAR_SLOT_ID) ?? root.querySelector?.(`#${INK_TOOLBAR_SLOT_ID}`)
  return host as T | null
}

/** Pen mode always docks ink tools. PDF pager/search chrome is Keyboard-only. */
export const penModeToolbarSlot = (drawingOpen: boolean, isPdfNote: boolean) => (
  drawingOpen ? 'ink' : isPdfNote ? 'pdf' : 'markdown'
)

/** Overlay + docked bar exist once a session key is assigned, even with no saved ink. */
export const inkBoardReady = (sessionKey: number) => Number.isFinite(sessionKey) && sessionKey > 0

/**
 * Missing/empty drawings still get a live overlay. Treating “no document” as
 * key 0 left PDF+Stift on a loading spinner with no hit target and no symbols bar.
 */
export const drawingSessionFromLoad = <T>(requestId: number, document: T | null) => ({
  key: Math.max(1, requestId),
  document,
})
/** Class on WorksheetLayer while the pen overlay is active. */
export const WORKSHEET_INKING_CLASS = 'is-disabled'
/** Class on the inline drawing board when it is the hit target. */
export const INLINE_INK_ACTIVE_CLASS = 'is-input-active'

/** These layers must not receive the pen; the ink overlay maps the sample. */
export const inkBlockedPdfSelectors = [
  '.pdf-note-view.is-inking',
  '.pdf-note-view.is-inking *',
  '.pdf-note-view.is-inking .pdf-note-page',
  '.pdf-note-view.is-inking .pdf-note-page canvas',
  '.pdf-note-view.is-inking .pdf-note-text-layer',
  '.pdf-note-view.is-inking .pdf-note-text-layer :is(span, br)',
] as const

export const inkBlockedWorksheetSelectors = [
  '.worksheet-layer.is-disabled .worksheet-page',
  '.worksheet-layer.is-disabled .worksheet-pdf-page canvas',
  '.worksheet-layer.is-disabled .worksheet-onenote-frame',
] as const

export const inkBlockedMarkdownSelectors = [
  '.unified-note-view.is-inking .editor-pane',
  '.unified-note-view.is-inking .editor-pane *',
  '.unified-note-view.is-inking .markdown-editor',
  '.unified-note-view.is-inking .markdown-editor .cm-editor',
  '.unified-note-view.is-inking .markdown-editor .cm-scroller',
  '.unified-note-view.is-inking .markdown-editor .cm-gutters',
  '.unified-note-view.is-inking .markdown-editor .cm-content',
  '.unified-note-view.is-inking .markdown-editor .cm-line',
] as const

/** Windows pen still starts a selection when user-select:text remains on glyphs. */
export const inkUserSelectNoneSelectors = [
  '.pdf-note-view.is-inking .pdf-note-text-layer',
  '.pdf-note-view.is-inking .pdf-note-text-layer :is(span, br)',
  ...inkBlockedMarkdownSelectors,
  '.worksheet-layer.is-disabled .worksheet-page',
  '.worksheet-layer.is-disabled .worksheet-onenote-frame',
] as const

export const inkOverlayHitSelector = '.lw-drawing-board.is-inline.is-input-active .lw-canvas-surface'

/** Live overlay must cover the write page (and extra paper). A 0×0 overlay still hits paper. */
export { inkOverlaySize as markdownNoteInkOverlaySize } from './noteCanvas'

/** Paper must grow with in-flow PDF/worksheet pages so the overlay covers them. */
export const inkCoveringPaperSelectors = [
  '.unified-paper.is-pdf-note.has-ink-extent',
  '.unified-paper.has-worksheet.has-ink-extent',
] as const

export const pointerEventsForInkLayer = (
  layer: 'pdf-page' | 'pdf-canvas' | 'pdf-text' | 'markdown' | 'worksheet-page' | 'overlay',
  inkOn: boolean,
) => {
  if (layer === 'overlay') return inkOn ? 'auto' : 'none'
  return inkOn ? 'none' : 'auto'
}

/** Text selection is Keyboard / Tastatur only. Stift must not start a glyph selection. */
export const userSelectForInkLayer = (
  layer: 'pdf-text' | 'markdown' | 'worksheet-page' | 'overlay',
  inkOn: boolean,
): 'none' | 'text' => {
  if (layer === 'overlay') return 'none'
  return inkOn ? 'none' : 'text'
}

export type PdfPageBox = { top: number; height: number }

export type PdfOverlayBox = { left: number; top: number; width: number; height: number }

export type InkWindow = { y0: number; y1: number }

export const FULL_INK_WINDOW: InkWindow = { y0: 0, y1: 1 }

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export const isFullInkWindow = (window: InkWindow) => window.y0 <= 0.002 && window.y1 >= 0.998

export const inkWindowSpan = (window: InkWindow) => Math.max(0.06, Math.min(1, window.y1 - window.y0))

/** CSS pad that pins the painted bitmap to the paper inside the extra-room overlay. */
export const INK_WINDOW_PAD_CSS = 'var(--paper-scroll-room, 0px)'

export type InkBoardSize = { width: number; height: number }

/**
 * Layout box of the painted ink canvas on the overlay board.
 * The board covers extra room; 0–1 ink is the paper. Canvas pad must equal
 * that extra room so `board − 2·pad === paper`.
 */
export const inkWindowCanvasBox = (
  window: InkWindow,
  board: InkBoardSize,
  pad: number,
) => {
  const safePad = Number.isFinite(pad) && pad >= 0 ? pad : 0
  const paperWidth = Math.max(1, board.width - 2 * safePad)
  const paperHeight = Math.max(1, board.height - 2 * safePad)
  const full = isFullInkWindow(window)
  const span = inkWindowSpan(window)
  const top = full ? safePad : safePad + window.y0 * paperHeight
  const height = full ? paperHeight : span * paperHeight
  return {
    left: safePad,
    right: safePad,
    top,
    height,
    width: paperWidth,
    paperWidth,
    paperHeight,
  }
}

/**
 * CSS box matching inkWindowCanvasBox. Inline `top/height: 0%/100%` would
 * override `.lw-tablet-canvas { inset: var(--paper-scroll-room) }` and paint
 * 0–1 ink onto the extra-room board (marks agree only at y=0.5).
 */
export const inkWindowLayoutStyle = (window: InkWindow) => {
  const pad = INK_WINDOW_PAD_CSS
  const paper = `calc(100% - 2 * ${pad})`
  const full = isFullInkWindow(window)
  const span = inkWindowSpan(window)
  return {
    top: full ? pad : `calc(${pad} + ${window.y0} * ${paper})`,
    height: full ? paper : `calc(${span} * ${paper})`,
    left: pad,
    right: pad,
    width: 'auto',
    bottom: 'auto',
  } as const
}

/** Paper 0–1 of a mark after the window canvas is placed with inkWindowCanvasBox. */
export const inkMarkPaperY = (
  markY: number,
  window: InkWindow,
  board: InkBoardSize,
  pad: number,
) => {
  const box = inkWindowCanvasBox(window, board, pad)
  const span = inkWindowSpan(window)
  const visual = box.top + ((markY - window.y0) / span) * box.height
  return (visual - pad) / box.paperHeight
}

/**
 * Visible ink slice from layout scroll, not getBoundingClientRect.
 * Visual rects lag compositor fling, so a window sized from them moves the
 * ink canvas on the paper — marks jump, erase misses, then they snap back.
 */
export const layoutInkWindow = (input: {
  paperHeight: number
  viewHeight: number
  scrollTop: number
  viewZoom?: number
  padRatio?: number
}): InkWindow => {
  const paperHeight = Math.max(1, Number(input.paperHeight) || 1)
  const viewHeight = Math.max(1, Number(input.viewHeight) || 1)
  const zoom = Math.max(0.01, Number(input.viewZoom) || 1)
  const visualPaper = paperHeight * zoom
  if (paperHeight < 1_600 || visualPaper <= viewHeight * 1.35) return { ...FULL_INK_WINDOW }
  const padRatio = Number.isFinite(input.padRatio) ? Number(input.padRatio) : 1.6
  const pad = Math.min(0.45, (viewHeight * Math.max(0, padRatio)) / visualPaper)
  const scrollTop = Math.max(0, Number(input.scrollTop) || 0)
  const y0 = clamp01(scrollTop / visualPaper - pad)
  const y1 = clamp01((scrollTop + viewHeight) / visualPaper + pad)
  if (y1 - y0 >= 0.94) return { ...FULL_INK_WINDOW }
  return { y0, y1 }
}

/** Same paper point after overlay and page boxes translate together (native pan). */
export const pdfOverlayShiftedBy = (
  overlay: PdfOverlayBox,
  pages: readonly PdfPageBox[],
  dx: number,
  dy: number,
) => ({
  overlay: { ...overlay, left: overlay.left + dx, top: overlay.top + dy },
  pages: pages.map((page) => ({ ...page, top: page.top + dy })),
})

/** Overlay 0–1 from a client sample. Page bands come from stacked PDF boxes, not an A4 card. */
export const pdfOverlayPointFromClient = (
  clientX: number,
  clientY: number,
  overlay: PdfOverlayBox,
  pages: readonly PdfPageBox[] = [],
) => {
  if (!(overlay.width > 0) || !(overlay.height > 0)) return null
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null
  const x = (clientX - overlay.left) / overlay.width
  const y = (clientY - overlay.top) / overlay.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  let page = 0
  for (let index = 0; index < pages.length; index += 1) {
    const box = pages[index]
    if (!(box.height > 0)) continue
    if (clientY >= box.top && clientY < box.top + box.height) {
      page = index + 1
      break
    }
  }
  if (!page && pages.length) {
    page = clientY < pages[0].top ? 1 : pages.length
  }
  return { x, y, page }
}

/**
 * Source height that keeps overlay y in the same page band as painted height.
 * Scale by the A4/write column, not the one-canvas plane width. Using the plane
 * width shrank a two-page PDF below A4, so y=0.75 × sourceHeight sat on page 1
 * and converted text spawned on the other Blatt.
 */
export const pdfOverlaySourceHeight = (sourceWidth: number, paintedWidth: number, paintedHeight: number) => {
  if (!(sourceWidth > 0) || !(paintedHeight > 1)) return 0
  const column = Math.min(Math.max(1, paintedWidth), sourceWidth)
  return paintedHeight * (sourceWidth / column)
}

export const shouldSyncPdfOverlaySource = (sourceHeight: number, overlaySourceHeight: number) => (
  Number.isFinite(sourceHeight)
  && Number.isFinite(overlaySourceHeight)
  && overlaySourceHeight > sourceHeight + 1
)
