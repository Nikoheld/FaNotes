/**
 * Screen-space laser pointer. Samples are CSS pixels. Nothing here is ink.
 */

export type LaserSample = { x: number; y: number; t: number }

export const LASER_TRAIL_MS = 380
const LASER_MIN_STEP = 2
const LASER_MAX_SAMPLES = 48

export const trimLaserSamples = (
  samples: readonly LaserSample[],
  now: number,
  trailMs = LASER_TRAIL_MS,
) => {
  const cutoff = now - trailMs
  let start = 0
  while (start < samples.length && samples[start].t < cutoff) start += 1
  return start === 0 ? samples.slice() : samples.slice(start)
}

/** Keep the head, refresh it when the pointer barely moved, and cap the trail. */
export const pushLaserSample = (samples: readonly LaserSample[], sample: LaserSample) => {
  const next = samples.length ? samples.slice() : []
  const head = next[next.length - 1]
  if (head && Math.hypot(sample.x - head.x, sample.y - head.y) < LASER_MIN_STEP) {
    next[next.length - 1] = { x: head.x, y: head.y, t: sample.t }
  } else {
    next.push({ x: sample.x, y: sample.y, t: sample.t })
    if (next.length > LASER_MAX_SAMPLES) next.splice(0, next.length - LASER_MAX_SAMPLES)
  }
  return trimLaserSamples(next, sample.t)
}

type LaserContext = {
  clearRect: (x: number, y: number, width: number, height: number) => void
  beginPath: () => void
  arc: (x: number, y: number, radius: number, start: number, end: number) => void
  fill: () => void
  moveTo?: (x: number, y: number) => void
  lineTo?: (x: number, y: number) => void
  stroke?: () => void
  save?: () => void
  restore?: () => void
  setTransform?: (a: number, b: number, c: number, d: number, e: number, f: number) => void
  strokeStyle?: string | CanvasGradient | CanvasPattern
  fillStyle?: string | CanvasGradient | CanvasPattern
  lineWidth?: number
  lineCap?: CanvasLineCap
}

export type LaserCanvas = {
  width: number
  height: number
  getContext: (kind: '2d') => LaserContext | null
}

/**
 * Fading red trail plus a white core. `live` keeps the head bright.
 * The canvas transform is device pixels; the clear runs in identity space.
 */
export const paintLaserPointer = (
  canvas: LaserCanvas,
  samples: readonly LaserSample[],
  now: number,
  live = false,
) => {
  const context = canvas.getContext('2d')
  if (!context) return
  context.save?.()
  context.setTransform?.(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.restore?.()
  if (typeof context.moveTo === 'function' && typeof context.lineTo === 'function' && typeof context.stroke === 'function') {
    for (let index = 1; index < samples.length; index += 1) {
      const sample = samples[index]
      const alpha = Math.max(0, 1 - (now - sample.t) / LASER_TRAIL_MS)
      if (alpha <= 0) continue
      context.beginPath()
      context.strokeStyle = `rgba(255,42,48,${(alpha * 0.85).toFixed(3)})`
      context.lineWidth = 2.4
      context.lineCap = 'round'
      context.moveTo(samples[index - 1].x, samples[index - 1].y)
      context.lineTo(sample.x, sample.y)
      context.stroke()
    }
  }
  const head = samples[samples.length - 1]
  if (!live || !head) return
  context.beginPath()
  context.fillStyle = 'rgba(255,42,42,0.35)'
  context.arc(head.x, head.y, 10, 0, Math.PI * 2)
  context.fill()
  context.beginPath()
  context.fillStyle = '#ff2a2a'
  context.arc(head.x, head.y, 5, 0, Math.PI * 2)
  context.fill()
  context.beginPath()
  context.fillStyle = '#ffffff'
  context.arc(head.x, head.y, 2, 0, Math.PI * 2)
  context.fill()
}
