import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  applyThemeChoice,
  burstSnow,
  createSnowWorld,
  interactSnow,
  obstaclesFromRects,
  snowLayerActive,
  snowWind,
  stepSnowWorld,
  syncSnowObstacles,
  SNOW_FLAKE_COUNT,
  SNOW_FLOOR_DEPTH,
  SNOW_LEDGE_DEPTH,
} from '../src/lib/snowTheme.ts'

const require = createRequire(import.meta.url)
const { sanitizeSettings } = require('../electron/settings-sanitize.cjs')
const appRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const floorFor = (world) => {
  stepSnowWorld(world, 16)
  return world.piles.get('floor')
}

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

  const world = createSnowWorld(1000, 800)
  assert.equal(world.flakes.length, SNOW_FLAKE_COUNT)
  const ledge = { left: 80, right: 460, top: 360 }
  const ceiling = obstaclesFromRects([
    { left: 0, top: 0, right: 1000, width: 1000, height: 40 },
    { left: ledge.left, top: ledge.top, right: ledge.right, width: ledge.right - ledge.left, height: 220 },
  ], 1000, 800)
  assert.deepEqual(ceiling, [ledge])
  syncSnowObstacles(world, [ledge])
  const ledgePile = [...world.piles.values()].find((pile) => pile.top === 360)
  assert.ok(ledgePile)

  const wind = [0, 5, 10, 30].map(snowWind)
  assert.ok(new Set(wind).size > 1)
  assert.equal(snowWind(12.5), snowWind(12.5))

  const tracked = world.flakes.reduce((best, flake) => (flake.y < best.y ? flake : best))
  const trackedY = tracked.y
  for (let frame = 0; frame < 20; frame += 1) stepSnowWorld(world, 16)
  assert.ok(tracked.y > trackedY)
  const before = JSON.stringify(world.flakes.map((flake) => flake.x))
  stepSnowWorld(world, 0)
  assert.equal(JSON.stringify(world.flakes.map((flake) => flake.x)), before)

  for (let frame = 0; frame < 3000; frame += 1) stepSnowWorld(world, 16)
  assert.equal(world.flakes.length >= SNOW_FLAKE_COUNT, true)
  assert.ok(world.flakes.length <= SNOW_FLAKE_COUNT + 60)
  const floor = world.piles.get('floor')
  assert.ok(Math.max(...floor.heights) > 1, 'snow piles up on the floor')
  assert.ok(Math.max(...floor.heights) <= SNOW_FLOOR_DEPTH + 0.001)
  assert.ok(Math.max(...ledgePile.heights) > 0.5, 'snow piles up on a ledge')
  assert.ok(Math.max(...ledgePile.heights) <= SNOW_LEDGE_DEPTH + 0.001)
  for (const pile of world.piles.values()) {
    for (let index = 0; index < pile.heights.length - 1; index += 1) {
      assert.ok(Math.abs(pile.heights[index] - pile.heights[index + 1]) < 4, 'slopes stay below the repose limit')
    }
  }
  assert.ok(world.flakes.every((flake) => Number.isFinite(flake.x) && Number.isFinite(flake.y)))

  // Stirring pushes flakes; plowing removes snow and throws flakes up.
  const stir = createSnowWorld(1000, 800)
  stir.flakes[0].x = 500
  stir.flakes[0].y = 400
  stir.flakes[0].vx = 0
  stir.flakes[0].vy = 0
  interactSnow(stir, 480, 400, 600, 0, false)
  assert.ok(stir.flakes[0].vx > 100)
  const bank = floorFor(stir)
  bank.heights.fill(10)
  const volume = bank.heights.reduce((sum, value) => sum + value, 0)
  const count = stir.flakes.length
  interactSnow(stir, 500, 790, 400, -50, true)
  assert.ok(bank.heights.reduce((sum, value) => sum + value, 0) < volume)
  assert.ok(stir.flakes.length > count)
  assert.equal(bank.heights[2], 10)
  const flat = createSnowWorld(1000, 800)
  const still = JSON.stringify(flat.flakes)
  interactSnow(flat, Number.NaN, 0, 0, 0, true)
  assert.equal(JSON.stringify(flat.flakes), still)
  const burst = createSnowWorld(1000, 800)
  burstSnow(burst, 500, 400, 10)
  assert.equal(burst.flakes.length, SNOW_FLAKE_COUNT + 10)

  // A ledge that disappears sheds its snow as flakes.
  ledgePile.heights.fill(8)
  const flakesBefore = world.flakes.length
  syncSnowObstacles(world, [])
  assert.equal(world.piles.has('floor'), true)
  assert.equal([...world.piles.values()].some((pile) => pile.top === 360), false)
  assert.ok(world.flakes.length > flakesBefore)
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
assert.match(settings, /`Anpassung · \$\{section\.count\} Optionen`/)
const appearance = settings.slice(settings.indexOf("active === 'appearance'"), settings.indexOf("active === 'editor'"))
const appearanceRows = appearance.match(/<SettingRow\b/g)?.length ?? 0
const appearanceCount = Number(settings.match(/case 'appearance': return (\d+)/)?.[1])
assert.equal(appearanceCount, appearanceRows)
assert.equal(appearanceCount, 12)

const css = read('src/styles.css')
const blockFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}(?:,[^{]*)?\\s*\\{([^}]+)\\}`))?.[1] ?? ''
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
assert.match(blockFor('.snow-layer'), /pointer-events:\s*none/)
const snowLayer = read('src/components/SnowLayer.tsx')
assert.match(snowLayer, /obstaclesFromRects/)
assert.match(snowLayer, /stepSnowWorld/)
assert.match(snowLayer, /syncSnowObstacles/)
assert.match(snowLayer, /interactSnow/)
assert.match(snowLayer, /controlTarget\(event\.target\)/)
assert.match(snowLayer, /MutationObserver/)
assert.match(snowLayer, /attributeFilter:\s*\['class', 'hidden'\]/)
assert.doesNotMatch(snowLayer, /preventDefault|stopPropagation/)

const app = read('src/App.tsx')
const layerUses = app.match(/<SnowLayer\b/g) ?? []
const guarded = app.match(/snowLayerActive\(theme\) \? <SnowLayer\b/g) ?? []
assert.ok(layerUses.length >= 1)
assert.equal(layerUses.length, guarded.length)
assert.equal(app.includes("snow: ['#eef5fc', '#dfecf8', '#e1edf8', '#fafdff']"), true)

console.log(`appearance Anpassung · ${appearanceCount} Optionen matches ${appearanceRows} setting rows`)
console.log('snow-theme ok')
