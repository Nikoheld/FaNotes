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

const { decideSendDataTick, planSendDataTick, SEND_DATA_MIN_INTERVAL_MS } = await server.ssrLoadModule('/src/lib/sendData.ts')

const runOnce = () => {
  const interval = 60_000
  const body = JSON.stringify({ kind: 'send-data', logs: [{ at: 1 }], linux: { hyprland: true, ozone: 'x11' } })
  const first = decideSendDataTick({
    enabled: true,
    now: 1_000,
    lastSentAt: null,
    body,
    minIntervalMs: interval,
    maxBytes: 4_000,
  })
  assert.equal(first.send, true)
  assert.equal(first.reason, 'send')

  const tooSoon = decideSendDataTick({
    enabled: true,
    now: 1_000 + 5_000,
    lastSentAt: 1_000,
    body,
    lastBodyHash: first.hash,
    minIntervalMs: interval,
    maxBytes: 4_000,
  })
  assert.equal(tooSoon.send, false)
  assert.equal(tooSoon.reason, 'too-soon')

  const duplicate = decideSendDataTick({
    enabled: true,
    now: 1_000 + interval,
    lastSentAt: 1_000,
    body,
    lastBodyHash: first.hash,
    minIntervalMs: interval,
    maxBytes: 4_000,
  })
  assert.equal(duplicate.send, false)
  assert.equal(duplicate.reason, 'duplicate')

  const empty = decideSendDataTick({
    enabled: true,
    now: 1_000 + interval,
    lastSentAt: 1_000,
    body: '',
    minIntervalMs: interval,
  })
  assert.equal(empty.send, false)
  assert.equal(empty.reason, 'empty')

  const oversized = decideSendDataTick({
    enabled: true,
    now: 1_000 + interval,
    lastSentAt: 1_000,
    body: `${body}${'x'.repeat(8_000)}`,
    minIntervalMs: interval,
    maxBytes: 100,
  })
  assert.equal(oversized.send, false)
  assert.equal(oversized.reason, 'oversized')

  const later = decideSendDataTick({
    enabled: true,
    now: 1_000 + interval,
    lastSentAt: 1_000,
    body: JSON.stringify({ kind: 'send-data', logs: [{ at: 2, message: 'later' }] }),
    lastBodyHash: first.hash,
    minIntervalMs: interval,
    maxBytes: 4_000,
  })
  assert.equal(later.send, true)
  assert.equal(later.reason, 'send')

  const idle = decideSendDataTick({
    enabled: true,
    now: 1_000 + interval,
    lastSentAt: 1_000,
    body,
    idle: true,
    minIntervalMs: interval,
  })
  assert.equal(idle.send, false)
  assert.equal(idle.reason, 'idle')

  const plannedOff = planSendDataTick({
    enabled: false,
    logs: [{ at: 1 }],
    now: 2_000,
  })
  assert.equal(plannedOff.send, false)

  assert.ok(SEND_DATA_MIN_INTERVAL_MS >= 60_000)

  return {
    first: first.send,
    tooSoon: tooSoon.send,
    duplicate: duplicate.send,
    empty: empty.send,
    oversized: oversized.send,
    later: later.send,
    idle: idle.send,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('send-data-battery ok')
} finally {
  await server.close()
}
