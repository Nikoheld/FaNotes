import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { buildSendDataPayload, linuxHyprlandRuntimeContext } = await server.ssrLoadModule('/src/lib/sendData.ts')

const runOnce = () => {
  const disabled = buildSendDataPayload({
    enabled: false,
    logs: [{ at: 1, kind: 'app', message: 'start' }],
    nutzerdaten: { version: '2026.8.50', platform: 'linux' },
    linux: { env: { XDG_CURRENT_DESKTOP: 'Hyprland' } },
  })
  assert.equal(disabled.send, false)

  const linux = linuxHyprlandRuntimeContext({
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
  })
  assert.equal(linux.hyprland, true)
  assert.equal(linux.ozone, 'x11')
  assert.notEqual(linux.desktop.toLowerCase(), 'linux')
  assert.match(linux.desktop, /Hyprland/i)

  const live = buildSendDataPayload({
    enabled: true,
    logs: [{ at: 1, kind: 'app', message: 'session-start' }],
    nutzerdaten: {
      version: '2026.8.50',
      platform: 'linux',
      theme: 'dark',
      hasOpenNote: true,
    },
    linux,
    now: 1_700_000_000_000,
  })
  assert.equal(live.send, true)
  assert.ok(live.send)
  if (!live.send) throw new Error('expected send')
  assert.equal(live.payload.kind, 'send-data')
  assert.equal(live.payload.logs[0].message, 'session-start')
  assert.equal(live.payload.nutzerdaten.version, '2026.8.50')
  assert.equal(live.payload.nutzerdaten.hasOpenNote, true)
  assert.equal(live.payload.linux.hyprland, true)
  assert.equal(live.payload.linux.ozone, 'x11')
  assert.equal(live.payload.linux.hyprlandZeroScaling, true)
  assert.notEqual(live.payload.linux.platform + live.payload.linux.desktop, 'linux')

  return {
    disabled: disabled.send,
    hyprland: live.payload.linux.hyprland,
    ozone: live.payload.linux.ozone,
    logs: live.payload.logs.length,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('send-data-payload ok')
} finally {
  await server.close()
}
