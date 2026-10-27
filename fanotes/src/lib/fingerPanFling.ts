/**
 * One-finger pan in pen mode follows the hand directly. Keyboard mode scrolls
 * the same sheet with the browser, which keeps moving after the finger lifts.
 * These helpers are that coast: speed from the last moments of the drag, then
 * an exponential slowdown. A finger that has already stopped does not fling.
 */

export const FINGER_PAN_VELOCITY_WINDOW_MS = 100
export const FINGER_PAN_MIN_FLING_SPEED = 0.08
export const FINGER_PAN_MAX_FLING_SPEED = 3.2
/** Time constant of the slowdown. Distance of a coast is about speed × tau. */
export const FINGER_PAN_FLING_TAU_MS = 380
export const FINGER_PAN_FLING_STOP_SPEED = 0.012

export type FingerPanSample = { t: number; x: number; y: number }
export type FingerPanVelocity = { vx: number; vy: number }

export const pushFingerPanSample = (
  samples: readonly FingerPanSample[],
  sample: FingerPanSample,
  now = sample.t,
): FingerPanSample[] => {
  const cutoff = now - (FINGER_PAN_VELOCITY_WINDOW_MS + 32)
  const next = samples.filter((item) => item.t >= cutoff && item.t <= now)
  next.push(sample)
  return next.length > 24 ? next.slice(next.length - 24) : next
}

/** px/ms in client space. Positive x is a finger moving right. */
export const fingerPanReleaseVelocity = (
  samples: readonly FingerPanSample[],
  now: number,
): FingerPanVelocity => {
  const recent = samples.filter((sample) => now - sample.t <= FINGER_PAN_VELOCITY_WINDOW_MS && sample.t <= now)
  if (recent.length < 2) return { vx: 0, vy: 0 }
  const first = recent[0]
  const last = recent[recent.length - 1]
  const dt = last.t - first.t
  if (dt < 8) return { vx: 0, vy: 0 }
  let vx = (last.x - first.x) / dt
  let vy = (last.y - first.y) / dt
  const speed = Math.hypot(vx, vy)
  if (!Number.isFinite(speed) || speed < FINGER_PAN_MIN_FLING_SPEED) return { vx: 0, vy: 0 }
  if (speed > FINGER_PAN_MAX_FLING_SPEED) {
    const scale = FINGER_PAN_MAX_FLING_SPEED / speed
    vx *= scale
    vy *= scale
  }
  return { vx, vy }
}

export const stepFingerPanFling = (
  velocity: FingerPanVelocity,
  dtMs: number,
  tau = FINGER_PAN_FLING_TAU_MS,
) => {
  // A stalled frame is not part of the flick. Jumping the whole coast at once
  // feels like the page slipped, so the gesture just ends.
  if (!Number.isFinite(dtMs) || dtMs > 80) return { vx: 0, vy: 0, dx: 0, dy: 0, done: true }
  const dt = Math.max(0, dtMs)
  const decay = tau > 0 ? Math.exp(-dt / tau) : 0
  const travel = tau > 0 ? tau * (1 - decay) : 0
  const vx = velocity.vx * decay
  const vy = velocity.vy * decay
  return {
    vx,
    vy,
    dx: velocity.vx * travel,
    dy: velocity.vy * travel,
    done: Math.hypot(vx, vy) < FINGER_PAN_FLING_STOP_SPEED,
  }
}
