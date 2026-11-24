'use strict'

// Background updates against a local fake GitHub releases server (HTTP on
// 127.0.0.1, every https://<host>/<path> request mapped to it) with manifests
// signed by a throwaway Ed25519 test key. Nothing here talks to GitHub.
//
// Linux: the real install helper swaps a fake AppImage (a shell script padded
// past the 10 MiB package minimum) and self-tests it. Windows: the helper
// invocation is checked with a mocked spawn; on a Windows runner the real
// PowerShell helpers also run against fake .cmd programs.
//
//   node scripts/check-background-update.cjs            all checks
//   FANOTES_MEASURE_BACKGROUND=1 node scripts/...        also measure a headless
//                                                        Electron run (Linux, needs
//                                                        the Electron binary)

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawn, spawnSync } = require('node:child_process')
const { createDeltaPatch } = require('./create-delta.cjs')
const { createUpdateManager, githubReleaseAssetUrl, stableStringify, WINDOWS_INSTALLER_HELPER, WINDOWS_LAUNCHER, WINDOWS_SWAP_HELPER } = require('../electron/updater.cjs')
const { createUpdateLocks, waitForInstallToFinish } = require('../electron/update-lock.cjs')
const { BACKOFF_BASE_MS, LOG_FILE, MAX_LOG_BYTES, appendLog, backoffDelay, detectMeteredConnection, loopbackFetch, readStatus, readUpdateSettings, runBackgroundUpdate } = require('../electron/background-update.cjs')

const PACKAGE_BYTES = 10 * 1024 * 1024 + 64 * 1024
const HOUR = 60 * 60 * 1000

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const testKey = (label) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  return {
    label,
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16),
  }
}

/** A runnable stand-in for an AppImage: answers --fanotes-self-test, then padding. */
const fakeAppImage = (version, { healthy = true, gui = 'exits', seed = 'common' } = {}) => {
  const script = Buffer.from([
    '#!/bin/sh',
    'if [ "$1" = --fanotes-self-test ]; then',
    healthy
      ? `  printf '{"ok":true,"version":"${version}"}' >"$FANOTES_SELF_TEST_FILE"; exit 0`
      : '  exit 1',
    'fi',
    // A normal start records its version and arguments next to the AppImage.
    `echo "${version} $*" >>"$(dirname "$0")/launches.log"`,
    gui === 'stays' ? 'sleep 10' : 'exit 0',
    'exit 0',
    '',
  ].join('\n'))
  const padding = Buffer.alloc(PACKAGE_BYTES - script.length)
  // Deterministic, shared padding keeps delta patches small between versions.
  let block = crypto.createHash('sha256').update(seed).digest()
  for (let offset = 0; offset < padding.length; offset += block.length) {
    block.copy(padding, offset)
    block = crypto.createHash('sha256').update(block).digest()
  }
  padding[0] = 0x23 // '#'
  return Buffer.concat([script, padding])
}

const sign = (payload, key) => ({
  ...payload,
  signature: { algorithm: 'ed25519', keyId: key.keyId, value: crypto.sign(null, Buffer.from(stableStringify(payload)), key.privateKey).toString('base64') },
})

// ------------------------------------------------------------ fake GitHub
function createFakeGithub() {
  const files = new Map()
  const releases = []
  const requests = []
  let etagSupport = true

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fake')
    const [, host, ...rest] = url.pathname.split('/')
    const pathname = `/${rest.join('/')}`
    requests.push({ host, pathname, search: url.search, headers: { ...request.headers } })
    const json = (status, body, headers = {}) => {
      const text = JSON.stringify(body)
      const etag = `W/"${sha256(text).slice(0, 20)}"`
      if (etagSupport && request.headers['if-none-match'] === etag) {
        requests.at(-1).notModified = true
        response.writeHead(304, { etag })
        response.end()
        return
      }
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...(etagSupport ? { etag } : {}), ...headers })
      response.end(text)
    }
    if (host === 'api.github.com' && pathname === '/repos/Nikoheld/FaNotes/releases/latest') {
      const stable = releases.filter((item) => !item.prerelease).at(-1)
      if (!stable) return json(404, { message: 'Not Found' })
      return json(200, stable.row)
    }
    if (host === 'api.github.com' && pathname === '/repos/Nikoheld/FaNotes/releases') {
      return json(200, [...releases].reverse().map((item) => item.row))
    }
    if (host === 'github.com' && pathname.startsWith('/Nikoheld/FaNotes/releases/download/')) {
      const name = pathname.slice('/Nikoheld/FaNotes/releases/download/'.length)
      if (!files.has(name)) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('missing')
        return
      }
      response.writeHead(302, { location: `https://objects.githubusercontent.com/fake/${name}` })
      response.end()
      return
    }
    if (host === 'objects.githubusercontent.com' && pathname.startsWith('/fake/')) {
      const bytes = files.get(pathname.slice('/fake/'.length))
      if (!bytes) {
        response.writeHead(404)
        response.end()
        return
      }
      const range = /^bytes=(\d+)-$/u.exec(request.headers.range || '')
      const offset = range ? Number(range[1]) : 0
      const body = bytes.subarray(offset)
      response.writeHead(offset ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        ...(offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
      })
      response.end(body)
      return
    }
    response.writeHead(404)
    response.end()
  })

  /**
   * Publishes one release: packages, an optional delta and the signed manifest
   * as GitHub release assets under v<version>.
   */
  // A delta needs the per-install manifest shape (currentVersion names its
  // base); release manifests from write-update-manifests.mjs carry none.
  const publish = ({ version, platform, channel = 'stable', packages, delta = null, key, manifestVersion = version, prerelease = channel !== 'stable' }) => {
    const manifestPlatform = platform === 'win32' ? 'windows' : 'linux'
    const described = {}
    for (const [kind, { fileName, bytes }] of Object.entries(packages)) {
      files.set(`v${version}/${fileName}`, bytes)
      described[kind] = { fileName, url: githubReleaseAssetUrl(version, fileName), sizeBytes: bytes.length, sha256: sha256(bytes) }
    }
    let deltaEntry = null
    if (delta) {
      files.set(`v${version}/${delta.fileName}`, delta.bytes)
      deltaEntry = {
        format: delta.format,
        fileName: delta.fileName,
        url: githubReleaseAssetUrl(version, delta.fileName),
        sizeBytes: delta.bytes.length,
        sha256: sha256(delta.bytes),
        source: delta.source,
        target: delta.target,
      }
    }
    const payload = {
      schemaVersion: 1,
      product: 'FaNotes',
      channel,
      platform: manifestPlatform,
      arch: 'x64',
      latestVersion: manifestVersion,
      ...(delta ? { currentVersion: delta.baseVersion, updateAvailable: true } : {}),
      mandatory: false,
      publishedAt: '2026-11-20T10:00:00.000Z',
      releaseNotes: [`FaNotes ${version}`],
      packages: described,
      delta: deltaEntry,
      websiteUrl: 'https://fanotes.fasrv.ch/',
    }
    const manifestName = channel === 'stable' ? `FaNotes-update-${manifestPlatform}-x64.json` : `FaNotes-update-${manifestPlatform}-x64-${channel}.json`
    files.set(`v${version}/${manifestName}`, Buffer.from(JSON.stringify(sign(payload, key))))
    const existing = releases.findIndex((item) => item.version === version)
    const row = {
      tag_name: `v${version}`,
      draft: false,
      prerelease,
      assets: [...files.keys()].filter((name) => name.startsWith(`v${version}/`)).map((name) => ({
        name: name.slice(`v${version}/`.length),
        browser_download_url: githubReleaseAssetUrl(version, name.slice(`v${version}/`.length)),
      })),
    }
    if (existing >= 0) releases.splice(existing, 1)
    releases.push({ version, prerelease, row })
  }

  return {
    requests,
    publish,
    files,
    setEtagSupport: (value) => { etagSupport = value },
    clear() {
      releases.length = 0
      files.clear()
    },
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
    }),
    close: () => new Promise((resolve) => { server.close(resolve) }),
    downloads: (fragment) => requests.filter((entry) => entry.host === 'objects.githubusercontent.com' && entry.pathname.includes(fragment)).length,
  }
}

// ------------------------------------------------------------ environment
async function makeProfile(root, name) {
  const base = path.join(root, name)
  const userData = path.join(base, 'user-data')
  const home = path.join(base, 'home')
  const updaterRoot = path.join(userData, 'updates')
  await fsp.mkdir(updaterRoot, { recursive: true })
  await fsp.mkdir(path.join(home, 'Apps'), { recursive: true })
  return { base, userData, home, updaterRoot, appImage: path.join(home, 'Apps', 'FaNotes.AppImage') }
}

const fakeApp = (profile, version) => ({
  getVersion: () => version,
  getPath: (name) => (name === 'home' ? profile.home : profile.userData),
  isPackaged: true,
})

const quietLogger = { warn: () => undefined, info: () => undefined, error: () => undefined }

const DEFAULT_SETTINGS = Object.freeze({
  autoCheckUpdates: true,
  autoDownloadUpdates: true,
  installUpdatesOnQuit: true,
  backgroundUpdates: true,
  updateChannel: 'stable',
})

/** A pid that has already exited: the helper starts at once. */
const exitedPid = () => {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

const waitForInstall = async (profile, timeoutMs = 60_000) => {
  const locks = createUpdateLocks(profile.updaterRoot)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!locks.installHolder() && fs.existsSync(path.join(profile.updaterRoot, 'install-result.json'))) {
      return JSON.parse(await fsp.readFile(path.join(profile.updaterRoot, 'install-result.json'), 'utf8'))
    }
    await sleep(100)
  }
  const log = await fsp.readFile(path.join(profile.updaterRoot, 'install.log'), 'utf8').catch(() => '')
  throw new Error(`The install helper did not finish.\n${log}`)
}

async function main() {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-background-update-'))
  const github = createFakeGithub()
  const origin = await github.listen()
  const fetchImpl = loopbackFetch(origin)
  const key = testKey('test')
  const otherKey = testKey('other')
  const children = []
  const liveProcess = () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
    children.push(child)
    return child
  }

  const managerFactory = (profile, version, extra = {}) => (managerSettings) => createUpdateManager({
    app: fakeApp(profile, version),
    getWindow: () => null,
    getSettings: () => managerSettings,
    logger: quietLogger,
    fetchImpl,
    forceSupported: true,
    platform: 'linux',
    appImagePath: profile.appImage,
    publicKeyPemOverride: key.publicPem,
    expectedKeyId: key.keyId,
    updaterRoot: profile.updaterRoot,
    helperParentPid: exitedPid(),
    ...extra,
  })

  const runLinux = (profile, version, overrides = {}) => runBackgroundUpdate({
    updaterRoot: profile.updaterRoot,
    settings: { ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) },
    currentVersion: version,
    createManager: overrides.createManager ?? managerFactory(profile, version, overrides.manager),
    isOnline: overrides.isOnline ?? (() => true),
    isMetered: overrides.isMetered ?? (() => false),
    now: overrides.now ?? Date.now,
    locks: overrides.locks,
  })

  try {
    // ------------------------------------------------ pure helpers
    assert.equal(backoffDelay(1), BACKOFF_BASE_MS)
    assert.equal(backoffDelay(2), 2 * BACKOFF_BASE_MS)
    assert.equal(backoffDelay(30), 24 * HOUR)
    assert.equal(await detectMeteredConnection({ platform: 'linux', run: async () => '(<uint32 1>,)\n' }), true)
    assert.equal(await detectMeteredConnection({ platform: 'linux', run: async () => '(<uint32 4>,)\n' }), false)
    assert.equal(await detectMeteredConnection({ platform: 'linux', run: async () => null }), false)
    assert.equal(await detectMeteredConnection({ platform: 'win32', run: async () => 'Variable\r\n' }), true)
    assert.equal(await detectMeteredConnection({ platform: 'win32', run: async () => 'Unrestricted\r\n' }), false)
    {
      const profile = await makeProfile(temporary, 'settings')
      await fsp.writeFile(path.join(profile.userData, 'config.json'), JSON.stringify({ settings: { backgroundUpdates: false, updateChannel: 'nightly', autoCheckUpdates: 'yes', openAiKey: 'secret' } }))
      const read = readUpdateSettings(profile.userData, DEFAULT_SETTINGS)
      assert.deepEqual(read, { ...DEFAULT_SETTINGS, backgroundUpdates: false, updateChannel: 'nightly' })
      assert.deepEqual(readUpdateSettings(path.join(profile.base, 'missing'), DEFAULT_SETTINGS), DEFAULT_SETTINGS)
      for (let index = 0; index < 400; index += 1) await appendLog(profile.updaterRoot, `line ${index} ${'x'.repeat(300)}`)
      const logSize = (await fsp.stat(path.join(profile.updaterRoot, LOG_FILE))).size
      assert.ok(logSize <= MAX_LOG_BYTES + 700, `Das Hintergrundprotokoll bleibt klein (${logSize} Bytes).`)
      assert.ok(fs.existsSync(path.join(profile.updaterRoot, `${LOG_FILE}.1`)), 'Das Protokoll wird rotiert.')
      assert.equal(fs.existsSync(path.join(profile.updaterRoot, `${LOG_FILE}.2`)), false)
    }

    // The install helper for these scenarios is the Linux shell script.
    if (process.platform !== 'win32') {
      // ------------------------------------------------ releases
      const v16 = fakeAppImage('2.16.0')
      const v17 = fakeAppImage('2.17.0')
      const v17Broken = fakeAppImage('2.17.0', { healthy: false })
      const v171 = fakeAppImage('2.17.1')
      const sourcePath = path.join(temporary, 'v16.AppImage')
      const targetPath = path.join(temporary, 'v17.AppImage')
      const patchPath = path.join(temporary, 'v16-v17.fndelta')
      await fsp.writeFile(sourcePath, v16)
      await fsp.writeFile(targetPath, v17)
      const delta = await createDeltaPatch({
        platform: 'linux', baseVersion: '2.16.0', targetVersion: '2.17.0', sourcePath, targetPath, outputPath: patchPath,
        targetKind: 'appimage', targetFileName: 'FaNotes-2.17.0-x86_64.AppImage',
      })
      assert.ok(delta.patchSizeBytes < v17.length / 4, 'Das Test-Delta ist deutlich kleiner als das Vollpaket.')
      const linuxPackages = (version, appImageBytes) => ({
        appimage: { fileName: `FaNotes-${version}-x86_64.AppImage`, bytes: appImageBytes },
        portable: { fileName: `FaNotes-${version}-x86_64.tar.gz`, bytes: Buffer.alloc(PACKAGE_BYTES, 7) },
      })
      const deltaAsset = {
        format: delta.format,
        baseVersion: '2.16.0',
        fileName: 'FaNotes-Delta-linux-x64-2.16.0-to-2.17.0.fndelta',
        bytes: await fsp.readFile(patchPath),
        source: delta.source,
        target: delta.target,
      }
      github.publish({ version: '2.17.0', platform: 'linux', packages: linuxPackages('2.17.0', v17), delta: deltaAsset, key })

      // ------------------------------------------------ 1. closed: delta, install, next start is the new version
      {
        const profile = await makeProfile(temporary, 'closed')
        await fsp.writeFile(profile.appImage, v16, { mode: 0o755 })
        const before = github.requests.length
        const status = await runLinux(profile, '2.16.0')
        assert.equal(status.result, 'installing', status.message)
        assert.equal(status.latestVersion, '2.17.0')
        assert.equal(status.failures, 0)
        const result = await waitForInstall(profile)
        assert.equal(result.ok, true)
        assert.equal(result.mode, 'quiet')
        assert.ok((await fsp.readFile(profile.appImage)).equals(v17), 'Das AppImage ist ersetzt.')
        assert.equal(fs.existsSync(`${profile.appImage}.fanotes-backup`), false)
        const newRequests = github.requests.slice(before)
        assert.equal(newRequests.filter((entry) => entry.pathname.endsWith('.fndelta')).length >= 1, true, 'Das Delta wurde geladen.')
        assert.equal(newRequests.filter((entry) => entry.host === 'objects.githubusercontent.com' && entry.pathname.endsWith('.AppImage')).length, 0, 'Kein Vollpaket bei passender Delta-Basis.')
        assert.ok(newRequests.every((entry) => entry.headers['user-agent'].startsWith('FaNotes/2.16.0 Linux updater')))
        const persisted = await readStatus(profile.updaterRoot)
        assert.equal(persisted.checkResult, 'installing')
        assert.match(await fsp.readFile(path.join(profile.updaterRoot, LOG_FILE), 'utf8'), /result=installing version=2\.16\.0 latest=2\.17\.0/u)

        // The next start of the app is 2.17.0 and shows the note once.
        const next = createUpdateManager({
          app: fakeApp(profile, '2.17.0'), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS, logger: quietLogger, fetchImpl,
          forceSupported: true, platform: 'linux', appImagePath: profile.appImage, publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId,
        })
        await next.initialize()
        assert.deepEqual(next.getState().justUpdated?.to, '2.17.0')
        assert.equal(next.getState().justUpdated?.from, '2.16.0')
        assert.equal(fs.existsSync(path.join(profile.updaterRoot, 'install-result.json')), false, 'Die App liest das Ergebnis einmal.')
        assert.equal(fs.existsSync(path.join(profile.updaterRoot, '2.17.0')), false, 'Installierte Stände werden aufgeräumt.')
        assert.equal(next.acknowledgeJustUpdated().justUpdated, null)
        next.stop()
      }

      // ------------------------------------------------ 2. app running: stage only, then install on quit
      {
        const profile = await makeProfile(temporary, 'running')
        await fsp.writeFile(profile.appImage, v16, { mode: 0o755 })
        const app = liveProcess()
        createUpdateLocks(profile.updaterRoot, { pid: app.pid }).markAppRunning({ version: '2.16.0' })
        const status = await runLinux(profile, '2.16.0')
        assert.equal(status.result, 'staged')
        assert.ok((await fsp.readFile(profile.appImage)).equals(v16), 'Während FaNotes läuft, wird nichts ersetzt.')
        assert.equal(fs.existsSync(path.join(profile.updaterRoot, 'install.lock')), false)
        const state = JSON.parse(await fsp.readFile(path.join(profile.updaterRoot, 'state.json'), 'utf8'))
        assert.equal(state.pendingInstall.version, '2.17.0')

        // The open app quits: it installs the package the background run staged, without reopening.
        const appManager = createUpdateManager({
          app: fakeApp(profile, '2.16.0'), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS, logger: quietLogger, fetchImpl,
          forceSupported: true, platform: 'linux', appImagePath: profile.appImage, publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId,
          helperParentPid: exitedPid(), locks: createUpdateLocks(profile.updaterRoot, { pid: app.pid }),
        })
        const requestsBefore = github.requests.length
        assert.equal(await appManager.installOnQuit(), true)
        assert.equal(github.requests.length, requestsBefore, 'Beim Beenden ist kein Netz nötig.')
        const result = await waitForInstall(profile)
        assert.equal(result.ok, true)
        assert.ok((await fsp.readFile(profile.appImage)).equals(v17))
        app.kill()
      }

      // ------------------------------------------------ 3. broken release: rollback, no retry loop, next release installs
      {
        github.publish({ version: '2.17.0', platform: 'linux', packages: linuxPackages('2.17.0', v17Broken), key })
        const profile = await makeProfile(temporary, 'rollback')
        await fsp.writeFile(profile.appImage, v16, { mode: 0o755 })
        let clock = Date.now()
        const status = await runLinux(profile, '2.16.0', { now: () => clock })
        assert.equal(status.result, 'installing')
        const result = await waitForInstall(profile)
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'self-test-failed')
        assert.ok((await fsp.readFile(profile.appImage)).equals(v16), 'Die vorherige Version ist wiederhergestellt.')
        assert.match(await fsp.readFile(path.join(profile.updaterRoot, 'install.log'), 'utf8'), /rolling back/u)

        clock += 2 * HOUR
        const downloadsBefore = github.downloads('2.17.0-x86_64.AppImage')
        const again = await runLinux(profile, '2.16.0', { now: () => clock })
        assert.equal(again.result, 'blocked', again.message)
        assert.equal(github.downloads('2.17.0-x86_64.AppImage'), downloadsBefore, 'Eine zurückgesetzte Version wird nicht erneut geladen.')
        assert.ok((await fsp.readFile(profile.appImage)).equals(v16))

        // The app also refuses to install it at launch, and says why in the settings.
        const appManager = createUpdateManager({
          app: fakeApp(profile, '2.16.0'), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS, logger: quietLogger, fetchImpl,
          forceSupported: true, platform: 'linux', appImagePath: profile.appImage, publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId,
          helperParentPid: exitedPid(),
        })
        await appManager.initialize()
        const launch = await appManager.applyPendingInstallOnLaunch()
        assert.equal(launch.installStarted, false)
        assert.equal(launch.state.failedInstallVersion, '2.17.0')
        assert.match(launch.state.error, /zurückgesetzt/u)
        appManager.stop()

        github.publish({ version: '2.17.1', platform: 'linux', packages: linuxPackages('2.17.1', v171), key })
        clock += 2 * HOUR
        const fixed = await runLinux(profile, '2.16.0', { now: () => clock })
        assert.equal(fixed.result, 'installing', fixed.message)
        const fixedResult = await waitForInstall(profile)
        assert.equal(fixedResult.ok, true)
        assert.equal(fixedResult.version, '2.17.1')
        assert.ok((await fsp.readFile(profile.appImage)).equals(v171))
      }

      // ------------------------------------------------ install at launch: relaunch, or roll back when the new window dies
      {
        github.clear()
        const releaseFor = (gui) => fakeAppImage('2.17.0', { gui })
        const launchProfile = async (name, gui) => {
          const profile = await makeProfile(temporary, name)
          await fsp.writeFile(profile.appImage, fakeAppImage('2.16.0', { gui: 'exits' }), { mode: 0o755 })
          return { profile, bytes: releaseFor(gui) }
        }
        const stays = await launchProfile('launch-ok', 'stays')
        const dies = await launchProfile('launch-crash', 'exits')
        const launch = async ({ profile, bytes }) => {
          github.publish({ version: '2.17.0', platform: 'linux', packages: linuxPackages('2.17.0', bytes), key })
          const manager = createUpdateManager({
            app: fakeApp(profile, '2.16.0'), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS, logger: quietLogger, fetchImpl,
            forceSupported: true, platform: 'linux', appImagePath: profile.appImage, publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId,
            helperParentPid: exitedPid(),
          })
          await manager.initialize()
          // A download that begins at launch never restarts the app by itself; once the
          // package is staged and verified, the next launch-time call installs it.
          const fresh = await manager.applyPendingInstallOnLaunch()
          assert.equal(fresh.installStarted, false, 'A fresh download must not restart the app.')
          for (let waited = 0; manager.getState().status !== 'downloaded' && waited < 20_000; waited += 50) await new Promise((resolve) => { setTimeout(resolve, 50) })
          assert.equal(manager.getState().status, 'downloaded', manager.getState().error)
          const started = await manager.applyPendingInstallOnLaunch()
          assert.equal(started.installStarted, true, started.state.error)
          return { done: waitForInstall(profile, 40_000) }
        }
        // The second release is published once the first is staged; the two
        // 8 s health windows of the helpers overlap.
        const first = await launch(stays)
        const second = await launch(dies)
        const [ok, crash] = await Promise.all([first.done, second.done])
        assert.equal(ok.ok, true)
        assert.equal(ok.mode, 'relaunch')
        assert.ok((await fsp.readFile(stays.profile.appImage)).equals(stays.bytes))
        assert.match(await fsp.readFile(path.join(path.dirname(stays.profile.appImage), 'launches.log'), 'utf8'), /^2\.17\.0 --fanotes-updated-from=2\.16\.0$/mu)
        assert.equal(crash.ok, false, 'Ein sofort beendetes neues Fenster löst den Rollback aus.')
        assert.ok((await fsp.readFile(dies.profile.appImage)).equals(fakeAppImage('2.16.0', { gui: 'exits' })))
        assert.match(await fsp.readFile(path.join(path.dirname(dies.profile.appImage), 'launches.log'), 'utf8'), /^2\.16\.0 --fanotes-update-rollback=2\.17\.0$/mu)
      }

      // ------------------------------------------------ 4. wrong signature, 5. backoff
      {
        github.clear()
        github.publish({ version: '2.17.0', platform: 'linux', packages: linuxPackages('2.17.0', v17), key: otherKey })
        const profile = await makeProfile(temporary, 'signature')
        await fsp.writeFile(profile.appImage, v16, { mode: 0o755 })
        const clock = Date.now()
        const packageDownloads = github.downloads('2.17.0-x86_64.AppImage')
        const status = await runLinux(profile, '2.16.0', { now: () => clock })
        assert.equal(status.result, 'error')
        assert.match(status.message, /unbekannten Schlüssel/u)
        assert.equal(status.failures, 1)
        assert.equal(Date.parse(status.nextAllowedAt), clock + BACKOFF_BASE_MS)
        assert.equal(github.downloads('2.17.0-x86_64.AppImage'), packageDownloads, 'Ohne gültige Signatur wird nichts geladen.')
        assert.equal(fs.existsSync(path.join(profile.updaterRoot, '2.17.0')), false)

        const before = github.requests.length
        const backoff = await runLinux(profile, '2.16.0', { now: () => clock + 10 * 60 * 1000 })
        assert.equal(backoff.result, 'backoff')
        assert.equal(github.requests.length, before, 'Während des Backoffs fragt FaNotes GitHub nicht.')
        assert.equal(backoff.checkResult, 'error', 'Die Anzeige behält das Ergebnis der letzten echten Prüfung.')

        const second = await runLinux(profile, '2.16.0', { now: () => clock + BACKOFF_BASE_MS + 1 })
        assert.equal(second.result, 'error')
        assert.equal(second.failures, 2)
        assert.equal(Date.parse(second.nextAllowedAt), clock + BACKOFF_BASE_MS + 1 + 2 * BACKOFF_BASE_MS)
      }

      // ------------------------------------------------ 6. downgrade / replay of an older signed release
      {
        github.clear()
        github.publish({ version: '2.17.0', platform: 'linux', packages: linuxPackages('2.17.0', v17), key })
        const profile = await makeProfile(temporary, 'downgrade')
        await fsp.writeFile(profile.appImage, v16, { mode: 0o755 })
        await fsp.writeFile(path.join(profile.updaterRoot, 'state.json'), JSON.stringify({ schemaVersion: 3, highestSeenVersions: { stable: '2.18.0', beta: null, nightly: null }, pendingInstall: null }))
        const packageDownloads = github.downloads('2.17.0-x86_64.AppImage')
        const status = await runLinux(profile, '2.16.0')
        assert.equal(status.result, 'error')
        assert.match(status.message, /ältere als die bereits bekannte Version/u)
        assert.equal(github.downloads('2.17.0-x86_64.AppImage'), packageDownloads)
        assert.ok((await fsp.readFile(profile.appImage)).equals(v16))
        // A manifest that names an older version under a newer tag is refused too.
        github.publish({ version: '2.19.0', manifestVersion: '2.17.0', platform: 'linux', packages: linuxPackages('2.17.0', v17), key })
        const replay = await runLinux(forgetRememberedVersions(profile), '2.16.0', { now: () => Date.now() + 3 * HOUR })
        assert.equal(replay.result, 'error')
        assert.match(replay.message, /anderen Release|ungültig/u)
      }

      // ------------------------------------------------ 7. offline, 8. metered, disabled, busy
      {
        github.clear()
        github.publish({ version: '2.17.0', platform: 'linux', packages: linuxPackages('2.17.0', v17), key })
        const profile = await makeProfile(temporary, 'conditions')
        await fsp.writeFile(profile.appImage, v16, { mode: 0o755 })
        const before = github.requests.length
        const packageDownloads = github.downloads('2.17.0-x86_64.AppImage')
        const offline = await runLinux(profile, '2.16.0', { isOnline: () => false })
        assert.equal(offline.result, 'offline')
        assert.equal(offline.failures, 0, 'Offline ist kein Fehler und verlängert keinen Backoff.')
        assert.equal(github.requests.length, before)

        const disabled = await runLinux(profile, '2.16.0', { settings: { backgroundUpdates: false } })
        assert.equal(disabled.result, 'disabled')
        assert.equal(github.requests.length, before)

        const metered = await runLinux(profile, '2.16.0', { isMetered: () => true })
        assert.equal(metered.result, 'metered')
        assert.equal(github.downloads('2.17.0-x86_64.AppImage'), packageDownloads, 'Über eine getaktete Verbindung wird kein Paket geladen.')
        assert.ok(github.requests.length > before, 'Die kleine Prüfung selbst läuft auch getaktet.')

        const other = liveProcess()
        const otherLocks = createUpdateLocks(profile.updaterRoot, { pid: other.pid })
        assert.equal(otherLocks.acquireWork({ purpose: 'download' }), true)
        const busy = await runLinux(profile, '2.16.0')
        assert.equal(busy.result, 'busy')
        otherLocks.releaseWork()
        other.kill()

        const noAutoDownload = await runLinux(profile, '2.16.0', { settings: { autoDownloadUpdates: false } })
        assert.equal(noAutoDownload.result, 'available')
        assert.equal(github.downloads('2.17.0-x86_64.AppImage'), packageDownloads)
      }

      // ------------------------------------------------ 9. ETag: an unchanged release list costs a 304
      {
        github.clear()
        github.publish({ version: '2.16.0', platform: 'linux', packages: linuxPackages('2.16.0', v16), key })
        const profile = await makeProfile(temporary, 'etag')
        await fsp.writeFile(profile.appImage, v16, { mode: 0o755 })
        const clock = Date.now()
        const first = await runLinux(profile, '2.16.0', { now: () => clock })
        assert.equal(first.result, 'up-to-date')
        const listRequests = () => github.requests.filter((entry) => entry.host === 'api.github.com')
        const firstCount = listRequests().length
        const recent = await runLinux(profile, '2.16.0', { now: () => clock + 10 * 60 * 1000 })
        assert.equal(recent.result, 'recent')
        assert.equal(listRequests().length, firstCount, 'Kurz nach einer Prüfung fragt die Anmeldung GitHub nicht erneut.')
        const later = await runLinux(profile, '2.16.0', { now: () => clock + 7 * HOUR })
        assert.equal(later.result, 'up-to-date')
        const conditional = listRequests().slice(firstCount)
        assert.equal(conditional.length, 1)
        assert.ok(conditional[0].headers['if-none-match'], 'Die Release-Liste wird mit If-None-Match abgefragt.')
        assert.equal(conditional[0].notModified, true, 'GitHub antwortet mit 304.')
        const cache = JSON.parse(await fsp.readFile(path.join(profile.updaterRoot, 'release-cache.json'), 'utf8'))
        assert.ok(Buffer.byteLength(JSON.stringify(cache)) < 4096, 'Der ETag-Cache speichert nur die nötigen Felder.')
      }

      // ------------------------------------------------ install lock: the app waits, then starts the new version
      {
        const profile = await makeProfile(temporary, 'wait')
        const helper = liveProcess()
        const helperLocks = createUpdateLocks(profile.updaterRoot, { pid: helper.pid })
        assert.equal(helperLocks.acquireInstall({ version: '2.17.0' }), true)
        const appLocks = createUpdateLocks(profile.updaterRoot)
        setTimeout(() => helperLocks.releaseInstall(), 300)
        const waited = await waitForInstallToFinish(appLocks, { pollMs: 50, timeoutMs: 5_000 })
        assert.equal(waited.pid, helper.pid)
        assert.equal(fs.existsSync(appLocks.paths.launchRequest), false)
        assert.equal(await waitForInstallToFinish(appLocks), null, 'Ohne laufende Installation wartet die App nicht.')
        helper.kill()
        // A stale lock of a crashed helper does not block anything.
        fs.writeFileSync(appLocks.paths.install, JSON.stringify({ pid: exitedPid(), at: new Date().toISOString() }))
        assert.equal(appLocks.installHolder(), null)
        assert.equal(appLocks.acquireInstall(), true)
        appLocks.releaseInstall()
      }

    }

    // ------------------------------------------------ Windows logic (mocked spawn)
    await checkWindowsLogic(temporary, github, fetchImpl, key)

    // ------------------------------------------------ real PowerShell helpers on a Windows runner
    if (process.platform === 'win32') await checkWindowsHelpers(temporary)

    if (process.env.FANOTES_MEASURE_BACKGROUND === '1') await measureElectron(temporary, github, origin, key)

    console.log('Hintergrund-Updates erfolgreich: geschlossene App (Delta, Installation, Selbsttest, Hinweis beim nächsten Start), laufende App (nur bereitstellen, Installation beim Beenden), Installation beim Start mit Neustart, Rollback bei Absturz und ohne Wiederholungsschleife, falsche Signatur, Downgrade, offline, getaktet, Backoff, ETag/304, Installationssperre und Windows-Pfade (NSIS, Delta, portabel).')
  } finally {
    for (const child of children) child.kill()
    await github.close()
    await fsp.rm(temporary, { recursive: true, force: true })
  }
}

/** The replay check reuses the downgrade profile, but forgets its remembered versions. */
function forgetRememberedVersions(profile) {
  fs.rmSync(path.join(profile.updaterRoot, 'state.json'), { force: true })
  fs.rmSync(path.join(profile.updaterRoot, 'background-status.json'), { force: true })
  return profile
}

function fakeChild(pid = 4242, onSpawn = () => undefined) {
  const child = new EventEmitter()
  child.pid = pid
  child.unref = () => undefined
  setImmediate(() => { child.emit('spawn'); onSpawn() })
  return child
}

/** A short-lived child with output (the Windows launcher). */
function fakeProcess({ stdout = '', code = 0, pid = 777 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.kill = () => undefined
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => {
    child.emit('spawn')
    if (stdout) child.stdout.emit('data', stdout)
    child.emit('close', code)
  })
  return child
}

const optionValue = (args, name) => args[args.indexOf(`-${name}`) + 1]
/** The helper's own arguments, which the launcher receives as base64 JSON. */
const launchedHelperArgs = (args) => JSON.parse(Buffer.from(optionValue(args, 'Arguments'), 'base64').toString('utf8'))
const writeStartedMarker = (updaterRoot, helperArgs, pid = 4242) => {
  fs.writeFileSync(path.join(updaterRoot, 'helper-started.json'), JSON.stringify({ attempt: optionValue(helperArgs, 'AttemptId'), pid }))
}

/**
 * Stands in for powershell.exe. `launcher`: 'ok' prints the helper pid, 'fail' exits 3.
 * `helper`: 'starts' writes the started marker like the real helper's first line, 'silent' never does.
 */
const windowsSpawn = (spawned, updaterRoot, { launcher = 'ok', helper = 'starts' } = {}) => (command, args, options) => {
  spawned.push({ command, args, options })
  if (args.includes('-Arguments')) {
    if (launcher !== 'ok') return fakeProcess({ code: 3 })
    if (helper === 'starts') writeStartedMarker(updaterRoot, launchedHelperArgs(args))
    return fakeProcess({ stdout: 'pid=4242 via=start-process\r\n' })
  }
  // The old detached path, used when the launcher fails.
  return fakeChild(4243, () => { if (helper === 'starts') writeStartedMarker(updaterRoot, args, 4243) })
}

async function checkWindowsLogic(temporary, github, fetchImpl, key) {
  const installer = Buffer.alloc(PACKAGE_BYTES, 0x4d)
  const portable = Buffer.alloc(PACKAGE_BYTES, 0x50)
  const asarSource = Buffer.alloc(2 * 1024 * 1024, 0x41)
  const asarTarget = Buffer.from(asarSource)
  Buffer.from('FaNotes 2.17.0 app.asar').copy(asarTarget, 4096)
  const sourcePath = path.join(temporary, 'source.asar')
  const targetPath = path.join(temporary, 'target.asar')
  const patchPath = path.join(temporary, 'windows.fndelta')
  await fsp.writeFile(sourcePath, asarSource)
  await fsp.writeFile(targetPath, asarTarget)
  const delta = await createDeltaPatch({
    platform: 'windows', baseVersion: '2.16.0', targetVersion: '2.17.0', sourcePath, targetPath, outputPath: patchPath,
    targetKind: 'app-asar', targetFileName: 'app.asar',
  })
  github.clear()
  github.publish({
    version: '2.17.0',
    platform: 'win32',
    packages: {
      installer: { fileName: 'FaNotes-Setup-2.17.0-x64.exe', bytes: installer },
      portable: { fileName: 'FaNotes-Portable-2.17.0-x64.exe', bytes: portable },
    },
    delta: { format: delta.format, baseVersion: '2.16.0', fileName: 'FaNotes-Delta-windows-x64-2.16.0-to-2.17.0.fndelta', bytes: await fsp.readFile(patchPath), source: delta.source, target: delta.target },
    key,
  })

  const windowsProfile = async (name, { asar }) => {
    const profile = await makeProfile(temporary, name)
    const installDirectory = path.join(profile.base, 'Programs', 'FaNotes')
    const resourcesPath = path.join(installDirectory, 'resources')
    await fsp.mkdir(resourcesPath, { recursive: true })
    await fsp.writeFile(path.join(resourcesPath, 'app.asar'), asar)
    await fsp.writeFile(path.join(installDirectory, 'FaNotes.exe'), 'MZ fake')
    return { ...profile, installDirectory, resourcesPath }
  }
  const run = async (profile, extra, behaviour) => {
    const spawned = []
    const status = await runBackgroundUpdate({
      updaterRoot: profile.updaterRoot,
      settings: DEFAULT_SETTINGS,
      currentVersion: '2.16.0',
      createManager: (managerSettings) => createUpdateManager({
        app: fakeApp(profile, '2.16.0'), getWindow: () => null, getSettings: () => managerSettings, logger: quietLogger, fetchImpl,
        forceSupported: true, platform: 'win32', resourcesPath: profile.resourcesPath, portableExecutable: null,
        executablePath: path.join(profile.installDirectory, 'FaNotes.exe'),
        publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId, updaterRoot: profile.updaterRoot,
        spawnImpl: windowsSpawn(spawned, profile.updaterRoot, behaviour),
        helperStartTimeoutMs: 400,
        isAlive: () => false,
        ...extra,
      }),
    })
    return { status, spawned }
  }
  const argument = optionValue

  // NSIS: no delta base (app.asar differs), full installer, quiet helper.
  {
    const profile = await windowsProfile('windows-nsis', { asar: Buffer.alloc(1024, 1) })
    const { status, spawned } = await run(profile)
    assert.equal(status.result, 'installing', status.message)
    assert.equal(spawned.length, 1)
    const [{ command, args: launcherArgs, options }] = spawned
    assert.equal(command, 'powershell.exe')
    assert.equal(options.windowsHide, true)
    assert.equal(Object.keys(options.env).some((name) => name.toLowerCase() === 'psmodulepath'), false)
    // Never a detached (console-less) PowerShell: it can exit without running its script.
    assert.notEqual(options.detached, true)
    assert.equal(await fsp.readFile(argument(launcherArgs, 'File'), 'utf8'), WINDOWS_LAUNCHER)
    const args = launchedHelperArgs(launcherArgs)
    assert.match(argument(args, 'AttemptId'), /^[a-f0-9]{24}$/u)
    assert.equal(argument(args, 'Mode'), 'quiet')
    assert.equal(argument(args, 'Installer'), path.join(profile.updaterRoot, '2.17.0', 'FaNotes-Setup-2.17.0-x64.exe'))
    assert.equal(argument(args, 'ExpectedSha'), sha256(installer))
    assert.equal(argument(args, 'Executable'), path.join(profile.installDirectory, 'FaNotes.exe'))
    assert.equal(argument(args, 'ResultFile'), path.join(profile.updaterRoot, 'install-result.json'))
    assert.equal(await fsp.readFile(argument(args, 'File'), 'utf8'), WINDOWS_INSTALLER_HELPER)
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile.updaterRoot, 'install.lock'), 'utf8')).pid, 4242, 'Die Installationssperre geht an den Helfer.')
  }
  // Delta: app.asar is the delta base; the swap helper replaces it.
  {
    const profile = await windowsProfile('windows-delta', { asar: asarSource })
    const { status, spawned } = await run(profile)
    assert.equal(status.result, 'installing', status.message)
    const args = launchedHelperArgs(spawned[0].args)
    assert.equal(await fsp.readFile(argument(args, 'File'), 'utf8'), WINDOWS_SWAP_HELPER)
    assert.equal(argument(args, 'Target'), path.join(profile.resourcesPath, 'app.asar'))
    assert.equal(argument(args, 'Executable'), path.join(profile.installDirectory, 'FaNotes.exe'))
    assert.equal(argument(args, 'ExpectedSha'), delta.target.sha256)
    assert.equal(argument(args, 'StubPid'), '0')
    assert.equal(github.downloads('FaNotes-Setup-2.17.0'), 1, 'Nur der NSIS-Fall lädt den Installer.')
  }
  // Portable: the portable package replaces the .exe; the delta and the installer are not used.
  {
    const profile = await windowsProfile('windows-portable', { asar: asarSource })
    const portableExe = path.join(profile.base, 'USB', 'FaNotes-Portable.exe')
    await fsp.mkdir(path.dirname(portableExe), { recursive: true })
    await fsp.writeFile(portableExe, 'MZ portable')
    const deltaDownloads = github.downloads('.fndelta')
    const { status, spawned } = await run(profile, { portableExecutable: portableExe })
    assert.equal(status.result, 'installing', status.message)
    const args = launchedHelperArgs(spawned[0].args)
    assert.equal(await fsp.readFile(argument(args, 'File'), 'utf8'), WINDOWS_SWAP_HELPER)
    assert.equal(argument(args, 'Target'), portableExe)
    assert.equal(argument(args, 'Executable'), portableExe)
    assert.equal(argument(args, 'ExpectedSha'), sha256(portable))
    assert.equal(argument(args, 'StubPid'), String(process.ppid))
    assert.equal(github.downloads('.fndelta'), deltaDownloads, 'Die portable Ausgabe lädt kein app.asar-Delta.')
    const checkedState = createUpdateManager({
      app: fakeApp(profile, '2.16.0'), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS, logger: quietLogger, fetchImpl,
      forceSupported: true, platform: 'win32', resourcesPath: profile.resourcesPath, portableExecutable: portableExe,
      publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId, updaterRoot: path.join(profile.base, 'other-updates'),
    })
    assert.equal(checkedState.installationKind, 'windows-portable')
    checkedState.stop()
  }
  // The launcher fails: the old detached start is tried, and its started marker counts.
  {
    const profile = await windowsProfile('windows-launcher-fails', { asar: Buffer.alloc(1024, 1) })
    const { status, spawned } = await run(profile, {}, { launcher: 'fail' })
    assert.equal(status.result, 'installing', status.message)
    assert.deepEqual(spawned.map(({ args }) => (args.includes('-Arguments') ? argument(args, 'Method') : 'detached')), ['auto', 'cim', 'detached'])
    assert.equal(spawned[2].options.detached, true)
    assert.equal(argument(spawned[2].args, 'Mode'), 'quiet')
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile.updaterRoot, 'install.lock'), 'utf8')).pid, 4243)
  }
  // The helper never comes up (the Windows 11 26200 report): no install is claimed, the lock is
  // released, the version is marked failed, and the next start does not try it again.
  {
    const profile = await windowsProfile('windows-helper-silent', { asar: Buffer.alloc(1024, 1) })
    const { status, spawned: tried } = await run(profile, {}, { helper: 'silent' })
    assert.equal(status.result, 'error')
    assert.equal(tried.length, 3, 'Jeder Startweg wird einmal versucht, dann bleibt FaNotes offen.')
    assert.match(status.message, /Installationshelfer ist nicht gestartet/u)
    assert.equal(fs.existsSync(path.join(profile.updaterRoot, 'install.lock')), false, 'Die Sperre eines nie gestarteten Helfers wird freigegeben.')
    assert.equal(fs.existsSync(path.join(profile.updaterRoot, 'install-attempt.json')), false)
    const persisted = JSON.parse(fs.readFileSync(path.join(profile.updaterRoot, 'state.json'), 'utf8'))
    assert.deepEqual([persisted.failedInstall.version, persisted.failedInstall.reason], ['2.17.0', 'helper-did-not-start'])
    assert.equal(persisted.pendingInstall?.version === '2.17.0', false)

    const spawned = []
    const next = createUpdateManager({
      app: fakeApp(profile, '2.16.0'), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS, logger: quietLogger, fetchImpl,
      forceSupported: true, platform: 'win32', resourcesPath: profile.resourcesPath, portableExecutable: null,
      executablePath: path.join(profile.installDirectory, 'FaNotes.exe'),
      publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId, updaterRoot: profile.updaterRoot,
      spawnImpl: windowsSpawn(spawned, profile.updaterRoot), helperStartTimeoutMs: 400, isAlive: () => false,
    })
    await next.initialize()
    const launch = await next.applyPendingInstallOnLaunch()
    assert.equal(launch.installStarted, false)
    assert.equal(launch.ready, false, 'Beim nächsten Start wird nicht erneut für diese Version beendet.')
    assert.equal(launch.state.failedInstallVersion, '2.17.0')
    assert.match(launch.state.error, /konnte nicht installiert werden/u)
    assert.equal(spawned.length, 0)
    next.stop()
  }
  // An attempt that quit FaNotes but left no result and no newer version behind (the helper died
  // after its marker, the install was interrupted) blocks that version once, in the app and the background run.
  {
    const managerFor = (profile, version = '2.16.0') => createUpdateManager({
      app: fakeApp(profile, version), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS, logger: quietLogger, fetchImpl,
      forceSupported: true, platform: 'win32', resourcesPath: profile.resourcesPath, portableExecutable: null,
      publicKeyPemOverride: key.publicPem, expectedKeyId: key.keyId, updaterRoot: profile.updaterRoot,
      spawnImpl: () => { throw new Error('In diesem Fall startet kein Helfer.') },
    })
    const attempt = (profile, version) => fs.writeFileSync(path.join(profile.updaterRoot, 'install-attempt.json'), JSON.stringify({ version, attempt: 'ab', at: new Date().toISOString() }))
    const profile = await windowsProfile('windows-attempt', { asar: Buffer.alloc(1024, 1) })
    await fsp.mkdir(profile.updaterRoot, { recursive: true })
    attempt(profile, '2.17.0')
    // A helper that still holds install.lock is at work: nothing is decided yet.
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    createUpdateLocks(profile.updaterRoot).handInstallTo(helper.pid, { version: '2.17.0' })
    const busy = managerFor(profile)
    await busy.initialize()
    assert.equal(busy.getState().failedInstallVersion, null)
    assert.equal(fs.existsSync(path.join(profile.updaterRoot, 'install-attempt.json')), true)
    busy.stop()
    helper.kill()
    await new Promise((resolve) => { helper.once('exit', resolve) })

    // The background run records the failure and leaves the note for the app.
    const background = managerFor(profile)
    await background.initialize({ consumeInstallResult: false })
    assert.equal(background.getState().failedInstallVersion, '2.17.0')
    assert.equal(fs.existsSync(path.join(profile.updaterRoot, 'install-attempt.json')), true)
    background.stop()
    const app = managerFor(profile)
    await app.initialize()
    assert.equal(app.getState().failedInstallVersion, '2.17.0')
    assert.equal(app.getState().installNotCompleted?.version, '2.17.0')
    assert.equal(app.getState().installNotCompleted?.reason, 'install-incomplete')
    assert.equal(fs.existsSync(path.join(profile.updaterRoot, 'install-attempt.json')), false)
    app.stop()

    // The attempt did install: the new version starts and the marker is just removed.
    const installed = await windowsProfile('windows-attempt-ok', { asar: Buffer.alloc(1024, 1) })
    await fsp.mkdir(installed.updaterRoot, { recursive: true })
    attempt(installed, '2.17.0')
    const updated = managerFor(installed, '2.17.0')
    await updated.initialize()
    assert.equal(updated.getState().failedInstallVersion, null)
    assert.equal(updated.getState().installNotCompleted, null)
    assert.equal(fs.existsSync(path.join(installed.updaterRoot, 'install-attempt.json')), false)
    updated.stop()
  }
}

/** Runs the real PowerShell helpers against .cmd stand-ins (Windows runner only). */
async function checkWindowsHelpers(temporary) {
  const root = path.join(temporary, 'ps')
  await fsp.mkdir(root, { recursive: true })
  const runHelper = (script, parameters) => {
    const helperPath = path.join(root, `${crypto.randomBytes(4).toString('hex')}.ps1`)
    fs.writeFileSync(helperPath, script)
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
      ...Object.entries(parameters).flatMap(([name, value]) => [`-${name}`, String(value)])]
    // Like the updater: PowerShell 7's module path must not leak into 5.1.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
    return spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 240_000, env })
  }
  const program = (name, version, healthy = true) => {
    const file = path.join(root, name)
    fs.writeFileSync(file, healthy
      ? `@echo off\r\nif "%~1"=="--fanotes-self-test" echo {"ok":true,"version":"${version}"}> "%FANOTES_SELF_TEST_FILE%"\r\nexit /b 0\r\n`
      : '@echo off\r\nexit /b 3\r\n')
    return file
  }
  const common = (directory) => ({
    FromVersion: '2.16.0',
    ToVersion: '2.17.0',
    LogFile: path.join(directory, 'install.log'),
    ResultFile: path.join(directory, 'install-result.json'),
    Mode: 'quiet',
  })
  const readResult = (directory) => JSON.parse(fs.readFileSync(path.join(directory, 'install-result.json'), 'utf8'))

  for (const healthy of [true, false]) {
    const directory = path.join(root, healthy ? 'swap-ok' : 'swap-rollback')
    fs.mkdirSync(directory, { recursive: true })
    const target = path.join(directory, 'app.asar')
    const staged = path.join(directory, 'staged.asar')
    fs.writeFileSync(target, 'old asar')
    fs.writeFileSync(staged, 'new asar')
    fs.writeFileSync(path.join(directory, 'install.lock'), '{"pid":1}')
    const run = runHelper(WINDOWS_SWAP_HELPER, {
      ParentPid: 0, Target: target, Staged: staged, ExpectedSha: sha256(Buffer.from('new asar')),
      Executable: program(`fanotes-${healthy}.cmd`, '2.17.0', healthy), ...common(directory),
    })
    assert.equal(run.status, healthy ? 0 : 18, `${run.stdout}\n${run.stderr}\n${fs.readFileSync(path.join(directory, 'install.log'), 'utf8')}`)
    assert.equal(fs.readFileSync(target, 'utf8'), healthy ? 'new asar' : 'old asar')
    assert.equal(readResult(directory).ok, healthy)
    assert.equal(fs.existsSync(path.join(directory, 'install.lock')), false)
    assert.equal(fs.existsSync(`${target}.fanotes-backup`), false)
  }
  {
    const directory = path.join(root, 'swap-checksum')
    fs.mkdirSync(directory, { recursive: true })
    const target = path.join(directory, 'app.asar')
    fs.writeFileSync(target, 'old asar')
    fs.writeFileSync(path.join(directory, 'staged.asar'), 'tampered')
    const run = runHelper(WINDOWS_SWAP_HELPER, {
      ParentPid: 0, Target: target, Staged: path.join(directory, 'staged.asar'), ExpectedSha: sha256(Buffer.from('new asar')),
      Executable: program('fanotes-ok.cmd', '2.17.0'), ...common(directory),
    })
    assert.equal(run.status, 19)
    assert.equal(fs.readFileSync(target, 'utf8'), 'old asar', 'Eine falsche Prüfsumme ändert nichts.')
  }
  {
    const directory = path.join(root, 'nsis')
    fs.mkdirSync(directory, { recursive: true })
    const installerPath = path.join(directory, 'setup.cmd')
    fs.writeFileSync(installerPath, '@echo off\r\nexit /b 0\r\n')
    const run = runHelper(WINDOWS_INSTALLER_HELPER, {
      ParentPid: 0, Installer: installerPath, ExpectedSha: sha256(fs.readFileSync(installerPath)),
      Executable: program('fanotes-installed.cmd', '2.17.0'), ...common(directory),
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${fs.readFileSync(path.join(directory, 'install.log'), 'utf8')}`)
    assert.equal(readResult(directory).ok, true)
    assert.equal(fs.existsSync(installerPath), false, 'Der Installer wird nach dem Erfolg entfernt.')
  }
  await checkWindowsRealSpawn(root)
}

const REAL_SPAWN_FLAG = '--windows-helper-parent'
const realSpawnLayout = (base) => {
  const userData = path.join(base, 'user-data')
  const updaterRoot = path.join(userData, 'updates')
  const installDirectory = path.join(base, 'Programs', 'FaNotes')
  return {
    profile: { base, userData, home: path.join(base, 'home'), updaterRoot },
    installDirectory,
    resourcesPath: path.join(installDirectory, 'resources'),
    staged: path.join(updaterRoot, '2.17.0', 'FaNotes-Setup-2.17.0-x64.exe'),
    report: path.join(base, 'parent.json'),
  }
}

/**
 * The real start path on Windows: an app process (this script in parent mode) installs a staged
 * update on quit with the real spawn, removes the installer and exits at once. The helper must
 * outlive it, find the installer missing and report that (the path that ends with exit 19).
 * A regression guard: the runner may not reproduce the Windows 11 26200 failure of detached PowerShell.
 */
async function checkWindowsRealSpawn(root) {
  const base = path.join(root, 'real-spawn')
  const layout = realSpawnLayout(base)
  const installer = Buffer.alloc(PACKAGE_BYTES, 0x4d)
  await fsp.mkdir(path.dirname(layout.staged), { recursive: true })
  await fsp.mkdir(layout.resourcesPath, { recursive: true })
  await fsp.mkdir(layout.profile.home, { recursive: true })
  await fsp.writeFile(path.join(layout.installDirectory, 'FaNotes.exe'), 'MZ fake')
  await fsp.writeFile(layout.staged, installer)
  await fsp.writeFile(path.join(layout.profile.updaterRoot, 'state.json'), JSON.stringify({
    schemaVersion: 3,
    highestSeenVersions: {},
    pendingInstall: { channel: 'stable', version: '2.17.0', fileName: path.basename(layout.staged), sha256: sha256(installer), sizeBytes: installer.length, usedDelta: false },
    failedInstall: null,
  }))
  const parent = spawn(process.execPath, [__filename, REAL_SPAWN_FLAG, base], { stdio: 'ignore', windowsHide: true })
  const parentCode = await new Promise((resolve) => { parent.once('exit', resolve) })
  const parentExitedAt = Date.now()
  const report = JSON.parse(fs.readFileSync(layout.report, 'utf8'))
  assert.equal(parentCode, 0, report.error)
  assert.equal(report.started, true, report.error)
  assert.equal(report.installerRemoved, true)
  assert.equal(report.warnings.some((line) => /Installationshelfer/u.test(line)), false, `Der Starter muss den Helfer auf dem ersten Weg starten:\n${report.warnings.join('\n')}`)
  const result = await waitForInstall(layout.profile, 120_000)
  const log = await fsp.readFile(path.join(layout.profile.updaterRoot, 'install.log'), 'utf8')
  assert.ok(Date.parse(result.at) >= parentExitedAt - 1000, 'Der Helfer arbeitet weiter, nachdem FaNotes beendet ist.')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'installer-failed')
  assert.equal(result.version, '2.17.0')
  assert.match(log, /FaNotes installer helper started \(quiet\)/u)
  assert.match(log, /The staged installer is missing\./u, log)
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.profile.updaterRoot, 'helper-started.json'), 'utf8')).pid, report.helperPid, 'Die Sperre ging an den echten Helfer.')
  assert.equal(fs.existsSync(path.join(layout.profile.updaterRoot, 'install.lock')), false)
  console.log('Windows: echter Helferstart über den Starter; der Helfer überlebt die App und meldet den fehlenden Installer.')
}

/** Parent mode of checkWindowsRealSpawn: the quitting app. */
async function windowsHelperParent(base) {
  const layout = realSpawnLayout(base)
  const report = {}
  try {
    const warnings = []
    const manager = createUpdateManager({
      app: fakeApp(layout.profile, '2.16.0'), getWindow: () => null, getSettings: () => DEFAULT_SETTINGS,
      logger: { ...quietLogger, warn: (...parts) => warnings.push(parts.join(' ')) },
      forceSupported: true, platform: 'win32', resourcesPath: layout.resourcesPath, portableExecutable: null,
      executablePath: path.join(layout.installDirectory, 'FaNotes.exe'), updaterRoot: layout.profile.updaterRoot,
    })
    await manager.initialize()
    report.started = await manager.installOnQuit()
    report.helperPid = JSON.parse(fs.readFileSync(path.join(layout.profile.updaterRoot, 'install.lock'), 'utf8')).pid
    report.warnings = warnings
    fs.rmSync(layout.staged, { force: true })
    report.installerRemoved = !fs.existsSync(layout.staged)
  } catch (error) {
    report.error = String(error?.stack ?? error)
  }
  fs.writeFileSync(layout.report, JSON.stringify(report))
  process.exit(report.error ? 1 : 0)
}

/**
 * Optional: runs the real `electron fanotes/ --background-update` against the
 * fake server and reports wall time and the peak resident memory of the whole
 * process tree (sampled from /proc every 20 ms).
 */
async function measureElectron(temporary, github, origin, key) {
  if (process.platform !== 'linux') return
  let electronPath
  try {
    electronPath = require('electron')
  } catch {
    console.log('Messung übersprungen: Electron ist nicht installiert.')
    return
  }
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    console.log('Messung übersprungen: Electron ist nicht installiert.')
    return
  }
  const appRoot = path.resolve(__dirname, '..')
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version
  const kind = version.includes('-beta.') ? 'beta' : version.includes('-nightly.') ? 'nightly' : 'stable'
  const bump = (value) => value.replace(/(\d+)$/u, (digits) => String(Number(digits) + 1))
  const next = bump(version)
  const packages = (release, bytes) => ({
    appimage: { fileName: `FaNotes-${release}-x86_64.AppImage`, bytes },
    portable: { fileName: `FaNotes-${release}-x86_64.tar.gz`, bytes: Buffer.alloc(PACKAGE_BYTES, 9) },
  })

  const treeRss = (rootPid) => {
    const parents = new Map()
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/u.test(entry)) continue
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
        parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
      } catch {
        // gone
      }
    }
    const members = new Set([rootPid])
    let grew = true
    while (grew) {
      grew = false
      for (const [pid, parent] of parents) if (members.has(parent) && !members.has(pid)) { members.add(pid); grew = true }
    }
    let rss = 0
    let pss = 0
    let processes = 0
    const types = []
    for (const pid of members) {
      try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        const match = /VmRSS:\s+(\d+) kB/u.exec(status)
        if (match) { rss += Number(match[1]); processes += 1 }
        const rollup = /^Pss:\s+(\d+) kB/mu.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
        if (rollup) pss += Number(rollup[1])
        const type = /--type=([a-z-]+)/u.exec(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '))
        types.push(type ? type[1] : 'main')
      } catch {
        // gone
      }
    }
    return { rss, pss, processes, types }
  }

  const runOnce = async (label, profile) => {
    const started = process.hrtime.bigint()
    const child = spawn(electronPath, [appRoot, '--background-update', '--ozone-platform=headless', `--user-data-dir=${profile.userData}`], {
      env: {
        ...process.env,
        APPIMAGE: profile.appImage,
        FANOTES_UPDATER_ALLOW_DEV: '1',
        FANOTES_UPDATER_TEST_ORIGIN: origin,
        FANOTES_UPDATER_TEST_PUBLIC_KEY: key.publicPem,
        ELECTRON_ENABLE_LOGGING: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
    let peak = { rss: 0, pss: 0, processes: 0, types: [] }
    const sampler = setInterval(() => {
      const sample = treeRss(child.pid)
      if (sample.pss > peak.pss) peak = sample
    }, 20)
    const code = await new Promise((resolve) => child.once('exit', resolve))
    clearInterval(sampler)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const status = await readStatus(profile.updaterRoot)
    if (code !== 0) console.error(`Electron endete mit ${code}:\n${stderr}`)
    console.log(`Messung ${label}: ${Math.round(ms)} ms, Spitze ${Math.round(peak.pss / 1024)} MiB PSS (${Math.round(peak.rss / 1024)} MiB RSS-Summe) in ${peak.processes} Prozessen [${peak.types.join(', ')}], Ergebnis ${status.result} (exit ${code}).`)
    return { ms, peakMiB: peak.pss / 1024, status }
  }

  github.clear()
  github.publish({ version, platform: 'linux', channel: kind, packages: packages(version, fakeAppImage(version)), key })
  const idle = await makeProfile(temporary, 'measure-idle')
  await fsp.writeFile(idle.appImage, fakeAppImage(version), { mode: 0o755 })
  const idleRun = await runOnce('ohne Update', idle)
  assert.equal(idleRun.status.result, 'up-to-date', JSON.stringify(idleRun.status))
  const idleAgain = await runOnce('zweiter Lauf kurz danach', idle)
  assert.equal(idleAgain.status.result, 'recent')

  github.publish({ version: next, platform: 'linux', channel: kind, packages: packages(next, fakeAppImage(next)), key })
  const update = await makeProfile(temporary, 'measure-update')
  await fsp.writeFile(update.appImage, fakeAppImage(version), { mode: 0o755 })
  const updateRun = await runOnce(`Update auf ${next} (10 MiB, voll)`, update)
  assert.equal(updateRun.status.result, 'installing', JSON.stringify(updateRun.status))
  const result = await waitForInstall(update)
  assert.equal(result.ok, true)
  assert.ok((await fsp.readFile(update.appImage)).equals(fakeAppImage(next)))

  // The self-test the install helpers run on a freshly installed version.
  const selfTest = await makeProfile(temporary, 'measure-self-test')
  const reportPath = path.join(selfTest.updaterRoot, 'self-test.json')
  const started = process.hrtime.bigint()
  const run = spawnSync(electronPath, [appRoot, '--fanotes-self-test', '--ozone-platform=headless', `--user-data-dir=${selfTest.userData}`], {
    env: { ...process.env, FANOTES_SELF_TEST_FILE: reportPath },
    stdio: 'ignore',
    timeout: 60_000,
  })
  assert.equal(run.status, 0)
  assert.deepEqual(JSON.parse(await fsp.readFile(reportPath, 'utf8')), { ok: true, version, reason: null })
  console.log(`Messung Selbsttest: ${Math.round(Number(process.hrtime.bigint() - started) / 1e6)} ms.`)
}

module.exports = { createFakeGithub, fakeAppImage, testKey }

if (require.main === module && process.argv[2] === REAL_SPAWN_FLAG) {
  void windowsHelperParent(process.argv[3])
} else if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
