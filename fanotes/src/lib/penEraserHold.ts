import { tabletButtonAction, type TabletButtonId } from './tabletButtons'

/**
 * Held pen buttons that can latch the eraser. `bit` is the `buttons` mask bit,
 * `button` the `button` index a press/release of that control reports.
 */
const HOLDABLE_PEN_BUTTONS: ReadonlyArray<{ id: TabletButtonId; bit: number; button: number }> = [
  { id: 'pen-barrel', bit: 2, button: 2 },
  { id: 'pen-upper', bit: 4, button: 1 },
  { id: 'pen-eraser', bit: 32, button: 5 },
]

/** A pen whose eraser-mapped button is held while it is over the sheet. */
export type PenEraserHold = { pointerId: number; mask: number }

export type PenEraserHoldSample = {
  pointerId: number
  pointerType?: string
  button?: number
  buttons?: number
}

/** `buttons` bits of held pen controls that are assigned to the eraser. */
export const penEraserButtonMask = (assignments: unknown, buttons: number | undefined) => {
  const mask = Number(buttons) || 0
  let held = 0
  for (const control of HOLDABLE_PEN_BUTTONS) {
    if ((mask & control.bit) !== 0 && tabletButtonAction(assignments, control.id) === 'eraser') held |= control.bit
  }
  return held
}

const releasedBit = (button: number | undefined) => (
  HOLDABLE_PEN_BUTTONS.find((control) => control.button === button)?.bit ?? 0
)

/**
 * Next held-eraser state after a pen Pointer Event.
 *
 * Chromium sends no new `pointerdown` while a pen button stays pressed: a tip
 * lift is a `pointermove` with `buttons === 2`, touching down again another
 * `pointermove` with `buttons === 3`. The latch keeps the eraser through those
 * samples and through hover moves. It ends only when the button is released
 * (`buttons === 0`, or a chorded release that names the button), the pointer
 * is cancelled, or the pen is no longer over the sheet (`overSheet === false`).
 * A contact sample that merely drops the bit (Linux Wacom) keeps the latch.
 */
export const nextPenEraserHold = (
  hold: PenEraserHold | null,
  sample: PenEraserHoldSample,
  assignments: unknown,
  overSheet: boolean,
): PenEraserHold | null => {
  if (sample.pointerType !== 'pen') return hold
  if (!overSheet) return null
  const mask = penEraserButtonMask(assignments, sample.buttons)
  if (mask) return { pointerId: sample.pointerId, mask }
  if (!hold || hold.pointerId !== sample.pointerId) return null
  const buttons = Number(sample.buttons) || 0
  if (buttons === 0) return null
  if ((releasedBit(sample.button) & hold.mask) !== 0) return null
  return hold
}

export const penEraserHeldFor = (hold: PenEraserHold | null, pointerId: number) => (
  hold !== null && hold.pointerId === pointerId
)
