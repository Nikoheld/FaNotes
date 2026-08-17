export const POST_PEN_IGNORE_MS = 850

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
