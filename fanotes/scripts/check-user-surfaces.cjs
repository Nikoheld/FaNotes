'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const inventoryPath = path.join(root, 'docs', 'USER_SURFACES.md')
const inventory = fs.readFileSync(inventoryPath, 'utf8')
const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
const settings = fs.readFileSync(path.join(root, 'src', 'components', 'SettingsModal.tsx'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const REQUIRED_HEADINGS = [
  'Notes / vault',
  'Paper / ink',
  'Recognition',
  'Math solver / corrector',
  'Settings / AI',
  'Homework',
  'PDF notes',
  'Search / palette',
  'Bug report',
  'Linux / Windows desktop',
]

const rows = [...inventory.matchAll(/^\| ([^|]+) \| `([^`]+)` \| `([^`]+)` \|$/gmu)].map((match) => ({
  surface: match[1].trim(),
  source: match[2].trim(),
  needle: match[3].trim(),
}))

assert.ok(rows.length >= 40, `Inventory is too thin: ${rows.length} rows`)
for (const heading of REQUIRED_HEADINGS) {
  assert.ok(inventory.includes(`## ${heading}`), `missing heading ${heading}`)
}

for (const row of rows) {
  const sourcePath = path.join(root, row.source)
  assert.equal(fs.existsSync(sourcePath), true, `missing source ${row.source}`)
  const text = fs.readFileSync(sourcePath, 'utf8')
  assert.ok(text.includes(row.needle), `${row.surface} needle «${row.needle}» missing in ${row.source}`)
}

const paletteIds = [...app.matchAll(/\{ id: '([a-z0-9-]+)', label:/gu)].map((match) => match[1])
assert.ok(paletteIds.includes('new-note'))
assert.ok(paletteIds.includes('reveal'), 'palette must expose reveal/download')
assert.ok(paletteIds.includes('bug-report'))
for (const id of paletteIds) {
  assert.ok(inventory.includes(`id: '${id}'`) || inventory.includes(id), `palette action ${id} is not inventoried`)
}

for (const section of ['appearance', 'editor', 'drawing', 'files', 'updates', 'accessibility', 'experimental', 'advanced']) {
  assert.ok(settings.includes(`id: '${section}'`), `settings section ${section} missing`)
  assert.ok(inventory.includes(`id: '${section}'`) || inventory.includes(section), `settings section ${section} not inventoried`)
}

assert.match(app, /currentVersion: APP_VERSION/)
assert.match(app, /onJumpToLine=\{\(line\) => \{ editorRef\.current\?\.revealLine\(line\) \}\}/)
const appVersion = fs.readFileSync(path.join(root, 'src', 'lib', 'appVersion.ts'), 'utf8')
assert.match(appVersion, /from '\.\.\/\.\.\/package\.json'/)
assert.match(appVersion, /export const APP_VERSION/)
assert.equal(typeof packageJson.version, 'string')

console.log(JSON.stringify({
  rows: rows.length,
  headings: REQUIRED_HEADINGS.length,
  paletteActions: paletteIds.length,
  version: packageJson.version,
}, null, 2))
console.log(`user-surfaces ok: ${rows.length} rows`)
