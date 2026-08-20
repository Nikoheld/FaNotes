import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const settingsSource = readFileSync(new URL('../src/components/SettingsModal.tsx', import.meta.url), 'utf8')
const defaultsSource = readFileSync(new URL('../src/defaults.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { defaultSettingsForPlatform } = await server.ssrLoadModule('/src/defaults.ts')

const runOnce = () => {
  assert.match(settingsSource, /id: 'experimental'/)
  assert.match(settingsSource, /title="Notiz-Backup"/)
  assert.match(settingsSource, /experimentalNoteBackup/)
  assert.match(defaultsSource, /experimentalNoteBackup: false/)
  assert.match(typesSource, /experimentalNoteBackup: boolean/)
  assert.match(mainSource, /experimentalNoteBackup: \{ type: 'boolean' \}/)
  assert.equal(defaultSettingsForPlatform('linux').experimentalNoteBackup, false)
  assert.equal(defaultSettingsForPlatform('win32').experimentalNoteBackup, false)

  assert.match(appSource, /className="note-backup-control"/)
  assert.match(appSource, /className=\{`editor-toolbar/)
  assert.match(appSource, /Backup/)
  assert.match(appSource, /noteBackupControlPolicy/)
  assert.match(appSource, /Weiteres Backup/)
  assert.match(appSource, /Wiederherstellen/)
  assert.ok(appSource.indexOf('editor-toolbar') < appSource.indexOf('note-backup-control'))
  assert.doesNotMatch(appSource, /glyphenwerk-sidebar-back[\s\S]{0,40}note-backup-control/)

  return { option: 'Notiz-Backup', defaultOff: true, toolbar: true }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-backup-ui ok')
} finally {
  await server.close()
}
