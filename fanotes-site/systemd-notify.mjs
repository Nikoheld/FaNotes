import { spawn } from 'node:child_process'

/** Half the watchdog window, in milliseconds. Zero when systemd did not arm a watchdog. */
export const notifyIntervalMs = (watchdogUsec) => {
  const usec = Number(watchdogUsec)
  if (!Number.isFinite(usec) || usec < 1) return 0
  return Math.max(1_000, Math.floor(usec / 2_000))
}

/**
 * How long a ping may stay running. systemd-notify must still be alive when PID 1
 * reads the datagram, or the ping is ignored (systemd-notify(1), --no-block).
 * The wait is far shorter than the ping interval, so a stuck helper is killed
 * before the next ping and cannot fill TasksMax.
 */
export const NOTIFY_WAIT_MS = 5_000

/**
 * Tell systemd the process is alive. Node on this host cannot open a Unix datagram
 * socket, so this asks systemd-notify, which writes WATCHDOG=1 to NOTIFY_SOCKET.
 * The helper waits until systemd has accepted the message. Nothing is sent when
 * systemd did not set that socket. Returns the child, or null when nothing was sent.
 */
export const systemdNotify = (state, {
  spawnImpl = spawn,
  env = process.env,
  killAfterMs = NOTIFY_WAIT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) => {
  if (!env.NOTIFY_SOCKET || typeof state !== 'string' || !state) return null
  try {
    const child = spawnImpl('systemd-notify', [state.endsWith('\n') ? state.slice(0, -1) : state], {
      stdio: 'ignore',
      env: { NOTIFY_SOCKET: env.NOTIFY_SOCKET, PATH: '/usr/bin:/bin' },
    })
    let timer = null
    const done = () => {
      if (timer) clearTimeoutImpl(timer)
      timer = null
    }
    child.on?.('exit', done)
    child.on?.('error', () => {})
    if (killAfterMs > 0) {
      timer = setTimeoutImpl(() => {
        timer = null
        try { child.kill?.('SIGKILL') } catch { /* already gone */ }
      }, killAfterMs)
      timer.unref?.()
    }
    child.unref?.()
    return child
  } catch {
    // A missing helper must not take the site down. The watchdog still fires if pings never arrive.
    return null
  }
}

/** Ping once, then at half the WatchdogSec interval. A ping still in flight is left to finish. Returns a stopper. */
export const startSystemdWatchdog = ({ spawnImpl = spawn, env = process.env, setTimer = setInterval, clearTimer = clearInterval, killAfterMs = NOTIFY_WAIT_MS, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) => {
  const intervalMs = notifyIntervalMs(env.WATCHDOG_USEC)
  if (!env.NOTIFY_SOCKET || !intervalMs) return () => {}
  let running = false
  const ping = () => {
    if (running) return
    running = true
    const child = systemdNotify('WATCHDOG=1', { spawnImpl, env, killAfterMs, setTimeoutImpl, clearTimeoutImpl })
    if (!child) {
      running = false
      return
    }
    const finish = () => { running = false }
    child.on?.('exit', finish)
    child.on?.('error', finish)
  }
  ping()
  const timer = setTimer(ping, intervalMs)
  timer.unref?.()
  return () => clearTimer(timer)
}
