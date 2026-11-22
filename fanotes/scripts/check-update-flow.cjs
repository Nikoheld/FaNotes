'use strict'

/**
 * Runs the desktop update state machine against a local fake release feed.
 * Nothing here talks to GitHub: the manager's fetch is pointed at a loopback
 * HTTP server that serves a signed manifest and a synthetic AppImage, and the
 * real Linux install helper swaps synthetic shell-script "AppImages".
 *
 * Covered: success (progress, verified install, relaunch with the user's
 * switches), corrupt download, interrupted download (Range resume), a damaged
 * resumed partial file (one automatic fresh retry), failed relaunch and failed
 * self-test (rollback, reported once, never retried automatically), launch
 * installs only for an already verified package, and "install on next quit".
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createUpdateManager, githubReleaseAssetUrl, stableStringify, UPDATE_EVENT } = require('../electron/updater.cjs')

if (process.platform === 'win32') {
  console.log('Update-Ablaufprüfung übersprungen: der Linux-Helfer braucht /bin/sh.')
  process.exit(0)
}

const BASE = '2026.11.3'
const TARGET = '2026.11.4'
const PACKAGE_NAME = `FaNotes-${TARGET}-x86_64.AppImage`
const SIZE = 10 * 1024 * 1024 + 4096
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const selfTestLine = (version) => `if [ "$1" = --fanotes-self-test ]; then printf '{"ok":true,"version":"${version}"}' >"$FANOTES_SELF_TEST_FILE"; exit 0; fi\n`

/** A runnable stand-in for the new AppImage, padded to the minimum package size. */
function buildPackage({ argsFile, startsOk = true, selfTestOk = true }) {
  const lines = ['#!/bin/sh\n']
  if (selfTestOk) lines.push(selfTestLine(TARGET))
  else lines.push('if [ "$1" = --fanotes-self-test ]; then exit 1; fi\n')
  if (startsOk) lines.push(`for a in "$@"; do printf '%s\\n' "$a" >>"${argsFile}"; done\nsleep 10\nexit 0\n`)
  else lines.push('exit 3\n')
  const head = Buffer.from(lines.join(''))
  const body = Buffer.alloc(SIZE, 0x23)
  head.copy(body)
  return body
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-update-flow-'))
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
  const keyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)

  // What the fake feed currently serves.
  const feed = { bytes: null, served: null, interruptions: 0, interruptAfter: 0, ranged: 0, requests: 0 }
  const setPackage = (bytes) => {
    feed.bytes = bytes
    feed.served = bytes
  }

  const manifestFor = (bytes) => {
    const payload = {
      schemaVersion: 1,
      product: 'FaNotes',
      channel: 'stable',
      platform: 'linux',
      arch: 'x64',
      latestVersion: TARGET,
      mandatory: false,
      publishedAt: '2026-11-22T10:00:00.000Z',
      releaseNotes: ['**Klarerer** Update-Ablauf', 'Zweite Notiz'],
      packages: {
        appimage: {
          fileName: PACKAGE_NAME,
          url: githubReleaseAssetUrl(TARGET, PACKAGE_NAME),
          sizeBytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
        portable: {
          fileName: `FaNotes-${TARGET}-x86_64.tar.gz`,
          url: githubReleaseAssetUrl(TARGET, `FaNotes-${TARGET}-x86_64.tar.gz`),
          sizeBytes: 11 * 1024 * 1024,
          sha256: 'b'.repeat(64),
        },
      },
      websiteUrl: 'https://fanotes.fasrv.ch/',
    }
    return { ...payload, signature: { algorithm: 'ed25519', keyId, value: crypto.sign(null, Buffer.from(stableStringify(payload)), privateKey).toString('base64') } }
  }

  const server = http.createServer((request, response) => {
    feed.requests += 1
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const json = (body) => {
      const text = JSON.stringify(body)
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }
    if (pathname.endsWith('/releases/latest')) {
      return json({
        tag_name: `v${TARGET}`,
        draft: false,
        prerelease: false,
        assets: [{ name: 'FaNotes-update-linux-x64.json', browser_download_url: githubReleaseAssetUrl(TARGET, 'FaNotes-update-linux-x64.json') }],
      })
    }
    if (pathname.endsWith('/FaNotes-update-linux-x64.json')) return json(manifestFor(feed.bytes))
    if (pathname.endsWith(`/${PACKAGE_NAME}`)) {
      const range = /^bytes=(\d+)-$/u.exec(request.headers.range || '')
      const offset = range ? Number(range[1]) : 0
      if (range) feed.ranged += 1
      const body = feed.served.subarray(offset)
      const headers = { 'content-type': 'application/octet-stream', 'content-length': body.length }
      if (range) headers['content-range'] = `bytes ${offset}-${feed.served.length - 1}/${feed.served.length}`
      response.writeHead(range ? 206 : 200, headers)
      if (feed.interruptions > 0) {
        feed.interruptions -= 1
        response.write(body.subarray(0, feed.interruptAfter))
        setTimeout(() => request.socket.destroy(), 20)
        return undefined
      }
      response.end(body)
      return undefined
    }
    response.writeHead(404)
    response.end('not found')
    return undefined
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  // The updater only accepts GitHub hosts; the fake feed answers for them.
  const fetchImpl = (input, options) => {
    const target = new URL(String(input))
    return fetch(`${origin}${target.pathname}${target.search}`, options)
  }

  const profiles = []
  async function createProfile(name, { settings = {}, launchArgv = ['/opt/FaNotes/fanotes', '--ozone-platform=x11', '--use-gl=angle'] } = {}) {
    const directory = path.join(root, name)
    const userData = path.join(directory, 'user-data')
    const target = path.join(directory, 'FaNotes.AppImage')
    const oldContents = `#!/bin/sh\n# old ${name}\nexit 0\n`
    await fsp.mkdir(userData, { recursive: true })
    await fsp.writeFile(target, oldContents, { mode: 0o755 })
    const events = []
    const options = {
      autoCheckUpdates: false,
      autoDownloadUpdates: false,
      installUpdatesOnQuit: true,
      updateChannel: 'stable',
      ...settings,
    }
    const make = (version = BASE) => createUpdateManager({
      app: { getVersion: () => version, getPath: () => userData, isPackaged: true },
      getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, state) => { if (channel === UPDATE_EVENT) events.push(state) } } }),
      getSettings: () => options,
      forceSupported: true,
      platform: 'linux',
      appImagePath: target,
      launchArgv,
      helperParentPid: 99_999_999,
      fetchImpl,
      publicKeyPemOverride: publicPem,
      expectedKeyId: keyId,
      logger: { warn: () => undefined },
    })
    const profile = { directory, userData, target, oldContents, events, options, make, argsFile: path.join(directory, 'relaunch-args.txt') }
    profiles.push(profile)
    return profile
  }

  async function waitForHelper(profile) {
    const lock = path.join(profile.userData, 'updates', 'install.lock')
    const result = path.join(profile.userData, 'updates', 'install-result.json')
    for (let waited = 0; waited < 60_000; waited += 100) {
      if (fs.existsSync(result) && !fs.existsSync(lock)) return JSON.parse(await fsp.readFile(result, 'utf8'))
      await sleep(100)
    }
    throw new Error('Der Update-Helfer ist nicht fertig geworden.')
  }

  async function waitFor(predicate, label) {
    for (let waited = 0; waited < 30_000; waited += 50) {
      if (await predicate()) return
      await sleep(50)
    }
    throw new Error(`Zeitüberschreitung: ${label}`)
  }

  try {
    // 1. Success: states in order, progress with sizes, verified install, relaunch with the user's switches.
    {
      const profile = await createProfile('success')
      setPackage(buildPackage({ argsFile: profile.argsFile }))
      const manager = profile.make()
      const checked = await manager.check({ manual: true })
      assert.equal(checked.status, 'available')
      assert.equal(checked.totalBytes, SIZE)
      assert.equal(checked.releaseNotes[0], '**Klarerer** Update-Ablauf')
      const downloaded = await manager.download()
      assert.equal(downloaded.status, 'downloaded')
      assert.equal(downloaded.downloadedBytes, SIZE)
      const statuses = [...new Set(profile.events.map((event) => event.status))]
      assert.deepEqual(statuses.filter((status) => ['available', 'downloading', 'downloaded'].includes(status)), ['available', 'downloading', 'downloaded'])
      const progressed = profile.events.filter((event) => event.status === 'downloading').map((event) => event.downloadedBytes)
      assert.ok(progressed.every((bytes, index) => index === 0 || bytes >= progressed[index - 1]), 'Der Fortschritt darf nie zurückspringen.')
      assert.equal(await fsp.readFile(profile.target, 'utf8'), profile.oldContents, 'Vor dem Neustart bleibt die alte Version unverändert.')

      const installing = await manager.prepareInstall({ mode: 'relaunch' })
      assert.equal(installing.status, 'installing')
      const result = await waitForHelper(profile)
      assert.equal(result.ok, true)
      assert.equal(result.version, TARGET)
      assert.deepEqual((await fsp.readFile(profile.argsFile, 'utf8')).split('\n').filter(Boolean), ['--ozone-platform=x11', '--use-gl=angle', `--fanotes-updated-from=${BASE}`])
      assert.equal(fs.existsSync(`${profile.target}.fanotes-backup`), false, 'Nach dem Erfolg bleibt keine Sicherung zurück.')

      // The next start of the new version tells the user once.
      const next = profile.make(TARGET)
      await next.start()
      assert.equal(next.getState().justUpdated?.to, TARGET)
      assert.equal(next.getState().rolledBack, null)
      next.stop()
      manager.stop()
    }

    // 2. Corrupt download: same size, one flipped byte. Rejected, nothing staged, retry succeeds.
    {
      const profile = await createProfile('corrupt')
      const good = buildPackage({ argsFile: profile.argsFile })
      setPackage(good)
      const manager = profile.make()
      await manager.check({ manual: true })
      const corrupt = Buffer.from(good)
      corrupt[SIZE - 1] ^= 0xff
      feed.served = corrupt
      const failed = await manager.download()
      assert.equal(failed.status, 'error')
      assert.equal(failed.failedPhase, 'download')
      assert.match(failed.error, /SHA-256/u)
      const releaseDirectory = path.join(profile.userData, 'updates', TARGET)
      assert.deepEqual((await fsp.readdir(releaseDirectory)).filter((name) => name.startsWith('FaNotes-')), [], 'Eine beschädigte Datei wird verworfen.')
      await assert.rejects(manager.prepareInstall(), /geprüftes Update/u, 'Ohne geprüften Download wird nichts installiert.')
      assert.equal(await fsp.readFile(profile.target, 'utf8'), profile.oldContents)
      feed.served = good
      const retried = await manager.download()
      assert.equal(retried.status, 'downloaded')
      assert.equal(retried.error, null)
      assert.equal(retried.failedPhase, null)
      manager.stop()
    }

    // 3. Interrupted download: the connection drops twice, the transfer resumes with Range.
    {
      const profile = await createProfile('interrupted')
      setPackage(buildPackage({ argsFile: profile.argsFile }))
      const manager = profile.make()
      await manager.check({ manual: true })
      feed.interruptions = 2
      feed.interruptAfter = 3 * 1024 * 1024
      feed.ranged = 0
      const downloaded = await manager.download()
      assert.equal(downloaded.status, 'downloaded')
      assert.ok(feed.ranged >= 2, `Der Download muss per Range fortgesetzt werden (${feed.ranged}).`)
      const staged = path.join(profile.userData, 'updates', TARGET, PACKAGE_NAME)
      assert.equal(crypto.createHash('sha256').update(await fsp.readFile(staged)).digest('hex'), crypto.createHash('sha256').update(feed.bytes).digest('hex'))
      manager.stop()
    }

    // 3b. A damaged partial file from an earlier run: resumed, fails the checksum, one automatic fresh download.
    {
      const profile = await createProfile('damaged-partial')
      setPackage(buildPackage({ argsFile: profile.argsFile }))
      const manager = profile.make()
      await manager.check({ manual: true })
      const releaseDirectory = path.join(profile.userData, 'updates', TARGET)
      await fsp.mkdir(releaseDirectory, { recursive: true })
      await fsp.writeFile(path.join(releaseDirectory, `${PACKAGE_NAME}.part`), Buffer.alloc(2 * 1024 * 1024, 0x55), { mode: 0o600 })
      const downloaded = await manager.download()
      assert.equal(downloaded.status, 'downloaded', 'Ein beschädigter Teil-Download darf den Nutzer nicht zum Neuversuch zwingen.')
      manager.stop()
    }

    // 4. Failed relaunch: the new version passes the self-test but dies when started normally. Rolled back.
    {
      const profile = await createProfile('failed-relaunch')
      setPackage(buildPackage({ argsFile: profile.argsFile, startsOk: false }))
      const manager = profile.make()
      await manager.check({ manual: true })
      await manager.download()
      await manager.prepareInstall({ mode: 'relaunch' })
      const result = await waitForHelper(profile)
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'self-test-failed')
      assert.equal(await fsp.readFile(profile.target, 'utf8'), profile.oldContents, 'Die alte Version wird wiederhergestellt.')
      assert.equal(fs.existsSync(`${profile.target}.fanotes-backup`), false)

      // The restored version reports it once and does not install the same release again by itself.
      profile.options.autoDownloadUpdates = true
      const restored = profile.make()
      await restored.start()
      assert.equal(restored.getState().rolledBack?.version, TARGET)
      assert.match(restored.getState().rolledBack.message, /nicht starten/u)
      assert.equal(restored.getState().failedInstallVersion, TARGET)
      const afterCheck = await restored.check({ manual: true })
      assert.equal(afterCheck.status, 'available', 'Eine zurückgesetzte Version wird nicht erneut automatisch geladen.')
      const launch = await restored.applyPendingInstallOnLaunch({ prepare: false })
      assert.equal(launch.ready, false)
      restored.stop()
      manager.stop()
    }

    // 4b. The new version fails its self-test right after the swap. Rolled back as well.
    {
      const profile = await createProfile('failed-self-test')
      setPackage(buildPackage({ argsFile: profile.argsFile, selfTestOk: false }))
      const manager = profile.make()
      await manager.check({ manual: true })
      await manager.download()
      await manager.prepareInstall({ mode: 'quiet' })
      const result = await waitForHelper(profile)
      assert.equal(result.ok, false)
      assert.equal(await fsp.readFile(profile.target, 'utf8'), profile.oldContents)
      manager.stop()
    }

    // 5. Launch: a fresh download never restarts the app; a package that is already verified does.
    {
      const profile = await createProfile('launch', { settings: { autoDownloadUpdates: true } })
      setPackage(buildPackage({ argsFile: profile.argsFile }))
      const manager = profile.make()
      await manager.start()
      const first = await manager.applyPendingInstallOnLaunch({ prepare: false })
      assert.equal(first.ready, false, 'Ein Download, der erst beim Start beginnt, startet die App nicht neu.')
      await waitFor(() => manager.getState().status === 'downloaded', 'der Hintergrund-Download')
      manager.stop()
      const second = profile.make()
      await second.start()
      const again = await second.applyPendingInstallOnLaunch({ prepare: false })
      assert.equal(again.ready, true)
      assert.equal(again.installStarted, false, 'Ohne Speichern durch das Fenster wird der Helfer nicht gestartet.')
      assert.equal(await fsp.readFile(profile.target, 'utf8'), profile.oldContents)
      second.stop()
    }

    // 6. Install on next quit: only after the user asked, even with automatic installs off.
    {
      const profile = await createProfile('quit-later', { settings: { installUpdatesOnQuit: false } })
      setPackage(buildPackage({ argsFile: profile.argsFile }))
      const manager = profile.make()
      await manager.check({ manual: true })
      await manager.download()
      assert.equal(await manager.installOnQuit(), false, 'Ohne Auftrag wird beim Beenden nichts installiert.')
      assert.equal(manager.requestInstallOnQuit(true) instanceof Promise, false)
      assert.equal(manager.getState().installOnQuitRequested, true)
      assert.equal(await manager.installOnQuit(), true)
      const result = await waitForHelper(profile)
      assert.equal(result.ok, true)
      assert.equal(result.mode, 'quiet')
      assert.match(await fsp.readFile(profile.target, 'utf8'), /fanotes-self-test/u)
      manager.stop()
    }

    console.log('Update-Ablaufprüfung erfolgreich: Erfolg mit Fortschritt und Relaunch-Schaltern, beschädigter Download, unterbrochener Download mit Range-Fortsetzung, beschädigter Teil-Download, Rollback bei gescheitertem Start und Selbsttest, Start-Installation nur für geprüfte Pakete, Installation beim nächsten Beenden.')
  } finally {
    server.close()
    server.closeAllConnections?.()
    await fsp.rm(root, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error)
  process.exit(1)
})
