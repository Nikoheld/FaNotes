'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  INSTALL_HELPER,
  PLATFORM_RELEASES,
  WINDOWS_DELTA_HELPER,
  WINDOWS_INSTALLER_ARGS,
  WINDOWS_INSTALLER_HELPER,
  WINDOWS_LAUNCHER,
  WINDOWS_SWAP_HELPER,
  githubReleaseAssetUrl,
  stableStringify,
  verifyManifest,
} = require('../electron/updater.cjs')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
const publicDer = publicKey.export({ type: 'spki', format: 'der' })
const keyId = crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 16)
// Desktop auto-update reads the signed manifest and its packages from the
// GitHub release (RELEASE_POLICY.md, scripts/write-update-manifests.mjs); the
// fanotes.fasrv.ch feed only serves copies older than 2026.10.6.
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
      url: githubReleaseAssetUrl('2.14.0', 'FaNotes-Setup-2.14.0-x64.exe'),
      sizeBytes: 120_000_000,
      sha256: 'a'.repeat(64),
    },
    portable: {
      fileName: 'FaNotes-Portable-2.14.0-x64.exe',
      url: githubReleaseAssetUrl('2.14.0', 'FaNotes-Portable-2.14.0-x64.exe'),
      sizeBytes: 125_000_000,
      sha256: 'b'.repeat(64),
    },
  },
  delta: {
    format: 'fanotes-delta-v1',
    fileName: 'FaNotes-Delta-windows-x64-2.13.0-to-2.14.0.fndelta',
    url: githubReleaseAssetUrl('2.14.0', 'FaNotes-Delta-windows-x64-2.13.0-to-2.14.0.fndelta'),
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

const verified = verifyManifest(signManifest(payload), '2.13.0', publicPem, 'win32', keyId, 'stable', '2.14.0')
assert.equal(verified.latestVersion, '2.14.0')
assert.equal(verified.packages.installer.fileName, payload.packages.installer.fileName)
assert.equal(verified.packages.portable.url, payload.packages.portable.url)
assert.equal(verified.delta.target.fileName, 'app.asar')
// The helper starts FaNotes itself after the self-test, so NSIS must not (--force-run).
assert.deepEqual(WINDOWS_INSTALLER_ARGS, ['/S', '--updated'])
assert.match(WINDOWS_DELTA_HELPER, /SHA256[\s\S]+fanotes-backup[\s\S]+Invoke-SelfTest[\s\S]+rolling back/u)
assert.equal(WINDOWS_SWAP_HELPER, WINDOWS_DELTA_HELPER)
assert.match(WINDOWS_INSTALLER_HELPER, /SHA256[\s\S]+'\/S','--updated'[\s\S]+Invoke-SelfTest/u)
for (const helper of [WINDOWS_SWAP_HELPER, WINDOWS_INSTALLER_HELPER]) {
  assert.match(helper, /install\.lock/u, 'Every Windows helper releases the install lock.')
  assert.match(helper, /\$Mode -eq 'relaunch'/u)
  assert.doesNotMatch(helper, /--force-run/u)
  // The app quits only after it has seen this marker, so it must be the helper's very first action.
  assert.match(helper, /^param\([\s\S]+?\[string\]\$AttemptId = ''\n\)\s*\$root = [^\n]+\n# First action[^\n]*\ntry \{\n {2}\[System\.IO\.File\]::WriteAllText\(\(Join-Path \$root 'helper-started\.json'\)/u)
}
assert.match(INSTALL_HELPER, /lock_file="[^\n]+\n# First action[^\n]*\nprintf [^\n]+helper-started\.json[^\n]+\n\nexec >>/u)
// Never a detached, console-less PowerShell: Start-Process gives the helper a hidden console of its own, WMI is the fallback.
assert.match(WINDOWS_LAUNCHER, /Start-Process -FilePath \$program -ArgumentList \$line -WindowStyle Hidden -PassThru[\s\S]+Win32_Process -MethodName Create[\s\S]+exit 3/u)
assert.doesNotMatch(WINDOWS_LAUNCHER, /-NoNewWindow/u)
assert.equal(PLATFORM_RELEASES.win32.api, 'https://api.github.com/repos/Nikoheld/FaNotes/releases')
// The manifest must name the release it was picked from.
assert.throws(
  () => verifyManifest(signManifest(payload), '2.13.0', publicPem, 'win32', keyId, 'stable', '2.15.0'),
  /anderen Release/u,
)
// The old server feed URLs are no longer trusted for packages.
assert.throws(
  () => verifyManifest(signManifest({ ...payload, packages: { ...payload.packages, installer: { ...payload.packages.installer, url: 'https://fanotes.fasrv.ch/download/windows-installer' } } }), '2.13.0', publicPem, 'win32', keyId),
  /vertrauenswürdig/u,
)

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
assert.equal(packageConfig.build.win.extraResources.length, 3)
const windowsNativeMathResource = packageConfig.build.win.extraResources.find((entry) => entry.to === 'native-math')
const windowsNativeOcrResource = packageConfig.build.win.extraResources.find((entry) => entry.from === 'native-ocr/win32-x64')
const windowsNativeRuntimeResource = packageConfig.build.win.extraResources.find((entry) => entry.from === 'node_modules/onnxruntime-node/bin/napi-v3/win32/x64')
assert.ok(windowsNativeMathResource)
assert.equal(windowsNativeMathResource.from, 'native-math/win32-x64')
assert.deepEqual(windowsNativeMathResource.filter, [
  'crispembed.exe',
  'crispembed-avx2.exe',
  'runtime-manifest.json',
])
assert.ok(windowsNativeOcrResource)
assert.ok(windowsNativeRuntimeResource)
assert.equal(windowsNativeOcrResource.to, 'native-ocr')
assert.deepEqual(windowsNativeOcrResource.filter, ['fanotes-ocr.exe', 'runtime-manifest.json'])
assert.equal(windowsNativeRuntimeResource.to, 'native-ocr')
assert.deepEqual(windowsNativeRuntimeResource.filter, ['onnxruntime.dll'])
assert.ok(![...windowsNativeOcrResource.filter, ...windowsNativeRuntimeResource.filter].some((entry) => /cuda|directml|tensorrt|linux|\.node$/iu.test(entry)))
const windowsOcrManifest = JSON.parse(read('native-ocr/win32-x64/runtime-manifest.json'))
const windowsOcrExecutable = fs.readFileSync(path.join(root, 'native-ocr', 'win32-x64', 'fanotes-ocr.exe'))
assert.equal(windowsOcrManifest.rustTarget, 'x86_64-pc-windows-gnu')
assert.equal(windowsOcrExecutable.subarray(0, 2).toString('latin1'), 'MZ')
assert.equal(windowsOcrExecutable.length, windowsOcrManifest.executable.size)
assert.equal(crypto.createHash('sha256').update(windowsOcrExecutable).digest('hex'), windowsOcrManifest.executable.sha256)
assert.equal(
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, windowsOcrManifest.onnxruntime.from))).digest('hex'),
  windowsOcrManifest.onnxruntime.sha256,
)
assert.equal(
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'resources', 'onenote', 'windows', 'one2html.exe'))).digest('hex'),
  '9d3d043f86a65e8b97782bb72275837768a066353c771dab96bceef683136981',
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
// The legacy server feed still serves copies older than 2026.10.6.
assert.match(serverSource, /'windows-installer', 'windows-portable'/u)
assert.match(serverSource, /deltaPathname\(platform, currentVersion, channel\)/u)
// The redesigned homepage (13b680a8) has a Windows platform panel.
assert.match(siteSource, /data-platform-panel="windows"/u)
assert.match(siteSource, /Windows <span>10 und 11, x64<\/span>/u)
assert.match(settingsSource, /windows-installer/u)
assert.match(settingsSource, /Differentieller Download/u)
assert.match(settingsSource, /desktopOcrModel/u)
assert.match(settingsSource, /memoryBudgetMb/u)
assert.match(mainSource, /materializeOneNoteTools/u)
assert.match(mainSource, /recognizeNativeOcrLine/u)
assert.match(mainSource, /require\('\.\/native-ocr\.cjs'\)/u)
assert.match(read('electron/native-ocr.cjs'), /platform === 'win32' \? 'fanotes-ocr\.exe'/u)
assert.match(read('electron/preload.cjs'), /recognizeNativeHandwritingLine/u)

console.log('Windows-Prüfung erfolgreich: differenzielles app.asar-Update, schlanke native ONNX-CPU-Laufzeit, OneNote-Werkzeuge, PowerShell-Rollback, NSIS-Fallback, signierte Plattformbindung und Website-Integration geprüft.')
