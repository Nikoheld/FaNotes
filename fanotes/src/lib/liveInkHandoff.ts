/**
 * The live layer shows the pen stroke until the committed bitmap shows it too.
 * Clearing the live layer first leaves frames where neither layer holds the
 * stroke (or, on a heavy page, where the committed bitmap was cleared and is
 * refilled slice by slice): the whole canvas flickers.
 */
export type LiveInkHandoff = {
  /** The stroke was drawn into the committed bitmap in this same task. */
  committedHasStroke: boolean
  /** A chunked committed repaint (heavy page) is still filling the bitmap. */
  committedPaintRunning: boolean
}

export const mayWipeLiveInk = (state: LiveInkHandoff) => (
  state.committedHasStroke && !state.committedPaintRunning
)
