#!/usr/bin/env node

// Build the signed update manifests that the desktop app downloads from a
// GitHub release. Package bytes stay on GitHub. This script never talks to
// the FaNotes server.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { githubReleaseAssetUrl, stableStringify } = require('../electron/updater.cjs')

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const websiteUrl = 'https://fanotes.fasrv.ch/'

const readArg = (name) => {
  const index = process.argv.indexOf(name)
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} fehlt.`)
  return process.argv[index + 1]
}

const sha256File = (filePath) => {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

const releaseNotes = (version) => {
  const changelog = fs.readFileSync(path.join(appRoot, 'CHANGELOG.md'), 'utf8')
  const parts = changelog.split(/^## /mu)
  const section = parts.find((part) => part.startsWith(`${version}\n`) || part.startsWith(`${version}\r\n`))
  const notes = section
    ? section.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim()).filter(Boolean).slice(0, 20)
    : []
  return notes.length ? notes : [`FaNotes ${version}`]
}

const entry = (directory, version, fileName, sums) => {
  const filePath = path.join(directory, fileName)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
  const sizeBytes = fs.statSync(filePath).size
  const sha256 = sha256File(filePath)
  sums.push(`${sha256}  ${fileName}`)
  return { fileName, url: githubReleaseAssetUrl(version, fileName), sizeBytes, sha256 }
}

const requireEntry = (directory, version, fileName, sums, label) => {
  const value = entry(directory, version, fileName, sums)
  if (!value) throw new Error(`${label} fehlt: ${fileName}`)
  return value
}

const channelForRelease = (version) => (
  /^\d{4}\.\d{1,2}\.[1-9]\d*-beta\.[1-9]\d*$/u.test(version) ? 'beta' : 'stable'
)

const updateManifestFileName = (platform, channel) => (
  channel === 'stable'
    ? `FaNotes-update-${platform}-x64.json`
    : `FaNotes-update-${platform}-x64-${channel}.json`
)

const sign = (payload, privateKeyPem) => {
  const key = crypto.createPrivateKey(privateKeyPem)
  const publicKey = crypto.createPublicKey(key)
  const keyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  const value = crypto.sign(null, Buffer.from(stableStringify(payload)), key).toString('base64')
  return { ...payload, signature: { algorithm: 'ed25519', keyId, value } }
}

const main = () => {
  const directory = path.resolve(readArg('--dir'))
  const version = readArg('--version')
  const privateKeyPem = process.env.FANOTES_UPDATE_SIGNING_KEY || ''
  if (!privateKeyPem.includes('PRIVATE KEY')) throw new Error('FANOTES_UPDATE_SIGNING_KEY fehlt.')
  const packageVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version
  if (packageVersion !== version) throw new Error(`package.json ist ${packageVersion}, das Release ist ${version}.`)
  const channel = channelForRelease(version)

  const sums = []
  const linux = {
    schemaVersion: 1,
    product: 'FaNotes',
    channel,
    platform: 'linux',
    arch: 'x64',
    latestVersion: version,
    mandatory: false,
    publishedAt: new Date().toISOString(),
    releaseNotes: releaseNotes(version),
    packages: {
      appimage: requireEntry(directory, version, `FaNotes-${version}-x86_64.AppImage`, sums, 'Linux-AppImage'),
      portable: requireEntry(directory, version, `FaNotes-${version}-x86_64.tar.gz`, sums, 'Linux-Archiv'),
    },
    delta: null,
    websiteUrl,
  }
  const windows = {
    schemaVersion: 1,
    product: 'FaNotes',
    channel,
    platform: 'windows',
    arch: 'x64',
    latestVersion: version,
    mandatory: false,
    publishedAt: linux.publishedAt,
    releaseNotes: linux.releaseNotes,
    packages: {
      installer: requireEntry(directory, version, `FaNotes-Setup-${version}-x64.exe`, sums, 'Windows-Setup'),
      portable: requireEntry(directory, version, `FaNotes-Portable-${version}-x64.exe`, sums, 'Windows-Portable'),
    },
    delta: null,
    websiteUrl,
  }
  for (const fileName of [
    `FaNotes-${version}-android.apk`,
    `FaNotes-${version}-arm64.dmg`,
    `FaNotes-${version}-arm64.zip`,
    `FaNotes-${version}-x64.dmg`,
    `FaNotes-${version}-x64.zip`,
  ]) entry(directory, version, fileName, sums)

  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${sums.sort().join('\n')}\n`)
  fs.writeFileSync(path.join(directory, updateManifestFileName('linux', channel)), `${JSON.stringify(sign(linux, privateKeyPem))}\n`)
  fs.writeFileSync(path.join(directory, updateManifestFileName('windows', channel)), `${JSON.stringify(sign(windows, privateKeyPem))}\n`)
  console.log(`Update-Manifeste für ${version} geschrieben.`)
}

if (process.argv.includes('--self-test')) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  assert(channelForRelease('2026.10.10') === 'stable', 'stable channel')
  assert(channelForRelease('2026.10.11-beta.1') === 'beta', 'beta channel')
  assert(updateManifestFileName('linux', 'stable') === 'FaNotes-update-linux-x64.json', 'stable linux manifest')
  assert(updateManifestFileName('windows', 'stable') === 'FaNotes-update-windows-x64.json', 'stable windows manifest')
  assert(updateManifestFileName('linux', 'beta') === 'FaNotes-update-linux-x64-beta.json', 'beta linux manifest')
  assert(updateManifestFileName('windows', 'beta') === 'FaNotes-update-windows-x64-beta.json', 'beta windows manifest')
  console.log('update manifest names ok')
} else {
  main()
}
