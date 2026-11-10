// The app's KantiPalette.kt, one to one: the same bases, the same contrast rules, so a theme looks
// the same in the browser as on the phone. Colours are 0xRRGGBB numbers here.

export const SNOW_THEME_ID = 'snow'
export const DEFAULT_ACCENT = '#2a6f97'
export const THEME_IDS = ['system', 'light', 'sepia', SNOW_THEME_ID, 'dark', 'midnight', 'forest', 'aurora'] as const

export interface KantiPalette {
  id: string
  dark: boolean
  background: number
  surface: number
  sunken: number
  raised: number
  text: number
  muted: number
  hairline: number
  outline: number
  accent: number
  onAccent: number
  accentSoft: number
  success: number
  successSoft: number
  warning: number
  warningSoft: number
  danger: number
  dangerSoft: number
  onDanger: number
  paper: number
  paperInk: number
  fixedAccent: boolean
}

interface Base {
  dark: boolean
  background: number; surface: number; sunken: number; raised: number
  text: number; muted: number; hairline: number; outline: number
  success: number; warning: number; danger: number
  paper?: number; paperInk?: number; accent?: number
}

const base = (dark: boolean, values: number[], extra: Partial<Base> = {}): Base => {
  const [background, surface, sunken, raised, text, muted, hairline, outline, success, warning, danger] = values
  return { dark, background, surface, sunken, raised, text, muted, hairline, outline, success, warning, danger, ...extra }
}

const LIGHT = base(false, [0xF4F5F2, 0xFFFFFF, 0xE8EBE6, 0xFFFFFF, 0x151C22, 0x505B64, 0xDCE0DA, 0x7F8991, 0x1D6A46, 0x875100, 0xB3252E])
const SEPIA = base(false, [0xF6F1E7, 0xFFFCF6, 0xEBE3D3, 0xFFFCF6, 0x2A251E, 0x5D5447, 0xE0D6C3, 0x877B69, 0x2B693E, 0x845008, 0xAA2E2E], { paper: 0xFFFBF2, paperInk: 0x3A3128 })
const SNOW = base(false, [0xF0F5FA, 0xFFFFFF, 0xE2EBF3, 0xFFFFFF, 0x11253A, 0x445B70, 0xD2DFEA, 0x7A93A9, 0x1B6A49, 0x83540B, 0xAD2E39], { paper: 0xFBFDFF, paperInk: 0x1C3347, accent: 0x2766A0 })
const GRAPHITE = base(true, [0x111315, 0x1A1C1F, 0x24272B, 0x202327, 0xECEDEE, 0xA8AEB4, 0x2D3135, 0x717980, 0x6FCB92, 0xE7B552, 0xFF8C8C], { paper: 0xEDEDE8 })
const MIDNIGHT = base(true, [0x0F1219, 0x171B24, 0x212631, 0x1C212B, 0xE7EAF0, 0xA4ABB9, 0x2A303C, 0x6B7486, 0x6FCB92, 0xE7B552, 0xFF8C8C], { paper: 0xEDEEF0 })
const FOREST = base(true, [0x101511, 0x171E19, 0x202923, 0x1C241E, 0xE4EBE5, 0xA2B1A6, 0x28322B, 0x68776C, 0x6FCB92, 0xE7B552, 0xFF8C8C], { paper: 0xECEFEA })
const AURORA = base(true, [0x141319, 0x1C1A23, 0x26232F, 0x211F29, 0xEAE8F0, 0xAEAABD, 0x2F2C3A, 0x716C83, 0x6FCB92, 0xE7B552, 0xFF8C8C], { paper: 0xEEEDF1 })

export const resolvedThemeId = (raw: string | null | undefined, systemDark: boolean): string => {
  const id = String(raw ?? '').trim()
  if (['light', 'dark', 'midnight', 'forest', 'aurora', 'sepia', SNOW_THEME_ID].includes(id)) return id
  return systemDark ? 'dark' : 'light'
}

export const parseHexColor = (raw: string | null | undefined): number | null => {
  const value = String(raw ?? '').trim().replace(/^#/u, '')
  return /^[0-9A-Fa-f]{6}$/u.test(value) ? parseInt(value, 16) : null
}

export const mixColor = (from: number, to: number, amount: number): number => {
  const t = Math.min(1, Math.max(0, amount))
  const channel = (shift: number) => {
    const a = (from >>> shift) & 0xFF
    const b = (to >>> shift) & 0xFF
    // Kotlin's Double.toInt() truncates towards zero.
    return Math.min(255, Math.max(0, Math.trunc(a + (b - a) * t)))
  }
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

export const relativeLuminance = (color: number): number => {
  const linear = (shift: number) => {
    const c = ((color >>> shift) & 0xFF) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(16) + 0.7152 * linear(8) + 0.0722 * linear(0)
}

export const contrastRatio = (a: number, b: number): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export const ensureContrast = (color: number, backgrounds: number[], minimum: number, towardsLight: boolean): number => {
  const target = towardsLight ? 0xFFFFFF : 0x000000
  let step = 0
  let current = color
  while (step <= 25 && backgrounds.some((background) => contrastRatio(current, background) < minimum)) {
    step += 1
    current = mixColor(color, target, step * 0.04)
  }
  return current
}

export const kantiPalette = (themeId: string | null | undefined, systemDark: boolean, accentHex: string | null = DEFAULT_ACCENT, amoled = false): KantiPalette => {
  const id = resolvedThemeId(themeId, systemDark)
  const b = { dark: GRAPHITE, midnight: MIDNIGHT, forest: FOREST, aurora: AURORA, sepia: SEPIA, [SNOW_THEME_ID]: SNOW }[id] ?? LIGHT
  const black = amoled && b.dark
  const background = black ? 0x000000 : b.background
  const surface = black ? mixColor(b.surface, 0x000000, 0.45) : b.surface
  const sunken = black ? mixColor(b.sunken, 0x000000, 0.35) : b.sunken
  const raised = black ? mixColor(b.raised, 0x000000, 0.35) : b.raised
  const hairline = black ? mixColor(b.hairline, 0x000000, 0.2) : b.hairline
  const surfaces = [background, surface, raised]
  const raw = b.accent ?? parseHexColor(accentHex) ?? parseHexColor(DEFAULT_ACCENT)!
  const accentSoft = mixColor(surface, raw, b.dark ? 0.24 : 0.13)
  const accent = ensureContrast(raw, [...surfaces, accentSoft], 4.5, b.dark)
  const white = 0xFFFFFF
  const ink = 0x0C1720
  const onAccent = contrastRatio(white, accent) >= contrastRatio(ink, accent) ? white : ink
  const tone = (color: number): [number, number] => {
    const soft = mixColor(surface, color, b.dark ? 0.2 : 0.12)
    return [ensureContrast(color, [...surfaces, soft], 4.5, b.dark), soft]
  }
  const [success, successSoft] = tone(b.success)
  const [warning, warningSoft] = tone(b.warning)
  const [danger, dangerSoft] = tone(b.danger)
  const onDanger = contrastRatio(white, danger) >= contrastRatio(ink, danger) ? white : ink
  return {
    id, dark: b.dark,
    background, surface, sunken, raised,
    text: ensureContrast(b.text, [...surfaces, sunken], 7.0, b.dark),
    muted: ensureContrast(b.muted, [...surfaces, sunken], 4.5, b.dark),
    hairline,
    outline: ensureContrast(b.outline, surfaces, 3.0, b.dark),
    accent, onAccent, accentSoft,
    success, successSoft, warning, warningSoft, danger, dangerSoft, onDanger,
    paper: b.paper ?? 0xFCFCFA, paperInk: b.paperInk ?? 0x26343B,
    fixedAccent: b.accent != null,
  }
}

export const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

/** CSS custom properties for a palette, set on the document root. */
export const paletteVariables = (palette: KantiPalette): Record<string, string> => ({
  '--bg': hex(palette.background),
  '--surface': hex(palette.surface),
  '--sunken': hex(palette.sunken),
  '--raised': hex(palette.raised),
  '--text': hex(palette.text),
  '--muted': hex(palette.muted),
  '--hairline': hex(palette.hairline),
  '--outline': hex(palette.outline),
  '--accent': hex(palette.accent),
  '--on-accent': hex(palette.onAccent),
  '--accent-soft': hex(palette.accentSoft),
  '--success': hex(palette.success),
  '--success-soft': hex(palette.successSoft),
  '--warning': hex(palette.warning),
  '--warning-soft': hex(palette.warningSoft),
  '--danger': hex(palette.danger),
  '--danger-soft': hex(palette.dangerSoft),
  '--on-danger': hex(palette.onDanger),
  '--paper': hex(palette.paper),
  '--paper-ink': hex(palette.paperInk),
  'color-scheme': palette.dark ? 'dark' : 'light',
})
