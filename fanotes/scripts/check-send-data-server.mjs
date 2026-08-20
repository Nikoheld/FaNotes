import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  acceptSendDataPayload,
  persistSendDataReport,
  SEND_DATA_MAX_BODY_BYTES as handlerMaxBody,
  sendDataCorsHeaders,
} from '../../fanotes-site/send-data-api.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const serverSource = readFileSync(new URL('../../fanotes-site/server.mjs', import.meta.url), 'utf8')
const handlerSource = readFileSync(new URL('../../fanotes-site/send-data-api.mjs', import.meta.url), 'utf8')
const nginxSource = readFileSync(new URL('../../fanotes-site/deploy/fanotes-fasrv.conf', import.meta.url), 'utf8')
const serviceSource = readFileSync(new URL('../../fanotes-site/deploy/fanotes-site.service', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  planSendDataTick,
  SEND_DATA_MAX_BYTES,
  SEND_DATA_PATH,
} = await server.ssrLoadModule('/src/lib/sendData.ts')

const runOnce = async () => {
  assert.match(serverSource, /handleSendDataRequest/)
  assert.ok(serverSource.indexOf('handleSendDataRequest') < serverSource.indexOf("Nur GET und HEAD sind erlaubt"))
  assert.match(handlerSource, /Access-Control-Allow-Origin/)
  assert.match(handlerSource, /OPTIONS/)
  assert.match(handlerSource, /persistSendDataReport/)
  assert.match(nginxSource, /location = \/api\/v1\/send-data \{[\s\S]*?Cross-Origin-Resource-Policy "cross-origin"/u)
  assert.match(serviceSource, /FANOTES_SEND_DATA_DIR=\/var\/lib\/fanotes-send-data/)
  assert.match(serviceSource, /ReadWritePaths=\/var\/lib\/fanotes-send-data/)
  assert.equal(sendDataCorsHeaders['Access-Control-Allow-Methods'], 'POST, OPTIONS')
  assert.equal(SEND_DATA_MAX_BYTES, handlerMaxBody)
  assert.equal(SEND_DATA_PATH, '/api/v1/send-data')

  const off = planSendDataTick({
    enabled: false,
    logs: [{ at: 1, kind: 'app', message: 'session-start' }],
    nutzerdaten: { version: '2026.8.50', platform: 'linux' },
    linux: { platform: 'linux', ozone: 'x11', env: { XDG_CURRENT_DESKTOP: 'Hyprland' } },
    now: 1_700_000_000_000,
  })
  assert.equal(off.send, false)
  assert.equal(acceptSendDataPayload(off.payload).ok, false)

  const planned = planSendDataTick({
    enabled: true,
    logs: [{ at: 1, kind: 'app', message: 'session-start', platform: 'linux' }],
    nutzerdaten: {
      version: '2026.8.50',
      platform: 'linux',
      theme: 'dark',
      hasOpenNote: true,
    },
    linux: {
      platform: 'linux',
      ozone: 'x11',
      hyprlandZeroScaling: true,
      env: {
        XDG_CURRENT_DESKTOP: 'Hyprland',
        XDG_SESSION_TYPE: 'wayland',
        HYPRLAND_INSTANCE_SIGNATURE: 'instance-1',
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-1',
        ELECTRON_OZONE_PLATFORM_HINT: 'x11',
      },
    },
    now: 1_700_000_000_000,
  })
  assert.equal(planned.send, true)
  assert.match(planned.body, /send-data/)
  const accepted = acceptSendDataPayload(JSON.parse(planned.body))
  assert.equal(accepted.ok, true)
  assert.equal(accepted.status, 202)
  assert.equal(accepted.report.kind, 'send-data')
  assert.equal(accepted.report.logs[0].message, 'session-start')
  assert.equal(accepted.report.nutzerdaten.version, '2026.8.50')
  assert.equal(accepted.report.nutzerdaten.hasOpenNote, true)
  assert.equal(accepted.report.linux.hyprland, true)
  assert.equal(accepted.report.linux.ozone, 'x11')
  assert.match(accepted.report.linux.desktop, /Hyprland/i)
  assert.notEqual(accepted.report.linux.desktop.toLowerCase(), 'linux')

  assert.equal(acceptSendDataPayload({ kind: 'send-data' }).ok, false)
  assert.equal(acceptSendDataPayload({ kind: 'send-data', nutzerdaten: { version: '1', platform: 'linux' } }).ok, false)

  const cacheRoot = join(appRoot, '..', '.fanotes-build-cache')
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
  const store = mkdtempSync(join(cacheRoot, 'send-data-'))
  const id = await persistSendDataReport(accepted.report, store)
  const files = readdirSync(store).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1)
  const stored = JSON.parse(readFileSync(join(store, `${id}.json`), 'utf8'))
  assert.equal(stored.linux.hyprland, true)
  assert.equal(stored.nutzerdaten.version, '2026.8.50')
  assert.equal(stored.logs[0].message, 'session-start')

  return {
    accepted: accepted.ok,
    hyprland: accepted.report.linux.hyprland,
    ozone: accepted.report.linux.ozone,
    persisted: files.length,
    offRejected: true,
  }
}

try {
  const first = await runOnce()
  const second = await runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('send-data-server ok')
} finally {
  await server.close()
}
