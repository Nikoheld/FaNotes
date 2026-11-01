import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  applyThemeChoice,
  createSnowField,
  dragSnowField,
  snowLayerActive,
  stepSnowField,
} from '../src/lib/snowTheme.ts'

const require = createRequire(import.meta.url)
const { sanitizeSettings } = require('../electron/settings-sanitize.cjs')
const appRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const vite = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const defaultsModule = await vite.ssrLoadModule('/src/defaults.ts')
  const profileModule = await vite.ssrLoadModule('/src/lib/sync/profile.ts')
  const factory = defaultsModule.defaultSettingsForPlatform('linux')
  assert.equal(factory.theme, 'light')
  assert.equal(snowLayerActive(factory.theme), false)
  assert.equal(read('electron/main.cjs').includes("theme: 'light'"), true)
  assert.equal(profileModule.PROFILE_THEMES.includes('snow'), true)
  assert.equal(profileModule.resolveProfileTheme('snow'), 'snow')
  assert.notEqual(profileModule.resolveProfileTheme('light'), 'snow')

  const snow = applyThemeChoice(factory, { id: 'snow', accent: '#111111', secondary: '#222222' })
  assert.equal(snow.theme, 'snow')
  assert.equal(snow.accent, '#111111')
  assert.equal(snow.accentSecondary, '#222222')
  assert.equal(snowLayerActive(snow.theme), true)
  assert.equal(sanitizeSettings({ theme: 'snow' }, factory, factory).theme, 'snow')

  for (const id of ['dark', 'light', 'system', 'midnight', 'forest', 'aurora', 'sepia']) {
    const next = applyThemeChoice(snow, { id, accent: '#333333', secondary: '#444444' })
    assert.notEqual(next.theme, 'snow')
    assert.equal(snowLayerActive(next.theme), false)
    assert.equal(sanitizeSettings({ theme: id }, snow, factory).theme, id)
    if (id === 'system') {
      assert.equal(next.accent, snow.accent)
      assert.equal(next.accentSecondary, snow.accentSecondary)
    }
  }

  const field = createSnowField(1000, 800)
  assert.ok(field.flakes.length >= 40)
  const xs = field.flakes.map((flake) => flake.x)
  const ys = field.flakes.map((flake) => flake.y)
  assert.ok(Math.max(...xs) - Math.min(...xs) > field.width * 0.5)
  assert.ok(Math.max(...ys) - Math.min(...ys) > field.height * 0.5)
  const before = field.flakes.map((flake) => [flake.x, flake.y])
  const stepped = stepSnowField(field, 48, false)
  assert.notDeepEqual(stepped.flakes.map((flake) => [flake.x, flake.y]), before)
  assert.deepEqual(field.flakes.map((flake) => [flake.x, flake.y]), before)
  const held = stepSnowField(field, 48, true)
  assert.equal(held, field)
  assert.deepEqual(held.flakes.map((flake) => [flake.x, flake.y]), before)
  const dragged = dragSnowField(held, 18, -7)
  assert.equal(dragged.flakes.length, held.flakes.length)
  for (let index = 0; index < held.flakes.length; index += 1) {
    assert.equal(dragged.flakes[index].x, held.flakes[index].x + 18)
    assert.equal(dragged.flakes[index].y, held.flakes[index].y - 7)
  }
  assert.deepEqual(field.flakes.map((flake) => [flake.x, flake.y]), before)
} finally {
  await vite.close()
}

const settings = read('src/components/SettingsModal.tsx')
const themes = settings.slice(settings.indexOf('const THEMES'), settings.indexOf('const BACKGROUNDS'))
assert.match(themes, /id: 'snow'/)
const farbschema = settings.slice(settings.indexOf('title="Farbschema"'), settings.indexOf('title="Arbeitsflächen-Design"'))
assert.match(farbschema, /THEMES\.map\(\(theme\)/)
assert.match(farbschema, /applyThemeChoice\(settings, theme\)/)
assert.doesNotMatch(farbschema, /setting-row/)
assert.match(settings, /\{`Anpassung · \$\{section\.count\} Optionen`\}/)
const appearance = settings.slice(settings.indexOf("active === 'appearance'"), settings.indexOf("active === 'editor'"))
const appearanceRows = appearance.match(/<SettingRow\b/g)?.length ?? 0
const appearanceCount = Number(settings.match(/case 'appearance': return (\d+)/)?.[1])
assert.equal(appearanceCount, appearanceRows)
assert.equal(appearanceCount, 12)

const css = read('src/styles.css')
const blockFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? ''
}
const tokenNames = (block) => [...block.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1])
const snowTokens = new Set(tokenNames(blockFor('.app-shell.theme-snow')))
assert.ok(snowTokens.size > 0)
for (const theme of ['light', 'midnight', 'forest', 'aurora', 'sepia']) {
  for (const token of tokenNames(blockFor(`.app-shell.theme-${theme}`))) {
    assert.equal(snowTokens.has(token), true, `snow is missing --${token} from ${theme}`)
  }
}
const snowHex = Object.fromEntries([...blockFor('.app-shell.theme-snow').matchAll(/--([\w-]+)\s*:\s*(#[\da-f]{3,8})\s*;/gi)].map((match) => [match[1], match[2]]))
for (const token of ['bg', 'bg-elevated', 'panel', 'panel-strong', 'text', 'text-soft', 'text-muted', 'danger', 'success', 'warning']) {
  assert.match(snowHex[token] ?? '', /^#[\da-f]{6}$/i)
}
assert.match(blockFor('.snow-layer'), /position:\s*fixed/)
assert.match(blockFor('.snow-layer'), /inset:\s*0/)

const app = read('src/App.tsx')
const layerUses = app.match(/<SnowLayer\b/g) ?? []
const guarded = app.match(/snowLayerActive\(theme\) \? <SnowLayer\b/g) ?? []
assert.ok(layerUses.length >= 1)
assert.equal(layerUses.length, guarded.length)
assert.equal(app.includes("snow: ['#f4f7fb', '#e7eef6', '#e7eef6', '#fbfcfe']"), true)

console.log(`appearance Anpassung · ${appearanceCount} Optionen matches ${appearanceRows} setting rows`)
console.log('snow-theme ok')
