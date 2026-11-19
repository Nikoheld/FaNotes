// Shared test vectors for the desktop updater: the JS implementation
// (electron/updater.cjs, delta.cjs, releaseVersion.cjs, download-hosts.cjs and
// release-policy-core.mjs) and the Rust port (crates/fanotes-updater) must give
// the same answer, down to the German error text, for every case in
// scripts/fixtures/updater/vectors.json.
//
//   node scripts/check-updater-vectors.mjs           verify the JS side against the file
//   node scripts/check-updater-vectors.mjs --write   rebuild the file (JS is the oracle;
//                                                     every case also carries an intent
//                                                     that must agree with the oracle)
//
// `cargo test -p fanotes-updater --test vectors` verifies the Rust side against
// the same file. Test keys are synthetic and derived from fixed seeds.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReleasePolicy } from './release-policy-core.mjs'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const vectorsPath = path.join(here, 'fixtures', 'updater', 'vectors.json')
const { applyDeltaPatch, sha256File } = require('../electron/delta.cjs')
const { assertModelDownloadUrl } = require('../electron/download-hosts.cjs')
const {
  DELTA_ROUTE_PATTERN, DOWNLOAD_ROUTE_PATTERN, LINUX_PACKAGE_PATTERN, WINDOWS_PACKAGE_PATTERN,
  channelForPackagedVersion, nightlyVersion, releaseVisibleOnChannel,
} = require('../electron/releaseVersion.cjs')
const {
  compareVersions, diagnoseUpdateFailure, githubReleaseAssetUrl, isPrivateAddress, pickUpdateRelease,
  stableStringify, verifyManifest,
} = require('../electron/updater.cjs')

// ---------------------------------------------------------------- test keys
const keyFromSeed = (label) => {
  const seed = crypto.createHash('sha256').update(`fanotes-updater-vectors:${label}`).digest()
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = crypto.createPublicKey(privateKey)
  return {
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16),
  }
}
const main = keyFromSeed('main')
const other = keyFromSeed('other')
const sign = (payload, key = main) => crypto.sign(null, Buffer.from(stableStringify(payload)), key.privateKey).toString('base64')
const signed = (payload, key = main, keyId = key.keyId) => ({ ...payload, signature: { algorithm: 'ed25519', keyId, value: sign(payload, key) } })
const sha = (label) => crypto.createHash('sha256').update(label).digest('hex')
const clone = (value) => structuredClone(value)

// ------------------------------------------------------------ manifest bases
const DELTA_FORMAT = 'fanotes-delta-v1'
const linuxPayload = (current, latest, channel = 'stable') => {
  const appimage = `FaNotes-${latest}-x86_64.AppImage`
  const portable = `FaNotes-${latest}-x86_64.tar.gz`
  const delta = `FaNotes-Delta-linux-x64-${current}-to-${latest}.fndelta`
  return {
    schemaVersion: 1, product: 'FaNotes', channel, platform: 'linux', arch: 'x64',
    currentVersion: current, latestVersion: latest, updateAvailable: compareVersions(latest, current) > 0, mandatory: false,
    publishedAt: '2026-11-14T22:30:00.000Z', releaseNotes: ['Differentieller Updater', 'Zweite Zeile'],
    packages: {
      appimage: { fileName: appimage, url: githubReleaseAssetUrl(latest, appimage), sizeBytes: 12 * 1024 * 1024, sha256: sha('appimage') },
      portable: { fileName: portable, url: githubReleaseAssetUrl(latest, portable), sizeBytes: 11 * 1024 * 1024, sha256: sha('portable') },
    },
    delta: {
      format: DELTA_FORMAT, fileName: delta, url: githubReleaseAssetUrl(latest, delta), sizeBytes: 786432, sha256: sha('delta'),
      source: { kind: 'appimage', sizeBytes: 12000000, sha256: sha('source') },
      target: { kind: 'appimage', fileName: appimage, sizeBytes: 12 * 1024 * 1024, sha256: sha('appimage') },
    },
    websiteUrl: 'https://fanotes.fasrv.ch/',
  }
}
const windowsPayload = (current, latest, channel = 'stable') => {
  const setup = `FaNotes-Setup-${latest}-x64.exe`
  const portable = `FaNotes-Portable-${latest}-x64.exe`
  const delta = `FaNotes-Delta-windows-x64-${current}-to-${latest}.fndelta`
  return {
    schemaVersion: 1, product: 'FaNotes', channel, platform: 'windows', arch: 'x64',
    currentVersion: current, latestVersion: latest, updateAvailable: compareVersions(latest, current) > 0, mandatory: false,
    publishedAt: '2026-11-14T20:00:00.000Z', releaseNotes: ['Windows-Testrelease'],
    packages: {
      installer: { fileName: setup, url: githubReleaseAssetUrl(latest, setup), sizeBytes: 120_000_000, sha256: sha('installer') },
      portable: { fileName: portable, url: githubReleaseAssetUrl(latest, portable), sizeBytes: 125_000_000, sha256: sha('winportable') },
    },
    delta: {
      format: DELTA_FORMAT, fileName: delta, url: githubReleaseAssetUrl(latest, delta), sizeBytes: 2_000_000, sha256: sha('windelta'),
      source: { kind: 'app-asar', sizeBytes: 90_000_000, sha256: sha('winsource') },
      target: { kind: 'app-asar', fileName: 'app.asar', sizeBytes: 91_000_000, sha256: sha('wintarget') },
    },
    websiteUrl: 'https://fanotes.fasrv.ch/',
  }
}

const manifestCases = []
// Intent: 'ok' (accepted) or 'reject' (refused). The oracle must agree.
const addManifest = (name, intent, { platform = 'linux', currentVersion, channel = 'stable', manifest, publicKeyPem, keyId }) => {
  const input = { platform, currentVersion, channel, manifest }
  if (publicKeyPem !== undefined) input.publicKeyPem = publicKeyPem
  if (keyId !== undefined) input.keyId = keyId
  manifestCases.push({ name, intent, input })
}
const LINUX_CURRENT = '2026.11.2'
const LINUX_LATEST = '2026.11.3'
const lin = () => linuxPayload(LINUX_CURRENT, LINUX_LATEST)
const win = () => windowsPayload(LINUX_CURRENT, LINUX_LATEST)
const okLinux = (name, payload, extra = {}) => addManifest(name, 'ok', { currentVersion: LINUX_CURRENT, manifest: signed(payload), ...extra })
const badLinux = (name, mutate, extra = {}) => {
  const payload = lin()
  mutate(payload)
  addManifest(name, 'reject', { currentVersion: LINUX_CURRENT, manifest: signed(payload), ...extra })
}
const badWindows = (name, mutate, extra = {}) => {
  const payload = win()
  mutate(payload)
  addManifest(name, 'reject', { platform: 'win32', currentVersion: LINUX_CURRENT, manifest: signed(payload), ...extra })
}

// Accepted manifests
okLinux('linux stable with delta', lin())
addManifest('windows stable with delta', 'ok', { platform: 'win32', currentVersion: LINUX_CURRENT, manifest: signed(win()) })
okLinux('linux stable without delta (null)', { ...lin(), delta: null })
okLinux('linux stable without delta (absent)', (() => { const p = lin(); delete p.delta; return p })())
okLinux('github-shape manifest: no currentVersion/updateAvailable, no delta', (() => { const p = lin(); delete p.currentVersion; delete p.updateAvailable; delete p.delta; return p })())
okLinux('manifest naming the installed version: not an update', (() => { const p = linuxPayload(LINUX_LATEST, LINUX_LATEST); delete p.delta; return p })(), { currentVersion: LINUX_LATEST })
addManifest('beta channel manifest', 'ok', { currentVersion: '2026.11.3-beta.4', channel: 'beta', manifest: signed(linuxPayload('2026.11.3-beta.4', '2026.11.3-beta.5', 'beta')) })
addManifest('beta user moves to a newer stable (picked release is stable)', 'ok', { currentVersion: '2026.11.3-beta.5', channel: 'stable', manifest: signed(linuxPayload('2026.11.3-beta.5', '2026.11.4')) })
addManifest('beta to stable never downgrades: older stable is not an update', 'ok', (() => {
  const p = linuxPayload('2026.11.3-beta.5', '2026.11.2'); delete p.delta
  return { currentVersion: '2026.11.3-beta.5', channel: 'stable', manifest: signed(p) }
})())
addManifest('downgrade offered by a signed manifest is reported as no update', 'ok', (() => {
  const p = linuxPayload('2026.11.3', '2026.11.2'); delete p.delta
  return { currentVersion: '2026.11.3', manifest: signed(p) }
})())
addManifest('stable newer than installed beta of the same triple', 'ok', { currentVersion: '2026.11.3-beta.9', manifest: signed(linuxPayload('2026.11.3-beta.9', '2026.11.3')) })
{
  const nightly = '2026.11.3-nightly.20261111120000.abcdef0'
  const p = linuxPayload(LINUX_CURRENT, nightly, 'nightly'); p.delta = null
  addManifest('nightly manifest with nightly version', 'ok', { currentVersion: LINUX_CURRENT, channel: 'nightly', manifest: signed(p) })
  addManifest('nightly channel manifest naming a stable version', 'ok', { currentVersion: LINUX_CURRENT, channel: 'nightly', manifest: signed(linuxPayload(LINUX_CURRENT, LINUX_LATEST, 'nightly')) })
  addManifest('nightly manifest is refused on the stable channel', 'reject', { currentVersion: LINUX_CURRENT, channel: 'stable', manifest: signed(p) })
  addManifest('nightly manifest is refused on the beta channel', 'reject', { currentVersion: LINUX_CURRENT, channel: 'beta', manifest: signed(p) })
}
okLinux('quirk: delta file name with the literal "undefined" when currentVersion is absent', (() => {
  const p = lin(); delete p.currentVersion; delete p.updateAvailable
  const name = `FaNotes-Delta-linux-x64-undefined-to-${LINUX_LATEST}.fndelta`
  p.delta.fileName = name; p.delta.url = githubReleaseAssetUrl(LINUX_LATEST, name)
  return p
})())
badLinux('delta present but currentVersion absent: file name cannot match', (p) => { delete p.currentVersion; delete p.updateAvailable })
okLinux('publishedAt date only', { ...lin(), publishedAt: '2026-11-14' })
okLinux('sizeBytes written as a float with integral value is a safe integer', (() => { const p = lin(); p.packages.portable.sizeBytes = 11534336.0; return p })())
okLinux('release notes: 20 notes of 4000 characters', { ...lin(), releaseNotes: Array.from({ length: 20 }, () => 'x'.repeat(4000)) })

// Signature and key failures
{
  const p = lin()
  const good = signed(p)
  const t = clone(good); t.delta.sizeBytes += 1
  addManifest('tampered: delta size changed after signing', 'reject', { currentVersion: LINUX_CURRENT, manifest: t })
  const t2 = clone(good); t2.packages.appimage.sha256 = 'c'.repeat(64)
  addManifest('tampered: package hash replaced after signing', 'reject', { currentVersion: LINUX_CURRENT, manifest: t2 })
  const t3 = clone(good); t3.packages.appimage.url = githubReleaseAssetUrl(LINUX_LATEST, 'FaNotes-evil.AppImage')
  addManifest('tampered: package url replaced after signing', 'reject', { currentVersion: LINUX_CURRENT, manifest: t3 })
  const t4 = clone(good); t4.releaseNotes.push('injected')
  addManifest('tampered: release note appended', 'reject', { currentVersion: LINUX_CURRENT, manifest: t4 })
  const flipped = clone(good)
  const raw = Buffer.from(flipped.signature.value, 'base64'); raw[10] ^= 0x01
  flipped.signature.value = raw.toString('base64')
  addManifest('signature with one flipped bit', 'reject', { currentVersion: LINUX_CURRENT, manifest: flipped })
  const zeros = clone(good); zeros.signature.value = Buffer.alloc(64).toString('base64')
  addManifest('all-zero signature', 'reject', { currentVersion: LINUX_CURRENT, manifest: zeros })
  addManifest('signed by a different key with the right key id', 'reject', { currentVersion: LINUX_CURRENT, manifest: signed(p, other, main.keyId) })
  addManifest('signed by a different key and its own key id', 'reject', { currentVersion: LINUX_CURRENT, manifest: signed(p, other) })
  addManifest('wrong algorithm', 'reject', { currentVersion: LINUX_CURRENT, manifest: { ...p, signature: { ...good.signature, algorithm: 'rsa' } } })
  const short = clone(good); short.signature.value = good.signature.value.slice(0, 40)
  addManifest('signature value too short', 'reject', { currentVersion: LINUX_CURRENT, manifest: short })
  const noPad = clone(good); noPad.signature.value = good.signature.value.replace(/=+$/u, '')
  addManifest('signature without base64 padding', 'reject', { currentVersion: LINUX_CURRENT, manifest: noPad })
  const nonCanonical = clone(good); nonCanonical.signature.value = `${good.signature.value.slice(0, 85)}B==`
  addManifest('signature with non-canonical base64 tail', 'reject', { currentVersion: LINUX_CURRENT, manifest: nonCanonical })
  const urlSafe = clone(good); urlSafe.signature.value = good.signature.value.replaceAll('+', '-').replaceAll('/', '_')
  addManifest('signature in url-safe base64', 'reject', { currentVersion: LINUX_CURRENT, manifest: urlSafe })
  const numeric = clone(good); numeric.signature.value = 12345
  addManifest('signature value not a string', 'reject', { currentVersion: LINUX_CURRENT, manifest: numeric })
  addManifest('unsigned manifest', 'reject', { currentVersion: LINUX_CURRENT, manifest: p })
  addManifest('signature is not an object', 'reject', { currentVersion: LINUX_CURRENT, manifest: { ...p, signature: 'abc' } })
  addManifest('manifest is an array', 'reject', { currentVersion: LINUX_CURRENT, manifest: [good] })
  addManifest('expected key id differs', 'reject', { currentVersion: LINUX_CURRENT, manifest: good, keyId: '0000000000000000' })
  addManifest('public key is garbage', 'reject', { currentVersion: LINUX_CURRENT, manifest: good, publicKeyPem: 'not a pem' })
  addManifest('public key is another key', 'reject', { currentVersion: LINUX_CURRENT, manifest: good, publicKeyPem: other.publicPem })
}

// Edition binding and fields
badLinux('channel stable manifest read as beta', () => {}, { channel: 'beta' })
badLinux('wrong platform field', (p) => { p.platform = 'windows' })
badLinux('wrong arch', (p) => { p.arch = 'arm64' })
badLinux('wrong product', (p) => { p.product = 'Other' })
badLinux('schemaVersion 2', (p) => { p.schemaVersion = 2 })
badLinux('schemaVersion as string', (p) => { p.schemaVersion = '1' })
badLinux('unknown channel', (p) => { p.channel = 'alpha' }, { channel: 'stable' })
badLinux('latestVersion with v prefix', (p) => { p.latestVersion = 'v2026.11.3' })
badLinux('latestVersion not a version', (p) => { p.latestVersion = 'latest' })
badLinux('latestVersion missing', (p) => { delete p.latestVersion })
badLinux('mandatory not boolean', (p) => { p.mandatory = 'no' })
badLinux('manifest names another installed version', (p) => { p.currentVersion = '2026.11.1' })
badLinux('updateAvailable lies', (p) => { p.updateAvailable = false })
badLinux('updateAvailable without currentVersion is checked', (p) => { delete p.currentVersion })
badLinux('publishedAt not a date', (p) => { p.publishedAt = 'yesterday' })
badLinux('publishedAt not a string', (p) => { p.publishedAt = 1763160600000 })
badLinux('21 release notes', (p) => { p.releaseNotes = Array.from({ length: 21 }, () => 'n') })
badLinux('release note of 4001 characters', (p) => { p.releaseNotes = ['x'.repeat(4001)] })
badLinux('release note not a string', (p) => { p.releaseNotes = [5] })
badLinux('release notes not an array', (p) => { p.releaseNotes = 'one' })
badLinux('packages missing', (p) => { delete p.packages })
badLinux('packages is an array', (p) => { p.packages = [] })
badLinux('portable package missing', (p) => { delete p.packages.portable })
badLinux('websiteUrl on another host', (p) => { p.websiteUrl = 'https://evil.example/' })
badLinux('websiteUrl without trailing slash', (p) => { p.websiteUrl = 'https://fanotes.fasrv.ch' })
badLinux('invalid current version passed to the verifier', () => {}, { currentVersion: 'nope' })

// File names: path traversal and mismatches
badLinux('package file name with path traversal', (p) => {
  const name = '../../.config/autostart/evil.AppImage'
  p.packages.appimage.fileName = name; p.packages.appimage.url = githubReleaseAssetUrl(LINUX_LATEST, name)
})
badLinux('package file name with a subdirectory', (p) => {
  const name = `x/FaNotes-${LINUX_LATEST}-x86_64.AppImage`
  p.packages.appimage.fileName = name; p.packages.appimage.url = githubReleaseAssetUrl(LINUX_LATEST, name)
})
badLinux('package file name for another version', (p) => {
  const name = 'FaNotes-2026.11.2-x86_64.AppImage'
  p.packages.appimage.fileName = name; p.packages.appimage.url = githubReleaseAssetUrl(LINUX_LATEST, name)
})
badLinux('package file name with backslash traversal', (p) => { p.packages.portable.fileName = '..\\evil.tar.gz' })
badLinux('package file name missing', (p) => { delete p.packages.appimage.fileName })
badWindows('windows installer called FaNotes.exe', (p) => { p.packages.installer.fileName = 'FaNotes.exe' })
badWindows('windows installer file name for the portable build', (p) => { p.packages.installer.fileName = `FaNotes-Portable-${LINUX_LATEST}-x64.exe` })
badLinux('delta target file name with path traversal', (p) => { p.delta.target.fileName = '../app.asar' })
badLinux('delta target file name differs from the AppImage name', (p) => { p.delta.target.fileName = 'other.AppImage' })
badWindows('windows delta target file name is not app.asar', (p) => { p.delta.target.fileName = 'FaNotes.exe' })
badWindows('windows delta target file name traversal', (p) => { p.delta.target.fileName = '..\\app.asar' })

// Sizes
badLinux('package below the 10 MiB minimum', (p) => { p.packages.appimage.sizeBytes = 10 * 1024 * 1024 - 1 })
badLinux('package above the 1 GiB maximum (oversize)', (p) => { p.packages.appimage.sizeBytes = 1024 * 1024 * 1024 + 1 })
badLinux('package of 2 GiB (oversize)', (p) => { p.packages.portable.sizeBytes = 2 * 1024 * 1024 * 1024 })
badLinux('package size negative', (p) => { p.packages.portable.sizeBytes = -12582912 })
badLinux('package size fractional', (p) => { p.packages.portable.sizeBytes = 11534336.5 })
badLinux('package size as string', (p) => { p.packages.portable.sizeBytes = '11534336' })
badLinux('package size beyond 2^53', (p) => { p.packages.portable.sizeBytes = 2 ** 60 })
badLinux('package size null', (p) => { p.packages.portable.sizeBytes = null })
okLinux('package of exactly 10 MiB', (() => { const p = lin(); p.packages.portable.sizeBytes = 10 * 1024 * 1024; return p })())
okLinux('package of exactly 1 GiB', (() => { const p = lin(); p.packages.portable.sizeBytes = 1024 * 1024 * 1024; return p })())
badLinux('delta of 255 bytes', (p) => { p.delta.sizeBytes = 255 })
badLinux('delta above 1 GiB', (p) => { p.delta.sizeBytes = 1024 * 1024 * 1024 + 1 })
badLinux('delta source of size 0', (p) => { p.delta.source.sizeBytes = 0 })
badLinux('delta source above 1 GiB', (p) => { p.delta.source.sizeBytes = 1024 * 1024 * 1024 + 1 })
badLinux('delta target size differs from the signed AppImage', (p) => { p.delta.target.sizeBytes += 1 })
okLinux('delta of exactly 256 bytes', (() => { const p = lin(); p.delta.sizeBytes = 256; return p })())

// Hashes
badLinux('package sha256 uppercase', (p) => { p.packages.appimage.sha256 = sha('appimage').toUpperCase() })
badLinux('package sha256 too short', (p) => { p.packages.appimage.sha256 = 'abc' })
badLinux('package sha256 missing', (p) => { delete p.packages.portable.sha256 })
badLinux('delta sha256 invalid', (p) => { p.delta.sha256 = 'z'.repeat(64) })
badLinux('delta source sha256 invalid', (p) => { p.delta.source.sha256 = 'abc' })
badLinux('delta target hash differs from the signed AppImage', (p) => { p.delta.target.sha256 = sha('other') })

// Hosts and URLs (allow-list: only the GitHub release asset for this version and file)
const assetUrl = githubReleaseAssetUrl(LINUX_LATEST, `FaNotes-${LINUX_LATEST}-x86_64.AppImage`)
for (const [label, url] of [
  ['other host', `https://example.com/FaNotes-${LINUX_LATEST}-x86_64.AppImage`],
  ['the old server feed', 'https://fanotes.fasrv.ch/download/appimage'],
  ['http scheme', assetUrl.replace('https:', 'http:')],
  ['userinfo', assetUrl.replace('https://', 'https://user:pw@')],
  ['a port', assetUrl.replace('github.com', 'github.com:8443')],
  ['a query string', `${assetUrl}?token=1`],
  ['a fragment', `${assetUrl}#x`],
  ['another repository', assetUrl.replace('Nikoheld', 'Evil')],
  ['another tag', assetUrl.replace(`v${LINUX_LATEST}`, 'v2026.11.2')],
  ['a lookalike host', assetUrl.replace('github.com', 'github.com.evil.example')],
  ['an allow-listed CDN host', assetUrl.replace('github.com', 'objects.githubusercontent.com')],
  ['api.github.com', assetUrl.replace('github.com', 'api.github.com')],
  ['a different file', githubReleaseAssetUrl(LINUX_LATEST, 'FaNotes-evil.AppImage')],
  ['a relative url', '/Nikoheld/FaNotes/releases/download/v1/x'],
  ['an empty string', ''],
  ['a number', 7],
  ['null', null],
]) badLinux(`package url: ${label}`, (p) => { p.packages.appimage.url = url })
okLinux('package url with an empty query marker is accepted (JS URL.search is empty)', (() => { const p = lin(); p.packages.appimage.url = `${assetUrl}?`; return p })())
okLinux('package url with dot segments that normalise to the right path is accepted and returned normalised', (() => { const p = lin(); p.packages.appimage.url = assetUrl.replace('/releases/', '/releases/../releases/'); return p })())
badLinux('package url whose dot segments escape to another path', (p) => { p.packages.appimage.url = assetUrl.replace('/releases/download/', '/releases/download/../') })
okLinux('package url with an upper-case host is normalised', (() => { const p = lin(); p.packages.appimage.url = assetUrl.replace('github.com', 'GitHub.COM'); return p })())
badWindows('windows installer url on the old server feed', (p) => { p.packages.installer.url = 'https://fanotes.fasrv.ch/download/windows-installer' })
badWindows('windows delta url on example.com', (p) => { p.delta.url = 'https://example.com/update.fndelta' })
badWindows('windows installer url on example.com', (p) => { p.packages.installer.url = 'https://example.com/FaNotes.exe' })
badLinux('delta url on another host', (p) => { p.delta.url = 'https://example.com/x.fndelta' })
badLinux('delta url for another tag', (p) => { p.delta.url = githubReleaseAssetUrl('2026.11.2', p.delta.fileName) })

// Delta structure
badLinux('delta unknown format', (p) => { p.delta.format = 'fanotes-delta-v2' })
badLinux('delta is not an object', (p) => { p.delta = 'delta' })
badLinux('delta is an array', (p) => { p.delta = [] })
badLinux('delta file name bound to another base version', (p) => {
  const name = `FaNotes-Delta-linux-x64-2026.11.1-to-${LINUX_LATEST}.fndelta`
  p.delta.fileName = name; p.delta.url = githubReleaseAssetUrl(LINUX_LATEST, name)
})
badLinux('delta file name with path traversal', (p) => {
  const name = '../FaNotes-Delta.fndelta'
  p.delta.fileName = name; p.delta.url = githubReleaseAssetUrl(LINUX_LATEST, name)
})
badLinux('delta source kind app-asar on linux', (p) => { p.delta.source.kind = 'app-asar' })
badLinux('delta target kind app-asar on linux', (p) => { p.delta.target.kind = 'app-asar' })
badLinux('delta source is missing', (p) => { delete p.delta.source })
badLinux('delta target is missing', (p) => { delete p.delta.target })
badWindows('windows delta with appimage kinds', (p) => { p.delta.source.kind = 'appimage'; p.delta.target.kind = 'appimage' })

// Platform binding
addManifest('linux manifest verified as windows', 'reject', { platform: 'win32', currentVersion: LINUX_CURRENT, manifest: signed(lin()) })
addManifest('windows manifest verified as linux', 'reject', { platform: 'linux', currentVersion: LINUX_CURRENT, manifest: signed(win()) })
addManifest('unsupported platform', 'reject', { platform: 'darwin', currentVersion: LINUX_CURRENT, manifest: signed(lin()) })

// ------------------------------------------------------------ small sections
const versionPairs = [
  ['2026.11.3-beta.5', '2026.11.3-beta.4'], ['2026.11.3-beta.4', '2026.11.3-beta.5'], ['2026.11.3', '2026.11.3-beta.99'],
  ['2026.11.4-beta.1', '2026.11.3'], ['2026.11.3', '2026.11.3'], ['2026.9.1', '2026.10.1'], ['2026.10.1', '2026.9.1'],
  ['2026.11.10', '2026.11.9'], ['2026.11.3-beta.10', '2026.11.3-beta.9'], ['2027.1.1', '2026.12.99'],
  ['2026.10.2-nightly.20261011120000.abcdef0', '2026.10.2'], ['2026.10.2', '2026.10.2-beta.9'],
  ['2026.10.3', '2026.10.2-nightly.20261011120000.abcdef0'],
  ['2026.10.2-nightly.20261011120001.aaaaaaa', '2026.10.2-nightly.20261011120000.fffffff'],
  ['2026.10.2-nightly.20261011120000.bbbbbbb', '2026.10.2-nightly.20261011120000.aaaaaaa'],
  ['2026.10.2-nightly.20261011120000.aaaaaaa', '2026.10.2-nightly.20261011120000.aaaaaaa'],
  ['2026.010.2', '2026.10.2'], ['2.17.0', '2.16.0'], ['2026.7.1-beta.2', '2026.7.1-beta.1'], ['2026.7.1', '2026.7.1-beta.99'],
  ['2026.7.2-beta.1', '2026.7.1'],
  ['2026.11', '2026.11.3'], ['v2026.11.3', '2026.11.3'], ['2026.11.3-rc.1', '2026.11.3'], ['2026.11.3-beta', '2026.11.3'],
  ['2026.11.3-beta.1.2', '2026.11.3'], ['', '2026.11.3'], ['2026.11.3 ', '2026.11.3'], ['2026.11.3-nightly.1.abcdef0', '2026.11.3'],
  ['2026.11.3-nightly.20261011120000.ABCDEF0', '2026.11.3'], ['２０２６.11.3', '2026.11.3'],
  ['2026.11.3\n', '2026.11.3'],
]
const channels = ['stable', 'beta', 'nightly', 'weekly']
const visibleVersions = ['2026.10.2', '2026.10.2-beta.1', '2026.10.2-nightly.20261011120000.abcdef0', 'bogus']
const packagedVersions = ['2026.10.2', '2026.10.2-beta.1', '2026.10.2-nightly.20261011120000.abcdef0', 'nope', '', '2026.10']
const nightlyInputs = [
  { base: '2026.10.2-beta.3', committedAt: '2026-10-11T12:00:00.000Z', sha: 'ABCDEF0' },
  { base: '2026.10.2', committedAt: '2026-10-11T12:00:00.000Z', sha: ' abcdef0123 ' },
  { base: '2026.10.2-nightly.20260101000000.1234567', committedAt: '2026-12-31T23:59:59.999Z', sha: '1234567' },
  { base: '2026.010.2', committedAt: '2026-10-11T12:00:00Z', sha: 'abcdef0' },
  { base: '2026.10.2', committedAt: 'garbage', sha: 'abcdef0' },
  { base: '2026.10.2', committedAt: '2026-10-11T12:00:00.000Z', sha: 'xyz' },
  { base: '2026.10.2', committedAt: '2026-10-11T12:00:00.000Z', sha: 'abc' },
  { base: 'nope', committedAt: '2026-10-11T12:00:00.000Z', sha: 'abcdef0' },
]
const nameCases = [
  ['linux', 'FaNotes-2026.10.2-x86_64.AppImage'], ['linux', 'FaNotes-2026.10.2-x86_64.tar.gz'], ['linux', 'FaNotes-2026.10.2-beta.1-x86_64.AppImage'],
  ['linux', 'FaNotes-2026.10.2-nightly.20261011120000.abcdef0-x86_64.AppImage'], ['linux', 'FaNotes-2026.10.2-nightly.1.abcdef0-x86_64.AppImage'],
  ['linux', 'FaNotes-2026.10.2-x86_64.zip'], ['linux', '../FaNotes-2026.10.2-x86_64.AppImage'], ['linux', 'FaNotes-2026.10.2-x86_64.AppImage\n'],
  ['windows', 'FaNotes-Setup-2026.10.2-x64.exe'], ['windows', 'FaNotes-Portable-2026.10.2-x64.exe'], ['windows', 'FaNotes-Setup-2026.10.2-nightly.20261011120000.abcdef0-x64.exe'],
  ['windows', 'FaNotes-Other-2026.10.2-x64.exe'], ['windows', 'FaNotes-Setup-2026.10.2-x64.msi'], ['windows', 'FaNotes-Setup-2026.10.2-x86.exe'],
  ['delta', '/download/delta/linux-x64/2026.10.1'], ['delta', '/download/delta/windows-x64/nightly/2026.10.2-nightly.20261011120000.abcdef0'],
  ['delta', '/download/delta/windows-x64/beta/2026.10.2-beta.1'], ['delta', '/download/delta/mac-x64/2026.10.1'], ['delta', '/download/delta/linux-x64/stable/2026.10.1'],
  ['download', '/download/appimage'], ['download', '/download/beta/windows-installer'], ['download', '/download/nightly/checksums'], ['download', '/download/stable/appimage'],
  ['download', '/download/appimage/'], ['download', '/download/delta'],
]
const stringifyInputs = [
  '{"b":1,"a":2}', '{"a":[3,2,1],"b":{"d":null,"c":true}}', '[]', '{}', 'null', 'true', '"text"', '12', '-0', '0', '1.0', '1.5', '1e21', '1e-7', '0.000001',
  '123456789012345678901234567890', '1.7976931348623157e308', '5e-324', '9007199254740993', '0.1', '100', '1E2', '"a\\u0001b"', '"\\u2028\\u2029"',
  '"tab\\there\\nnewline \\"quoted\\" back\\\\slash"', '"\\u00e9 \\ud83d\\ude00 \\u007f"', '{"\\uff5e":1,"\\ud83d\\ude00":2,"b":3,"a":{"z":1,"y":[1.0,null]}}',
  '{"b":1,"b":2}', '{"10":1,"9":2,"a":3}', '{"":1,"a":2}', '{"é":1,"e":2,"z":3}', '[1,[2,[3,{"x":[]}]]]', '{"n":-1.25e-3,"m":1e300,"o":4294967296}',
]
const privateAddresses = [
  '10.0.0.1', '192.168.0.1', '8.8.8.8', '::ffff:10.8.0.1', '::ffff:8.8.8.8', '::ffff:7f00:1', '::1', '::', '[fe80::1]', '2001:4860:4860::8888',
  '169.254.169.254', '100.64.0.1', '100.128.0.1', '172.16.0.1', '172.32.0.1', '224.0.0.1', '0.0.0.0', '127.0.0.1', 'fd00::1', '3fff::1', '4000::1',
  '2000::', 'fe80::1%eth0', '', 'not-an-ip', '300.1.1.1', '1.2.3', '10..0.1', '0x0a.0.0.1', '1.2.3.4.5', ' 10.0.0.1 ', '::FFFF:0A08:0001', 'zz::1',
]
const modelHostInputs = [
  ['https://huggingface.co/org/model/resolve/main/config.json', 'https://cdn-lfs.huggingface.co/org/config.json'],
  ['https://huggingface.co/org/model/resolve/main/config.json', 'https://evil.example/config.json'],
  ['https://huggingface.co/a', 'https://cdn.hf.co/x'], ['https://hf.co/a', 'https://huggingface.co/x'], ['https://huggingface.co/a', 'https://nothuggingface.co/x'],
  ['https://huggingface.co/a', 'https://huggingface.co.evil.example/x'], ['https://example.org/a', 'https://example.org/b'], ['https://example.org/a', 'https://huggingface.co/x'],
  ['https://example.org/a', 'http://example.org/x'], ['http://example.org/a', 'https://example.org/x'], ['https://example.org/a', 'https://u:p@example.org/x'],
  ['https://example.org/a', null], ['https://huggingface.co./a', 'https://cdn-lfs.huggingface.co./x'], ['https://HuggingFace.CO/a', 'https://CDN.HF.CO/x'],
  ['not a url', 'https://example.org/x'], ['https://example.org/a', 'not a url'],
]
const zurich = { year: 2026, month: 11 }
const policyInputs = [
  ['2026.11.3', zurich, ['v2026.11.1', 'v2026.11.2', 'v2026.10.5']], ['2026.11.4', zurich, ['v2026.11.1', 'v2026.11.2']], ['2026.11.1', zurich, []],
  ['2026.11.2', zurich, ['v2026.11.1']], ['2026.11.2', zurich, ['v2026.11.1', 'v2026.11.2']], ['2026.11.3-beta.1', zurich, ['v2026.11.1', 'v2026.11.2']],
  ['2026.11.3-beta.2', zurich, ['v2026.11.1', 'v2026.11.2', 'v2026.11.3-beta.1']], ['2026.11.3-beta.3', zurich, ['v2026.11.1', 'v2026.11.2', 'v2026.11.3-beta.1']],
  ['2026.11.3-beta.1', zurich, ['v2026.11.1', 'v2026.11.2', 'v2026.11.3-beta.1']], ['2026.11.2-beta.1', zurich, ['v2026.11.1', 'v2026.11.2']],
  ['2026.11.4-beta.1', zurich, ['v2026.11.1', 'v2026.11.2']], ['2026.11.3-beta.2', zurich, ['v2026.11.1', 'v2026.11.2', 'v2026.11.3-beta.10', 'v2026.11.3-beta.9']],
  ['2026.11.3-beta.11', zurich, ['v2026.11.1', 'v2026.11.2', 'v2026.11.3-beta.10', 'v2026.11.3-beta.9']], ['2026.10.1', zurich, []], ['2025.11.1', zurich, []],
  ['2026.13.1', { year: 2026, month: 13 }, []], ['2026.0.1', zurich, []], ['2026.11.0', zurich, []], ['2026.11.3-beta.0', zurich, []], ['2026.11', zurich, []],
  ['2026.11.3-beta', zurich, []], ['v2026.11.3', zurich, []], ['2026.11.03', zurich, []], ['2026.07.1', { year: 2026, month: 7 }, []],
  ['2026.7.1', { year: 2026, month: 7 }, ['v2026.7.1-beta.1']], ['2026.7.2', { year: 2026, month: 7 }, ['v2026.7.1', 'v2026.11.1', 'v2026.17.1']],
  ['2026.1.1', { year: 2026, month: 1 }, ['v2026.11.1', 'v2026.11.2']], ['2026.11.3', zurich, ['v2026.11.1', 'v2026.11.2', 'v2026.11.3-beta.1']],
  ['2026.11.2', zurich, ['v2026.11.1', 'v2026.11.2-beta.1']],
]
const rawResponse = (status, headers, bodyText) => ({ status, headers, bodyText })
const diagnoseInputs = [
  { name: 'dns-hijack via mapped address', phase: 'download', url: 'https://fanotes.fasrv.ch/download/appimage', error: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' }, resolvedAddress: '::ffff:10.8.0.1' },
  { name: 'redirect to a login page', phase: 'download', url: 'https://fanotes.fasrv.ch/download/appimage', response: rawResponse(302, { location: 'http://login.schule.local/start', 'content-type': 'text/html' }, '<html><title>WLAN-Anmeldung</title></html>'), bodyText: '<html><title>WLAN-Anmeldung</title></html>' },
  { name: '403 filter page', phase: 'download', url: 'https://fanotes.fasrv.ch/download/appimage', response: rawResponse(403, { 'content-type': 'text/html; charset=utf-8' }, ''), bodyText: '<html><title>Zugriff verweigert</title></html>' },
  { name: 'tls interception', phase: 'check', url: 'https://fanotes.fasrv.ch/api/v1/updates/linux-x64', error: { message: 'unable to verify the first certificate', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } },
  { name: 'dns-hijack', phase: 'download', url: 'https://fanotes.fasrv.ch/download/appimage', error: { message: 'getaddrinfo ENOTFOUND fanotes.fasrv.ch', code: 'ENOTFOUND' }, resolvedAddress: '10.8.0.1' },
  { name: 'dns failure', phase: 'check', url: 'https://api.github.com/repos/Nikoheld/FaNotes/releases/latest', error: { message: 'getaddrinfo ENOTFOUND api.github.com', code: 'ENOTFOUND' }, resolvedAddress: null },
  { name: 'connection reset', phase: 'download', url: 'https://github.com/Nikoheld/FaNotes/releases/download/v1/x', error: { message: 'read ECONNRESET', code: 'ECONNRESET' } },
  { name: 'timeout code', phase: 'check', url: 'https://api.github.com/repos/Nikoheld/FaNotes/releases', error: { message: 'connect timeout', code: 'UND_ERR_CONNECT_TIMEOUT' } },
  { name: 'abort error', phase: 'check', url: 'https://api.github.com/repos/Nikoheld/FaNotes/releases', error: { message: 'This operation was aborted', name: 'AbortError' } },
  { name: 'proxy auth 407', phase: 'download', url: 'https://github.com/x', response: rawResponse(407, {}, ''), bodyText: '' },
  { name: '401', phase: 'check', url: 'https://github.com/x', response: rawResponse(401, {}, ''), bodyText: '' },
  { name: '451 with title', phase: 'check', url: 'https://github.com/x', response: rawResponse(451, { 'content-type': 'text/html' }, ''), bodyText: '<TITLE>  Gesperrt \n durch   Filter </TITLE>' },
  { name: '500 html', phase: 'download', url: 'https://github.com/x', response: rawResponse(500, { 'content-type': 'text/html' }, ''), bodyText: '<html><title>Oops</title></html>' },
  { name: '500 plain', phase: 'download', url: 'https://github.com/x', response: rawResponse(500, { 'content-type': 'text/plain' }, ''), bodyText: 'boom' },
  { name: '404 json', phase: 'check', url: 'https://github.com/x', response: rawResponse(404, { 'content-type': 'application/json' }, ''), bodyText: '{}' },
  { name: '200 html body', phase: 'check', url: 'https://github.com/x', response: rawResponse(200, { 'content-type': 'text/html' }, ''), bodyText: '<html><title>Portal</title></html>' },
  { name: '200 html body without title', phase: 'check', url: 'https://github.com/x', response: rawResponse(200, {}, ''), bodyText: ' <p>hi</p>' },
  { name: '206 clean', phase: 'download', url: 'https://github.com/x', response: rawResponse(206, { 'content-type': 'application/octet-stream' }, ''), bodyText: '', error: { message: 'plain failure' } },
  { name: 'unknown error', phase: 'download', url: 'https://github.com/x', error: { message: 'something odd at https://api.github.com/repos/Nikoheld/FaNotes/releases here' } },
  { name: 'nothing known', phase: 'check', url: 'not a url' },
  { name: 'redirect without location', phase: 'check', url: 'https://github.com/x', response: rawResponse(301, {}, ''), bodyText: '' },
  { name: 'redirect with relative location', phase: 'check', url: 'https://github.com/x', response: rawResponse(307, { location: '/login' }, ''), bodyText: '' },
  { name: 'long title is cut at 120', phase: 'check', url: 'https://github.com/x', response: rawResponse(403, {}, ''), bodyText: `<title>${'T'.repeat(170)}</title>` },
  { name: 'cert error without code', phase: 'check', url: 'https://github.com/x', error: { message: 'self signed certificate in chain' } },
]

const pickReleaseCases = (() => {
  const nameFor = (platform, kind) => (kind === 'stable' ? `FaNotes-update-${platform}-x64.json` : `FaNotes-update-${platform}-x64-${kind}.json`)
  const kindOf = (version) => (version.includes('-beta.') ? 'beta' : version.includes('-nightly.') ? 'nightly' : 'stable')
  const row = (version, platform = 'linux', extras = {}) => {
    const name = nameFor(platform, kindOf(version))
    return { tag_name: `v${version}`, draft: false, assets: [{ name, browser_download_url: githubReleaseAssetUrl(version, name) }], ...extras }
  }
  const nightly = '2026.11.3-nightly.20261111120000.abcdef0'
  const cases = [
    ['beta takes a newer stable over an older beta', [row('2026.11.2-beta.2'), row('2026.11.2')], 'beta'],
    ['beta takes the newest beta when it is above stable', [row('2026.11.2'), row('2026.11.3-beta.1')], 'beta'],
    ['stable never sees a prerelease', [row('2026.11.3-beta.1'), row('2026.11.2')], 'stable'],
    ['stable only prerelease: nothing', [row('2026.11.3-beta.1')], 'stable'],
    ['beta ignores nightly', [row('2026.11.3-beta.1'), row(nightly)], 'beta'],
    ['nightly sees nightly and stable', [row('2026.11.2-beta.2'), row(nightly), row('2026.11.2')], 'nightly'],
    ['nightly with only betas: nothing', [row('2026.11.2-beta.2')], 'nightly'],
    ['drafts are skipped', [row('2026.11.2', 'linux', { draft: true }), row('2026.11.1-beta.2')], 'beta'],
    ['release without the platform manifest is skipped', [row('2026.11.3', 'windows'), row('2026.11.2')], 'stable'],
    ['windows platform', [row('2026.11.3', 'windows'), row('2026.11.2', 'windows')], 'stable', 'windows'],
    ['beta manifest asset name for a beta tag only', [{ tag_name: 'v2026.11.3-beta.1', draft: false, assets: [{ name: 'FaNotes-update-linux-x64.json', browser_download_url: 'https://github.com/x' }] }], 'beta'],
    ['asset without a string url is skipped', [{ tag_name: 'v2026.11.2', assets: [{ name: 'FaNotes-update-linux-x64.json', browser_download_url: 5 }] }], 'stable'],
    ['tag without v prefix', [{ tag_name: '2026.11.2', assets: [] }], 'stable'],
    ['invalid tag', [{ tag_name: 'vnightly', assets: [] }, row('2026.11.1')], 'stable'],
    ['missing assets array', [{ tag_name: 'v2026.11.9' }, row('2026.11.1')], 'stable'],
    ['null and scalar rows', [null, 5, 'x', row('2026.11.1')], 'stable'],
    ['not an array', { tag_name: 'v2026.11.2' }, 'stable'],
    ['equal versions keep the first row', [row('2026.11.2', 'linux', { id: 1 }), row('2026.11.2', 'linux', { id: 2 })], 'stable'],
    ['position does not matter: highest wins', [row('2026.11.1'), row('2026.11.5'), row('2026.11.3')], 'stable'],
    ['beta.10 beats beta.9', [row('2026.11.3-beta.9'), row('2026.11.3-beta.10')], 'beta'],
    ['unknown channel sees nothing', [row('2026.11.2')], 'weekly'],
  ]
  return cases.map(([name, releases, channel, platform = 'linux']) => ({ name, input: { releases, channel, platform } }))
})()

// ------------------------------------------------------------- delta vectors
const DELTA_MAGIC = Buffer.from('FANOTESDELTA1\0\0\0', 'ascii')
const buildSource = (size = 1200, salt = 0) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + 7 + salt) & 255))
const baseSource = buildSource()
const dataOne = Buffer.from('FaNotes delta new payload ')
const dataTwo = Buffer.from('tail data')
const baseTarget = Buffer.concat([baseSource.subarray(0, 300), dataOne, baseSource.subarray(500, 800), dataTwo])
const hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const baseHeader = () => ({
  format: DELTA_FORMAT, platform: 'linux', baseVersion: '2026.11.2', targetVersion: '2026.11.3',
  source: { kind: 'appimage', sizeBytes: baseSource.length, sha256: hex(baseSource) },
  target: { kind: 'appimage', fileName: 'FaNotes-2026.11.3-x86_64.AppImage', sizeBytes: baseTarget.length, sha256: hex(baseTarget) },
  operations: [
    { kind: 'copy', sourceOffset: 0, sizeBytes: 300 },
    { kind: 'data', dataOffset: 0, sizeBytes: dataOne.length },
    { kind: 'copy', sourceOffset: 500, sizeBytes: 300 },
    { kind: 'data', dataOffset: dataOne.length, sizeBytes: dataTwo.length },
  ],
})
const basePayload = Buffer.concat([dataOne, dataTwo])
const buildPatch = (header, payload = basePayload, { magic = DELTA_MAGIC, headerLength, rawHeader } = {}) => {
  const encoded = rawHeader ?? Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(20)
  magic.copy(prefix)
  prefix.writeUInt32BE(headerLength ?? encoded.length, 16)
  return Buffer.concat([prefix, encoded, payload])
}
const deltaCases = []
const addDelta = (name, intent, { source = baseSource, patch, expected }) => {
  const input = { sourceB64: source.toString('base64'), patchB64: patch.toString('base64') }
  if (expected) input.expected = expected
  deltaCases.push({ name, intent, input })
}
const mutatedHeader = (mutate) => { const h = baseHeader(); mutate(h); return h }
const okExpected = () => ({
  platform: 'linux', baseVersion: '2026.11.2', targetVersion: '2026.11.3',
  source: { kind: 'appimage', sizeBytes: baseSource.length, sha256: hex(baseSource) },
  target: { kind: 'appimage', fileName: 'FaNotes-2026.11.3-x86_64.AppImage', sizeBytes: baseTarget.length, sha256: hex(baseTarget) },
})
addDelta('valid patch reconstructs the target', 'ok', { patch: buildPatch(baseHeader()) })
addDelta('valid patch with matching manifest bindings', 'ok', { patch: buildPatch(baseHeader()), expected: okExpected() })
addDelta('windows app-asar patch', 'ok', { patch: buildPatch(mutatedHeader((h) => { h.platform = 'windows'; h.source.kind = 'app-asar'; h.target.kind = 'app-asar'; h.target.fileName = 'app.asar' })) })
addDelta('copy-only patch with stray payload is refused (a patch needs a data operation)', 'reject', (() => {
  const target = baseSource.subarray(100, 400)
  const h = baseHeader(); h.target.sizeBytes = target.length; h.target.sha256 = hex(target)
  h.operations = [{ kind: 'copy', sourceOffset: 100, sizeBytes: 300 }]
  return { patch: buildPatch(h, Buffer.from('xx')) }
})())
addDelta('copy-only patch without payload is refused (header must end before the file end)', 'reject', (() => {
  const target = baseSource.subarray(100, 400)
  const h = baseHeader(); h.target.sizeBytes = target.length; h.target.sha256 = hex(target)
  h.operations = [{ kind: 'copy', sourceOffset: 100, sizeBytes: 300 }]
  return { patch: buildPatch(h, Buffer.alloc(0)) }
})())
addDelta('patch whose last payload byte is flipped (tampered)', 'reject', { patch: (() => { const p = buildPatch(baseHeader()); p[p.length - 1] ^= 0xff; return p })() })
addDelta('patch whose first payload byte is flipped (tampered)', 'reject', { patch: (() => { const p = buildPatch(baseHeader()); const at = 20 + Buffer.byteLength(JSON.stringify(baseHeader())); p[at] ^= 0x01; return p })() })
addDelta('wrong target hash in header (wrong hash)', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.sha256 = hex('other') })) })
addDelta('source file modified: same size, other bytes', 'reject', { source: buildSource(1200, 1), patch: buildPatch(baseHeader()) })
addDelta('source file has a different size', 'reject', { source: baseSource.subarray(0, 1100), patch: buildPatch(baseHeader()) })
addDelta('wrong magic', 'reject', { patch: buildPatch(baseHeader(), basePayload, { magic: Buffer.from('FANOTESDELTA2\0\0\0', 'ascii') }) })
addDelta('header length zero', 'reject', { patch: buildPatch(baseHeader(), basePayload, { headerLength: 0 }) })
addDelta('header length beyond the file', 'reject', { patch: buildPatch(baseHeader(), basePayload, { headerLength: 100000 }) })
addDelta('header length above 8 MiB', 'reject', { patch: buildPatch(baseHeader(), basePayload, { headerLength: 8 * 1024 * 1024 + 1 }) })
addDelta('header is not json', 'reject', { patch: buildPatch(null, Buffer.from('xx'), { rawHeader: Buffer.from('{not json at all}') }) })
addDelta('header is a json array', 'reject', { patch: buildPatch(null, Buffer.from('xx'), { rawHeader: Buffer.from('[1,2,3]') }) })
addDelta('patch shorter than the prefix', 'reject', { patch: Buffer.concat([DELTA_MAGIC, Buffer.from([0, 0, 0])]) })
addDelta('empty patch', 'reject', { patch: Buffer.alloc(0) })
addDelta('unknown delta format', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.format = 'fanotes-delta-v2' })) })
addDelta('unknown platform', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.platform = 'macos' })) })
addDelta('invalid base version', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.baseVersion = 'latest' })) })
addDelta('invalid target version', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.targetVersion = '2026.11' })) })
addDelta('source kind not allowed', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.source.kind = 'exe' })) })
addDelta('kinds do not fit the platform', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.platform = 'windows' })) })
addDelta('source description missing', 'reject', { patch: buildPatch(mutatedHeader((h) => { delete h.source })) })
addDelta('target size zero', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.sizeBytes = 0 })) })
addDelta('target above 1 GiB (oversize)', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.sizeBytes = 1024 * 1024 * 1024 + 1 })) })
addDelta('target sha256 malformed', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.sha256 = 'ABC' })) })
addDelta('target file name with path traversal', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.fileName = '../../evil' })) })
addDelta('target file name with a slash', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.fileName = 'dir/app.asar' })) })
addDelta('target file name with a backslash', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.fileName = '..\\app.asar' })) })
addDelta('target file name of 161 characters', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.fileName = 'a'.repeat(161) })) })
addDelta('target file name empty', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.target.fileName = '' })) })
addDelta('target file name missing', 'reject', { patch: buildPatch(mutatedHeader((h) => { delete h.target.fileName })) })
addDelta('no operations', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations = [] })) })
addDelta('operations not an array', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations = {} })) })
addDelta('operation without a size', 'reject', { patch: buildPatch(mutatedHeader((h) => { delete h.operations[0].sizeBytes })) })
addDelta('operation of size zero', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[0].sizeBytes = 0 })) })
addDelta('plan exceeds the target', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[2].sizeBytes = 2000 })) })
addDelta('plan does not cover the target', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations.pop() }), dataOne) })
addDelta('copy beyond the source', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[0].sourceOffset = 1000 })) })
addDelta('copy with negative offset', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[0].sourceOffset = -1 })) })
addDelta('copy with fractional offset', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[0].sourceOffset = 0.5 })) })
addDelta('copy with offset at the source end', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[0].sourceOffset = h.source.sizeBytes })) })
addDelta('data operations with a gap', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[3].dataOffset += 1 })) })
addDelta('data operations out of order', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[1].dataOffset = dataTwo.length; h.operations[3].dataOffset = 0 })) })
addDelta('unknown operation kind', 'reject', { patch: buildPatch(mutatedHeader((h) => { h.operations[1].kind = 'exec' })) })
addDelta('payload shorter than the plan', 'reject', { patch: buildPatch(baseHeader(), basePayload.subarray(0, basePayload.length - 1)) })
addDelta('payload longer than the plan', 'reject', { patch: buildPatch(baseHeader(), Buffer.concat([basePayload, Buffer.from('x')])) })
addDelta('binding: other platform', 'reject', { patch: buildPatch(baseHeader()), expected: { ...okExpected(), platform: 'windows' } })
addDelta('binding: other base version (downgrade attempt)', 'reject', { patch: buildPatch(baseHeader()), expected: { ...okExpected(), baseVersion: '2026.11.1' } })
addDelta('binding: other target version', 'reject', { patch: buildPatch(baseHeader()), expected: { ...okExpected(), targetVersion: '2026.11.4' } })
addDelta('binding: source hash differs from the signed manifest', 'reject', { patch: buildPatch(baseHeader()), expected: { ...okExpected(), source: { ...okExpected().source, sha256: hex('x') } } })
addDelta('binding: target size differs', 'reject', { patch: buildPatch(baseHeader()), expected: { ...okExpected(), target: { ...okExpected().target, sizeBytes: 1 } } })
addDelta('binding: target file name differs', 'reject', { patch: buildPatch(baseHeader()), expected: { ...okExpected(), target: { ...okExpected().target, fileName: 'other' } } })
addDelta('binding: target kind differs', 'reject', { patch: buildPatch(baseHeader()), expected: { ...okExpected(), target: { ...okExpected().target, kind: 'app-asar' } } })

// ---------------------------------------------------------------- evaluators
const errorOf = (error) => ({ error: String(error?.message ?? error) })
const attempt = (fn) => { try { return fn() } catch (error) { return errorOf(error) } }

const summarizeManifest = (verified) => ({
  schemaVersion: verified.schemaVersion, channel: verified.channel, currentVersion: verified.currentVersion,
  latestVersion: verified.latestVersion, updateAvailable: verified.updateAvailable, mandatory: verified.mandatory,
  publishedAt: verified.publishedAt, releaseNotes: verified.releaseNotes, packages: verified.packages,
  delta: verified.delta, websiteUrl: verified.websiteUrl,
})

const evaluators = {
  versionCompare: ([a, b]) => attempt(() => ({ sign: Math.sign(compareVersions(a, b)) })),
  versionVisible: ([version, channel]) => attempt(() => ({ visible: releaseVisibleOnChannel(version, channel) })),
  versionPackaged: (version) => ({ channel: channelForPackagedVersion(version) }),
  versionNightly: ({ base, committedAt, sha: commit }) => attempt(() => ({ version: nightlyVersion(base, committedAt, commit) })),
  names: ([kind, name]) => {
    const pattern = { linux: LINUX_PACKAGE_PATTERN, windows: WINDOWS_PACKAGE_PATTERN, delta: DELTA_ROUTE_PATTERN, download: DOWNLOAD_ROUTE_PATTERN }[kind]
    return { match: pattern.test(name) }
  },
  stringify: (text) => ({ text: stableStringify(JSON.parse(text)) }),
  privateAddress: (address) => ({ private: isPrivateAddress(address) }),
  modelHost: ([original, final]) => attempt(() => ({ href: assertModelDownloadUrl(original, final).href })),
  policy: ({ version, zurich: month, tags }) => attempt(() => ({ kind: checkReleasePolicy(version, month, tags) })),
  pick: ({ releases, channel, platform }) => {
    const picked = pickUpdateRelease(releases, channel, platform)
    return { picked: picked ? { tagVersion: picked.tagVersion, assetName: picked.assetName, kind: picked.kind, assetUrl: picked.asset.browser_download_url } : null }
  },
  diagnose: (input) => {
    const error = input.error ? Object.assign(new Error(input.error.message), { ...(input.error.code ? { code: input.error.code } : {}), ...(input.error.name ? { name: input.error.name } : {}) }) : null
    const response = input.response ? new Response(null, { status: input.response.status, headers: input.response.headers }) : null
    const diagnosis = diagnoseUpdateFailure({
      phase: input.phase, url: input.url, error, response, bodyText: input.bodyText ?? '', resolvedAddress: input.resolvedAddress ?? null,
    })
    return { diagnosis: JSON.parse(JSON.stringify(diagnosis)) }
  },
  manifest: (input) => attempt(() => ({
    ok: summarizeManifest(verifyManifest(input.manifest, input.currentVersion, input.publicKeyPem ?? main.publicPem, input.platform, input.keyId ?? main.keyId, input.channel)),
  })),
  delta: async (input) => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-updater-vectors-'))
    try {
      const sourcePath = path.join(directory, 'source.bin')
      const patchPath = path.join(directory, 'patch.fndelta')
      const outputPath = path.join(directory, 'output.bin')
      await fsp.writeFile(sourcePath, Buffer.from(input.sourceB64, 'base64'))
      await fsp.writeFile(patchPath, Buffer.from(input.patchB64, 'base64'))
      const header = await applyDeltaPatch({ patchPath, sourcePath, outputPath, expected: input.expected })
      const exists = await fsp.stat(outputPath).then(() => true, () => false)
      assert.ok(exists)
      return { ok: { platform: header.platform, baseVersion: header.baseVersion, targetVersion: header.targetVersion, targetFileName: header.target.fileName, targetSizeBytes: header.target.sizeBytes, targetSha256: await sha256File(outputPath) } }
    } catch (error) {
      const leftover = await fsp.stat(path.join(directory, 'output.bin')).then(() => true, () => false)
      return { ...errorOf(error), outputRemoved: !leftover }
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  },
}

// ------------------------------------------------------------------- build
const plain = (items, section, mapper = (x) => x) => items.map((input) => ({ input: mapper(input) }))
const buildInputs = () => ({
  versionCompare: versionPairs.map((input) => ({ input })),
  versionVisible: visibleVersions.flatMap((v) => channels.map((c) => ({ input: [v, c] }))),
  versionPackaged: packagedVersions.map((input) => ({ input })),
  versionNightly: nightlyInputs.map((input) => ({ input })),
  names: nameCases.map((input) => ({ input })),
  stringify: stringifyInputs.map((input) => ({ input })),
  privateAddress: privateAddresses.map((input) => ({ input })),
  modelHost: modelHostInputs.map((input) => ({ input })),
  policy: policyInputs.map(([version, month, tags]) => ({ input: { version, zurich: month, tags } })),
  pick: pickReleaseCases,
  diagnose: diagnoseInputs.map(({ name, ...input }) => ({ name, input })),
  manifest: manifestCases,
  delta: deltaCases,
})

const evaluate = async (section, input) => evaluators[section](input)

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const writeMode = process.argv.includes('--write')

if (writeMode) {
  const sections = {}
  const counts = {}
  for (const [section, cases] of Object.entries(buildInputs())) {
    sections[section] = []
    for (const entry of cases) {
      const expect = await evaluate(section, entry.input)
      if (entry.intent) {
        const accepted = section === 'delta' ? expect.ok !== undefined : expect.ok !== undefined
        assert.equal(accepted, entry.intent === 'ok', `${section}: "${entry.name}" intent ${entry.intent} but the JS oracle said ${JSON.stringify(expect).slice(0, 300)}`)
      }
      sections[section].push({ ...(entry.name ? { name: entry.name } : {}), ...(entry.intent ? { intent: entry.intent } : {}), input: entry.input, expect })
    }
    counts[section] = sections[section].length
  }
  const document = {
    description: 'Shared updater vectors. Generated by scripts/check-updater-vectors.mjs --write; JS is the oracle. Test keys are synthetic.',
    keys: { publicPem: main.publicPem, keyId: main.keyId, otherPublicPem: other.publicPem, otherKeyId: other.keyId },
    sections,
  }
  await fsp.mkdir(path.dirname(vectorsPath), { recursive: true })
  // One case per line keeps the file small and diffs readable.
  const lines = ['{', ` "description": ${JSON.stringify(document.description)},`, ` "keys": ${JSON.stringify(document.keys)},`, ' "sections": {']
  const names = Object.keys(sections)
  names.forEach((section, index) => {
    lines.push(`  ${JSON.stringify(section)}: [`)
    sections[section].forEach((entry, at) => lines.push(`   ${JSON.stringify(entry)}${at < sections[section].length - 1 ? ',' : ''}`))
    lines.push(`  ]${index < names.length - 1 ? ',' : ''}`)
  })
  lines.push(' }', '}')
  await fsp.writeFile(vectorsPath, `${lines.join('\n')}\n`)
  console.log('Wrote', vectorsPath, counts)
} else {
  const document = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'))
  assert.equal(document.keys.publicPem, main.publicPem, 'The committed test key does not match the generator seed.')
  let total = 0
  const sections = buildInputs()
  for (const [section, cases] of Object.entries(document.sections)) {
    assert.ok(evaluators[section], `Unknown section ${section}`)
    for (const entry of cases) {
      const actual = await evaluate(section, entry.input)
      assert.ok(sameJson(actual, entry.expect), `${section}: "${entry.name ?? JSON.stringify(entry.input).slice(0, 80)}"\n  expected ${JSON.stringify(entry.expect).slice(0, 400)}\n  actual   ${JSON.stringify(actual).slice(0, 400)}`)
      total += 1
    }
    // The generator and the committed file must describe the same inputs.
    assert.equal(cases.length, sections[section].length, `${section}: committed vectors are stale; run with --write.`)
    assert.ok(sameJson(cases.map((c) => c.input), sections[section].map((c) => c.input)), `${section}: committed inputs differ from the generator; run with --write.`)
  }
  console.log(`Updater-Vektoren erfolgreich: ${total} Fälle stimmen mit der JavaScript-Implementierung überein.`)
}
