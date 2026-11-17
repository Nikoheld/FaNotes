/**
 * Wacom quick menu: hold the pen button mapped to "Schwenken" and press the
 * tip. The pan button alone keeps panning; only the added tip contact opens
 * the radial colour / tool menu at the pen.
 */

/** Pointer Events `buttons` bit for the pen tip (same as the primary button). */
export const PEN_TIP_MASK = 1

/** A pen-button pan whose pointer was quiet this long no longer chords with a new tip pointer. */
export const QUICK_MENU_CROSS_POINTER_MS = 4000

export type QuickMenuPanState = {
  pointerId: number
  /** The pan was started by a mapped stylus button (not a finger). */
  stylusButton: boolean
  /** Whether the tip bit was set on the last event of this pan. */
  tipDown: boolean
  /** The menu opened from this pan; the rest of the gesture neither pans nor inks. */
  menu: boolean
  lastAt: number
}

export type ButtonsLike = { buttons?: number }

export const pointerTipDown = (event: ButtonsLike) => ((Number(event.buttons) || 0) & PEN_TIP_MASK) !== 0

/**
 * A move of the panning pointer. Returns true when the tip was just pressed
 * while the pan button is held: that is the quick-menu chord. Updates
 * `tipDown` so a tip that was already down when the pan started does not count.
 */
export const quickMenuChordOnMove = (
  pan: QuickMenuPanState,
  pointerId: number,
  buttons: number | undefined,
  now: number,
) => {
  if (pan.pointerId !== pointerId) return false
  pan.lastAt = now
  if (!pan.stylusButton || pan.menu || buttons === undefined) return false
  const tip = (buttons & PEN_TIP_MASK) !== 0
  const chord = tip && !pan.tipDown
  pan.tipDown = tip
  return chord
}

/**
 * A new pointerdown while a pen-button pan is live. Some drivers send the tip
 * as its own pen pointer (the button came in as a mouse-labelled pointer).
 */
export const quickMenuChordOnDown = (
  pan: QuickMenuPanState | null,
  event: { pointerId: number; pointerType?: string; button?: number; buttons?: number },
  now: number,
) => {
  if (!pan || !pan.stylusButton || pan.menu) return false
  if (event.pointerType !== 'pen') return false
  const tip = pointerTipDown(event) || event.button === 0
  if (!tip) return false
  if (pan.pointerId === event.pointerId) return !pan.tipDown
  return now - pan.lastAt < QUICK_MENU_CROSS_POINTER_MS
}

export const QUICK_MENU_TOOL_RADIUS = 52
export const QUICK_MENU_COLOR_RADIUS = 100
export const QUICK_MENU_ITEM_SIZE = 40
/** Outer edge of the menu from its centre, including the colour swatches. */
export const QUICK_MENU_EXTENT = QUICK_MENU_COLOR_RADIUS + QUICK_MENU_ITEM_SIZE / 2 + 8

/** Positions on a ring, starting at 12 o'clock and going clockwise. */
export const ringPositions = (count: number, radius: number, offset = 0) => (
  Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + ((index + offset) / Math.max(1, count)) * Math.PI * 2
    return {
      x: Math.round(Math.cos(angle) * radius * 10) / 10,
      y: Math.round(Math.sin(angle) * radius * 10) / 10,
    }
  })
)

/** Keeps the whole radial menu inside the viewport. */
export const clampQuickMenuCenter = (
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  extent = QUICK_MENU_EXTENT,
) => {
  const clamp = (value: number, size: number) => (
    size <= extent * 2 ? size / 2 : Math.min(Math.max(value, extent), size - extent)
  )
  return { x: clamp(x, viewportWidth), y: clamp(y, viewportHeight) }
}
