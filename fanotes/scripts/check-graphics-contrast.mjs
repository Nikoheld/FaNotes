// Contrast of the colour pairs changed for the dark-mode / contrast fixes, in every theme and accent preset.
// Graphics (heatmap steps, chart fills) need 3:1 (WCAG 1.4.11), text 4.5:1 (1.4.3).
// Tokens and mix percentages are read from the CSS sources, the readable accent comes from the app's own
// ensureReadableColor, so the numbers follow the code. Run from fanotes/: node scripts/check-graphics-contrast.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const css = read('src/styles.css')
const stats = read('src/components/statistics.css')
const app = read('src/App.tsx')
const settings = read('src/components/SettingsModal.tsx')

const THEMES = ['dark', 'midnight', 'forest', 'aurora', 'light', 'sepia', 'snow']
const LIGHT = new Set(['light', 'sepia', 'snow'])
const GRAPHIC = 3
const TEXT = 4.5
const MIN_STEP = 1.15 // adjacent heatmap levels, as a contrast ratio between the two fills

const problems = []
const fail = (message) => problems.push(message)

// -- CSS reading ---------------------------------------------------------------------------
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hexVars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+)\s*:\s*(#[\da-f]{3,8})\s*;/gi)].map((match) => [match[1], match[2].toLowerCase()]))
// The selector may be followed by more selectors (`.app-shell.theme-light, body.app-theme-light {`).
const blocks = (source, selector) => [...source.matchAll(new RegExp(`(?:^|\\n)${escape(selector)}(?:,[^{]*)?\\s*\\{([^}]+)\\}`, 'g'))].map((match) => match[1]).join('\n')
const percent = (source, pattern, label) => {
  const value = Number(pattern.exec(source)?.[1])
  if (!Number.isFinite(value)) fail(`could not read ${label}; the CSS changed, update this check`)
  return value
}

// -- colour maths (sRGB, as CSS color-mix in srgb and WCAG 2) --------------------------------
const parse = (hex) => {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.replace(/./g, '$&$&') : raw.slice(0, 6)
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16))
}
const channel = (value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
const ratio = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const mix = (from, to, share) => from.map((c, i) => Math.round(c + (to[i] - c) * share)) // share = part of `to`
const over = (top, alpha, under) => mix(under, top, alpha)

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
let readable
try {
  ({ ensureReadableColor: readable } = await server.ssrLoadModule('/src/lib/colorContrast.ts'))
} finally {
  await server.close()
}

// Same surfaces the app uses to derive --accent-readable at run time.
const surfaceBlock = /THEME_CONTRAST_SURFACES[^=]*=\s*\{([^}]+)\}/.exec(app)?.[1] ?? ''
const surfaces = Object.fromEntries([...surfaceBlock.matchAll(/(\w+):\s*\[([^\]]+)\]/g)].map((match) => [match[1], [...match[2].matchAll(/#[\da-f]{6}/gi)].map((hex) => hex[0])]))
for (const theme of THEMES) if (!surfaces[theme]?.length) fail(`could not read THEME_CONTRAST_SURFACES.${theme} from App.tsx`)
const accents = [...(/const ACCENTS = \[([^\]]+)\]/.exec(settings)?.[1] ?? '').matchAll(/#[\da-f]{6}/gi)].map((match) => match[0])
if (accents.length < 5) fail('could not read the accent presets from SettingsModal.tsx')

const rootVars = hexVars(blocks(css, ':root'))
const paperVars = hexVars(blocks(css, '.unified-paper'))
const tokens = (theme) => (theme === 'dark' ? rootVars : { ...rootVars, ...hexVars(blocks(css, `.app-shell.theme-${theme}`)) })

// The card the charts sit on: 70% --panel-strong over the settings modal (--bg).
if (!/\.setting-card \{[^}]*background: color-mix\(in srgb, var\(--panel-strong\) 70%, transparent\)/.test(css)) fail('.setting-card background changed; update the card model in this check')
if (!/\.settings-modal \{ border-radius: 12px; background: var\(--bg\)/.test(css)) fail('.settings-modal background changed; update the card model in this check')

// statistics.css: heat scale and category colours
const heatMix = percent(stats, /--stat-heat:\s*color-mix\(in srgb, var\(--accent-readable\) (\d+)%, var\(--text\)\)/, '--stat-heat')
const level0 = percent(stats, /--stat-lvl-0:\s*color-mix\(in srgb, var\(--text-muted\) (\d+)%, var\(--panel-strong\)\)/, '--stat-lvl-0')
const levelMix = [1, 2, 3].map((n) => percent(stats, new RegExp(`--stat-lvl-${n}:\\s*color-mix\\(in srgb, var\\(--stat-heat\\) (\\d+)%, var\\(--panel-strong\\)\\)`), `--stat-lvl-${n}`))
const statBase = hexVars(blocks(stats, '.statistics-page'))
const statLight = hexVars((/\.app-shell\.theme-light \.statistics-page[^{]*\{([^}]+)\}/.exec(stats) ?? [])[1] ?? '')
const kindNames = { 'stat-2': 'handwriting', 'stat-3': 'pdf', 'stat-4': 'story', 'stat-5': 'image' }

// .lw-error: tinted box, danger text
const errorTint = percent(css, /\.lw-error \{[^}]*background: color-mix\(in srgb, var\(--danger\) (\d+)%, var\(--panel\)\)/, '.lw-error background tint')

// -- source guards: the failures these checks replaced must not come back --------------------
if (/#b42318/i.test(css)) fail('styles.css still has the hard-coded #b42318')
for (const selector of ['.study-label input', '.study-legend-row input']) {
  if (!new RegExp(`${escape(selector)} \\{[^}]*\\bcolor: var\\(--text\\)`).test(css)) fail(`${selector} sets no text colour (white on white in dark themes)`)
}
if (!/color-scheme:\s*light/.test(blocks(css, '.unified-paper'))) fail('.unified-paper must set color-scheme: light')
for (const token of ['danger', 'success', 'warning']) if (!paperVars[token]) fail(`.unified-paper must pin --${token}`)

// -- measurements ---------------------------------------------------------------------------
const rows = new Map() // label -> { min, at, need }
const measure = (label, need, value, at) => {
  const row = rows.get(label) ?? { min: Infinity, at: '', need }
  if (value < row.min) { row.min = value; row.at = at }
  rows.set(label, row)
  if (value < need - 1e-9) fail(`${label}: ${value.toFixed(2)}:1 (needs ${need}:1) at ${at}`)
}

for (const theme of THEMES) {
  const v = tokens(theme)
  const card = over(parse(v['panel-strong']), 0.7, parse(v.bg))
  const strong = parse(v['panel-strong'])
  const text = parse(v.text)

  // category colours for the Vault bar and legend dots (light cards use the darker set)
  for (const [name, label] of Object.entries(kindNames)) {
    const colour = parse((LIGHT.has(theme) ? statLight[name] : undefined) ?? statBase[name])
    measure(`chart colour (${label}) on card`, GRAPHIC, ratio(colour, card), theme)
    measure(`chart colour (${label}) on bar track`, GRAPHIC, ratio(colour, strong), theme)
  }

  for (const accent of accents) {
    const at = `${theme} / ${accent}`
    const accentReadable = parse(readable(accent, surfaces[theme]))
    measure('bars, markdown segment, progress (--accent-readable) on card', GRAPHIC, ratio(accentReadable, card), at)
    const heat = mix(accentReadable, text, heatMix / 100)
    const levels = [mix(strong, parse(v['text-muted']), level0 / 100), ...levelMix.map((n) => mix(strong, heat, n / 100)), heat]
    levels.slice(1).forEach((fill, index) => measure(`heatmap level ${index + 1} on card`, GRAPHIC, ratio(fill, card), at))
    levels.slice(1).forEach((fill, index) => measure(`heatmap step ${index} to ${index + 1}`, MIN_STEP, ratio(fill, levels[index]), at))
  }
}

// danger text: themed surfaces, plus the always-light paper (study blocks inside notes)
for (const theme of [...THEMES, 'paper']) {
  const v = theme === 'paper' ? { ...rootVars, ...paperVars } : tokens(theme)
  const danger = parse(v.danger)
  const panel = parse(v.panel)
  const tinted = mix(panel, danger, errorTint / 100)
  measure('.lw-error text on its tinted box', TEXT, ratio(danger, tinted), theme)
  measure('.lw-error border / .cm-lw-broken stripe on panel', GRAPHIC, ratio(danger, panel), theme)
  measure('.lw-clock.is-over on panel', TEXT, ratio(danger, panel), theme)
  measure('.lw-clock.is-over on panel-strong', TEXT, ratio(danger, parse(v['panel-strong'])), theme)
}

// study label / legend text and placeholder sit on the paper panel
{
  const v = { ...rootVars, ...paperVars }
  measure('study legend / label input text on paper panel', TEXT, ratio(parse(v.text), parse(v.panel)), 'paper')
  measure('study input placeholder (--text-muted) on paper panel', TEXT, ratio(parse(v['text-muted']), parse(v.panel)), 'paper')
}

const width = Math.max(...[...rows.keys()].map((label) => label.length))
for (const [label, row] of rows) console.log(`${label.padEnd(width)}  worst ${row.min.toFixed(2)}:1  (needs ${row.need}:1)  ${row.at}`)
if (problems.length) {
  console.error(`\n${problems.length} contrast problem(s):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`\ngraphics contrast ok: ${rows.size} checks over ${THEMES.length} themes and ${accents.length} accent presets`)
