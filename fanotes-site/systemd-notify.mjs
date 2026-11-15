import { spawn } from 'node:child_process'

/** Half the watchdog window, in milliseconds. Zero when systemd did not arm a watchdog. */
export const notifyIntervalMs = (watchdogUsec) => {
  const usec = Number(watchdogUsec)
  if (!Number.isFinite(usec) || usec < 1) return 0
  return Math.max(1_000, Math.floor(usec / 2_000))
}

/**
 * Tell systemd the process is alive. Node on this host cannot open a Unix datagram
 * socket, so this asks systemd-notify, which writes WATCHDOG=1 to NOTIFY_SOCKET.
 * Nothing is sent when systemd did not set that socket.
 */
export const systemdNotify = (state, { spawnImpl = spawn, env = process.env } = {}) => {
  if (!env.NOTIFY_SOCKET || typeof state !== 'string' || !state) return
  try {
    const child = spawnImpl('systemd-notify', ['--no-block', state.endsWith('\n') ? state.slice(0, -1) : state], {
      stdio: 'ignore',
      env: { NOTIFY_SOCKET: env.NOTIFY_SOCKET, PATH: '/usr/bin:/bin' },
    })
    child.on?.('error', () => {})
    child.unref?.()
  } catch {
    // A missing helper must not take the site down. The watchdog still fires if pings never arrive.
  }
}

/** Ping once, then at half the WatchdogSec interval. Returns a stopper. */
export const startSystemdWatchdog = ({ spawnImpl = spawn, env = process.env, setTimer = setInterval, clearTimer = clearInterval } = {}) => {
  const intervalMs = notifyIntervalMs(env.WATCHDOG_USEC)
  if (!env.NOTIFY_SOCKET || !intervalMs) return () => {}
  const ping = () => systemdNotify('WATCHDOG=1', { spawnImpl, env })
  ping()
  const timer = setTimer(ping, intervalMs)
  timer.unref?.()
  return () => clearTimer(timer)
}
