/**
 * Page grow under the pen on a heavy page (DrawingBoard).
 *
 * A grow mid-stroke (an origin pad near the top/left edge, or more room at the
 * bottom/right) remaps every 0–1 point and resizes the committed bitmap. The
 * board used to repaint the whole page in that pointer event, synchronously,
 * because a heavy repaint job may not run while a stroke is live: 150–300 ms on
 * a 1,000-stroke page at 1x, close to 1 s on a slow CPU.
 *
 * The committed bitmap already holds every stroke. A grow only moves and
 * (by rounding) rescales it, so one bitmap copy puts it where the new layout
 * wants it. Rows the old slice did not cover are band-painted from the model.
 * The copy can be off by a fraction of a pixel, so the board marks it as
 * provisional and repaints it exactly after the pen lifts, with the sliced
 * heavy job (no long task).
 */

/** `x' = a·x + b` in the 0–1 page space. */
export type InkAxisMap = { a: number; b: number }

export const IDENTITY_AXIS: InkAxisMap = { a: 1, b: 0 }

/**
 * The affine map a 0–1 remap applies, or null when it is not affine (or not
 * finite) on [0, 1]: then only a repaint is exact enough.
 */
export const inkAxisMapOf = (remap: (value: number) => number): InkAxisMap | null => {
  const at0 = remap(0)
  const at1 = remap(1)
  const atHalf = remap(0.5)
  if (!Number.isFinite(at0) || !Number.isFinite(at1) || !Number.isFinite(atHalf)) return null
  const a = at1 - at0
  if (!(a > 0)) return null
  if (Math.abs(atHalf - (at0 + a / 2)) > 1e-9) return null
  return { a, b: at0 }
}

/** Pixel geometry of a committed bitmap: page width and virtual height in px, slice top. */
export type InkBitmapGeometry = {
  width: number
  height: number
  virtualHeight: number
  topPx: number
}

export type HeldInkRemapPlan = {
  /** Copy without scaling at whole-pixel offsets (the usual case: same density). */
  unit: boolean
  scaleX: number
  scaleY: number
  dx: number
  dy: number
  /** Rows of the new bitmap the copied picture does not cover; paint them from the model. */
  bands: { y: number; height: number }[]
}

/**
 * Where the held bitmap goes in the grown page. Old pixel x is `x·from.width`,
 * old row y is `y·from.virtualHeight − from.topPx`; the grow maps 0–1 x and y
 * by `mapX`/`mapY`. Null when the copy would not be a fair stand-in (bad
 * sizes, a shrink, or a slice that left most of the new one uncovered).
 */
export const planHeldInkRemap = (
  from: InkBitmapGeometry,
  to: InkBitmapGeometry,
  mapX: InkAxisMap,
  mapY: InkAxisMap,
): HeldInkRemapPlan | null => {
  const sizes = [from.width, from.height, from.virtualHeight, to.width, to.height, to.virtualHeight]
  if (sizes.some((value) => !(value >= 1) || !Number.isFinite(value))) return null
  if (!Number.isFinite(from.topPx) || !Number.isFinite(to.topPx)) return null
  let scaleX = mapX.a * to.width / from.width
  let scaleY = mapY.a * to.virtualHeight / from.virtualHeight
  let dx = mapX.b * to.width
  let dy = (from.topPx / from.virtualHeight) * mapY.a * to.virtualHeight + mapY.b * to.virtualHeight - to.topPx
  if (![scaleX, scaleY, dx, dy].every(Number.isFinite)) return null
  // A grow never shrinks the ink; a large scale means the density changed and
  // a stretched copy would look wrong for the rest of the stroke.
  if (scaleX < 0.9 || scaleX > 1.1 || scaleY < 0.9 || scaleY > 1.1) return null
  const unit = Math.abs(scaleX - 1) * from.width < 0.5 && Math.abs(scaleY - 1) * from.height < 0.5
  if (unit) {
    scaleX = 1
    scaleY = 1
    dx = Math.round(dx)
    dy = Math.round(dy)
  }
  const top = unit ? dy : Math.floor(dy)
  const bottom = unit ? dy + from.height : Math.ceil(dy + from.height * scaleY)
  const covered = Math.max(0, Math.min(to.height, bottom) - Math.max(0, top))
  if (covered < to.height / 2) return null
  const bands: { y: number; height: number }[] = []
  // Edge rows of a scaled copy are partly blended with transparency: repaint them.
  const pad = unit ? 0 : 1
  if (top + pad > 0) bands.push({ y: 0, height: Math.min(to.height, top + pad) })
  if (bottom - pad < to.height) {
    const y = Math.max(0, bottom - pad)
    bands.push({ y, height: to.height - y })
  }
  return { unit, scaleX, scaleY, dx, dy, bands }
}

/** Mirrors `STAY_PUT_PAD_EPSILON` in crates/fanotes-paper. */
const STAY_PUT_PAD_EPSILON = 1e-6

/**
 * `keepMarkOnPage` (crates/fanotes-paper `keep_mark_on_page`) with the extents
 * bound once, for remapping every point of a page: a mark `v` becomes
 * `(v · prev + pad) / next` (non-finite values stay). The same f64 operations
 * in the same order as the Rust, so each result is bit-identical to the wasm
 * call (check-ink-grow-remap compares them). Null when the remap leaves every
 * value alone. A page grow on a 1,000-stroke page made about 80k wasm calls
 * inside the pointer event.
 */
export const keepMarkOnPageAxis = (prevExtent: number, nextExtent: number, minPad = 0): { prev: number; next: number; pad: number } | null => {
  if (!(prevExtent > 0) || !(nextExtent > 0)) return null
  const pad = Math.max(0, Number.isFinite(minPad) ? minPad : 0)
  if (Math.abs(nextExtent - prevExtent) < STAY_PUT_PAD_EPSILON && pad === 0) return null
  return { prev: prevExtent, next: nextExtent, pad }
}
