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

const { sendDataPolicy } = await server.ssrLoadModule('/src/lib/sendData.ts')

const runOnce = () => {
  const off = sendDataPolicy(false)
  assert.equal(off.enabled, false)
  assert.equal(off.ongoing, false)
  assert.equal(sendDataPolicy(undefined).enabled, false)
  assert.equal(sendDataPolicy(null).enabled, false)

  const on = sendDataPolicy(true)
  assert.equal(on.enabled, true)
  assert.equal(on.ongoing, true)

  const offAgain = sendDataPolicy(false)
  assert.equal(offAgain.enabled, false)
  assert.equal(offAgain.ongoing, false)

  return { off: off.enabled, on: on.enabled, offAgain: offAgain.enabled }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('send-data-policy ok')
} finally {
  await server.close()
}
