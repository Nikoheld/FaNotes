import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const settingsSource = readFileSync(new URL('../src/components/SettingsModal.tsx', import.meta.url), 'utf8')
const defaultsSource = readFileSync(new URL('../src/defaults.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { defaultSettingsForPlatform } = await server.ssrLoadModule('/src/defaults.ts')
const { sendDataPolicy } = await server.ssrLoadModule('/src/lib/sendData.ts')

const runOnce = () => {
  assert.match(settingsSource, /id: 'experimental'/)
  assert.match(settingsSource, /title="Send Data"/)
  assert.match(settingsSource, /experimentalSendData/)
  assert.match(defaultsSource, /experimentalSendData: false/)
  assert.match(typesSource, /experimentalSendData: boolean/)
  assert.match(mainSource, /experimentalSendData: \{ type: 'boolean' \}/)
  assert.equal(defaultSettingsForPlatform('linux').experimentalSendData, false)
  assert.equal(defaultSettingsForPlatform('win32').experimentalSendData, false)
  assert.equal(sendDataPolicy(defaultSettingsForPlatform('linux').experimentalSendData).enabled, false)
  assert.match(appSource, /planSendDataTick|sendDataPolicy/)
  assert.doesNotMatch(appSource, /glyphenwerk-sidebar-back[\s\S]{0,40}Send Data/)
  assert.doesNotMatch(settingsSource, /id: 'onboarding'[\s\S]{0,80}Send Data/)
  return { option: 'Send Data', defaultOff: true }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('send-data-ui ok')
} finally {
  await server.close()
}
