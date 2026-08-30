export const POST_PEN_IGNORE_MS = 850

/** Windows tablets treat a resting palm as touch/mouse. Pen-only is the factory default there. */
export const defaultPenOnlyForPlatform = (platform: string | undefined) => String(platform ?? '') === 'win32'

export const shouldRejectNonPenInk = (pointerType: string | undefined, penOnly: boolean) => (
  Boolean(penOnly) && pointerType !== 'pen'
)

export type InkInputSession = {
  activePointerId: number | null
  captureId: number | null
  lastContactAt: number
}

export const emptyInkInputSession = (): InkInputSession => ({
  activePointerId: null,
  captureId: null,
  lastContactAt: 0,
})

export const shouldIgnorePointerAfterPen = (
  pointerType: string | undefined,
  lastPenAt: number,
  now: number,
) => {
  if (pointerType === 'pen') return false
  if (!Number.isFinite(lastPenAt) || lastPenAt <= 0) return false
  return now - lastPenAt < POST_PEN_IGNORE_MS
}

/** A mapped stylus/pad button is not leftover trackpad in the post-pen window. */
export const shouldIgnoreUnmappedPointerAfterPen = (
  pointerType: string | undefined,
  lastPenAt: number,
  now: number,
  mappedControl: boolean,
) => mappedControl ? false : shouldIgnorePointerAfterPen(pointerType, lastPenAt, now)

/** Live mapped ink/eraser (often labelled `mouse`) must still receive moves. */
export const shouldRejectNonPenInkMove = (
  pointerType: string | undefined,
  penOnly: boolean,
  isLiveStrokePointer: boolean,
) => isLiveStrokePointer ? false : shouldRejectNonPenInk(pointerType, penOnly)

export const applyWheelInkPolicy = (
  session: InkInputSession,
  wheel: { ctrlKey?: boolean; metaKey?: boolean },
) => {
  const pinch = Boolean(wheel.ctrlKey || wheel.metaKey)
  return {
    session: emptyInkInputSession(),
    preventDefault: pinch,
    allowPan: !pinch,
    pinch,
    previous: session,
  }
}

export const applyPenUpInkCleanup = (session: InkInputSession) => ({
  session: emptyInkInputSession(),
  releaseCapture: session.captureId !== null || session.activePointerId !== null,
  blurCanvas: true,
  previous: session,
})

export const keepGotPointerCaptureId = (
  eventPointerId: number,
  liveStrokePointerId: number | null,
) => liveStrokePointerId !== null && eventPointerId === liveStrokePointerId
