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

/** Distance from the menu origin below which no option is chosen (movement there cancels). */
export const QUICK_MENU_DEAD_ZONE = 22
/** Beyond this distance the direction picks from the colour ring instead of the tool ring. */
export const QUICK_MENU_RING_SPLIT = (QUICK_MENU_TOOL_RADIUS + QUICK_MENU_COLOR_RADIUS) / 2

/**
 * Marking-menu selection: the option is chosen by the direction of the move
 * from the menu origin, so the pen never has to reach the option itself.
 * Past the dead zone the nearest sector wins; the inner distance band picks a
 * tool, the outer band a colour. Returns `tool:<index>` / `color:<index>` or null.
 */
export const quickMenuSelectByDirection = (
  dx: number,
  dy: number,
  toolCount: number,
  colorCount: number,
  deadZone = QUICK_MENU_DEAD_ZONE,
): { ring: 'tool' | 'color'; index: number } | null => {
  const dist = Math.hypot(dx, dy)
  if (!(dist > deadZone)) return null
  const useColor = colorCount > 0 && (toolCount === 0 || dist > QUICK_MENU_RING_SPLIT)
  const count = useColor ? colorCount : toolCount
  if (count <= 0) return null
  const offset = useColor ? 0.5 : 0
  // Angle clockwise from 12 o'clock, matching ringPositions.
  let turn = Math.atan2(dy, dx) + Math.PI / 2
  turn = ((turn % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const index = Math.round(turn / (Math.PI * 2) * count - offset)
  return { ring: useColor ? 'color' : 'tool', index: ((index % count) + count) % count }
}
