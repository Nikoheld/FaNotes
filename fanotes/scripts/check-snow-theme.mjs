import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  applyThemeChoice,
  createSnowField,
  dragSnowField,
  obstaclesFromRects,
  snowDragHitsSettled,
  snowLayerActive,
  stepSnowField,
  SNOW_DRAG_REACH,
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
  const obstacle = { left: 80, right: 460, top: 360 }
  const ceiling = obstaclesFromRects([
    { left: 0, top: 0, right: 1000, width: 1000, height: 40 },
    { left: obstacle.left, top: obstacle.top, right: obstacle.right, width: obstacle.right - obstacle.left, height: 220 },
  ], field.width, field.height)
  assert.deepEqual(ceiling, [obstacle])
  const highest = field.flakes.reduce((best, flake, index) => (flake.y < field.flakes[best].y ? index : best), 0)
  const stepped = stepSnowField(field, 48, false, [obstacle])
  assert.ok(stepped.flakes[highest].y > field.flakes[highest].y)
  assert.deepEqual(field.flakes.map((flake) => [flake.x, flake.y]), before)
  const held = stepSnowField(field, 48, true, [obstacle])
  assert.equal(held, field)

  const bottomOf = (flake) => flake.y + flake.radius * 2
  const overlaps = (flake, left, right) => flake.x < right && flake.x + flake.radius * 2 > left
  let settled = field
  for (let frame = 0; frame < 800; frame += 1) {
    const next = stepSnowField(settled, 16, false, [obstacle])
    if (next === settled) break
    settled = next
  }
  assert.equal(stepSnowField(settled, 48, false, [obstacle]), settled)
  assert.ok(settled.flakes.some((flake) => flake.settled && Math.abs(bottomOf(flake) - obstacle.top) < 0.01 && overlaps(flake, obstacle.left, obstacle.right)))
  assert.ok(settled.flakes.some((flake) => flake.settled && Math.abs(bottomOf(flake) - field.height) < 0.01 && !overlaps(flake, obstacle.left, obstacle.right)))
  assert.ok(settled.flakes.some((flake, index) => settled.flakes.some((other, otherIndex) => (
    otherIndex !== index
    && flake.settled
    && other.settled
    && Math.abs(bottomOf(flake) - other.y) < 0.01
    && overlaps(flake, other.x, other.x + other.radius * 2)
  ))))
  assert.ok(settled.flakes.every((flake) => flake.y + flake.radius * 2 <= field.height + 0.01))
  assert.ok(settled.flakes.every((flake) => flake.y > -flake.radius))

  const clusterIndex = settled.flakes.findIndex((flake) => flake.settled)
  const cluster = settled.flakes[clusterIndex]
  const pointerX = cluster.x + cluster.radius
  const pointerY = cluster.y + cluster.radius
  const distantIndex = settled.flakes.findIndex((flake) => (
    Math.hypot(pointerX - (flake.x + flake.radius), pointerY - (flake.y + flake.radius)) > SNOW_DRAG_REACH + flake.radius + 80
  ))
  assert.ok(clusterIndex >= 0)
  assert.ok(distantIndex >= 0)
  assert.equal(snowDragHitsSettled(settled, pointerX, pointerY), true)
  assert.equal(snowDragHitsSettled(settled, settled.flakes[distantIndex].x, -400), false)
  const dx = 36
  const dy = -18
  const dragged = dragSnowField(settled, pointerX, pointerY, dx, dy)
  assert.notEqual(dragged.flakes[clusterIndex].x, cluster.x)
  assert.ok(Math.abs(dragged.flakes[clusterIndex].vx) + Math.abs(dragged.flakes[clusterIndex].vy) > 0)
  assert.equal(dragged.flakes[distantIndex].x, settled.flakes[distantIndex].x)
  assert.equal(dragged.flakes[distantIndex].y, settled.flakes[distantIndex].y)
  assert.equal(dragged.flakes.every((flake, index) => flake.x === settled.flakes[index].x + dx && flake.y === settled.flakes[index].y + dy), false)
  let moving = dragged
  let traveled = false
  for (let frame = 0; frame < 40; frame += 1) {
    const next = stepSnowField(moving, 16, false, [obstacle])
    if (next.flakes[clusterIndex].x !== moving.flakes[clusterIndex].x || next.flakes[clusterIndex].y !== moving.flakes[clusterIndex].y) traveled = true
    moving = next
  }
  assert.equal(traveled, true)
  for (let frame = 0; frame < 800; frame += 1) {
    const next = stepSnowField(moving, 16, false, [obstacle])
    if (next === moving) break
    moving = next
  }
  assert.equal(stepSnowField(moving, 48, false, [obstacle]), moving)
  assert.ok(moving.flakes.every((flake) => flake.settled))
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
assert.match(blockFor('.snow-layer'), /pointer-events:\s*none/)
const snowLayer = read('src/components/SnowLayer.tsx')
assert.match(snowLayer, /obstaclesFromRects/)
assert.match(snowLayer, /stepSnowField\([\s\S]*obstaclesRef/)
assert.match(snowLayer, /snowDragHitsSettled/)
assert.match(snowLayer, /controlTarget\(event\.target\)/)
assert.match(snowLayer, /button, a, input, textarea/)

const app = read('src/App.tsx')
const layerUses = app.match(/<SnowLayer\b/g) ?? []
const guarded = app.match(/snowLayerActive\(theme\) \? <SnowLayer\b/g) ?? []
assert.ok(layerUses.length >= 1)
assert.equal(layerUses.length, guarded.length)
assert.equal(app.includes("snow: ['#f4f7fb', '#e7eef6', '#e7eef6', '#fbfcfe']"), true)

console.log(`appearance Anpassung · ${appearanceCount} Optionen matches ${appearanceRows} setting rows`)
console.log('snow-theme ok')
