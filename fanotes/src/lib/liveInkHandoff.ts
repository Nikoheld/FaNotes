/**
 * The live layer shows the pen stroke until the committed bitmap shows it too.
 * Clearing the live layer first leaves frames where neither layer holds the
 * stroke (or, on a heavy page, where the visible bitmap is stale until the
 * offscreen repaint is swapped in): the whole canvas flickers.
 */
export type LiveInkHandoff = {
  /** The stroke was drawn into the committed bitmap in this same task. */
  committedHasStroke: boolean
  /** A chunked committed repaint (heavy page) is still filling the offscreen page. */
  committedPaintRunning: boolean
}

export const mayWipeLiveInk = (state: LiveInkHandoff) => (
  state.committedHasStroke && !state.committedPaintRunning
)

/**
 * After a redraw with no pen down. Every synchronous repaint leaves a
 * committed bitmap that shows every stroke, so the live copy of a finished
 * stroke may go. A chunked repaint has not swapped its page in yet: the live
 * copy stays (a redraw before the swap must not wipe it, that is the flicker
 * the pen-up guard exists for) and the swap wipes it.
 */
export const mayWipeLiveInkAfterRedraw = (state: { committedPaintRunning: boolean }) => (
  !state.committedPaintRunning
)

/**
 * A finished stroke may be drawn straight into the committed bitmap only when
 * that bitmap is placed, up to date, and not about to be replaced. While a
 * chunked repaint runs, the visible bitmap is the old page (possibly at the
 * old pixel size or slice): the stroke would land at the wrong scale, or be
 * drawn twice with the live copy. The live layer keeps it until the swap, and
 * the repaint paints it into the new page.
 */
export const mayCommitStrokeToBitmap = (state: {
  placed: boolean
  dirty: boolean
  committedPaintRunning: boolean
}) => state.placed && !state.dirty && !state.committedPaintRunning
