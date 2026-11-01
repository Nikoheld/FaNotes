import type { AppSettings, ThemeMode } from '../types'

/** A flake in viewport pixels. `x` and `y` are the top-left of its box. */
export type SnowFlake = {
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
export const SNOW_OBSTACLE_SELECTOR = '.sidebar, .sidebar-header, .sidebar-search, .sidebar-footer, .editor-toolbar, button, [role="dialog"]'

const SNOW_SEED = 0x5e0
const GRAVITY = 0.0009
const MAX_FALL = 0.55

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
 * Reduce-motion, or a field that is already at rest, returns the same field.
 */
export const stepSnowField = (
  field: SnowField,
  dtMs: number,
  reduceMotion: boolean,
  obstacles: readonly SnowObstacle[] = [],
): SnowField => {
  if (reduceMotion || !Number.isFinite(dtMs) || dtMs <= 0) return field
  if (field.flakes.every(resting)) return field
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
      vx = 0
      vy = 0
      settled = true
    }
    if (x !== flake.x || y !== flake.y || vx !== flake.vx || vy !== flake.vy || settled !== flake.settled) moved = true
    flakes[index] = { ...flake, x, y, vx, vy, settled }
  }
  if (!moved) return field
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
 * Push settled flakes near the pointer and leave them with throw velocity.
 * Flakes outside the reach stay where they are. Reduce-motion does not apply.
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
    changed = true
    const shove = influence
    return {
      ...flake,
      x: flake.x + dx * shove,
      y: flake.y + dy * shove,
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
