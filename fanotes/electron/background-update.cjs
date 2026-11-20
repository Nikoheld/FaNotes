'use strict'

// `FaNotes --background-update`: one headless run of the app's own updater,
// started by the Scheduled Task (Windows) or the systemd user timer / XDG
// autostart entry (Linux). No window, no renderer, no GPU; it exits after the
// run. It uses the same createUpdateManager as the app, so signature,
// channel, tag binding, no-downgrade (highest seen version), SHA-256 and
// rollback rules are one implementation, not a copy.
//
// While FaNotes is running (app-instance.json names a live process) the run
// only stages the verified package; the app installs it when it quits.
// Otherwise it hands the package to the install helper in "quiet" mode, so
// the next start is already the new version.
//
// `FaNotes --fanotes-self-test`: the headless start the install helpers use
// to check a freshly installed version before they keep it.

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { createUpdateLocks } = require('./update-lock.cjs')

const STATUS_FILE = 'background-status.json'
const LOG_FILE = 'background.log'
const MAX_LOG_BYTES = 64 * 1024
/** A logon trigger right after a timer run does not ask GitHub again. */
const MIN_CHECK_INTERVAL_MS = 60 * 60 * 1000
const BACKOFF_BASE_MS = 60 * 60 * 1000
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000
const HARD_STOP_MS = 55 * 60 * 1000
const SELF_TEST_FILE = 'self-test.json'

/**
 * A run without windows needs no GPU process and no separate network service
 * (the updater uses Node's fetch). Measured on Linux: 163 MiB PSS in 7
 * processes without these switches, 121 MiB in 4 with them.
 */
const configureHeadless = (app) => {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('in-process-gpu')
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2')
  app.on('window-all-closed', () => {})
}

const backoffDelay = (failures) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))

const readStatus = async (updaterRoot) => {
  try {
    const raw = await fsp.readFile(path.join(updaterRoot, STATUS_FILE), 'utf8')
    if (raw.length > 16 * 1024) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const writeStatus = async (updaterRoot, status) => {
  await fsp.mkdir(updaterRoot, { recursive: true, mode: 0o700 })
  const target = path.join(updaterRoot, STATUS_FILE)
  const temporary = `${target}.${process.pid}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temporary, target)
}

/** One line per run, at most 64 KiB plus one rotated file. */
const appendLog = async (updaterRoot, line) => {
  const target = path.join(updaterRoot, LOG_FILE)
  try {
    const info = await fsp.stat(target).catch(() => null)
    if (info && info.size > MAX_LOG_BYTES) await fsp.rename(target, `${target}.1`)
    await fsp.appendFile(target, `${line.replace(/[\r\n]+/gu, ' ').slice(0, 600)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Logging never fails a run.
  }
}

const execText = (command, args, timeoutMs) => new Promise((resolve) => {
  execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, stdout) => {
    resolve(error ? null : String(stdout || ''))
  })
})

/**
 * Best effort and only asked when a download is due. Linux: NetworkManager's
 * Metered property (1 yes, 3 guess-yes). Windows: the cost type of the
 * internet connection profile (Fixed or Variable is a metered plan).
 * Unknown counts as not metered.
 */
async function detectMeteredConnection({ platform = process.platform, run = execText } = {}) {
  if (platform === 'linux') {
    const output = await run('gdbus', [
      'call', '--system', '--dest', 'org.freedesktop.NetworkManager', '--object-path', '/org/freedesktop/NetworkManager',
      '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.NetworkManager', 'Metered',
    ], 3_000)
    const match = /uint32\s+(\d+)/u.exec(output || '')
    return match ? match[1] === '1' || match[1] === '3' : false
  }
  if (platform === 'win32') {
    const script = '[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime];'
      + '$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile();'
      + 'if($p){$p.GetConnectionCost().NetworkCostType.ToString()}'
    const output = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 8_000)
    return /^(Fixed|Variable)\s*$/mu.test(output || '')
  }
  return false
}

/**
 * The decision logic of one background run. Everything platform-specific is
 * injected, so the checks drive it against a local fake release server.
 */
async function runBackgroundUpdate({
  updaterRoot,
  settings,
  createManager,
  isOnline = () => true,
  isMetered = () => false,
  locks = createUpdateLocks(updaterRoot),
  now = Date.now,
  currentVersion,
}) {
  const startedAt = now()
  const previous = await readStatus(updaterRoot)
  const failures = Number.isSafeInteger(previous.failures) && previous.failures > 0 ? previous.failures : 0
  const base = {
    schemaVersion: 1,
    lastRunAt: new Date(startedAt).toISOString(),
    lastCheckAt: typeof previous.lastCheckAt === 'string' ? previous.lastCheckAt : null,
    currentVersion,
    latestVersion: typeof previous.latestVersion === 'string' ? previous.latestVersion : null,
    failures,
    nextAllowedAt: typeof previous.nextAllowedAt === 'string' ? previous.nextAllowedAt : null,
  }
  // Runs that never asked GitHub keep the outcome of the last real check.
  const skipped = new Set(['disabled', 'backoff', 'recent', 'offline'])
  const finish = async (result, message = null, patch = {}) => {
    const text = message ? String(message).slice(0, 400) : null
    const status = {
      ...base,
      ...patch,
      result,
      message: text,
      checkResult: skipped.has(result) ? (previous.checkResult ?? null) : result,
      checkMessage: skipped.has(result) ? (previous.checkMessage ?? null) : text,
    }
    await writeStatus(updaterRoot, status).catch(() => {})
    await appendLog(updaterRoot, [
      status.lastRunAt,
      `result=${result}`,
      `version=${currentVersion}`,
      `latest=${status.latestVersion ?? '-'}`,
      `failures=${status.failures}`,
      `ms=${now() - startedAt}`,
      message ? JSON.stringify(String(message).slice(0, 200)) : '',
    ].join(' ').trim())
    return status
  }
  const fail = (message, patch = {}) => {
    const nextFailures = failures + 1
    return finish('error', message, {
      ...patch,
      failures: nextFailures,
      nextAllowedAt: new Date(now() + backoffDelay(nextFailures)).toISOString(),
    })
  }

  if (!settings.backgroundUpdates || !settings.autoCheckUpdates) return finish('disabled')
  const nextAllowed = Date.parse(base.nextAllowedAt || '')
  if (Number.isFinite(nextAllowed) && startedAt < nextAllowed) return finish('backoff')
  const lastCheck = Date.parse(base.lastCheckAt || '')
  if (Number.isFinite(lastCheck) && startedAt - lastCheck < MIN_CHECK_INTERVAL_MS && ['up-to-date', 'staged', 'installing'].includes(previous.checkResult)) {
    return finish('recent')
  }
  if (!await isOnline()) return finish('offline')

  // Downloads are started explicitly below, after the metered-network check.
  const manager = createManager({ ...settings, autoDownloadUpdates: false })
  try {
    await manager.initialize({ consumeInstallResult: false })
    const checked = await manager.check({ manual: false })
    const checkedPatch = { lastCheckAt: new Date(now()).toISOString(), latestVersion: checked.latestVersion ?? base.latestVersion }
    if (checked.status === 'error') return fail(checked.error, checkedPatch)
    if (checked.status === 'idle') return finish('busy', 'FaNotes prüft gerade selbst auf Updates.')
    const healthy = { ...checkedPatch, failures: 0, nextAllowedAt: null }
    if (checked.status === 'up-to-date') return finish('up-to-date', null, healthy)
    if (checked.latestVersion && checked.latestVersion === checked.failedInstallVersion) {
      return finish('blocked', checked.error, healthy)
    }
    let ready = checked
    if (ready.status === 'available') {
      if (!settings.autoDownloadUpdates) return finish('available', null, healthy)
      if (await isMetered()) return finish('metered', 'Getaktete Verbindung: Der Download wartet auf ein freies Netz.', healthy)
      ready = await manager.download()
      if (ready.status === 'error') return fail(ready.error, checkedPatch)
      if (ready.status !== 'downloaded') return finish('busy', 'FaNotes lädt das Update gerade selbst herunter.', healthy)
    }
    if (ready.status !== 'downloaded') return finish('busy', null, healthy)

    // Take the install lock first, then look for a running app. The app marks
    // itself first and then looks at the lock, so one of the two always sees
    // the other.
    if (!locks.acquireInstall({ version: ready.latestVersion })) return finish('busy', 'Ein Update wird bereits installiert.', healthy)
    if (locks.runningApp()) {
      locks.releaseInstall()
      return finish('staged', 'FaNotes läuft; das geprüfte Update wird beim Beenden installiert.', healthy)
    }
    let installed
    try {
      installed = await manager.prepareInstall({ mode: 'quiet' })
    } catch (error) {
      locks.releaseInstall()
      return fail(error?.message || error, checkedPatch)
    }
    if (installed.status !== 'installing') {
      locks.releaseInstall()
      return fail(installed.error || 'Die Installation konnte nicht gestartet werden.', checkedPatch)
    }
    return finish('installing', null, healthy)
  } catch (error) {
    return fail(error?.message || error)
  } finally {
    manager.stop?.({ abortDownload: false })
  }
}

const readUpdateSettings = (userDataPath, defaults) => {
  try {
    const raw = fs.readFileSync(path.join(userDataPath, 'config.json'), 'utf8')
    if (raw.length > 2 * 1024 * 1024) return { ...defaults }
    const parsed = JSON.parse(raw)
    const { sanitizeSettings } = require('./settings-sanitize.cjs')
    const picked = {}
    for (const key of Object.keys(defaults)) {
      if (parsed?.settings && Object.prototype.hasOwnProperty.call(parsed.settings, key)) picked[key] = parsed.settings[key]
    }
    const sanitized = sanitizeSettings(picked, {}, defaults)
    return Object.fromEntries(Object.keys(defaults).map((key) => [key, sanitized[key]]))
  } catch {
    return { ...defaults }
  }
}

/**
 * Development-only switches for the end-to-end check against a local fake
 * release server. A packaged FaNotes ignores them: it always talks to GitHub
 * over HTTPS and verifies with the product key.
 */
const developmentOverrides = (app, env) => {
  if (app.isPackaged) return {}
  const overrides = {}
  const origin = env.FANOTES_UPDATER_TEST_ORIGIN
  if (origin) {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('FANOTES_UPDATER_TEST_ORIGIN must be a loopback http origin.')
    }
    overrides.fetchImpl = loopbackFetch(parsed.origin)
  }
  if (env.FANOTES_UPDATER_TEST_PUBLIC_KEY) {
    const publicKey = crypto.createPublicKey(env.FANOTES_UPDATER_TEST_PUBLIC_KEY)
    overrides.publicKeyPemOverride = publicKey.export({ type: 'spki', format: 'pem' })
    overrides.expectedKeyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  }
  if (env.FANOTES_UPDATER_ALLOW_DEV === '1') overrides.forceSupported = true
  return overrides
}

/** Maps https://<host>/<path> to <origin>/<host>/<path> (fake release server). */
const loopbackFetch = (origin, fetchImpl = globalThis.fetch) => async (input, options = {}) => {
  const url = new URL(String(input))
  if (url.protocol !== 'https:') throw new Error('Only https URLs are mapped.')
  return fetchImpl(`${origin}/${url.host}${url.pathname}${url.search}`, options)
}

/** Electron entry for --background-update. */
function runCli() {
  const { app, net } = require('electron')
  app.setName('FaNotes')
  const userDataPath = app.getPath('userData')
  const updaterRoot = path.join(userDataPath, 'updates')
  // Chromium keeps its own profile files (Local State, caches) under userData.
  // A separate directory keeps a background run away from the files of an
  // open FaNotes window, including the Windows safeStorage key in Local State.
  app.setPath('userData', path.join(updaterRoot, 'background-profile'))
  configureHeadless(app)
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Not permitted everywhere; the task or unit already lowers the priority.
  }
  const hardStop = setTimeout(() => app.exit(3), HARD_STOP_MS)
  hardStop.unref?.()

  app.whenReady().then(async () => {
    const { channelForPackagedVersion } = require('./releaseVersion.cjs')
    const { createUpdateManager } = require('./updater.cjs')
    const version = app.getVersion()
    const settings = readUpdateSettings(userDataPath, {
      autoCheckUpdates: true,
      autoDownloadUpdates: true,
      installUpdatesOnQuit: true,
      backgroundUpdates: true,
      updateChannel: channelForPackagedVersion(version),
    })
    const overrides = developmentOverrides(app, process.env)
    const logger = { warn: () => undefined, info: () => undefined, error: () => undefined }
    const status = await runBackgroundUpdate({
      updaterRoot,
      settings,
      currentVersion: version,
      isOnline: () => net.isOnline(),
      isMetered: () => detectMeteredConnection(),
      createManager: (managerSettings) => createUpdateManager({
        app,
        getWindow: () => null,
        getSettings: () => managerSettings,
        logger,
        updaterRoot,
        ...overrides,
      }),
    })
    app.exit(status.result === 'error' ? 2 : 0)
  }).catch(async (error) => {
    await appendLog(updaterRoot, `${new Date().toISOString()} result=crash ${JSON.stringify(String(error?.message || error).slice(0, 200))}`)
    app.exit(4)
  })
}

/**
 * Electron entry for --fanotes-self-test. Compiles main.cjs, loads the main
 * process modules a start needs and reports the version to the file the
 * helper named in FANOTES_SELF_TEST_FILE. No window, no profile access.
 */
function runSelfTest() {
  const { app } = require('electron')
  app.setName('FaNotes')
  const userDataPath = app.getPath('userData')
  app.setPath('userData', path.join(userDataPath, 'updates', 'background-profile'))
  configureHeadless(app)
  const target = process.env.FANOTES_SELF_TEST_FILE
  const report = (ok, reason = null) => {
    try {
      if (typeof target === 'string' && path.isAbsolute(target) && path.basename(target) === SELF_TEST_FILE) {
        fs.writeFileSync(target, `${JSON.stringify({ ok, version: app.getVersion(), reason })}\n`, { encoding: 'utf8', mode: 0o600 })
      }
    } catch {
      // The helper treats a missing report as a failed self-test.
    }
    app.exit(ok ? 0 : 1)
  }
  const timer = setTimeout(() => report(false, 'timeout'), 90_000)
  timer.unref?.()
  app.whenReady().then(() => {
    const vm = require('node:vm')
    const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
    // Compile only; the CommonJS wrapper allows main.cjs's top-level return.
    void new vm.Script(`(function (exports, require, module, __filename, __dirname) {${mainSource}\n})`, { filename: 'main.cjs' })
    for (const name of ['./updater.cjs', './update-lock.cjs', './update-scheduler.cjs', './settings-sanitize.cjs', './startup-preflight.cjs', './famd.cjs', './i18n.cjs']) {
      require(name)
    }
    if (app.isPackaged && !fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html'))) throw new Error('renderer missing')
    report(true)
  }).catch((error) => report(false, String(error?.message || error).slice(0, 200)))
}

module.exports = {
  BACKOFF_BASE_MS,
  LOG_FILE,
  MAX_LOG_BYTES,
  MIN_CHECK_INTERVAL_MS,
  SELF_TEST_FILE,
  STATUS_FILE,
  appendLog,
  backoffDelay,
  detectMeteredConnection,
  loopbackFetch,
  readStatus,
  readUpdateSettings,
  runBackgroundUpdate,
  runCli,
  runSelfTest,
}
