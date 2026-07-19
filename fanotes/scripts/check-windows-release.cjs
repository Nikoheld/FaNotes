'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  PLATFORM_RELEASES,
  WINDOWS_DELTA_HELPER,
  WINDOWS_INSTALLER_ARGS,
  stableStringify,
  verifyManifest,
} = require('../electron/updater.cjs')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
const publicDer = publicKey.export({ type: 'spki', format: 'der' })
const keyId = crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 16)
const payload = {
  schemaVersion: 1,
  product: 'FaNotes',
  channel: 'stable',
  platform: 'windows',
  arch: 'x64',
  currentVersion: '2.13.0',
  latestVersion: '2.14.0',
  updateAvailable: true,
  mandatory: false,
  publishedAt: '2026-07-14T20:00:00.000Z',
  releaseNotes: ['Windows-Testrelease'],
  packages: {
    installer: {
      fileName: 'FaNotes-Setup-2.14.0-x64.exe',
      url: 'https://fanotes.fasrv.ch/download/windows-installer',
      sizeBytes: 120_000_000,
      sha256: 'a'.repeat(64),
    },
    portable: {
      fileName: 'FaNotes-Portable-2.14.0-x64.exe',
      url: 'https://fanotes.fasrv.ch/download/windows-portable',
      sizeBytes: 125_000_000,
      sha256: 'b'.repeat(64),
    },
  },
  delta: {
    format: 'fanotes-delta-v1',
    fileName: 'FaNotes-Delta-windows-x64-2.13.0-to-2.14.0.fndelta',
    url: 'https://fanotes.fasrv.ch/download/delta/windows-x64/2.13.0',
    sizeBytes: 2_000_000,
    sha256: 'c'.repeat(64),
    source: { kind: 'app-asar', sizeBytes: 90_000_000, sha256: 'd'.repeat(64) },
    target: { kind: 'app-asar', fileName: 'app.asar', sizeBytes: 91_000_000, sha256: 'e'.repeat(64) },
  },
  websiteUrl: 'https://fanotes.fasrv.ch/',
}

const signManifest = (candidatePayload) => ({
  ...candidatePayload,
  signature: {
    algorithm: 'ed25519',
    keyId,
    value: crypto.sign(null, Buffer.from(stableStringify(candidatePayload)), privateKey).toString('base64'),
  },
})

const verified = verifyManifest(signManifest(payload), '2.13.0', publicPem, 'win32', keyId)
assert.equal(verified.latestVersion, '2.14.0')
assert.equal(verified.packages.installer.fileName, payload.packages.installer.fileName)
assert.equal(verified.packages.portable.url, payload.packages.portable.url)
assert.equal(verified.delta.target.fileName, 'app.asar')
assert.deepEqual(WINDOWS_INSTALLER_ARGS, ['/S', '--updated', '--force-run'])
assert.match(WINDOWS_DELTA_HELPER, /Get-FileHash[\s\S]+fanotes-backup[\s\S]+rolling back/u)
assert.equal(PLATFORM_RELEASES.win32.api, 'https://fanotes.fasrv.ch/api/v1/updates/windows-x64')

assert.throws(
  () => verifyManifest(signManifest(payload), '2.13.0', publicPem, 'linux', keyId),
  /Plattform|bestimmt/u,
)
assert.throws(
  () => verifyManifest(signManifest({ ...payload, delta: { ...payload.delta, url: 'https://example.com/update.fndelta' } }), '2.13.0', publicPem, 'win32', keyId),
  /vertrauenswürdig/u,
)
assert.throws(
  () => verifyManifest(signManifest({ ...payload, packages: { ...payload.packages, installer: { ...payload.packages.installer, fileName: 'FaNotes.exe' } } }), '2.13.0', publicPem, 'win32', keyId),
  /Dateiname/u,
)
assert.throws(
  () => verifyManifest(signManifest({ ...payload, packages: { ...payload.packages, installer: { ...payload.packages.installer, url: 'https://example.com/FaNotes.exe' } } }), '2.13.0', publicPem, 'win32', keyId),
  /vertrauenswürdig/u,
)
const tampered = signManifest(payload)
tampered.packages.installer.sha256 = 'c'.repeat(64)
assert.throws(() => verifyManifest(tampered, '2.13.0', publicPem, 'win32', keyId), /Signatur/u)

const packageConfig = JSON.parse(read('package.json'))
assert.deepEqual(packageConfig.build.win.target.map((target) => target.target), ['nsis', 'portable'])
assert.equal(packageConfig.build.nsis.artifactName, 'FaNotes-Setup-${version}-x64.${ext}')
assert.equal(packageConfig.build.portable.artifactName, 'FaNotes-Portable-${version}-x64.${ext}')
assert.ok(packageConfig.build.files.includes('resources/onenote/**/*'))
assert.ok(packageConfig.build.files.includes('!dist/ocr/fanotes-trocr-web/**/*'))
assert.ok(packageConfig.build.files.includes('!dist/ocr/pylaia-iam-q8.onnx'))
assert.equal(packageConfig.build.win.extraResources.length, 2)
const windowsNativeOcrResource = packageConfig.build.win.extraResources.find((entry) => entry.from === 'node_modules/onnxruntime-node')
const windowsNativeCommonResource = packageConfig.build.win.extraResources.find((entry) => entry.to === 'native-ocr/node_modules/onnxruntime-common')
assert.ok(windowsNativeOcrResource)
assert.ok(windowsNativeCommonResource)
assert.equal(windowsNativeOcrResource.from, 'node_modules/onnxruntime-node')
assert.equal(windowsNativeOcrResource.to, 'native-ocr/node_modules/onnxruntime-node')
assert.ok(windowsNativeOcrResource.filter.includes('bin/napi-v3/win32/x64/onnxruntime_binding.node'))
assert.ok(windowsNativeOcrResource.filter.includes('bin/napi-v3/win32/x64/onnxruntime.dll'))
assert.ok(!windowsNativeOcrResource.filter.some((entry) => /cuda|directml|tensorrt|linux/iu.test(entry)))
assert.equal(windowsNativeCommonResource.from, 'node_modules/onnxruntime-node/node_modules/onnxruntime-common')
assert.ok(windowsNativeCommonResource.filter.includes('dist/cjs/**/*'))
assert.equal(
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'resources', 'onenote', 'windows', 'one2html.exe'))).digest('hex'),
  'cfcba9231edf433e3f84b92a7ce119ec4af3df870301691bbefea83618f295af',
)
assert.equal(
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'resources', 'onenote', 'windows', '7za.exe'))).digest('hex'),
  'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95',
)

const serverSource = read('../fanotes-site/server.mjs')
const siteSource = read('../fanotes-site/public/index.html')
const settingsSource = read('src/components/SettingsModal.tsx')
const mainSource = read('electron/main.cjs')
assert.match(serverSource, /\/api\/v1\/updates\/windows-x64/u)
assert.match(serverSource, /windows-installer\|windows-portable/u)
assert.match(serverSource, /download\\\/delta|download\/delta/u)
assert.match(siteSource, /data-download-windows-installer/u)
assert.match(siteSource, /Windows 10 &amp; 11/u)
assert.match(settingsSource, /windows-installer/u)
assert.match(settingsSource, /Differentieller Download/u)
assert.match(settingsSource, /desktopOcrModel/u)
assert.match(settingsSource, /memoryBudgetMb/u)
assert.match(mainSource, /materializeOneNoteTools/u)
assert.match(mainSource, /recognizeNativeOcrLine/u)
assert.match(mainSource, /native-ocr-worker\.cjs/u)
assert.match(read('electron/preload.cjs'), /recognizeNativeHandwritingLine/u)

console.log('Windows-Prüfung erfolgreich: differenzielles app.asar-Update, schlanke native ONNX-CPU-Laufzeit, OneNote-Werkzeuge, PowerShell-Rollback, NSIS-Fallback, signierte Plattformbindung und Website-Integration geprüft.')
