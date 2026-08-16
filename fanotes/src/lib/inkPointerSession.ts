/** Longer than shape-dwell (~700ms) so a still tip does not look like a missed lift. */
export const INK_POINTER_IDLE_MS = 1600

export type InkPointerSessionSnapshot = {
  pointerId: number
  pointerType: string
  lastButtons: number
  lastPressure: number
  lastContactAt: number
}

export type InkPointerSample = {
  pointerId: number
  pointerType?: string
  buttons: number
  pressure?: number
}

/** Tip or eraser still in contact. Hover (including Linux Wacom hover with a stuck button bit) is not. */
export const isInkTipDown = (sample: { pointerType?: string; buttons: number; pressure?: number }) => {
  const buttons = Number(sample.buttons) || 0
  if ((buttons & 32) !== 0) return true
  if ((buttons & 1) === 0) return false
  if ((sample.pointerType ?? '') === 'pen') {
    const pressure = sample.pressure
    if (typeof pressure === 'number' && pressure <= 0) return false
  }
  return true
}

export const inkPointerSessionFromSample = (
  sample: InkPointerSample,
  at: number,
): InkPointerSessionSnapshot => ({
  pointerId: sample.pointerId,
  pointerType: sample.pointerType || 'mouse',
  lastButtons: Number(sample.buttons) || 0,
  lastPressure: typeof sample.pressure === 'number' ? sample.pressure : 0.5,
  lastContactAt: at,
})

export const touchInkPointerSession = (
  session: InkPointerSessionSnapshot,
  sample: InkPointerSample,
  at: number,
): InkPointerSessionSnapshot => (
  sample.pointerId !== session.pointerId
    ? session
    : {
      ...session,
      lastButtons: Number(sample.buttons) || 0,
      lastPressure: typeof sample.pressure === 'number' ? sample.pressure : session.lastPressure,
      lastContactAt: isInkTipDown({
        pointerType: sample.pointerType ?? session.pointerType,
        buttons: sample.buttons,
        pressure: sample.pressure,
      })
        ? at
        : session.lastContactAt,
    }
)

/** True lift: no tip or eraser button. Hover with a stuck button bit is not a tip-up. */
export const isInkTipUp = (sample: { buttons: number }) => {
  const buttons = Number(sample.buttons) || 0
  if ((buttons & 32) !== 0) return false
  return (buttons & 1) === 0
}

/**
 * Whether a live ink session must be hard-ended.
 * True tip-up (`buttons === 0`) ends immediately.
 * Silence after last real contact ends a missed Linux `pointerup`.
 * A same-pointer sample that is still writing — including Linux Wacom
 * `buttons === 1` with a transient `pressure === 0` — does not end.
 * Hover with a stuck button bit ends only after the idle window since
 * last real contact, so scroll/clicks recover without cutting a live stroke.
 */
export const shouldHardEndInkPointerSession = (
  session: InkPointerSessionSnapshot | null,
  now: number,
  incoming?: InkPointerSample | null,
): boolean => {
  if (!session) return false
  if (incoming && incoming.pointerId === session.pointerId) {
    if (isInkTipUp(incoming)) return true
    if (isInkTipDown({
      pointerType: incoming.pointerType ?? session.pointerType,
      buttons: incoming.buttons,
      pressure: incoming.pressure,
    })) return false
    return now - session.lastContactAt >= INK_POINTER_IDLE_MS
  }
  return now - session.lastContactAt >= INK_POINTER_IDLE_MS
}

/**
 * A finish event may append a last sample only when it carries a real contact
 * position. Synthetic recoveries (`pointercancel`, missing coords) must keep
 * the last ink point — never a canvas-center fake.
 */
export const resolveInkFinishSample = (
  event: { type?: string; clientX?: number; clientY?: number } | null | undefined,
): { clientX: number; clientY: number } | null => {
  if (!event) return null
  if (event.type === 'pointercancel' || event.type === 'lostpointercapture') return null
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null
  return { clientX: event.clientX as number, clientY: event.clientY as number }
}

/** After a missed pen-up, a different pointer (trackpad/mouse) may start ink. */
export const shouldAllowNewInkPointer = (
  session: InkPointerSessionSnapshot | null,
  incoming: { pointerId: number; pointerType?: string },
  now: number,
): boolean => {
  if (!session) return true
  if (session.pointerId === incoming.pointerId) return false
  if (shouldHardEndInkPointerSession(session, now)) return true
  // Do not keep blocking mouse/trackpad solely because the Wacom id was never cleared.
  // Touch stays rejected while the pen session is live (palm).
  return session.pointerType === 'pen' && incoming.pointerType === 'mouse'
}
