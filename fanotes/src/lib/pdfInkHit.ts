/** Class on PdfNoteView while the pen overlay is active. */
export const PDF_INKING_CLASS = 'is-inking'
/** Top editor-bar slot for PDF page/zoom/search chrome (not an overlay on the page). */
export const PDF_TOOLBAR_SLOT_ID = 'fanotes-pdf-toolbar-slot'
/** Top editor-bar slot for docked ink tools, including Piktogramme on PDF+Stift. */
export const INK_TOOLBAR_SLOT_ID = 'fanotes-ink-toolbar-slot'

type ToolbarHostNode = { id?: string; isConnected?: boolean }

type ToolbarHostRoot = {
  getElementById?: (id: string) => ToolbarHostNode | null
  querySelector?: (selector: string) => ToolbarHostNode | null
} | null | undefined

/** SafeBoundary title when the overlay throws. A remount must drop this fallback. */
export const INK_OVERLAY_CRASH_TITLE = 'Die Stiftebene ist abgestürzt'

/** Only a document-connected slot may receive the docked ink portal. */
export const liveInkToolbarHost = <T extends { isConnected?: boolean }>(
  host: T | null | undefined,
): T | null => {
  if (!host) return null
  if (host.isConnected === false) return null
  return host
}

/** Docked ink bar host. Pen mode on a PDF note uses this slot, never an empty PDF pager. */
export const resolveInkToolbarHost = <T extends ToolbarHostNode>(root: ToolbarHostRoot) => {
  if (!root) return null
  const host = root.getElementById?.(INK_TOOLBAR_SLOT_ID) ?? root.querySelector?.(`#${INK_TOOLBAR_SLOT_ID}`)
  return liveInkToolbarHost(host as T | null)
}

/**
 * Portal target for docked ink tools. A detached slot (note switch remounts the
 * toolbar-context div) must not be passed to createPortal — that throw is the
 * intermittent “Die Stiftebene ist abgestürzt” fallback.
 */
export const inkToolbarPortalHost = <T extends { isConnected?: boolean }>(
  host: T | null | undefined,
  drawingOpen: boolean,
): T | null => {
  if (!drawingOpen) return null
  return liveInkToolbarHost(host)
}

/** createPortal only into a live host. Detached nodes are skipped, not thrown. */
export const portalInkToolbar = <Node, Host extends { isConnected?: boolean }>(
  createPortal: (node: Node, host: Host) => Node,
  node: Node,
  host: Host | null | undefined,
  drawingOpen: boolean,
): Node | null => {
  const live = inkToolbarPortalHost(host, drawingOpen)
  if (!live) return null
  try {
    return createPortal(node, live)
  } catch {
    return null
  }
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

export type OverlayLifetimeState<T = unknown> = {
  session: { key: number; document: T | null }
  drawingOpen: boolean
  host: ToolbarHostNode | null
}

export type OverlayLifetimeOp<T = unknown> =
  | { type: 'note-switch'; requestId: number }
  | { type: 'ink-loaded'; requestId: number; document: T | null }
  | { type: 'stift'; open: boolean }
  | { type: 'host'; host: ToolbarHostNode | null }

/**
 * Note switch: keep a ready overlay session (never key 0). Stift stays on if it
 * was on. A detached toolbar slot is dropped so createPortal cannot throw.
 */
export const overlayAfterNoteSwitch = <T>(
  previous: OverlayLifetimeState<T>,
  requestId: number,
): OverlayLifetimeState<T> => ({
  session: drawingSessionFromLoad(requestId, null),
  drawingOpen: previous.drawingOpen === true,
  host: liveInkToolbarHost(previous.host),
})

export const applyOverlayLifetimeOp = <T>(
  state: OverlayLifetimeState<T>,
  op: OverlayLifetimeOp<T>,
): OverlayLifetimeState<T> => {
  if (op.type === 'note-switch') return overlayAfterNoteSwitch(state, op.requestId)
  if (op.type === 'ink-loaded') {
    return { ...state, session: drawingSessionFromLoad(op.requestId, op.document) }
  }
  if (op.type === 'stift') return { ...state, drawingOpen: op.open }
  return { ...state, host: liveInkToolbarHost(op.host) }
}

export const overlayShowsCrashFallback = (ui: { fallbackTitle?: string; ready?: boolean }) => (
  ui.fallbackTitle === INK_OVERLAY_CRASH_TITLE && ui.ready !== true
)
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

export const overlayPenHitReady = (sessionKey: number, drawingOpen: boolean) => (
  inkBoardReady(sessionKey) && pointerEventsForInkLayer('overlay', drawingOpen) === 'auto'
)

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

export const inkWindowsDiffer = (left: InkWindow, right: InkWindow) => (
  Math.abs(left.y0 - right.y0) > 0.04 || Math.abs(left.y1 - right.y1) > 0.04
)

/**
 * Whether the current overlay already covers the visible slice.
 * A full overlay covers every paper y, but at 500% that bitmap is budget-capped
 * and stretched — a slice visible range must replace it.
 */
export const visibleFitsInkWindow = (window: InkWindow, visible: InkWindow) => {
  if (isFullInkWindow(visible)) return isFullInkWindow(window)
  if (isFullInkWindow(window)) return false
  const margin = 0.05
  return visible.y0 >= window.y0 + margin && visible.y1 <= window.y1 - margin
}

/** Keep-vs-window decision for scroll and zoom. Zoom must pass force so 100%→500% windows. */
export const resolveInkOverlayWindow = (
  current: InkWindow,
  visible: InkWindow,
  next: InkWindow,
  force = false,
): InkWindow => {
  if (force) return next
  if (visibleFitsInkWindow(current, visible)) return current
  if (!inkWindowsDiffer(current, next)) return current
  return next
}

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
 *
 * `width` must be explicit. A canvas is a replaced element: with `width: auto`
 * and a non-auto `height` the used width is `height × bitmap aspect ratio`
 * and `right` is ignored, so the CSS box followed the backing store instead
 * of the paper. Any moment where the bitmap and the window slice disagreed
 * (grow, window move) stretched the painted ink sideways.
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
    width: paper,
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
  if (visualPaper <= viewHeight * 1.35) return { ...FULL_INK_WINDOW }
  // A4 stays a full overlay at ~100% so the bitmap does not jump while scrolling.
  // At ~500% the visual sheet is far larger than the viewport — window it.
  if (paperHeight < 1_600 && zoom <= 1.4) return { ...FULL_INK_WINDOW }
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
