/** Class on PdfNoteView while the pen overlay is active. */
export const PDF_INKING_CLASS = 'is-inking'
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
