import assert from 'node:assert/strict'
import test from 'node:test'
import { createReleaseCache } from './release-cache.mjs'

test('a fresh listing is reused and a stale one is returned while the next load runs', async () => {
  let clock = 1_000
  let loads = 0
  let release = { version: '2026.10.6' }
  const cache = createReleaseCache(async () => {
    loads += 1
    return release
  }, 5_000, () => clock)
  assert.deepEqual(await cache.get(), { version: '2026.10.6' })
  assert.deepEqual(await cache.get('stable'), { version: '2026.10.6' })
  assert.equal(loads, 1)
  clock += 5_000
  release = { version: '2026.10.7' }
  assert.deepEqual(await cache.get(), { version: '2026.10.6' })
  assert.equal(loads, 2)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(await cache.get(), { version: '2026.10.7' })
  assert.equal(loads, 2)
})

test('a failed refresh keeps the previous listing', async () => {
  let clock = 0
  let fail = false
  const cache = createReleaseCache(async () => {
    if (fail) throw new Error('share down')
    return { version: '1' }
  }, 10, () => clock)
  assert.deepEqual(await cache.get(), { version: '1' })
  fail = true
  clock = 10
  assert.deepEqual(await cache.get(), { version: '1' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await cache.get(), { version: '1' })
})

test('a health check does not wait for a share that never answers', async () => {
  const cache = createReleaseCache(() => new Promise(() => {}), 5_000, () => 0)
  const started = Date.now()
  assert.equal(await cache.get('stable', 30), null)
  assert.ok(Date.now() - started < 500)
  assert.equal(await cache.get('stable', 30), null)
})

test('the first load failure is visible', async () => {
  const cache = createReleaseCache(async () => { throw new Error('share down') }, 10, () => 0)
  await assert.rejects(cache.get(), /share down/)
})
