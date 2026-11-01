import type { AppSettings, ThemeMode } from '../types'

/** Falling snow the shell paints while the snow theme is the active theme. */
export type SnowFlake = {
  x: number
  y: number
  radius: number
  speed: number
  drift: number
}

export type SnowField = {
  width: number
  height: number
  flakes: readonly SnowFlake[]
}

export type ThemeSwatch = {
  id: ThemeMode
  accent: string
  secondary: string
}

export const SNOW_FLAKE_COUNT = 84

const SNOW_SEED = 0x5e0

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

const wrap = (value: number, span: number) => ((value % span) + span) % span

/** A field of flakes spread across the shell. Positions come only from `width`, `height`, and the seed. */
export const createSnowField = (width: number, height: number, seed = SNOW_SEED): SnowField => {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const random = mix(seed)
  const flakes: SnowFlake[] = []
  for (let index = 0; index < SNOW_FLAKE_COUNT; index += 1) {
    flakes.push({
      x: random() * safeWidth,
      y: random() * safeHeight,
      radius: 3 + random() * 4,
      speed: 0.035 + random() * 0.075,
      drift: (random() - 0.5) * 0.04,
    })
  }
  return { width: safeWidth, height: safeHeight, flakes }
}

/**
 * Advance flakes by `dtMs`. Reduce-motion returns the same field, so a timer
 * cannot move snow while the preference is on. Drag is a separate function.
 */
export const stepSnowField = (field: SnowField, dtMs: number, reduceMotion: boolean): SnowField => {
  if (reduceMotion || !Number.isFinite(dtMs) || dtMs === 0) return field
  return {
    width: field.width,
    height: field.height,
    flakes: field.flakes.map((flake) => {
      const spanX = field.width + flake.radius * 2
      const spanY = field.height + flake.radius * 2
      const x = wrap(flake.x + flake.drift * dtMs + flake.radius, spanX) - flake.radius
      const y = wrap(flake.y + flake.speed * dtMs + flake.radius, spanY) - flake.radius
      return { ...flake, x, y }
    }),
  }
}

/** Move every flake by the pointer delta. Reduce-motion does not apply. */
export const dragSnowField = (field: SnowField, dx: number, dy: number): SnowField => {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return field
  return {
    width: field.width,
    height: field.height,
    flakes: field.flakes.map((flake) => ({ ...flake, x: flake.x + dx, y: flake.y + dy })),
  }
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
