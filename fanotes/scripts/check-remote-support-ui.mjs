import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const settingsSource = readFileSync(new URL('../src/components/SettingsModal.tsx', import.meta.url), 'utf8')
const defaultsSource = readFileSync(new URL('../src/defaults.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

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
  assert.match(settingsSource, /count: 3/)
  assert.match(settingsSource, /title="Handschrift zu Text"/)
  assert.match(settingsSource, /title="Hausaufgaben API"/)
  assert.match(settingsSource, /title="Remote Support"/)
  assert.match(settingsSource, /label="Remote Support"/)
  assert.match(settingsSource, /Sitzung starten/)
  assert.match(settingsSource, /Sitzung beenden/)
  assert.ok(settingsSource.indexOf('title="Handschrift zu Text"') < settingsSource.indexOf('title="Remote Support"'))
  assert.ok(settingsSource.indexOf('title="Hausaufgaben API"') < settingsSource.indexOf('title="Remote Support"'))

  const linux = defaultSettingsForPlatform('linux')
  const windows = defaultSettingsForPlatform('win32')
  assert.equal(linux.experimentalRemoteSupport, false)
  assert.equal(windows.experimentalRemoteSupport, false)
  assert.equal(linux.experimentalHandwritingToText, false)
  assert.equal(linux.experimentalHomeworkApi, false)
  assert.equal(windows.experimentalHandwritingToText, false)
  assert.equal(windows.experimentalHomeworkApi, false)

  assert.match(defaultsSource, /experimentalRemoteSupport: false/)
  assert.match(typesSource, /experimentalRemoteSupport: boolean/)
  assert.match(appSource, /startRemoteSupportSession/)
  assert.match(appSource, /dispatchRemoteSupportCommand/)
  assert.match(appSource, /applyRemoteSupportBoardDrive/)
  assert.match(appSource, /flushRemoteSupportBoardDrive/)
  assert.match(settingsSource, /experimentalHandwritingToText/)
  assert.match(settingsSource, /experimentalHomeworkApi/)
  assert.equal(settingsSource.includes('experimentalRemoteSupport') && settingsSource.includes('experimentalHomeworkApi'), true)
}

try {
  runOnce()
  runOnce()
  console.log(JSON.stringify({
    experimentalCount: 3,
    defaultOff: true,
    rows: ['Handschrift zu Text', 'Hausaufgaben API', 'Remote Support'],
  }))
  console.log('remote-support-ui ok')
} finally {
  await server.close()
}
