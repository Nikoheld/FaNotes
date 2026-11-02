import type { AppSettings, ThemeMode } from '../types'

/** A flake in viewport pixels. `x` and `y` are the top-left of its box. */
export type SnowFlake = {
  id: number
  x: number
  y: number
  radius: number
  vx: number
  vy: number
  settled: boolean
}

export type SnowField = {
  width: number
  height: number
  flakes: readonly SnowFlake[]
}

/** A horizontal ledge snow can rest on. `top` is the ledge's viewport y. */
export type SnowObstacle = {
  left: number
  right: number
  top: number
}

export type SnowRect = {
  left: number
  top: number
  right: number
  width: number
  height: number
}

export type ThemeSwatch = {
  id: ThemeMode
  accent: string
  secondary: string
}

export const SNOW_FLAKE_COUNT = 84

/** Pointer reach for a push, outside the flake's own radius. */
export const SNOW_DRAG_REACH = 56

/** Surfaces whose top edge can hold snow. A full-width bar at the ceiling is ignored. */
export const SNOW_OBSTACLE_SELECTOR = '.sidebar, .sidebar-header, .sidebar-search, .sidebar-footer, .editor-toolbar, button, [role="dialog"], [role="menu"], .file-tree__context-menu, .command-palette, .note-tags-popover, .editor-more-menu, .note-backup-menu'

const SNOW_SEED = 0x5e0
const GRAVITY = 0.0009
const MAX_FALL = 0.55
/** Horizontal speed below this counts as stopped, so a slide can finish. */
const SLIDE_STOP = 0.004
/** A packed flake grows until it is about this big, then extra snow sticks to it. */
const SNOW_BALL_RADIUS = 28
/** Circles closer than this fraction of a touch sink into one flake. */
const MERGE_DEPTH = 0.8
const SUPPORT_SLACK = 0.75
const WAKE_FALL = 0.08

const mix = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const spanOf = (flake: SnowFlake) => flake.radius * 2

const resting = (flake: SnowFlake) => flake.settled && flake.vx === 0 && flake.vy === 0

const overlapsX = (x: number, span: number, left: number, right: number) => x < right && x + span > left

const centerOf = (flake: SnowFlake) => ({ x: flake.x + flake.radius, y: flake.y + flake.radius })

const canGrow = (a: SnowFlake, b: SnowFlake) => Math.hypot(a.radius, b.radius) <= SNOW_BALL_RADIUS

/** True when two resting flakes still overlap enough to stick into a bigger one. */
const wantsCompany = (flakes: readonly SnowFlake[]) => {
  for (let index = 0; index < flakes.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < flakes.length; otherIndex += 1) {
      const a = flakes[index]
      const b = flakes[otherIndex]
      if (!a.settled && !b.settled) continue
      if (!canGrow(a, b)) continue
      const touch = a.radius + b.radius
      const ca = centerOf(a)
      const cb = centerOf(b)
      const dist = Math.hypot(ca.x - cb.x, ca.y - cb.y)
      if (dist > 0 && dist <= touch + 0.6) return true
    }
  }
  return false
}

/**
 * Overlapping snow sticks. Flakes that sink into each other become one larger
 * flake. A flake that is already as big as a snowball keeps its size and shares
 * a sideways push with whatever is packed against it.
 */
const coalesceSnow = (flakes: SnowFlake[], width: number, height: number) => {
  let moved = false
  const dead = new Set<number>()
  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 0; index < flakes.length; index += 1) {
      if (dead.has(index)) continue
      for (let otherIndex = index + 1; otherIndex < flakes.length; otherIndex += 1) {
        if (dead.has(otherIndex)) continue
        const a = flakes[index]
        const b = flakes[otherIndex]
        if (!a.settled && !b.settled) continue
        const touch = a.radius + b.radius
        if (touch <= 0) continue
        const ca = centerOf(a)
        const cb = centerOf(b)
        const dx = cb.x - ca.x
        const dy = cb.y - ca.y
        const dist = Math.hypot(dx, dy) || 0.0001
        if (dist > touch + 0.6) continue
        const areaA = a.radius * a.radius
        const areaB = b.radius * b.radius
        const grow = canGrow(a, b)
        if (grow && dist < touch * MERGE_DEPTH) {
          const keep = areaA >= areaB ? a : b
          const drop = keep === a ? otherIndex : index
          const radius = Math.sqrt(areaA + areaB)
          const nx = (ca.x * areaA + cb.x * areaB) / (areaA + areaB)
          const bottom = Math.min(height, Math.max(a.y + spanOf(a), b.y + spanOf(b)))
          keep.radius = radius
          keep.x = Math.min(Math.max(0, nx - radius), Math.max(0, width - radius * 2))
          keep.y = bottom - radius * 2
          if (keep.y <= -radius) keep.y = -radius + 0.05
          const mass = areaA + areaB
          keep.vx = (a.vx * areaA + b.vx * areaB) / mass
          keep.settled = a.settled && b.settled
          keep.vy = keep.settled ? 0 : (a.vy * areaA + b.vy * areaB) / mass
          dead.add(drop)
          moved = true
          if (drop === index) break
          continue
        }
        if (!grow && a.settled && b.settled) {
          const mid = (a.vx * areaA + b.vx * areaB) / (areaA + areaB)
          if (Math.abs(a.vx - mid) > SLIDE_STOP || Math.abs(b.vx - mid) > SLIDE_STOP) {
            a.vx = mid
            b.vx = mid
            moved = true
          }
          continue
        }
        if (!grow || dist <= touch * MERGE_DEPTH) continue
        const pull = Math.min(1.2, (dist - touch * MERGE_DEPTH) / 2)
        if (pull <= 0.02) continue
        const ux = dx / dist
        const uy = dy / dist
        const mass = areaA + areaB
        a.x += ux * pull * (areaB / mass)
        a.y += uy * pull * (areaB / mass)
        b.x -= ux * pull * (areaA / mass)
        b.y -= uy * pull * (areaA / mass)
        const clampDown = (flake: SnowFlake) => {
          const span = spanOf(flake)
          if (flake.y + span > height) flake.y = height - span
          if (flake.y <= -flake.radius) flake.y = -flake.radius + 0.05
          const maxX = Math.max(0, width - span)
          if (flake.x < 0) flake.x = 0
          else if (flake.x > maxX) flake.x = maxX
        }
        clampDown(a)
        clampDown(b)
        moved = true
      }
    }
  }
  if (dead.size > 0) {
    let write = 0
    for (let read = 0; read < flakes.length; read += 1) {
      if (dead.has(read)) continue
      flakes[write] = flakes[read]
      write += 1
    }
    flakes.length = write
  }
  return moved
}

const isSupported = (
  flake: SnowFlake,
  index: number,
  flakes: readonly SnowFlake[],
  obstacles: readonly SnowObstacle[],
  height: number,
) => {
  const span = spanOf(flake)
  const bottom = flake.y + span
  if (bottom >= height - SUPPORT_SLACK) return true
  for (const obstacle of obstacles) {
    if (Math.abs(bottom - obstacle.top) > SUPPORT_SLACK) continue
    if (overlapsX(flake.x, span, obstacle.left, obstacle.right)) return true
  }
  for (let otherIndex = 0; otherIndex < flakes.length; otherIndex += 1) {
    if (otherIndex === index) continue
    const other = flakes[otherIndex]
    if (!other.settled) continue
    if (Math.abs(bottom - other.y) > SUPPORT_SLACK) continue
    if (overlapsX(flake.x, span, other.x, other.x + spanOf(other))) return true
  }
  return false
}

/** Wake settled flakes whose ledge is gone, from the bottom of a pile upward. */
const releaseUnsupported = (
  flakes: SnowFlake[],
  obstacles: readonly SnowObstacle[],
  height: number,
) => {
  let released = false
  let changed = true
  let guard = 0
  while (changed && guard <= flakes.length) {
    changed = false
    guard += 1
    for (let index = 0; index < flakes.length; index += 1) {
      const flake = flakes[index]
      if (!flake.settled) continue
      if (isSupported(flake, index, flakes, obstacles, height)) continue
      flakes[index] = { ...flake, settled: false, vy: Math.max(flake.vy, WAKE_FALL) }
      released = true
      changed = true
    }
  }
  return released
}

/**
 * Ledges from visible shell rectangles. A full-width strip flush with the
 * ceiling is not a ledge, so flakes can enter the shell and still reach the floor.
 */
export const obstaclesFromRects = (
  rects: readonly SnowRect[],
  shellWidth: number,
  shellHeight: number,
): SnowObstacle[] => {
  const obstacles: SnowObstacle[] = []
  for (const rect of rects) {
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) continue
    if (rect.width < 28 || rect.height < 16) continue
    if (rect.top < 4 || rect.top > shellHeight - 8) continue
    if (rect.width > shellWidth * 0.92 && rect.top < 28) continue
    const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width
    if (right - rect.left < 28) continue
    obstacles.push({ left: rect.left, right, top: rect.top })
  }
  return obstacles
}

/** A field of flakes spread across the shell. Positions come only from `width`, `height`, and the seed. */
export const createSnowField = (width: number, height: number, seed = SNOW_SEED): SnowField => {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const random = mix(seed)
  const flakes: SnowFlake[] = []
  for (let index = 0; index < SNOW_FLAKE_COUNT; index += 1) {
    const radius = 3 + random() * 4
    const span = radius * 2
    flakes.push({
      id: index + 1,
      x: random() * Math.max(1, safeWidth - span),
      y: random() * Math.max(1, safeHeight - span),
      radius,
      vx: (random() - 0.5) * 0.03,
      vy: 0.12 + random() * 0.2,
      settled: false,
    })
  }
  return { width: safeWidth, height: safeHeight, flakes }
}

/**
 * Advance flakes by `dtMs`. Falling flakes gain downward speed and stop on an
 * obstacle top, on snow that has already settled, or on the shell bottom.
 * Leftover sideways speed slides, then stops. Overlapping flakes stick and
 * grow into a larger flake. Reduce-motion, or a field already at rest with
 * nothing left to absorb, returns the same field.
 */
export const stepSnowField = (
  field: SnowField,
  dtMs: number,
  reduceMotion: boolean,
  obstacles: readonly SnowObstacle[] = [],
): SnowField => {
  if (reduceMotion || !Number.isFinite(dtMs) || dtMs <= 0) return field
  if (field.flakes.every(resting) && !wantsCompany(field.flakes)) return field
  const dt = Math.min(dtMs, 50)
  const flakes = field.flakes.map((flake) => ({ ...flake }))
  const order = flakes
    .map((_, index) => index)
    .sort((a, b) => (flakes[b].y + spanOf(flakes[b])) - (flakes[a].y + spanOf(flakes[a])))
  let moved = false
  for (const index of order) {
    const flake = flakes[index]
    if (resting(flake)) continue
    const span = spanOf(flake)
    let vx = flake.vx * Math.exp(-dt / 320)
    let vy = Math.min(MAX_FALL, flake.vy + GRAVITY * dt)
    let x = flake.x + vx * dt
    let y = flake.y + vy * dt
    const maxX = Math.max(0, field.width - span)
    if (x < 0) {
      x = 0
      vx = 0
    } else if (x > maxX) {
      x = maxX
      vx = 0
    }
    const oldBottom = flake.y + span
    const newBottom = y + span
    let support: number | null = null
    const consider = (surface: number) => {
      if (!Number.isFinite(surface)) return
      if (surface + 0.25 < oldBottom) return
      if (newBottom < surface - 0.25) return
      if (support === null || surface < support) support = surface
    }
    consider(field.height)
    for (const obstacle of obstacles) {
      if (!overlapsX(x, span, obstacle.left, obstacle.right)) continue
      consider(obstacle.top)
    }
    for (let otherIndex = 0; otherIndex < flakes.length; otherIndex += 1) {
      if (otherIndex === index) continue
      const other = flakes[otherIndex]
      if (!other.settled) continue
      if (!overlapsX(x, span, other.x, other.x + spanOf(other))) continue
      consider(other.y)
    }
    // A downward push can start the flake already past the floor. That surface
    // is still the support, or the flake falls without ever settling.
    if ((oldBottom >= field.height - 0.25 || newBottom >= field.height - 0.25) && (support === null || support > field.height)) {
      support = field.height
    }
    let settled = false
    if (support !== null) {
      y = support - span
      vy = 0
      const slide = vx * 0.86
      if (Math.abs(slide) < SLIDE_STOP) vx = 0
      else vx = slide
      settled = true
    }
    if (x !== flake.x || y !== flake.y || vx !== flake.vx || vy !== flake.vy || settled !== flake.settled) moved = true
    flakes[index] = { ...flake, x, y, vx, vy, settled }
  }
  if (coalesceSnow(flakes, field.width, field.height)) moved = true
  if (releaseUnsupported(flakes, obstacles, field.height)) moved = true
  if (!moved) return field
  return { width: field.width, height: field.height, flakes }
}

/**
 * Let settled snow fall again when a ledge it was resting on is gone.
 * A pile wakes from the supporting flake upward. An unchanged pile returns
 * the same field.
 */
export const wakeSnowForObstacles = (
  field: SnowField,
  obstacles: readonly SnowObstacle[],
): SnowField => {
  const flakes = field.flakes.map((flake) => ({ ...flake }))
  if (!releaseUnsupported(flakes, obstacles, field.height)) return field
  return { width: field.width, height: field.height, flakes }
}

/**
 * Drop a few new flakes along the top when a merge has left room.
 * The field never grows past `SNOW_FLAKE_COUNT`. A full field is returned as-is.
 */
export const sprinkleSnow = (field: SnowField, count: number): SnowField => {
  const room = SNOW_FLAKE_COUNT - field.flakes.length
  const add = Math.min(room, Math.max(0, Math.floor(count)))
  if (add <= 0) return field
  let nextId = 0
  for (const flake of field.flakes) nextId = Math.max(nextId, flake.id)
  const random = mix((nextId + 1) ^ SNOW_SEED)
  const flakes = field.flakes.slice()
  for (let index = 0; index < add; index += 1) {
    nextId += 1
    const radius = 3 + random() * 2.2
    const span = radius * 2
    flakes.push({
      id: nextId,
      x: random() * Math.max(1, field.width - span),
      y: -span - random() * 48,
      radius,
      vx: (random() - 0.5) * 0.04,
      vy: 0.08 + random() * 0.14,
      settled: false,
    })
  }
  return { width: field.width, height: field.height, flakes }
}

/** True when the pointer is on settled snow, close enough to push that pile. */
export const snowDragHitsSettled = (field: SnowField, pointerX: number, pointerY: number) => {
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return false
  return field.flakes.some((flake) => {
    if (!flake.settled) return false
    const distance = Math.hypot(pointerX - (flake.x + flake.radius), pointerY - (flake.y + flake.radius))
    return distance <= SNOW_DRAG_REACH + flake.radius
  })
}

/**
 * Push settled flakes near the pointer and pack them toward it so they stick.
 * A bigger flake is heavier. Flakes outside the reach stay where they are.
 */
export const dragSnowField = (
  field: SnowField,
  pointerX: number,
  pointerY: number,
  dx: number,
  dy: number,
): SnowField => {
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY) || !Number.isFinite(dx) || !Number.isFinite(dy)) return field
  if (dx === 0 && dy === 0) return field
  let changed = false
  const flakes = field.flakes.map((flake) => {
    if (!flake.settled) return flake
    const distance = Math.hypot(pointerX - (flake.x + flake.radius), pointerY - (flake.y + flake.radius))
    const reach = SNOW_DRAG_REACH + flake.radius
    if (distance > reach) return flake
    const influence = 1 - distance / reach
    const shove = influence * (8 / (8 + flake.radius))
    const cx = flake.x + flake.radius
    const cy = flake.y + flake.radius
    const pack = influence * 0.18
    changed = true
    return {
      ...flake,
      x: flake.x + dx * shove + (pointerX - cx) * pack,
      y: flake.y + dy * shove + (pointerY - cy) * pack,
      vx: dx * shove * 0.012,
      vy: dy * shove * 0.012,
      settled: false,
    }
  })
  if (!changed) return field
  return { width: field.width, height: field.height, flakes }
}

export const snowLayerActive = (theme: string | null | undefined) => theme === 'snow'

/** The Farbschema button. `system` keeps the current accent; every other theme stores its swatch. */
export const applyThemeChoice = <T extends Pick<AppSettings, 'theme' | 'accent' | 'accentSecondary'>>(
  settings: T,
  swatch: ThemeSwatch,
): T => {
  if (swatch.id === 'system') return { ...settings, theme: swatch.id }
  return {
    ...settings,
    theme: swatch.id,
    accent: swatch.accent,
    accentSecondary: swatch.secondary,
  }
}
