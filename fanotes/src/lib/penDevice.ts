/**
 * Pen device profiles beyond Wacom: Windows Ink / Microsoft Pen Protocol
 * (Surface, Dell, HP, Lenovo), USI, N-trig, Goodix/Elan/Synaptics digitizers
 * and libinput tablet tools. Some of them report no pressure, no tilt, a
 * `mouse` pointer type, or an eraser as button 5 only. These helpers keep one
 * rule set for all of them.
 */

/** Pointer Events value for a pen that reports no pressure (spec: 0.5 while a button is down). */
export const PEN_FALLBACK_PRESSURE = 0.5
export const MOUSE_FALLBACK_PRESSURE = 0.55
/** A touch is a palm when it lands this soon after the pen was last seen hovering or touching. */
export const PEN_NEAR_PALM_MS = 450

export type PenEventLike = {
  pointerType?: string
  pressure?: number
  buttons?: number
  button?: number
  tiltX?: number
  tiltY?: number
  twist?: number
}

/**
 * Pressure for a stroke point. A real reading is kept; 0 or a missing value
 * (device without pressure, or a transient 0 while the tip is down) becomes a
 * constant so the line keeps a sensible width instead of vanishing.
 */
export const effectivePressure = (event: PenEventLike) => {
  const pressure = Number(event.pressure)
  if (Number.isFinite(pressure) && pressure > 0) return Math.min(1, pressure)
  return event.pointerType === 'mouse' ? MOUSE_FALLBACK_PRESSURE : PEN_FALLBACK_PRESSURE
}

/**
 * Some Windows/X11 drivers label a stylus `mouse`. A real mouse always reports
 * pressure 0.5 while a button is down and never tilts, so a `mouse` contact
 * with another pressure, tilt or twist is a pen. A pen without any of that
 * cannot be told apart from a mouse; the pen-only setting covers it.
 */
export const looksLikePenReportedAsMouse = (event: PenEventLike) => {
  if (event.pointerType !== 'mouse') return false
  const buttons = Number(event.buttons) || 0
  if ((buttons & 33) === 0) return false
  const pressure = Number(event.pressure)
  const variablePressure = Number.isFinite(pressure) && pressure > 0 && pressure !== 0.5
  return variablePressure
    || (Number(event.tiltX) || 0) !== 0
    || (Number(event.tiltY) || 0) !== 0
    || (Number(event.twist) || 0) !== 0
}

/** The pointer type the ink tools should act on. */
export const effectivePointerType = (event: PenEventLike) => (
  looksLikePenReportedAsMouse(event) ? 'pen' : event.pointerType || 'mouse'
)

/** Eraser end of the pen: button 5 on contact, or buttons bit 32. */
export const isPenEraserEnd = (event: PenEventLike) => (
  event.button === 5 || ((Number(event.buttons) || 0) & 32) !== 0
)

/**
 * A pen that reported pressure 0 on contact has no pressure sensor (or its
 * driver omits it). While it stays that way, pressure 0 with the tip bit set is
 * still ink, not hover.
 */
export const isPressurelessContact = (event: PenEventLike) => (
  event.pointerType === 'pen'
  && ((Number(event.buttons) || 0) & 1) !== 0
  && !(Number(event.pressure) > 0)
)

export const isPenNearPalmWindow = (lastPenNearAt: number, now: number) => (
  Number.isFinite(lastPenNearAt) && lastPenNearAt > 0 && now - lastPenNearAt < PEN_NEAR_PALM_MS
)
