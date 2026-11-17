import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReleaseCache } from './release-cache.mjs'
import { readReleaseShare } from './release-list.mjs'

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

test('a second health check does not wait again while the share is still silent', async () => {
  const cache = createReleaseCache(() => new Promise(() => {}), 5_000, () => 0)
  const first = Date.now()
  assert.equal(await cache.get('stable', 40), null)
  assert.ok(Date.now() - first >= 30)
  const second = Date.now()
  assert.equal(await cache.get('stable', 40), null)
  assert.ok(Date.now() - second < 25)
})

test('the first load failure is visible', async () => {
  const cache = createReleaseCache(async () => { throw new Error('share down') }, 10, () => 0)
  await assert.rejects(cache.get(), /share down/)
})

test('a release share listing reads files and checksums from the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanotes-release-'))
  try {
    await writeFile(join(dir, 'FaNotes.AppImage'), 'package')
    await writeFile(join(dir, 'SHA256SUMS'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  FaNotes.AppImage\n')
    const share = await readReleaseShare(dir, { timeoutMs: 5_000 })
    assert.deepEqual([...share.files].sort(), ['FaNotes.AppImage', 'SHA256SUMS'])
    assert.match(share.checksums, /FaNotes\.AppImage/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a release share listing that runs too long is killed and stays in flight until it exits', async () => {
  let killed = ''
  let onExit = null
  const child = {
    stdout: { on() {} },
    kill(signal) { killed = signal },
    on(event, fn) { if (event === 'exit') onExit = fn },
  }
  let timer = null
  const pending = readReleaseShare('/releases', {
    spawnImpl: (cmd, args) => {
      assert.equal(args.at(-2), '--')
      assert.equal(args.at(-1), '/releases')
      assert.equal(cmd, process.execPath)
      return child
    },
    timeoutMs: 15,
    setTimeoutImpl: (fn, ms) => {
      timer = { fn, ms }
      return { unref() {} }
    },
    clearTimeoutImpl: () => { timer = null },
  })
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  assert.equal(timer.ms, 15)
  timer.fn()
  assert.equal(killed, 'SIGKILL')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  onExit(null)
  await assert.rejects(pending, /release list failed/)
  assert.equal(settled, true)
})
