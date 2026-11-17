import type { AppSettings, ThemeMode } from '../types'

/** A falling or flying flake. Positions are viewport pixels, velocities px/s. */
export type SnowFlake = {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  /** Per-flake phase for the sideways flutter. */
  phase: number
}

/** A horizontal ledge snow can rest on. `top` is the ledge's viewport y. */
export type SnowObstacle = { left: number; right: number; top: number }

export type SnowRect = { left: number; top: number; right: number; width: number; height: number }

/** Snow lying on one ledge: one height per `SNOW_COLUMN` px of its span. */
export type SnowPile = { left: number; right: number; top: number; heights: Float32Array }

export type SnowWorld = {
  width: number
  height: number
  time: number
  nextId: number
  seed: number
  flakes: SnowFlake[]
  /** Piles keyed by ledge. The viewport floor is the ledge keyed `floor`. */
  piles: Map<string, SnowPile>
}

export type ThemeSwatch = { id: ThemeMode; accent: string; secondary: string }

export const SNOW_FLAKE_COUNT = 140
export const SNOW_COLUMN = 4
/** Deepest snow on a ledge and on the floor, in px. */
export const SNOW_LEDGE_DEPTH = 14
export const SNOW_FLOOR_DEPTH = 46
/** Steepest allowed height difference between neighbouring columns. */
const SNOW_REPOSE = 2.2
/** Pointer reach for pushing flakes and plowing piles. */
export const SNOW_POINTER_REACH = 72

/** Surfaces whose top edge can hold snow. A full-width bar at the ceiling is ignored. */
export const SNOW_OBSTACLE_SELECTOR = '.sidebar, .sidebar-header, .sidebar-search, .sidebar-footer, .editor-toolbar, button, [role="dialog"], [role="menu"], .file-tree__context-menu, .command-palette, .note-tags-popover, .editor-more-menu, .note-backup-menu'

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

const rand = (world: SnowWorld) => {
  world.seed = (world.seed + 0x9e3779b9) >>> 0
  return mix(world.seed)()
}

/** Slowly changing wind in px/s: a steady breeze plus gusts. Same time gives the same wind. */
export const snowWind = (time: number) => (
  Math.sin(time * 0.23) * 14 + Math.sin(time * 0.71 + 1.3) * 9 + Math.max(0, Math.sin(time * 0.09 + 2)) * 22
)

const spawnFlake = (world: SnowWorld, anywhere: boolean): SnowFlake => {
  const depth = rand(world)
  const radius = 1.3 + depth * depth * 3.1
  world.nextId += 1
  return {
    id: world.nextId,
    x: rand(world) * world.width,
    y: anywhere ? rand(world) * world.height : -radius * 2 - rand(world) * 60,
    vx: 0,
    vy: 22 + radius * 11 + rand(world) * 12,
    radius,
    phase: rand(world) * Math.PI * 2,
  }
}

export const createSnowWorld = (width: number, height: number, seed = 0x5e0): SnowWorld => {
  const world: SnowWorld = {
    width: Math.max(1, width),
    height: Math.max(1, height),
    time: 0,
    nextId: 0,
    seed: seed >>> 0,
    flakes: [],
    piles: new Map(),
  }
  for (let index = 0; index < SNOW_FLAKE_COUNT; index += 1) world.flakes.push(spawnFlake(world, true))
  return world
}

const columnsFor = (left: number, right: number) => Math.max(1, Math.ceil((right - left) / SNOW_COLUMN))

const pileKey = (obstacle: SnowObstacle) => `${Math.round(obstacle.left)}:${Math.round(obstacle.right)}:${Math.round(obstacle.top)}`

const floorPile = (world: SnowWorld): SnowPile => {
  const existing = world.piles.get('floor')
  if (existing && existing.right === world.width && existing.top === world.height) return existing
  const pile: SnowPile = { left: 0, right: world.width, top: world.height, heights: new Float32Array(columnsFor(0, world.width)) }
  if (existing) {
    const ratio = existing.heights.length / pile.heights.length
    for (let index = 0; index < pile.heights.length; index += 1) {
      pile.heights[index] = existing.heights[Math.min(existing.heights.length - 1, Math.floor(index * ratio))]
    }
  }
  world.piles.set('floor', pile)
  return pile
}

/** Relax a pile so no slope is steeper than the angle of repose. Spilled snow is returned. */
const relaxPile = (pile: SnowPile, maxDepth: number, openEdges: boolean, passes = 3) => {
  const h = pile.heights
  let spilled = 0
  for (let pass = 0; pass < passes; pass += 1) {
    for (let index = 0; index < h.length - 1; index += 1) {
      const diff = h[index] - h[index + 1]
      if (Math.abs(diff) > SNOW_REPOSE) {
        const move = (Math.abs(diff) - SNOW_REPOSE) * 0.5
        const sign = diff > 0 ? 1 : -1
        h[index] -= move * sign
        h[index + 1] += move * sign
      }
    }
    if (openEdges) {
      // Ledge edges are open air: whatever builds up at the rim falls off.
      for (const edge of [0, h.length - 1]) {
        if (h[edge] > 0.6) {
          spilled += h[edge] - 0.6
          h[edge] = 0.6
        }
      }
    }
  }
  for (let index = 0; index < h.length; index += 1) if (h[index] > maxDepth) { spilled += h[index] - maxDepth; h[index] = maxDepth }
  return spilled
}

const isFloor = (pile: SnowPile, world: SnowWorld) => pile.top === world.height && pile.left === 0

const depthOf = (pile: SnowPile, world: SnowWorld) => (isFloor(pile, world) ? SNOW_FLOOR_DEPTH : SNOW_LEDGE_DEPTH)

/** Snow depth of a pile at viewport x. */
export const pileHeightAt = (pile: SnowPile, x: number) => {
  const index = Math.floor((x - pile.left) / SNOW_COLUMN)
  if (index < 0 || index >= pile.heights.length) return 0
  return pile.heights[index]
}

const surfaces = (world: SnowWorld) => {
  const list = [floorPile(world)]
  for (const [key, pile] of world.piles) if (key !== 'floor') list.push(pile)
  return list
}

/**
 * Ledges from visible shell rectangles. A full-width strip flush with the
 * ceiling is not a ledge, so flakes can enter the shell and still reach the floor.
 */
export const obstaclesFromRects = (rects: readonly SnowRect[], shellWidth: number, shellHeight: number): SnowObstacle[] => {
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

/** Match piles to the current ledges. A pile whose ledge is gone sheds its snow as falling flakes. */
export const syncSnowObstacles = (world: SnowWorld, obstacles: readonly SnowObstacle[]) => {
  const keep = new Set<string>(['floor'])
  for (const obstacle of obstacles) {
    const key = pileKey(obstacle)
    keep.add(key)
    if (!world.piles.has(key)) {
      world.piles.set(key, { left: obstacle.left, right: obstacle.right, top: obstacle.top, heights: new Float32Array(columnsFor(obstacle.left, obstacle.right)) })
    }
  }
  for (const [key, pile] of [...world.piles]) {
    if (keep.has(key)) continue
    world.piles.delete(key)
    for (let index = 0; index < pile.heights.length; index += 6) {
      if (pile.heights[index] < 1) continue
      world.nextId += 1
      world.flakes.push({
        id: world.nextId,
        x: pile.left + index * SNOW_COLUMN,
        y: pile.top - pile.heights[index],
        vx: (rand(world) - 0.5) * 30,
        vy: 20 + rand(world) * 30,
        radius: 1.6 + rand(world) * 1.8,
        phase: rand(world) * Math.PI * 2,
      })
    }
  }
}

const deposit = (pile: SnowPile, world: SnowWorld, x: number, amount: number) => {
  const center = Math.floor((x - pile.left) / SNOW_COLUMN)
  for (let offset = -1; offset <= 1; offset += 1) {
    const index = center + offset
    if (index < 0 || index >= pile.heights.length) continue
    pile.heights[index] += amount * (offset === 0 ? 0.5 : 0.25)
  }
  relaxPile(pile, depthOf(pile, world), !isFloor(pile, world), 2)
}

/** Total snow volume lying on all ledges. */
export const snowVolume = (world: SnowWorld) => {
  let total = 0
  for (const pile of world.piles.values()) for (const value of pile.heights) total += value
  return total
}

/**
 * Advance the world by `dtMs`. Flakes fall with drag, flutter, and drift in the
 * wind. A flake that reaches a snow surface melts into the pile, which settles
 * to a natural slope. The flake count stays at `SNOW_FLAKE_COUNT`.
 */
export const stepSnowWorld = (world: SnowWorld, dtMs: number) => {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return
  const dt = Math.min(dtMs, 50) / 1000
  world.time += dt
  const wind = snowWind(world.time)
  const piles = surfaces(world)
  const drag = Math.exp(-dt * 1.6)
  for (let index = 0; index < world.flakes.length; index += 1) {
    const flake = world.flakes[index]
    const depth = 0.5 + flake.radius / 4
    const targetVx = wind * depth + Math.sin(world.time * 1.7 + flake.phase) * 9
    flake.vx += (targetVx - flake.vx) * (1 - drag)
    const terminal = 24 + flake.radius * 12
    flake.vy += (terminal - flake.vy) * (1 - drag) + 40 * dt * (flake.vy < terminal ? 1 : 0)
    const prevBottom = flake.y + flake.radius
    flake.x += flake.vx * dt
    flake.y += flake.vy * dt
    if (flake.x < -20) flake.x += world.width + 40
    else if (flake.x > world.width + 20) flake.x -= world.width + 40
    let landed = false
    for (const pile of piles) {
      if (flake.x < pile.left || flake.x >= pile.right) continue
      const surface = pile.top - pileHeightAt(pile, flake.x)
      const bottom = flake.y + flake.radius
      if (bottom >= surface && prevBottom <= surface + 2 + flake.vy * dt) {
        deposit(pile, world, flake.x, flake.radius * 0.9)
        landed = true
        break
      }
    }
    if (landed || flake.y > world.height + 30) world.flakes[index] = spawnFlake(world, false)
  }
  while (world.flakes.length < SNOW_FLAKE_COUNT) world.flakes.push(spawnFlake(world, false))
  for (const pile of world.piles.values()) {
    const spilled = relaxPile(pile, depthOf(pile, world), !isFloor(pile, world), 1)
    if (spilled > 0.8 && !isFloor(pile, world) && rand(world) < 0.3) {
      world.nextId += 1
      world.flakes.push({
        id: world.nextId,
        x: rand(world) < 0.5 ? pile.left : pile.right,
        y: pile.top,
        vx: (rand(world) - 0.5) * 20,
        vy: 25,
        radius: 1.6 + rand(world) * 1.4,
        phase: rand(world) * Math.PI * 2,
      })
    }
  }
  if (world.flakes.length > SNOW_FLAKE_COUNT + 60) world.flakes.length = SNOW_FLAKE_COUNT + 60
}

/**
 * Move through the snow with the pointer. Nearby flakes are swept along with
 * the pointer's velocity (px/s) and pushed away from it. With `press` the
 * pointer also plows piles, throwing the removed snow up as flakes.
 */
export const interactSnow = (
  world: SnowWorld,
  pointerX: number,
  pointerY: number,
  velX: number,
  velY: number,
  press: boolean,
) => {
  if (![pointerX, pointerY, velX, velY].every(Number.isFinite)) return
  const reach = SNOW_POINTER_REACH
  for (const flake of world.flakes) {
    const dx = flake.x - pointerX
    const dy = flake.y - pointerY
    const dist = Math.hypot(dx, dy)
    if (dist > reach) continue
    const influence = (1 - dist / reach) * (press ? 1 : 0.6)
    const nx = dist > 0.001 ? dx / dist : 0
    const ny = dist > 0.001 ? dy / dist : -1
    flake.vx += (velX * 0.35 + nx * 140) * influence
    flake.vy += (velY * 0.35 + ny * 140) * influence
  }
  if (!press) return
  for (const pile of surfaces(world)) {
    const first = Math.max(0, Math.floor((pointerX - reach - pile.left) / SNOW_COLUMN))
    const last = Math.min(pile.heights.length - 1, Math.ceil((pointerX + reach - pile.left) / SNOW_COLUMN))
    for (let index = first; index <= last; index += 1) {
      const colX = pile.left + (index + 0.5) * SNOW_COLUMN
      const height = pile.heights[index]
      if (height < 0.4) continue
      const surfaceY = pile.top - height
      const dist = Math.hypot(colX - pointerX, Math.max(0, surfaceY - pointerY))
      if (dist > reach || pointerY > pile.top + reach * 0.5) continue
      const cut = Math.min(height, height * (1 - dist / reach) * 0.5 + 0.3)
      pile.heights[index] = height - cut
      const count = Math.min(3, Math.floor(cut * 0.9) + (rand(world) < cut ? 1 : 0))
      for (let n = 0; n < count && world.flakes.length < SNOW_FLAKE_COUNT + 60; n += 1) {
        world.nextId += 1
        world.flakes.push({
          id: world.nextId,
          x: colX,
          y: surfaceY - 1,
          vx: velX * 0.5 + (rand(world) - 0.5) * 90,
          vy: velY * 0.5 - 40 - rand(world) * 90,
          radius: 1.4 + rand(world) * 2,
          phase: rand(world) * Math.PI * 2,
        })
      }
    }
  }
}

/** A burst of flakes at a point, for a click on empty space. */
export const burstSnow = (world: SnowWorld, x: number, y: number, count = 18) => {
  for (let index = 0; index < count && world.flakes.length < SNOW_FLAKE_COUNT + 60; index += 1) {
    const angle = rand(world) * Math.PI * 2
    const speed = 40 + rand(world) * 140
    world.nextId += 1
    world.flakes.push({
      id: world.nextId,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40,
      radius: 1.4 + rand(world) * 2.2,
      phase: rand(world) * Math.PI * 2,
    })
  }
}

export const resizeSnowWorld = (world: SnowWorld, width: number, height: number) => {
  world.width = Math.max(1, width)
  world.height = Math.max(1, height)
  floorPile(world)
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
