import assert from 'node:assert/strict'
import test from 'node:test'
import { notifyIntervalMs, startSystemdWatchdog, systemdNotify } from './systemd-notify.mjs'

const fakeSpawn = (calls) => (cmd, args, opts) => {
  calls.push({ cmd, args, socket: opts.env.NOTIFY_SOCKET, path: opts.env.PATH })
  return { on() {}, unref() {} }
}

test('the ping interval is half the watchdog and at least one second', () => {
  assert.equal(notifyIntervalMs(180_000_000), 90_000)
  assert.equal(notifyIntervalMs(1_000_000), 1_000)
  assert.equal(notifyIntervalMs('0'), 0)
  assert.equal(notifyIntervalMs(undefined), 0)
})

test('no ping is sent unless systemd armed the socket', () => {
  const calls = []
  systemdNotify('WATCHDOG=1', { spawnImpl: fakeSpawn(calls), env: {} })
  assert.equal(calls.length, 0)
  const stop = startSystemdWatchdog({ spawnImpl: fakeSpawn(calls), env: { WATCHDOG_USEC: '180000000' } })
  stop()
  assert.equal(calls.length, 0)
})

test('a watchdog ping is sent at once and then at the half interval', () => {
  const calls = []
  let timer = null
  const stop = startSystemdWatchdog({
    env: { NOTIFY_SOCKET: '@fanotes', WATCHDOG_USEC: '10000000' },
    spawnImpl: fakeSpawn(calls),
    setTimer: (fn, ms) => {
      timer = { fn, ms }
      return { unref() {} }
    },
    clearTimer: () => { timer = null },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['--no-block', 'WATCHDOG=1'])
  assert.equal(calls[0].cmd, 'systemd-notify')
  assert.equal(calls[0].socket, '@fanotes')
  assert.equal(calls[0].path, '/usr/bin:/bin')
  assert.equal(timer.ms, 5_000)
  timer.fn()
  assert.equal(calls.length, 2)
  stop()
  assert.equal(timer, null)
})

test('a helper that cannot start does not throw', () => {
  assert.doesNotThrow(() => systemdNotify('WATCHDOG=1', {
    env: { NOTIFY_SOCKET: '/run/systemd/notify' },
    spawnImpl: () => { throw new Error('enoent') },
  }))
})
