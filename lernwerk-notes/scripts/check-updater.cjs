'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pipeline } = require('node:stream/promises')
const { applyDeltaPatch } = require('../electron/delta.cjs')
const { createDeltaPatch } = require('./create-delta.cjs')
const { compareVersions, createUpdateManager, INSTALL_HELPER, stableStringify, verifyManifest } = require('../electron/updater.cjs')

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

const waitForProcess = (child) => new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Update-Helfer endete mit ${code ?? signal}.`)))
})

async function main() {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-updater-test-'))
  try {
    const baseVersion = '2.16.0'
    const targetVersion = '2.17.0'
    assert.ok(compareVersions('2026.7.1-beta.2', '2026.7.1-beta.1') > 0)
    assert.ok(compareVersions('2026.7.1', '2026.7.1-beta.99') > 0)
    assert.ok(compareVersions('2026.7.2-beta.1', '2026.7.1') > 0)
    const sourcePath = path.join(temporary, 'FaNotes-2.16.0-x86_64.AppImage')
    const targetPath = path.join(temporary, 'FaNotes-2.17.0-x86_64.AppImage')
    const patchName = `FaNotes-Delta-linux-x64-${baseVersion}-to-${targetVersion}.fndelta`
    const patchPath = path.join(temporary, patchName)
    const sourceBytes = Buffer.alloc(12 * 1024 * 1024, 0x31)
    crypto.randomFillSync(sourceBytes, 3 * 1024 * 1024, 128 * 1024)
    const targetBytes = Buffer.from(sourceBytes)
    crypto.randomFillSync(targetBytes, 7 * 1024 * 1024, 96 * 1024)
    Buffer.from('FaNotes delta updater 2.17.0').copy(targetBytes, 128)
    await Promise.all([fsp.writeFile(sourcePath, sourceBytes), fsp.writeFile(targetPath, targetBytes)])
    const delta = await createDeltaPatch({
      platform: 'linux',
      baseVersion,
      targetVersion,
      sourcePath,
      targetPath,
      outputPath: patchPath,
      targetKind: 'appimage',
      targetFileName: path.basename(targetPath),
    })
    assert.ok(delta.patchSizeBytes < targetBytes.length / 8, 'Das Delta-Paket muss deutlich kleiner als die Zieldatei sein.')

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
    const keyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
    const payload = {
      schemaVersion: 1,
      product: 'FaNotes',
      channel: 'stable',
      platform: 'linux',
      arch: 'x64',
      currentVersion: baseVersion,
      latestVersion: targetVersion,
      updateAvailable: true,
      mandatory: false,
      publishedAt: '2026-07-14T22:30:00.000Z',
      releaseNotes: ['Differentieller Updater'],
      packages: {
        appimage: {
          fileName: path.basename(targetPath),
          url: 'https://fanotes.fasrv.ch/download/appimage',
          sizeBytes: targetBytes.length,
          sha256: delta.target.sha256,
        },
        portable: {
          fileName: `FaNotes-${targetVersion}-x86_64.tar.gz`,
          url: 'https://fanotes.fasrv.ch/download/portable',
          sizeBytes: 11 * 1024 * 1024,
          sha256: 'b'.repeat(64),
        },
      },
      delta: {
        format: delta.format,
        fileName: patchName,
        url: `https://fanotes.fasrv.ch/download/delta/linux-x64/${baseVersion}`,
        sizeBytes: delta.patchSizeBytes,
        sha256: delta.patchSha256,
        source: delta.source,
        target: delta.target,
      },
      websiteUrl: 'https://fanotes.fasrv.ch/',
    }
    const signedManifest = {
      ...payload,
      signature: {
        algorithm: 'ed25519',
        keyId,
        value: crypto.sign(null, Buffer.from(stableStringify(payload)), privateKey).toString('base64'),
      },
    }
    const verified = verifyManifest(signedManifest, baseVersion, publicPem, 'linux', keyId)
    assert.equal(verified.delta.sizeBytes, delta.patchSizeBytes)
    assert.equal(verified.delta.target.sha256, delta.target.sha256)
    const tampered = structuredClone(signedManifest)
    tampered.delta.sizeBytes += 1
    assert.throws(() => verifyManifest(tampered, baseVersion, publicPem, 'linux', keyId), /Signatur/u)

    const betaPayload = structuredClone(payload)
    betaPayload.channel = 'beta'
    betaPayload.packages.appimage.url = 'https://fanotes.fasrv.ch/download/beta/appimage'
    betaPayload.packages.portable.url = 'https://fanotes.fasrv.ch/download/beta/portable'
    betaPayload.delta.url = `https://fanotes.fasrv.ch/download/delta/linux-x64/beta/${baseVersion}`
    const signedBetaManifest = {
      ...betaPayload,
      signature: {
        algorithm: 'ed25519',
        keyId,
        value: crypto.sign(null, Buffer.from(stableStringify(betaPayload)), privateKey).toString('base64'),
      },
    }
    assert.equal(verifyManifest(signedBetaManifest, baseVersion, publicPem, 'linux', keyId, 'beta').channel, 'beta')
    assert.throws(() => verifyManifest(signedBetaManifest, baseVersion, publicPem, 'linux', keyId, 'stable'), /FaNotes-Ausgabe/u)

    const patchBytes = await fsp.readFile(patchPath)
    const manifestUrl = `https://fanotes.fasrv.ch/api/v1/updates/linux-x64?current=${baseVersion}&channel=stable`
    const betaManifestUrl = `https://fanotes.fasrv.ch/api/v1/updates/linux-x64?current=${baseVersion}&channel=beta`
    const patchUrl = payload.delta.url
    const betaPatchUrl = betaPayload.delta.url
    const fullPackageUrl = payload.packages.appimage.url
    const fetchImpl = async (input, options = {}) => {
      const url = String(input)
      if (url === manifestUrl) return new Response(JSON.stringify(signedManifest), { status: 200, headers: { 'content-length': String(Buffer.byteLength(JSON.stringify(signedManifest))) } })
      if (url === betaManifestUrl) return new Response(JSON.stringify(signedBetaManifest), { status: 200, headers: { 'content-length': String(Buffer.byteLength(JSON.stringify(signedBetaManifest))) } })
      if (url === fullPackageUrl) return new Response(targetBytes, { status: 200, headers: { 'content-length': String(targetBytes.length) } })
      if (url !== patchUrl && url !== betaPatchUrl) return new Response('not found', { status: 404 })
      const range = /^bytes=(\d+)-$/u.exec(options.headers?.Range || '')
      const offset = range ? Number(range[1]) : 0
      const body = patchBytes.subarray(offset)
      return new Response(body, {
        status: offset ? 206 : 200,
        headers: {
          'content-length': String(body.length),
          ...(offset ? { 'content-range': `bytes ${offset}-${patchBytes.length - 1}/${patchBytes.length}` } : {}),
        },
      })
    }
    const settings = { autoCheckUpdates: false, autoDownloadUpdates: false, installUpdatesOnQuit: true, updateChannel: 'stable' }
    const app = {
      getVersion: () => baseVersion,
      getPath: (name) => name === 'home' ? path.join(temporary, 'home') : path.join(temporary, 'user-data'),
      isPackaged: true,
    }
    const manager = createUpdateManager({
      app,
      getWindow: () => null,
      getSettings: () => settings,
      forceSupported: true,
      platform: 'linux',
      appImagePath: sourcePath,
      fetchImpl,
      publicKeyPemOverride: publicPem,
      expectedKeyId: keyId,
      logger: { warn: () => undefined },
    })
    const checked = await manager.check({ manual: true })
    assert.equal(checked.status, 'available')
    assert.equal(checked.totalBytes, delta.patchSizeBytes)
    assert.equal(checked.installationKind, 'differential-appimage')

    const releaseDirectory = path.join(temporary, 'user-data', 'updates', targetVersion)
    const partPath = path.join(releaseDirectory, `${patchName}.part`)
    await fsp.mkdir(releaseDirectory, { recursive: true })
    await fsp.writeFile(partPath, patchBytes.subarray(0, Math.floor(patchBytes.length / 3)), { mode: 0o600 })
    const downloaded = await manager.download()
    assert.equal(downloaded.status, 'downloaded')
    assert.equal(downloaded.downloadedBytes, delta.patchSizeBytes)
    assert.equal(downloaded.totalBytes, delta.patchSizeBytes)
    const reconstructedPath = path.join(releaseDirectory, path.basename(targetPath))
    assert.equal(await sha256File(reconstructedPath), delta.target.sha256)
    assert.equal(await fsp.stat(path.join(releaseDirectory, patchName)).catch(() => null), null)
    settings.updateChannel = 'beta'
    manager.configure()
    const betaChecked = await manager.check({ manual: true })
    assert.equal(betaChecked.status, 'available')
    assert.equal(betaChecked.updateChannel, 'beta')
    manager.stop()
    settings.updateChannel = 'stable'

    const incompatibleSourcePath = path.join(temporary, 'FaNotes-incompatible-base.AppImage')
    await fsp.writeFile(incompatibleSourcePath, sourceBytes.subarray(0, sourceBytes.length - 17))
    const fallbackWarnings = []
    const fallbackApp = {
      ...app,
      getPath: (name) => name === 'home' ? path.join(temporary, 'fallback-home') : path.join(temporary, 'fallback-user-data'),
    }
    const fallbackManager = createUpdateManager({
      app: fallbackApp,
      getWindow: () => null,
      getSettings: () => settings,
      forceSupported: true,
      platform: 'linux',
      appImagePath: incompatibleSourcePath,
      fetchImpl,
      publicKeyPemOverride: publicPem,
      expectedKeyId: keyId,
      logger: { warn: (...messages) => fallbackWarnings.push(messages.join(' ')) },
    })
    const fallbackChecked = await fallbackManager.check({ manual: true })
    assert.equal(fallbackChecked.status, 'available')
    assert.equal(fallbackChecked.totalBytes, delta.patchSizeBytes)
    const fallbackDownloaded = await fallbackManager.download()
    assert.equal(fallbackDownloaded.status, 'downloaded')
    assert.equal(fallbackDownloaded.downloadedBytes, targetBytes.length)
    assert.equal(fallbackDownloaded.totalBytes, targetBytes.length)
    assert.equal(fallbackDownloaded.installationKind, 'appimage')
    const fallbackTarget = path.join(temporary, 'fallback-user-data', 'updates', targetVersion, path.basename(targetPath))
    assert.equal(await sha256File(fallbackTarget), delta.target.sha256)
    assert.ok(fallbackWarnings.some((message) => /signierte Vollpaket/u.test(message)), 'Eine inkompatible Delta-Basis muss transparent auf das signierte Vollpaket wechseln.')
    fallbackManager.stop()

    const corruptPatch = path.join(temporary, 'corrupt.fndelta')
    const corruptBytes = Buffer.from(patchBytes)
    corruptBytes[corruptBytes.length - 1] ^= 0xff
    await fsp.writeFile(corruptPatch, corruptBytes)
    await assert.rejects(
      applyDeltaPatch({ patchPath: corruptPatch, sourcePath, outputPath: path.join(temporary, 'corrupt-output'), expected: { platform: 'linux', baseVersion, targetVersion } }),
      /SHA-256/u,
    )

    const helperDirectory = path.join(temporary, 'helper')
    const helperPath = path.join(helperDirectory, 'install.sh')
    const helperTarget = path.join(helperDirectory, 'FaNotes.AppImage')
    const stagedPath = path.join(helperDirectory, 'FaNotes.next.AppImage')
    const markerPath = path.join(helperDirectory, 'installed.json')
    const logPath = path.join(helperDirectory, 'install.log')
    const oldExecutable = '#!/bin/sh\nexit 0\n'
    const nextExecutable = '#!/bin/sh\nsleep 12\n'
    await fsp.mkdir(helperDirectory, { recursive: true })
    await fsp.writeFile(helperPath, INSTALL_HELPER, { mode: 0o700 })
    await fsp.writeFile(helperTarget, oldExecutable, { mode: 0o700 })
    await fsp.writeFile(stagedPath, nextExecutable, { mode: 0o700 })
    const stagedSha = crypto.createHash('sha256').update(nextExecutable).digest('hex')
    await waitForProcess(spawn('/bin/sh', [helperPath, '99999999', helperTarget, stagedPath, stagedSha, baseVersion, targetVersion, logPath, markerPath]))
    assert.equal(await fsp.readFile(helperTarget, 'utf8'), nextExecutable)
    assert.equal(JSON.parse(await fsp.readFile(markerPath, 'utf8')).version, targetVersion)

    console.log(`Updaterprüfung erfolgreich: signiertes ${DELTA_LABEL(delta.patchSizeBytes, targetBytes.length)}, Range-Fortsetzung, automatische Vollpaket-Ausweichroute, lokale Rekonstruktion, SHA-256 und atomarer Rollback-Pfad.`)
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true })
  }
}

const DELTA_LABEL = (patchBytes, targetBytes) => `Delta-Update (${(patchBytes / targetBytes * 100).toFixed(1)} % der Vollgröße)`

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
