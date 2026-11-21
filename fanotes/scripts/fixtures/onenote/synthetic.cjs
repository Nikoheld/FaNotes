'use strict'

// Synthetic one2html-style pages and sessions for the OneNote import checks. No real notebook data.

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real, valid PNG of one colour. */
const solidPng = (width, height, [r, g, b]) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const page = ({ title = 'Synthetic', pageId = null, body = '' }) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    ${pageId ? `<meta name="X-Original-Page-Id" content="${pageId}"/>` : ''}
    <meta name="X-Created-Time" content="1603795643"/>
    <meta name="X-Updated-Time" content="1603795959"/>
    <title>${title}</title>
    <style>.ink-text, .ink-space { display: inline-block; }</style>
</head>
<body>
<div class="title" style="left: 48px; position: absolute; top: 24px;"><div class="container-outline" style="max-width: 624px;"><div class="outline-element" style="margin-left: 0px;"><span style="font-family: Arial; font-size: 20pt; line-height: 32px;">${title}</span></div>
</div></div><div class="container-outline" style="left: 48px; max-width: 576px; position: absolute; top: 115px;">${body}</div>
</body>
</html>`

const paragraph = (inner) => `<div class="outline-element" style="margin-left: 0px;"><p style="font-family: Arial; font-size: 11pt; line-height: 18px;">${inner}</p></div>\n`

/** Ink the way one2html writes it: an absolutely positioned SVG whose viewBox starts at the page position. */
const inkSvg = ({ left = 48.87, top = 200, width = 300, height = 80, paths }) => `<svg style="height: ${height}px; left: ${left}px; pointer-events: none; position: absolute; top: ${top}px; width: ${width}px;" viewBox="${left} ${top} ${width} ${height}">${paths.join('')}</svg>`
const inkPath = (d, { stroke = 'WindowText', width = 1, opacity = '1.00' } = {}) => `<path d="${d}" fill="none" opacity="${opacity}" stroke="${stroke}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${width}" />`

/**
 * A scanned session over files written below a fresh temp directory:
 * pages = [{ title, section: ['A'], html, pageId, files: { 'name.png': Buffer } }].
 */
async function makeSession(pages, { notebookName = 'Synthetic Notebook' } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-onenote-synthetic-'))
  const outputRoot = path.join(root, 'rendered')
  const result = { id: crypto.randomUUID(), root, outputRoot, sourceName: 'Synthetic.onetoc2', notebookName, warnings: [], pages: [] }
  for (const [index, entry] of pages.entries()) {
    const directory = path.join(outputRoot, ...(entry.section ?? []))
    await fsp.mkdir(directory, { recursive: true })
    const file = path.join(directory, `${entry.title}.html`)
    await fsp.writeFile(file, entry.html ?? page({ title: entry.title, pageId: entry.pageId ?? `{PAGE-${index}}`, body: entry.body ?? paragraph(`Text of ${entry.title}`) }))
    for (const [name, data] of Object.entries(entry.files ?? {})) {
      await fsp.mkdir(path.dirname(path.join(directory, name)), { recursive: true })
      await fsp.writeFile(path.join(directory, name), data)
    }
    const html = await fsp.readFile(file, 'utf8')
    result.pages.push({
      id: `p${index}`,
      file,
      title: entry.title,
      sectionPath: entry.section ?? [],
      parents: [],
      pageKey: `key-${notebookName}-${entry.pageId ?? index}`,
      hasInk: /<path\b[^>]*\bstroke="/u.test(html),
      imageCount: (html.match(/<img\b/gu) ?? []).length,
    })
  }
  return result
}

const tempVault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-onenote-vault-'))

module.exports = { inkPath, inkSvg, makeSession, page, paragraph, solidPng, tempVault }
