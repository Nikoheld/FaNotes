#!/usr/bin/env node
'use strict'

// Build the signed update manifests that the desktop app downloads from a
// GitHub release. Package bytes stay on GitHub. This script never talks to
// the FaNotes server.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { githubReleaseAssetUrl, stableStringify } = require('../electron/updater.cjs')

const appRoot = path.resolve(__dirname, '..')
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

  const sums = []
  const linux = {
    schemaVersion: 1,
    product: 'FaNotes',
    channel: 'stable',
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
    channel: 'stable',
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
  fs.writeFileSync(path.join(directory, 'FaNotes-update-linux-x64.json'), `${JSON.stringify(sign(linux, privateKeyPem))}\n`)
  fs.writeFileSync(path.join(directory, 'FaNotes-update-windows-x64.json'), `${JSON.stringify(sign(windows, privateKeyPem))}\n`)
  console.log(`Update-Manifeste für ${version} geschrieben.`)
}

main()
