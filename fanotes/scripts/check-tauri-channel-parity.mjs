import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '..')
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8')

const names = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1])
const preload = names(read('electron/preload.cjs').slice(0, read('electron/preload.cjs').indexOf('const invoke')), /'(fanotes:[^']+)'/g)
const host = [...new Set(names(fs.readFileSync(path.join(repoRoot, 'crates/fanotes-host/src/channels.rs'), 'utf8'), /"(fanotes:[^"]+)"/g))]
// The generated list is `name => "fanotes:..."`. Window commands are handwritten
// as `#[tauri::command(rename = "fanotes:...")]` and are not in that list.
const commands = [...new Set([
  ...names(read('src-tauri/src/lib.rs'), /=> "(fanotes:[^"]+)"/g),
  ...names(read('src-tauri/src/lib.rs'), /rename = "(fanotes:[^"]+)"/g),
])]
const bridge = [...new Set([
  ...names(read('src-tauri/src/fanotes-api.js'), /invoke\('(fanotes:[^']+)'/g),
  ...names(read('src-tauri/src/fanotes-api.js'), /listen\('(fanotes:[^']+)'/g),
])]
const same = (left, right, label) => {
  const missing = left.filter((name) => !right.includes(name))
  const extra = right.filter((name) => !left.includes(name))
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label} weicht von preload.cjs ab`)
}

assert.ok(preload.length > 90, 'Die Preload-Kanalliste ist unvollständig.')
same(preload, host, 'fanotes-host')
same(preload, commands, 'Tauri-Befehle')
same(preload, bridge, 'window.fanotes')

const packageJson = JSON.parse(read('package.json'))
assert.equal(packageJson.main, 'electron/main.cjs')
assert.match(packageJson.scripts['dist:linux'], /electron-builder/)
assert.equal(packageJson.scripts.dev.includes('electron .'), true)
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))
assert.equal(tauriConfig.bundle.active, false, 'Tauri darf das Electron-Release nicht ersetzen.')
assert.equal(tauriConfig.build.frontendDist, '../dist')

const test = spawnSync('cargo', ['test', '-p', 'fanotes-host', '--', '--test-threads=8'], {
  cwd: repoRoot,
  stdio: 'inherit',
})
assert.equal(test.status, 0, 'Die Host-Prüfungen für Pfade, SSRF, Geheimnisse und den Updater sind fehlgeschlagen.')
console.log(`Tauri-Kanalparität: ${preload.length} Preload-Kanäle haben einen Befehl. Electron bleibt der Release-Host.`)
