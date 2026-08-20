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
] as const

export const inkBlockedWorksheetSelectors = [
  '.worksheet-layer.is-disabled .worksheet-page',
  '.worksheet-layer.is-disabled .worksheet-pdf-page canvas',
] as const

export const inkOverlayHitSelector = '.lw-drawing-board.is-inline.is-input-active .lw-canvas-surface'

/** Paper must grow with in-flow PDF/worksheet pages so the overlay covers them. */
export const inkCoveringPaperSelectors = [
  '.unified-paper.is-pdf-note.has-ink-extent',
  '.unified-paper.has-worksheet.has-ink-extent',
] as const

export const pointerEventsForInkLayer = (
  layer: 'pdf-page' | 'pdf-canvas' | 'pdf-text' | 'worksheet-page' | 'overlay',
  inkOn: boolean,
) => {
  if (layer === 'overlay') return inkOn ? 'auto' : 'none'
  return inkOn ? 'none' : 'auto'
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

/** Source height that keeps y×sourceHeight in the same band as y×painted overlay height. */
export const pdfOverlaySourceHeight = (sourceWidth: number, paintedWidth: number, paintedHeight: number) => {
  if (!(sourceWidth > 0) || !(paintedWidth > 1) || !(paintedHeight > 1)) return 0
  return paintedHeight * (sourceWidth / paintedWidth)
}

export const shouldSyncPdfOverlaySource = (sourceHeight: number, overlaySourceHeight: number) => (
  Number.isFinite(sourceHeight)
  && Number.isFinite(overlaySourceHeight)
  && overlaySourceHeight > sourceHeight + 1
)
