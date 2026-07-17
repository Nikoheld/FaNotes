'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_EXPANDED_BYTES = 6 * 1024 * 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_HTML_BYTES = 128 * 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const TOOL_TIMEOUT_MS = 12 * 60 * 1000
const TOOL_MANIFEST = Object.freeze({
  linux: Object.freeze({
    one2html: Object.freeze({ fileName: 'one2html', sha256: '140c347e192d8bed8225f01a4c736e04c19bed241589d46cdc8b241b906eadb0' }),
    sevenZip: Object.freeze({ fileName: '7za', sha256: 'afc9448bd0cc2eeda131cce313ef4994f9656417e0a15c8465fcda9ca859b280' }),
  }),
  win32: Object.freeze({
    one2html: Object.freeze({ fileName: 'one2html.exe', sha256: 'cfcba9231edf433e3f84b92a7ce119ec4af3df870301691bbefea83618f295af' }),
    sevenZip: Object.freeze({ fileName: '7za.exe', sha256: 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95' }),
  }),
})
const IMAGE_FORMATS = new Map([
  ['.png', { mime: 'image/png', signature: (data) => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ['.jpg', { mime: 'image/jpeg', signature: (data) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff }],
  ['.jpeg', { mime: 'image/jpeg', signature: (data) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff }],
  ['.gif', { mime: 'image/gif', signature: (data) => ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii')) }],
  ['.webp', { mime: 'image/webp', signature: (data) => data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP' }],
])

const isInside = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const safeSegment = (value, fallback = 'Unbenannt') => {
  const safe = String(value ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 120)
  return safe && safe !== '.' && safe !== '..' ? safe : fallback
}

const markdownTitle = (value) => safeSegment(value, 'OneNote-Seite').replace(/([\\`*_{}\[\]()#+.!|-])/gu, '\\$1')

const atomicWrite = async (target, data) => {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  await fsp.writeFile(temporary, data, { mode: 0o600 })
  await fsp.rename(temporary, target)
}

const hashFile = (target) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(target)
  stream.once('error', reject)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.once('end', () => resolve(hash.digest('hex')))
})

const hashBuffer = (data) => crypto.createHash('sha256').update(data).digest('hex')

const atomicCopy = async (source, target) => {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
  await fsp.chmod(temporary, 0o600)
  await fsp.rename(temporary, target)
}

async function runTool(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', RUST_BACKTRACE: '0' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const collect = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-256 * 1024)
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk) })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('Der OneNote-Import hat das sichere Zeitlimit überschritten.'))
    }, options.timeoutMs ?? TOOL_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${options.label ?? 'OneNote-Werkzeug'} ist fehlgeschlagen${signal ? ` (${signal})` : ''}: ${(stderr || stdout || `Code ${code}`).trim().slice(-1800)}`))
    })
  })
}

async function walkRegularFiles(root, limits = {}) {
  const result = []
  const pending = [root]
  let totalBytes = 0
  while (pending.length) {
    const directory = pending.pop()
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    if (result.length + entries.length > (limits.entries ?? MAX_ARCHIVE_ENTRIES)) throw new Error('Der OneNote-Export enthält zu viele Dateien.')
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (!isInside(root, target)) throw new Error('Ein OneNote-Pfad verlässt das Importverzeichnis.')
      const info = await fsp.lstat(target)
      if (info.isSymbolicLink()) throw new Error('Symbolische Verknüpfungen sind in einem OneNote-Import nicht erlaubt.')
      if (info.isDirectory()) pending.push(target)
      else if (info.isFile()) {
        totalBytes += info.size
        if (totalBytes > (limits.bytes ?? MAX_EXPANDED_BYTES)) throw new Error('Der entpackte OneNote-Export ist zu groß.')
        result.push({ path: target, size: info.size })
      } else {
        throw new Error('Der OneNote-Export enthält einen nicht unterstützten Dateityp.')
      }
    }
  }
  return result
}

function validateArchiveListing(stdout) {
  const records = stdout.split(/\r?\n\r?\n/gu)
  let count = 0
  let bytes = 0
  for (const record of records) {
    const fields = new Map(record.split(/\r?\n/gu).map((line) => {
      const separator = line.indexOf(' = ')
      return separator > 0 ? [line.slice(0, separator), line.slice(separator + 3)] : ['', '']
    }))
    const entryPath = fields.get('Path')
    if (!entryPath || fields.get('Type')) continue
    const normalized = entryPath.replaceAll('\\', '/')
    if (normalized.startsWith('/') || /^[a-z]:\//iu.test(normalized) || normalized.split('/').some((segment) => segment === '..' || segment === '')) {
      throw new Error('Das OneNote-Archiv enthält einen unsicheren Pfad.')
    }
    if (fields.get('Folder') !== '+') bytes += Number(fields.get('Size') ?? 0)
    count += 1
    if (count > MAX_ARCHIVE_ENTRIES || !Number.isSafeInteger(bytes) || bytes > MAX_EXPANDED_BYTES) {
      throw new Error('Das OneNote-Archiv überschreitet die sicheren Importgrenzen.')
    }
  }
  if (!count) throw new Error('Das OneNote-Archiv enthält keine importierbaren Dateien.')
}

async function prepareInput(inputPath, temporaryRoot, sevenZip) {
  const extension = path.extname(inputPath).toLocaleLowerCase('en-US')
  if (extension === '.one' || extension === '.onetoc2') return [inputPath]
  if (extension !== '.zip' && extension !== '.onepkg') throw new Error('Unterstützt werden .one, .onetoc2, OneDrive-ZIP und .onepkg.')
  const extracted = path.join(temporaryRoot, 'extracted')
  await fsp.mkdir(extracted, { mode: 0o700 })
  const listing = await runTool(sevenZip, ['l', '-slt', '--', inputPath], { label: 'Archivprüfung', timeoutMs: 90_000 })
  validateArchiveListing(listing.stdout)
  await runTool(sevenZip, ['x', '-y', '-bd', '-bb0', `-o${extracted}`, '--', inputPath], { label: 'Archivextraktion' })
  const files = await walkRegularFiles(extracted)
  const tocFiles = files.filter((entry) => path.extname(entry.path).toLocaleLowerCase('en-US') === '.onetoc2')
    .sort((left, right) => left.path.split(path.sep).length - right.path.split(path.sep).length)
  if (tocFiles.length) return [tocFiles[0].path]
  const sections = files.filter((entry) => path.extname(entry.path).toLocaleLowerCase('en-US') === '.one').map((entry) => entry.path)
  if (!sections.length) throw new Error('Im Archiv wurde kein OneNote-Notizbuch gefunden.')
  return sections
}

function commonAncestor(paths) {
  if (!paths.length) return path.parse(process.cwd()).root
  let ancestor = path.dirname(paths[0])
  while (!paths.every((candidate) => isInside(ancestor, candidate))) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return ancestor
}

async function renderSectionsIndividually(sections, sourceRoot, outputRoot, one2html) {
  for (const section of sections) {
    const relativeDirectory = path.relative(sourceRoot, path.dirname(section))
      .split(path.sep).filter((segment) => segment && segment !== '..').map((segment) => safeSegment(segment))
    const destination = path.join(outputRoot, ...relativeDirectory)
    await fsp.mkdir(destination, { recursive: true, mode: 0o700 })
    await runTool(one2html, ['--input', section, '--output', destination], { label: `OneNote-Abschnitt ${path.basename(section)}` })
  }
}

async function renderOneNoteInputs(inputs, outputRoot, one2html) {
  const warnings = []
  if (inputs.length === 1 && path.extname(inputs[0]).toLocaleLowerCase('en-US') === '.onetoc2') {
    try {
      await runTool(one2html, ['--input', inputs[0], '--output', outputRoot], { label: 'OneNote-Konvertierung' })
      return warnings
    } catch (notebookError) {
      const notebookRoot = path.dirname(inputs[0])
      const files = await walkRegularFiles(notebookRoot)
      const sections = files.filter((entry) => path.extname(entry.path).toLocaleLowerCase('en-US') === '.one').map((entry) => entry.path)
      if (!sections.length) throw notebookError
      // A failed notebook conversion may already have emitted partial pages.
      // Start the section fallback from a clean tree so no page is duplicated.
      await fsp.rm(outputRoot, { recursive: true, force: true })
      await fsp.mkdir(outputRoot, { mode: 0o700 })
      await renderSectionsIndividually(sections, notebookRoot, outputRoot, one2html)
      warnings.push('Verschachtelte OneNote-Abschnittsgruppen wurden abschnittsweise mit ihrer Ordnerhierarchie übernommen.')
      return warnings
    }
  }
  const sections = inputs.filter((candidate) => path.extname(candidate).toLocaleLowerCase('en-US') === '.one')
  if (!sections.length) throw new Error('Es wurden keine OneNote-Abschnitte für die Konvertierung gefunden.')
  await renderSectionsIndividually(sections, commonAncestor(sections), outputRoot, one2html)
  return warnings
}

async function materializeOneNoteTools({ embeddedRoot, cacheRoot, platform = process.platform }) {
  const manifest = TOOL_MANIFEST[platform]
  if (!manifest) throw new Error('Der OneNote-Import wird auf dieser Plattform noch nicht unterstützt.')
  await fsp.mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const cacheInfo = await fsp.lstat(cacheRoot)
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) throw new Error('Der lokale OneNote-Werkzeugcache ist unsicher.')
  const cacheReal = await fsp.realpath(cacheRoot)
  const targetDirectory = path.join(cacheReal, `v1-${platform}-x64`)
  await fsp.mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  const targetInfo = await fsp.lstat(targetDirectory)
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('Der lokale OneNote-Werkzeugcache ist unsicher.')

  const tools = {}
  for (const [name, entry] of Object.entries(manifest)) {
    const source = path.join(embeddedRoot, platform === 'win32' ? 'windows' : 'linux', entry.fileName)
    const data = await fsp.readFile(source)
    if (hashBuffer(data) !== entry.sha256) throw new Error(`Die eingebettete OneNote-Komponente ${entry.fileName} ist beschädigt.`)
    const target = path.join(targetDirectory, entry.fileName)
    let reuse = false
    try {
      const existing = await fsp.lstat(target)
      reuse = existing.isFile() && !existing.isSymbolicLink() && await hashFile(target) === entry.sha256
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (!reuse) {
      await fsp.rm(target, { force: true })
      await atomicWrite(target, data)
    }
    await fsp.chmod(target, 0o700)
    tools[name] = target
  }
  return tools
}

const decodeHtmlEntities = (value) => value
  .replace(/&#x([0-9a-f]+);/giu, (_match, number) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(number, 16))))
  .replace(/&#([0-9]+);/gu, (_match, number) => String.fromCodePoint(Math.min(0x10ffff, Number(number))))
  .replace(/&(nbsp|amp|lt|gt|quot|apos);/giu, (_match, entity) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLocaleLowerCase('en-US')])

function extractSearchText(html) {
  return decodeHtmlEntities(html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/giu, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/giu, ' ')
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(?:p|h[1-6]|li|tr|td|div|table)>/giu, '\n')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n\s*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, 2_000_000)
}

function pageDimensions(html) {
  const values = (name) => [...html.matchAll(new RegExp(`(?:^|[;\\s\"])(?:max-)?${name}\\s*:\\s*(-?[0-9.]+)px`, 'giu'))]
    .map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value >= 0)
  const max = (items, fallback) => items.length ? Math.max(...items) : fallback
  const blockCount = (html.match(/<(?:p|li|tr|h[1-6])\b/giu) ?? []).length
  const width = Math.max(720, Math.min(3000, max(values('left'), 0) + max(values('width'), 720) + 96))
  const height = Math.max(900, Math.min(30_000, max(values('top'), 0) + max(values('height'), 160) + 140, blockCount * 24 + 280))
  return { width: Math.round(width), height: Math.round(height) }
}

async function inlineImages(html, pagePath, outputRoot) {
  const replacements = new Map()
  let embeddedBytes = 0
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=(['"])([^'"]+)\1[^>]*>/giu)) {
    const source = match[2]
    if (/^(?:data:|https?:|file:|javascript:)/iu.test(source)) {
      if (!source.startsWith('data:')) replacements.set(source, '')
      continue
    }
    let decoded
    try { decoded = decodeURIComponent(source) } catch { decoded = source }
    const imagePath = path.resolve(path.dirname(pagePath), decoded)
    if (!isInside(outputRoot, imagePath)) {
      replacements.set(source, '')
      continue
    }
    const format = IMAGE_FORMATS.get(path.extname(imagePath).toLocaleLowerCase('en-US'))
    if (!format) {
      replacements.set(source, '')
      continue
    }
    try {
      const info = await fsp.lstat(imagePath)
      if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_IMAGE_BYTES || embeddedBytes + info.size > 96 * 1024 * 1024) throw new Error('Bildgrenze')
      const data = await fsp.readFile(imagePath)
      if (!format.signature(data)) throw new Error('Bildsignatur')
      embeddedBytes += data.length
      replacements.set(source, `data:${format.mime};base64,${data.toString('base64')}`)
    } catch {
      replacements.set(source, '')
    }
  }
  return html.replace(/(<img\b[^>]*\bsrc=)(['"])([^'"]+)\2/giu, (full, prefix, quote, source) => {
    if (!replacements.has(source)) return full
    const replacement = replacements.get(source)
    return replacement ? `${prefix}${quote}${replacement}${quote}` : prefix.replace(/\bsrc=$/u, 'data-fanotes-missing-image=') + `${quote}blocked${quote}`
  })
}

async function sanitizePage(pagePath, outputRoot) {
  const info = await fsp.lstat(pagePath)
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_HTML_BYTES) throw new Error('Eine OneNote-Seite ist leer oder zu groß.')
  let html = await fsp.readFile(pagePath, 'utf8')
  const title = decodeHtmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? path.basename(pagePath, '.html')).replace(/<[^>]+>/gu, '').trim()
  const transcript = extractSearchText(html)
  const dimensions = pageDimensions(html)
  html = await inlineImages(html, pagePath, outputRoot)
  html = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
    .replace(/<(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)\b[^>]*>[\s\S]*?<\/(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)>/giu, '')
    .replace(/<(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)\b[^>]*\/?>/giu, '')
    .replace(/\s+on[a-z][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '')
    .replace(/\s+(?:href|action|formaction|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '')
    .replace(/(?:javascript|vbscript)\s*:/giu, '')
    .replace(/@import\s+[^;]+;?/giu, '')
    .replace(/url\s*\([^)]*\)/giu, 'none')
    .replace(/expression\s*\([^)]*\)/giu, '')
  const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  const guard = `<meta name="fanotes-onenote-safe-v1" content="1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style id="fanotes-page-guard">html,body{width:${dimensions.width}px;min-width:${dimensions.width}px;min-height:${dimensions.height}px;overflow:hidden;background:#fff;color:#111}a{color:inherit;text-decoration:underline;pointer-events:none}</style>`
  html = html.includes('<head>') ? html.replace('<head>', `<head>${guard}`) : `<!doctype html><html><head>${guard}</head><body>${html}</body></html>`
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('Eine eingebettete OneNote-Seite überschreitet nach der Bildübernahme die sichere Größe.')
  return { html, title: safeSegment(title, 'OneNote-Seite'), transcript, ...dimensions }
}

function buildPageParentMap(htmlFiles, outputRoot) {
  const parents = new Map()
  for (const entry of htmlFiles) {
    const html = fs.readFileSync(entry.path, 'utf8')
    if (!/<nav\b/iu.test(html)) continue
    const stack = []
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
      const attributes = match[1]
      const href = /\bhref=(['"])([^'"]+)\1/iu.exec(attributes)?.[2]
      const level = Number(/\bclass=(['"])[^'"]*\bl([1-9])\b[^'"]*\1/iu.exec(attributes)?.[2] ?? 1)
      if (!href || !Number.isInteger(level)) continue
      let decodedHref
      try { decodedHref = decodeURIComponent(href) } catch { decodedHref = href }
      const target = path.resolve(path.dirname(entry.path), decodedHref)
      if (!isInside(outputRoot, target)) continue
      const titleAttribute = /\btitle=(['"])([^'"]+)\1/iu.exec(attributes)?.[2]
      const title = safeSegment(decodeHtmlEntities(titleAttribute ?? match[2].replace(/<[^>]+>/gu, ' ')), 'OneNote-Seite')
      stack[level - 1] = title
      stack.length = level
      parents.set(target, stack.slice(0, Math.max(0, level - 1)))
    }
  }
  return parents
}

async function uniqueDirectory(parent, preferred) {
  for (let index = 0; index < 10_000; index += 1) {
    const name = index ? `${preferred} ${index + 1}` : preferred
    const target = path.join(parent, name)
    try {
      await fsp.mkdir(target, { mode: 0o700 })
      return target
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('Für den OneNote-Import konnte kein freier Zielordner angelegt werden.')
}

async function copyInertAttachments(files, outputRoot, attachmentDirectory) {
  const attachments = []
  for (const entry of files) {
    if (path.extname(entry.path).toLocaleLowerCase('en-US') === '.html') continue
    const digest = await hashFile(entry.path)
    const relative = path.relative(outputRoot, entry.path).split(path.sep).map((segment) => safeSegment(segment)).join('/')
    const inertName = `${digest.slice(0, 16)}-${safeSegment(path.basename(entry.path), 'Anlage')}.fanotes-attachment`
    const target = path.join(attachmentDirectory, inertName)
    if (!fs.existsSync(target)) await atomicCopy(entry.path, target)
    attachments.push({ originalPath: relative, storedName: inertName, size: entry.size, sha256: digest })
  }
  return attachments
}

async function preserveOriginalSources(inputPath, internalBatch) {
  const extension = path.extname(inputPath).toLocaleLowerCase('en-US')
  let sources = [{ path: inputPath, size: (await fsp.lstat(inputPath)).size }]
  let sourceRoot = path.dirname(inputPath)
  if (extension === '.onetoc2') {
    sources = (await walkRegularFiles(sourceRoot)).filter((entry) => ['.one', '.onetoc2'].includes(path.extname(entry.path).toLocaleLowerCase('en-US')))
  }
  const directory = path.join(internalBatch, 'original')
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const preserved = []
  for (const source of sources) {
    const digest = await hashFile(source.path)
    const relative = path.relative(sourceRoot, source.path).split(path.sep).map((segment) => safeSegment(segment)).join('/') || safeSegment(path.basename(source.path))
    const storedName = `${digest.slice(0, 16)}-${safeSegment(path.basename(source.path), 'OneNote')}.fanotes-onenote-source`
    await atomicCopy(source.path, path.join(directory, storedName))
    preserved.push({ originalPath: relative, storedName, size: source.size, sha256: digest })
  }
  return preserved
}

async function importOneNoteToVault({ inputPath, vaultRoot, one2html, sevenZip }) {
  const sourceInfo = await fsp.lstat(inputPath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !sourceInfo.size || sourceInfo.size > MAX_SOURCE_BYTES) {
    throw new Error('Die OneNote-Quelldatei ist leer, unsicher oder größer als 4 GB.')
  }
  const rootInfo = await fsp.lstat(vaultRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Der aktive Vault ist kein sicherer Ordner.')
  for (const executable of [one2html, sevenZip]) {
    const info = await fsp.lstat(executable)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Eine geprüfte OneNote-Importkomponente fehlt.')
  }

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-onenote-'))
  let noteRoot = null
  let internalBatch = null
  try {
    const inputs = await prepareInput(inputPath, temporaryRoot, sevenZip)
    const outputRoot = path.join(temporaryRoot, 'rendered')
    await fsp.mkdir(outputRoot, { mode: 0o700 })
    const conversionWarnings = await renderOneNoteInputs(inputs, outputRoot, one2html)
    const outputFiles = await walkRegularFiles(outputRoot, { bytes: MAX_OUTPUT_BYTES })
    const pageParentMap = buildPageParentMap(outputFiles.filter((entry) => path.extname(entry.path).toLocaleLowerCase('en-US') === '.html'), outputRoot)
    const pageFiles = []
    for (const entry of outputFiles) {
      if (path.extname(entry.path).toLocaleLowerCase('en-US') !== '.html') continue
      const preview = await fsp.readFile(entry.path, { encoding: 'utf8' })
      if (/<nav\b/iu.test(preview) || /<iframe\b/iu.test(preview)) continue
      pageFiles.push(entry.path)
    }
    if (!pageFiles.length) throw new Error('Im OneNote-Export wurden keine lesbaren Seiten gefunden. Verwende einen aktuellen OneDrive-Export oder eine moderne .one-Datei.')

    const sourceDigest = await hashFile(inputPath)
    const sourceBase = path.basename(inputPath, path.extname(inputPath))
    const notebookName = safeSegment(sourceBase === 'Open Notebook' ? path.basename(path.dirname(inputPath)) : sourceBase, 'OneNote-Notizbuch')
    noteRoot = await uniqueDirectory(vaultRoot, `OneNote – ${notebookName}`)
    const internalRoot = path.join(vaultRoot, '.lernwerk')
    const oneNoteRoot = path.join(internalRoot, 'onenote')
    const worksheetsRoot = path.join(internalRoot, 'worksheets')
    await fsp.mkdir(oneNoteRoot, { recursive: true, mode: 0o700 })
    await fsp.mkdir(worksheetsRoot, { recursive: true, mode: 0o700 })
    internalBatch = path.join(oneNoteRoot, crypto.randomUUID())
    const attachmentDirectory = path.join(internalBatch, 'attachments')
    await fsp.mkdir(attachmentDirectory, { recursive: true, mode: 0o700 })

    const [attachments, originalSources] = await Promise.all([
      copyInertAttachments(outputFiles, outputRoot, attachmentDirectory),
      preserveOriginalSources(inputPath, internalBatch),
    ])
    const now = new Date().toISOString()
    const importedNotes = []
    for (const pagePath of pageFiles.sort((left, right) => left.localeCompare(right, 'de', { numeric: true }))) {
      const page = await sanitizePage(pagePath, outputRoot)
      const relativePage = path.relative(outputRoot, pagePath)
      const hierarchy = path.dirname(relativePage).split(path.sep).filter((segment) => segment && segment !== '.')
      const withoutDuplicateNotebook = hierarchy[0]?.localeCompare(notebookName, 'de', { sensitivity: 'base' }) === 0 ? hierarchy.slice(1) : hierarchy
      const pageParents = pageParentMap.get(pagePath) ?? []
      const noteDirectory = path.join(noteRoot, ...withoutDuplicateNotebook.map((segment) => safeSegment(segment)), ...pageParents.map((segment) => safeSegment(segment)))
      if (!isInside(noteRoot, noteDirectory)) throw new Error('Eine OneNote-Seitenhierarchie ist ungültig.')
      await fsp.mkdir(noteDirectory, { recursive: true, mode: 0o700 })
      const id = crypto.randomUUID()
      const sourcePath = path.join(worksheetsRoot, `${id}.html`)
      const dataPath = path.join(worksheetsRoot, `${id}.json`)
      const worksheet = {
        schemaVersion: 1,
        id,
        title: page.title,
        kind: 'html',
        mimeType: 'text/html',
        sourceRelativePath: `.lernwerk/worksheets/${id}.html`,
        dataRelativePath: `.lernwerk/worksheets/${id}.json`,
        createdAt: now,
        updatedAt: now,
        pageWidth: page.width,
        pageHeight: page.height,
        textBoxes: [],
      }
      await atomicWrite(sourcePath, page.html)
      await atomicWrite(dataPath, `${JSON.stringify(worksheet, null, 2)}\n`)
      let notePath = path.join(noteDirectory, `${safeSegment(page.title, 'OneNote-Seite')}.md`)
      for (let index = 2; fs.existsSync(notePath); index += 1) notePath = path.join(noteDirectory, `${safeSegment(page.title, 'OneNote-Seite')} ${index}.md`)
      const searchable = page.transcript
        ? `\n<details>\n<summary>Importierter Text · suchbar und bearbeitbar</summary>\n\n\`\`\`text\n${page.transcript.replaceAll('```', 'ˋˋˋ')}\n\`\`\`\n\n</details>\n`
        : ''
      const markdown = `# ${markdownTitle(page.title)}\n\n<!-- fanotes-onenote:${sourceDigest.slice(0, 24)} -->\n<!-- fanotes-worksheet:${id} -->\n${searchable}`
      await atomicWrite(notePath, markdown)
      importedNotes.push(path.relative(vaultRoot, notePath).split(path.sep).join('/'))
    }
    const manifest = {
      schemaVersion: 1,
      importedAt: now,
      sourceName: path.basename(inputPath),
      sourceSha256: sourceDigest,
      pages: importedNotes.length,
      attachments,
      originalSources,
      safety: 'Attachments are stored byte-identically with an inert .fanotes-attachment suffix and are never executed.',
    }
    await atomicWrite(path.join(internalBatch, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return {
      rootFolder: path.relative(vaultRoot, noteRoot).split(path.sep).join('/'),
      pageCount: importedNotes.length,
      attachmentCount: attachments.length,
      importedNotes,
      warnings: [
        ...conversionWarnings,
        ...(attachments.length ? ['Anlagen wurden bytegenau, aber nicht ausführbar im internen Vault-Bereich verwahrt.'] : []),
      ],
    }
  } catch (error) {
    if (noteRoot) await fsp.rm(noteRoot, { recursive: true, force: true }).catch(() => {})
    if (internalBatch) await fsp.rm(internalBatch, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = { importOneNoteToVault, materializeOneNoteTools, TOOL_MANIFEST }
