/** Class on PdfNoteView while the pen overlay is active. */
export const PDF_INKING_CLASS = 'is-inking'
/** Top editor-bar slot for PDF page/zoom/search chrome (not an overlay on the page). */
export const PDF_TOOLBAR_SLOT_ID = 'fanotes-pdf-toolbar-slot'
/** Class on WorksheetLayer while the pen overlay is active. */
export const WORKSHEET_INKING_CLASS = 'is-disabled'
/** Class on the inline drawing board when it is the hit target. */
export const INLINE_INK_ACTIVE_CLASS = 'is-input-active'

/** These layers must not receive the pen; the ink overlay maps the sample. */
export const inkBlockedPdfSelectors = [
  '.pdf-note-view.is-inking',
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

/** Live overlay must cover Blatt + dark stage. A 0×0 Blatt overlay paints no line. */
export { inkOverlayCoversStage as markdownNoteInkOverlaySize } from './paperCanvas'

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
