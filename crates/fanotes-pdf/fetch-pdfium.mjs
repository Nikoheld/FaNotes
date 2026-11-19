#!/usr/bin/env node
// Fetch the PDFium build pinned in pdfium-pin.json for one platform.
//
//   node crates/fanotes-pdf/fetch-pdfium.mjs [--platform linux-x64|win-x64] [--out <dir>] [--archive <file.tgz>]
//
// The archive and the library inside it must both match their SHA-256 pins, or
// nothing is written. Output (default `crates/fanotes-pdf/pdfium/<platform>/`):
// the library, PDFium's LICENSE, the third-party `licenses/`, and VERSION.
// `--archive` checks and unpacks a .tgz that is already on disk instead of
// downloading it. fanotes-pdf loads the library from that folder in a dev
// checkout; a desktop bundle ships the same folder as `pdfium/`.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const pin = JSON.parse(readFileSync(join(here, 'pdfium-pin.json'), 'utf8'))

const option = (name) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}

const hostPlatform = () => {
  if (process.arch !== 'x64') return null
  if (process.platform === 'linux') return 'linux-x64'
  if (process.platform === 'win32') return 'win-x64'
  return null
}

const platform = option('--platform') ?? hostPlatform()
const entry = platform ? pin.platforms[platform] : undefined
if (!entry) {
  console.error(`No pinned PDFium for ${platform ?? `${process.platform}-${process.arch}`}. Pinned: ${Object.keys(pin.platforms).join(', ')}`)
  process.exit(2)
}
const out = option('--out') ?? join(here, 'pdfium', platform)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const download = async (url) => {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Regular files of a ustar/GNU tar, by normalized path. */
const untar = (tar) => {
  const files = new Map()
  let offset = 0
  let longName = null
  const text = (start, length) => {
    const raw = tar.subarray(start, start + length)
    const end = raw.indexOf(0)
    return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8')
  }
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = text(offset + 345, 155)
    let name = longName ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100))
    longName = null
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = text(offset - Math.ceil(size / 512) * 512, size)
      continue
    }
    if (type !== '0') continue
    name = normalize(name).replaceAll('\\', '/').replace(/^\.\//u, '')
    if (name.startsWith('../') || name.startsWith('/')) throw new Error(`Unsafe path in archive: ${name}`)
    files.set(name, body)
  }
  return files
}

const archivePath = option('--archive')
const url = `${pin.source}/releases/download/${encodeURIComponent(pin.tag)}/${entry.archive}`
const archive = archivePath ? readFileSync(archivePath) : await download(url)
const archiveDigest = sha256(archive)
if (archiveDigest !== entry.archiveSha256) {
  console.error(`${entry.archive}: SHA-256 ${archiveDigest} is not the pinned ${entry.archiveSha256}. Nothing was written.`)
  process.exit(1)
}
const files = untar(gunzipSync(archive))
const library = files.get(entry.library)
if (!library) {
  console.error(`${entry.archive} has no ${entry.library}.`)
  process.exit(1)
}
const libraryDigest = sha256(library)
if (libraryDigest !== entry.librarySha256) {
  console.error(`${entry.library}: SHA-256 ${libraryDigest} is not the pinned ${entry.librarySha256}. Nothing was written.`)
  process.exit(1)
}

// Unpack next to the target and swap it in, so a reader never sees half a folder.
const staging = `${out}.partial-${process.pid}`
rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'licenses'), { recursive: true })
writeFileSync(join(staging, entry.libraryName), library)
for (const [name, body] of files) {
  if (name === 'LICENSE' || name === 'VERSION') writeFileSync(join(staging, name), body)
  else if (name.startsWith('licenses/') && !name.slice('licenses/'.length).includes('/')) {
    writeFileSync(join(staging, name), body)
  }
}
writeFileSync(join(staging, 'PIN.json'), `${JSON.stringify({ tag: pin.tag, platform, ...entry }, null, 2)}\n`)
mkdirSync(dirname(out), { recursive: true })
rmSync(out, { recursive: true, force: true })
renameSync(staging, out)
console.log(`PDFium ${pin.tag} ${platform}: ${join(out, entry.libraryName)} (sha256 ${libraryDigest})`)
