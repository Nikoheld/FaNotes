'use strict'

// Coordination between the running FaNotes app, the headless background
// updater (`FaNotes --background-update`) and the detached install helpers.
// Everything lives in <userData>/updates and is plain JSON with a pid:
//
//   app-instance.json  written by the app while a window may be open. The
//                      background updater never installs while it names a
//                      live process; it only stages.
//   updater.lock       held while one process checks or downloads, so the app
//                      and the background run never write the same .part file.
//   install.lock       held from the moment an install is decided until the
//                      helper has swapped (or rolled back) the files. An app
//                      that starts meanwhile waits for it instead of running
//                      from a half-replaced installation.
//
// A lock whose pid is gone, or that is older than its limit, is stale. A pid
// that was reused by another program only makes the background run stage
// instead of install, which is the safe direction.

const fs = require('node:fs')
const path = require('node:path')

const INSTANCE_FILE = 'app-instance.json'
const WORK_LOCK_FILE = 'updater.lock'
const INSTALL_LOCK_FILE = 'install.lock'
const LAUNCH_REQUEST_FILE = 'launch-request.json'
const WORK_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000
const INSTALL_LOCK_MAX_AGE_MS = 30 * 60 * 1000
const MAX_LOCK_BYTES = 4096

const isPidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const readLockFile = (filePath) => {
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LOCK_BYTES) return { invalid: true }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger(parsed.pid)) return { invalid: true }
    return { value: parsed }
  } catch (error) {
    return error?.code === 'ENOENT' ? { missing: true } : { invalid: true }
  }
}

const writeJsonAtomic = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

const liveHolder = (filePath, maxAgeMs, { alive = isPidAlive, now = Date.now } = {}) => {
  const read = readLockFile(filePath)
  if (!read.value) return null
  const at = Date.parse(read.value.at || '')
  if (!Number.isFinite(at) || now() - at > maxAgeMs) return null
  if (!alive(read.value.pid)) return null
  return read.value
}

/**
 * Creates the lock with O_EXCL. A stale or unreadable lock is removed once and
 * the exclusive create is retried, so two racing processes cannot both win.
 */
const tryAcquire = (filePath, maxAgeMs, details = {}, options = {}) => {
  const alive = options.alive ?? isPidAlive
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(filePath, 'wx', 0o600)
      try {
        fs.writeSync(handle, `${JSON.stringify({ ...details, pid, at: new Date(now()).toISOString() })}\n`)
      } finally {
        fs.closeSync(handle)
      }
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const holder = liveHolder(filePath, maxAgeMs, { alive, now })
    if (holder) return holder.pid === pid
    fs.rmSync(filePath, { force: true })
  }
  return false
}

const releaseIfOwned = (filePath, pid = process.pid) => {
  const read = readLockFile(filePath)
  if (read.value?.pid === pid) fs.rmSync(filePath, { force: true })
}

function createUpdateLocks(updaterRoot, options = {}) {
  const alive = options.alive ?? isPidAlive
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  const instancePath = path.join(updaterRoot, INSTANCE_FILE)
  const workPath = path.join(updaterRoot, WORK_LOCK_FILE)
  const installPath = path.join(updaterRoot, INSTALL_LOCK_FILE)
  const launchRequestPath = path.join(updaterRoot, LAUNCH_REQUEST_FILE)
  let workDepth = 0

  return {
    paths: { instance: instancePath, work: workPath, install: installPath, launchRequest: launchRequestPath },

    /** The app marks itself as running for as long as a window may be open. */
    markAppRunning(details = {}) {
      writeJsonAtomic(instancePath, { ...details, pid, at: new Date(now()).toISOString() })
    },
    clearAppRunning() {
      releaseIfOwned(instancePath, pid)
    },
    /** Another live FaNotes app process, or null. The instance marker never goes stale by age. */
    runningApp() {
      const holder = liveHolder(instancePath, Number.POSITIVE_INFINITY, { alive, now })
      return holder && holder.pid !== pid ? holder : null
    },

    /** Re-entrant within one process: the app's check() and download() nest. */
    acquireWork(details = {}) {
      if (workDepth > 0) {
        workDepth += 1
        return true
      }
      const acquired = tryAcquire(workPath, WORK_LOCK_MAX_AGE_MS, details, { alive, now, pid })
      if (acquired) workDepth = 1
      return acquired
    },
    releaseWork() {
      if (workDepth === 0) return
      workDepth -= 1
      if (workDepth === 0) releaseIfOwned(workPath, pid)
    },

    acquireInstall(details = {}) {
      return tryAcquire(installPath, INSTALL_LOCK_MAX_AGE_MS, details, { alive, now, pid })
    },
    /** The detached helper takes over the install lock before this process exits. */
    handInstallTo(helperPid, details = {}) {
      writeJsonAtomic(installPath, { ...details, pid: helperPid, at: new Date(now()).toISOString() })
    },
    releaseInstall() {
      releaseIfOwned(installPath, pid)
    },
    installHolder() {
      return liveHolder(installPath, INSTALL_LOCK_MAX_AGE_MS, { alive, now })
    },

    requestLaunchAfterInstall() {
      writeJsonAtomic(launchRequestPath, { pid, at: new Date(now()).toISOString() })
    },
    clearLaunchRequest() {
      fs.rmSync(launchRequestPath, { force: true })
    },
  }
}

/**
 * Called by the app before it opens a window. While a background install is
 * swapping files, wait for it (bounded) instead of starting a half-replaced
 * installation. Resolves to the holder that was waited for, or null.
 */
async function waitForInstallToFinish(locks, { timeoutMs = 5 * 60 * 1000, pollMs = 400, sleep } = {}) {
  const holder = locks.installHolder()
  if (!holder) return null
  locks.requestLaunchAfterInstall()
  const pause = sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms) }))
  const deadline = Date.now() + timeoutMs
  while (locks.installHolder() && Date.now() < deadline) await pause(pollMs)
  locks.clearLaunchRequest()
  return holder
}

module.exports = {
  INSTALL_LOCK_FILE,
  INSTANCE_FILE,
  LAUNCH_REQUEST_FILE,
  WORK_LOCK_FILE,
  createUpdateLocks,
  isPidAlive,
  waitForInstallToFinish,
}
