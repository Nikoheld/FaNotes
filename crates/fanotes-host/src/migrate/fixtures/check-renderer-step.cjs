'use strict'

// Runs the real renderer step (fanotes/src/lib/desktopMigration.ts, bundled with esbuild)
// in Electron's Chromium against a Rust export, twice, in a fresh profile, then reads
// every database back and compares it with the fixture's expected.json.
//
//   FANOTES_MIGRATION_EXPORT_OUT=<export> cargo test -p fanotes-host --lib -- --ignored write_export_for_renderer_check
//   xvfb-run -a fanotes/node_modules/electron/dist/electron --no-sandbox \
//     crates/fanotes-host/src/migrate/fixtures/check-renderer-step.cjs --export <export> --out <tmp>

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')

const argument = (name) => process.argv[process.argv.indexOf(name) + 1]
const exportDir = path.resolve(argument('--export'))
const out = path.resolve(argument('--out'))
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
app.setPath('userData', path.join(out, 'profile'))

const repo = path.resolve(__dirname, '../../../../..')
const bundle = require(path.join(repo, 'fanotes/node_modules/esbuild')).buildSync({
  entryPoints: [path.join(repo, 'fanotes/src/lib/desktopMigration.ts')],
  bundle: true, format: 'iife', globalName: 'FaNotesMigration', write: false,
}).outputFiles[0].text

const files = {}
for (const name of fs.readdirSync(exportDir)) if (name.endsWith('.jsonl')) files[name] = fs.readFileSync(path.join(exportDir, name), 'utf8').split('\n').filter(Boolean)
const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'))
const expected = JSON.parse(fs.readFileSync(path.join(exportDir, 'expected.json'), 'utf8'))

const FAKE_HOST = `
  window.__done = []
  window.__TAURI_INTERNALS__ = { invoke: async (command, { args }) => {
    if (command === 'fanotes-native:migration-plan') return window.__plan
    if (command === 'fanotes-native:migration-page') {
      const [file, start] = args
      const lines = window.__files[file].slice(start, start + 25).map((line) => JSON.parse(line))
      return { items: lines, next: start + 25 < window.__files[file].length ? start + 25 : null }
    }
    if (command === 'fanotes-native:migration-done') { window.__done.push(args[0]); return null }
    throw new Error('unexpected ' + command)
  } }`

const DUMP = `(async () => {
  const { encode } = FaNotesMigration
  const request = (value) => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
  const databases = []
  for (const info of (await indexedDB.databases()).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const database = await request(indexedDB.open(info.name))
    const stores = []
    for (const name of [...database.objectStoreNames]) {
      const store = database.transaction(name, 'readonly').objectStore(name)
      const keys = await request(store.getAllKeys())
      const records = await request(store.getAll())
      stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((indexName) => { const index = store.index(indexName); return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry } }),
        records: records.map((value, index) => ({ key: encode(keys[index]), value: encode(value) })) })
    }
    databases.push({ name: database.name, version: database.version, stores })
    database.close()
  }
  const storage = {}
  for (let index = 0; index < localStorage.length; index += 1) { const name = localStorage.key(index); storage[name] = localStorage.getItem(name) }
  return JSON.stringify({ indexedDB: databases, localStorage: Object.fromEntries(Object.entries(storage).sort(([a], [b]) => a < b ? -1 : 1)) })
})()`

app.whenReady().then(async () => {
  const page = path.join(out, 'index.html')
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>check</title>')
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await window.loadFile(page)
  await window.webContents.executeJavaScript(`window.__plan = ${JSON.stringify(manifest)}; window.__files = ${JSON.stringify(files)}; ${FAKE_HOST}; ${bundle}; 1`)
  await window.webContents.executeJavaScript('FaNotesMigration.runDesktopMigration().then(() => FaNotesMigration.runDesktopMigration()).then(() => 1)')
  const done = await window.webContents.executeJavaScript('JSON.stringify(window.__done)')
  const dump = JSON.parse(await window.webContents.executeJavaScript(DUMP))
  const reports = JSON.parse(done)
  let records = 0
  const failures = []
  if (reports.length !== 2) failures.push(`expected two confirmations, got ${reports.length}`)
  for (const report of reports) {
    for (const [name, counts] of Object.entries({ ...report.stores, localStorage: report.localStorage })) {
      if (counts.equal !== counts.expected || counts.keptExisting || counts.failed) failures.push(`${name}: ${JSON.stringify(counts)}`)
    }
  }
  const sortStores = (databases) => databases.map((database) => ({ ...database, stores: [...database.stores].sort((a, b) => a.name < b.name ? -1 : 1).map((store) => ({ ...store, indexes: [...store.indexes].sort((a, b) => a.name < b.name ? -1 : 1) })) }))
  const have = sortStores(dump.indexedDB)
  const want = sortStores(expected.indexedDB)
  for (const database of want) for (const store of database.stores) records += store.records.length
  if (!util.isDeepStrictEqual(have, want)) failures.push('IndexedDB read back differs from expected.json')
  if (!util.isDeepStrictEqual(dump.localStorage, expected.localStorage)) failures.push('localStorage read back differs from expected.json')
  if (failures.length) console.log(`renderer step FAILED:\n${failures.join('\n')}`)
  else console.log(`renderer step OK: ${records} records and ${Object.keys(dump.localStorage).length} localStorage keys equal after two runs`)
  window.destroy()
  app.exit(failures.length ? 1 : 0)
}).catch((error) => { console.error(error); app.exit(1) })
