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
    one2html: Object.freeze({ fileName: 'one2html', sha256: '343c247d7a5513df08185418d2be0ecaeb00ac06e4bc427f084f1e2179af5523' }),
    sevenZip: Object.freeze({ fileName: '7za', sha256: 'afc9448bd0cc2eeda131cce313ef4994f9656417e0a15c8465fcda9ca859b280' }),
  }),
  win32: Object.freeze({
    one2html: Object.freeze({ fileName: 'one2html.exe', sha256: '9d3d043f86a65e8b97782bb72275837768a066353c771dab96bceef683136981' }),
    sevenZip: Object.freeze({ fileName: '7za.exe', sha256: 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95' }),
  }),
})
// The official Windows one2html build imports VCRUNTIME140.dll. Electron already
// ships that DLL beside the app executable. The converter runs from the tool
// cache, so Windows would not search the app directory unless we copy it there.
const WINDOWS_CRT_NAMES = Object.freeze(['vcruntime140.dll', 'vcruntime140_1.dll'])
const WINDOWS_CRT_MAX_BYTES = 8 * 1024 * 1024

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

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu

const safeSegment = (value, fallback = 'Unbenannt') => {
  const safe = String(value ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 120)
  if (!safe || safe === '.' || safe === '..' || WINDOWS_DEVICE_NAME.test(safe.split('.')[0].trim())) return fallback
  return safe
}


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

function windowsAppDirectory() {
  return path.dirname(process.execPath)
}

function toolEnv() {
  const env = { ...process.env, NO_COLOR: '1', RUST_BACKTRACE: '0' }
  if (process.platform !== 'win32') return env
  const appDirectory = windowsAppDirectory()
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  const entries = String(env[pathKey] ?? '').split(';').filter(Boolean)
  if (!entries.some((entry) => path.resolve(entry) === path.resolve(appDirectory))) {
    env[pathKey] = [appDirectory, ...entries].join(';')
  }
  return env
}

async function stageWindowsCrt(targetDirectory) {
  if (process.platform !== 'win32') return
  const appDirectory = windowsAppDirectory()
  for (const name of WINDOWS_CRT_NAMES) {
    const source = path.join(appDirectory, name)
    let info
    try {
      info = await fsp.lstat(source)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > WINDOWS_CRT_MAX_BYTES) continue
    const data = await fsp.readFile(source)
    const target = path.join(targetDirectory, name)
    let reuse = false
    try {
      const existing = await fsp.lstat(target)
      reuse = existing.isFile() && !existing.isSymbolicLink() && await hashFile(target) === hashBuffer(data)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (!reuse) {
      await fsp.rm(target, { force: true })
      await atomicWrite(target, data)
    }
  }
}

async function runTool(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: toolEnv(),
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
      return { warnings, notebookRoot: true }
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
      return { warnings, notebookRoot: false }
    }
  }
  const sections = inputs.filter((candidate) => path.extname(candidate).toLocaleLowerCase('en-US') === '.one')
  if (!sections.length) throw new Error('Es wurden keine OneNote-Abschnitte für die Konvertierung gefunden.')
  await renderSectionsIndividually(sections, commonAncestor(sections), outputRoot, one2html)
  return { warnings, notebookRoot: false }
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
  if (platform === 'win32') await stageWindowsCrt(targetDirectory)
  return tools
}

const codePointFromEntity = (raw, radix) => {
  const point = radix === 16 ? Number.parseInt(raw, 16) : Number(raw)
  if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xD800 && point <= 0xDFFF)) return '\uFFFD'
  return String.fromCodePoint(point)
}

const decodeHtmlEntities = (value) => value
  .replace(/&#x([0-9a-f]+);/giu, (_match, number) => codePointFromEntity(number, 16))
  .replace(/&#([0-9]+);/gu, (_match, number) => codePointFromEntity(number, 10))
  .replace(/&(nbsp|amp|lt|gt|quot|apos);/giu, (_match, entity) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLocaleLowerCase('en-US')])

let oneNoteSanitizer = null
/**
 * Parses the page with parse5 and cleans it with hast-util-sanitize (the
 * sanitiser behind rehype-sanitize) against onenote-sanitize-policy.json, the
 * allowlist the Rust host applies with ammonia. Event handlers, scripts, frames,
 * forms and every URL attribute except inline `data:image/` sources are dropped,
 * whatever the markup looks like (`<svg/onload=…>` included).
 */
function sanitizeOneNoteHtml(html) {
  if (!oneNoteSanitizer) {
    const { createOneNoteSanitizer } = require('./onenote-sanitizer.bundle.cjs')
    oneNoteSanitizer = createOneNoteSanitizer(require('./onenote-sanitize-policy.json'))
  }
  return oneNoteSanitizer(html)
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


// ---------------------------------------------------------------------------
// Two-step import: scan (pick pages) -> import (selected pages into a folder)
// ---------------------------------------------------------------------------

const IMAGE_DIRECTORY = '.fanotes/assets/onenote'
const INDEX_RELATIVE_PATH = path.join('.fanotes', 'onenote', 'imports.json')
const MAX_INDEX_BYTES = 8 * 1024 * 1024

const sha1Short = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 12)

/** Stable key of a page across imports: notebook, section and OneNote's own page id (title as fallback). */
const pageKeyOf = (notebookName, sectionPath, pageId, title) => crypto
  .createHash('sha256')
  .update(`${notebookName}\n${sectionPath.join('/')}\n${pageId || `title:${title}`}`)
  .digest('hex')
  .slice(0, 24)

async function readImportIndex(vaultRoot) {
  try {
    const raw = await fsp.readFile(path.join(vaultRoot, INDEX_RELATIVE_PATH), 'utf8')
    if (raw.length > MAX_INDEX_BYTES) return { version: 1, pages: {} }
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.pages && typeof parsed.pages === 'object' ? { version: 1, pages: parsed.pages } : { version: 1, pages: {} }
  } catch {
    return { version: 1, pages: {} }
  }
}

async function writeImportIndex(vaultRoot, index) {
  const target = path.join(vaultRoot, INDEX_RELATIVE_PATH)
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await atomicWrite(target, `${JSON.stringify(index, null, 2)}\n`)
}

/**
 * The note an earlier import wrote for this page, when it still exists inside the destination folder.
 * Importing the page into another folder is a deliberate copy and is not skipped.
 */
function importedNoteIn(entry, destination, vaultRoot) {
  const paths = [...new Set([...(Array.isArray(entry?.paths) ? entry.paths : []), entry?.path])].filter((value) => typeof value === 'string' && value && !value.includes('..'))
  const prefix = destination.logical ? `${destination.logical}/` : ''
  for (const logical of paths) {
    if (prefix && !logical.startsWith(prefix)) continue
    const candidates = [path.join(vaultRoot, ...logical.split('/'))]
    if (prefix) candidates.unshift(path.join(destination.physical, ...logical.slice(prefix.length).split('/')))
    if (candidates.some((candidate) => fs.existsSync(candidate))) return logical
  }
  return null
}

/**
 * Converts the source once and lists what it holds. The returned session keeps the converted
 * pages in a private temporary directory until disposeSession() so the page picker can import
 * a selection later without converting again.
 */
async function scanOneNote({ inputPath, one2html, sevenZip, signal }) {
  const sourceInfo = await fsp.lstat(inputPath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !sourceInfo.size || sourceInfo.size > MAX_SOURCE_BYTES) {
    throw new Error('Die OneNote-Quelldatei ist leer, unsicher oder größer als 4 GB.')
  }
  for (const executable of [one2html, sevenZip]) {
    const info = await fsp.lstat(executable)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Eine geprüfte OneNote-Importkomponente fehlt.')
  }
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-onenote-'))
  try {
    const inputs = await prepareInput(inputPath, temporaryRoot, sevenZip)
    const outputRoot = path.join(temporaryRoot, 'rendered')
    await fsp.mkdir(outputRoot, { mode: 0o700 })
    const rendered = await renderOneNoteInputs(inputs, outputRoot, one2html)
    if (signal?.aborted) throw new Error('Abgebrochen.')
    const outputFiles = await walkRegularFiles(outputRoot, { bytes: MAX_OUTPUT_BYTES })
    const htmlFiles = outputFiles.filter((entry) => path.extname(entry.path).toLocaleLowerCase('en-US') === '.html')
    const parentMap = buildPageParentMap(htmlFiles, outputRoot)
    const sourceBase = path.basename(inputPath, path.extname(inputPath))
    const notebookName = safeSegment(sourceBase === 'Open Notebook' ? path.basename(path.dirname(inputPath)) : sourceBase, 'OneNote-Notizbuch')
    const pages = []
    for (const entry of htmlFiles.sort((left, right) => left.path.localeCompare(right.path, 'de', { numeric: true }))) {
      if (signal?.aborted) throw new Error('Abgebrochen.')
      if (entry.size > MAX_HTML_BYTES) continue
      const html = await fsp.readFile(entry.path, 'utf8')
      if (/<nav\b/iu.test(html) || /<iframe\b/iu.test(html)) continue
      const relative = path.relative(outputRoot, entry.path)
      let hierarchy = path.dirname(relative).split(path.sep).filter((segment) => segment && segment !== '.')
      if (rendered.notebookRoot && hierarchy.length) hierarchy = hierarchy.slice(1)
      const title = decodeHtmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? path.basename(entry.path, '.html')).replace(/<[^>]+>/gu, '').trim() || 'OneNote-Seite'
      const pageId = /<meta\s+name="X-Original-Page-Id"\s+content="([^"]*)"/iu.exec(html)?.[1] ?? null
      const sectionPath = hierarchy.map((segment) => safeSegment(segment))
      pages.push({
        id: sha1Short(relative),
        file: entry.path,
        title: safeSegment(title, 'OneNote-Seite'),
        sectionPath,
        parents: parentMap.get(entry.path) ?? [],
        pageKey: pageKeyOf(notebookName, sectionPath, pageId, title),
        hasInk: /class="ink-text"|<(?:path|polyline|line)\b[^>]*\bstroke="(?!none)/iu.test(html),
        imageCount: (html.match(/<img\b/giu) ?? []).length,
      })
    }
    if (!pages.length) throw new Error('Im OneNote-Export wurden keine lesbaren Seiten gefunden. Verwende einen aktuellen OneDrive-Export oder eine moderne .one-Datei.')
    return {
      id: crypto.randomUUID(),
      root: temporaryRoot,
      outputRoot,
      sourceName: path.basename(inputPath),
      notebookName,
      warnings: rendered.warnings,
      pages,
    }
  } catch (error) {
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function disposeSession(session) {
  if (session?.root) await fsp.rm(session.root, { recursive: true, force: true }).catch(() => {})
}

/** What the picker shows: sections (with their folder path) and their pages. No file paths leave the main process. */
function describeSession(session, index = { pages: {} }) {
  const sections = new Map()
  // The picker shows the name the note will get: pages with the same title in one section are
  // written as "Title", "Title 2", ... (see writeNoteFiles), so list them the same way.
  const titleUses = new Map()
  for (const page of session.pages) {
    const key = page.sectionPath.join('\u0000')
    if (!sections.has(key)) sections.set(key, { path: page.sectionPath, name: page.sectionPath.join(' / ') || session.notebookName, pages: [] })
    sections.get(key).pages.push({
      id: page.id,
      title: (() => {
        const useKey = `${key}\u0001${page.title.toLocaleLowerCase('en-US')}`
        const uses = (titleUses.get(useKey) ?? 0) + 1
        titleUses.set(useKey, uses)
        return uses === 1 ? page.title : `${page.title} ${uses}`
      })(),
      depth: Math.min(4, page.parents.length),
      hasInk: page.hasInk,
      imageCount: page.imageCount,
      alreadyImported: Boolean(index.pages[page.pageKey]),
    })
  }
  return {
    sessionId: session.id,
    notebookName: session.notebookName,
    sourceName: session.sourceName,
    pageCount: session.pages.length,
    inkPageCount: session.pages.filter((page) => page.hasInk).length,
    warnings: session.warnings,
    sections: [...sections.values()],
  }
}

/** Pixel size of a PNG, JPEG, GIF or WebP, or null. */
function imageSize(data, extension) {
  try {
    if (extension === '.png') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    if (extension === '.gif') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
    if (extension === '.webp') {
      const kind = data.subarray(12, 16).toString('ascii')
      if (kind === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) }
      if (kind === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
      if (kind === 'VP8L') { const bits = data.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 } }
      return null
    }
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue }
      const marker = data[offset + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) }
      offset += 2 + data.readUInt16BE(offset + 2)
    }
  } catch { /* unreadable header */ }
  return null
}

/** Stores one embedded image in the vault's asset folder (named by content hash, so a re-import reuses it). */
async function storeImage(source, pagePath, outputRoot, vaultRoot, cache, infoByRef) {
  if (/^(?:https?:|file:|javascript:|data:)/iu.test(source)) return null
  let decoded
  try { decoded = decodeURIComponent(source) } catch { decoded = source }
  const imagePath = path.resolve(path.dirname(pagePath), decoded)
  if (!isInside(outputRoot, imagePath)) return null
  const extension = path.extname(imagePath).toLocaleLowerCase('en-US')
  const format = IMAGE_FORMATS.get(extension)
  if (!format) return null
  if (cache.has(imagePath)) return cache.get(imagePath)
  let result = null
  try {
    const info = await fsp.lstat(imagePath)
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_IMAGE_BYTES) throw new Error('image limit')
    const data = await fsp.readFile(imagePath)
    if (!format.signature(data)) throw new Error('image signature')
    const name = `${hashBuffer(data).slice(0, 24)}${extension === '.jpeg' ? '.jpg' : extension}`
    const directory = path.join(vaultRoot, ...IMAGE_DIRECTORY.split('/'))
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
    const target = path.join(directory, name)
    if (!fs.existsSync(target)) await atomicWrite(target, data)
    result = `${IMAGE_DIRECTORY}/${name}`
    const size = imageSize(data, extension)
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : null
    const dataUrl = mime ? `data:${mime};base64,${data.toString('base64')}` : null
    infoByRef.set(result, { width: size?.width || 300, height: size?.height || 200, dataUrl: dataUrl && dataUrl.length <= 1_500_000 ? dataUrl : null })
  } catch {
    result = null
  }
  cache.set(imagePath, result)
  return result
}

/** Creates `<stem>.md` (and `<stem>.famd` for ink) without replacing anything; returns the paths written. */
async function writeNoteFiles(directory, title, markdown, famdText, modifiedAt) {
  const stem = safeSegment(title, 'OneNote-Seite')
  const open = (target) => fsp.open(
    target,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  )
  for (let index = 0; index < 10_000; index += 1) {
    const name = index === 0 ? stem : `${stem} ${index + 1}`
    const mdPath = path.join(directory, `${name}.md`)
    const famdPath = path.join(directory, `${name}.famd`)
    if (!famdText && fs.existsSync(famdPath)) continue
    let famdHandle = null
    let mdHandle = null
    try {
      if (famdText) {
        famdHandle = await open(famdPath)
      }
      mdHandle = await open(mdPath)
      if (famdHandle) { await famdHandle.writeFile(famdText); await famdHandle.sync() }
      await mdHandle.writeFile(markdown)
      await mdHandle.sync()
      await famdHandle?.close()
      await mdHandle.close()
      if (modifiedAt) {
        const when = new Date(modifiedAt)
        for (const written of famdText ? [mdPath, famdPath] : [mdPath]) await fsp.utimes(written, when, when).catch(() => {})
      }
      return { mdPath, famdPath: famdText ? famdPath : null, name }
    } catch (error) {
      await famdHandle?.close().catch(() => {})
      await mdHandle?.close().catch(() => {})
      if (error?.code === 'EEXIST') {
        // Only a file this attempt created may be removed: the EEXIST one belongs to the user.
        if (famdHandle && !mdHandle) await fsp.rm(famdPath, { force: true }).catch(() => {})
        continue
      }
      await fsp.rm(mdPath, { force: true }).catch(() => {})
      if (famdHandle) await fsp.rm(famdPath, { force: true }).catch(() => {})
      throw error
    }
  }
  throw new Error('Für die OneNote-Seite konnte kein freier Dateiname erzeugt werden.')
}

/**
 * Imports the chosen pages. `destination` is { physical, logical }: the resolved target folder and its
 * vault-relative path. Every page becomes `<section>/<title>.md` (plus `.famd` when it has ink); one
 * failing page never stops the others. Pages imported earlier are skipped.
 */
async function importOneNotePages({ session, pageIds, destination, vaultRoot, sectionFolders = true, onProgress, signal }) {
  const { convertOneNotePage, buildInkDocument } = require('./onenote-convert.cjs')
  const rootInfo = await fsp.lstat(vaultRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Der aktive Vault ist kein sicherer Ordner.')
  const wanted = new Set(pageIds)
  const selected = session.pages.filter((page) => wanted.has(page.id))
  const index = await readImportIndex(vaultRoot)
  const result = { imported: [], skipped: [], failed: [], cancelled: false, inkPages: 0, layoutPages: 0, imageCount: 0, strokeCount: 0, warnings: [] }
  const imageCache = new Map()
  const imageInfo = new Map()
  const report = (done, title, status) => onProgress?.({ done, total: selected.length, title, status })
  let done = 0
  for (const page of selected) {
    if (signal?.aborted) { result.cancelled = true; break }
    report(done, page.title, 'working')
    try {
      const existing = index.pages[page.pageKey]
      const present = existing ? importedNoteIn(existing, destination, vaultRoot) : null
      if (present) {
        result.skipped.push({ id: page.id, title: page.title, path: present, reason: 'already-imported' })
        done += 1
        continue
      }
      const info = await fsp.lstat(page.file)
      if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_HTML_BYTES) throw new Error('Die Seite ist leer oder zu groß.')
      const html = await fsp.readFile(page.file, 'utf8')
      const stored = new Map()
      for (const match of html.matchAll(/<img\b[^>]*\bsrc=(['"])([^'"]+)\1/giu)) {
        const reference = await storeImage(decodeHtmlEntities(match[2]), page.file, session.outputRoot, vaultRoot, imageCache, imageInfo)
        stored.set(match[2], reference)
        stored.set(decodeHtmlEntities(match[2]), reference)
      }
      const converted = convertOneNotePage(html, {
        fallbackTitle: page.title,
        resolveImage: (source) => stored.get(source) ?? null,
        imageInfo: (reference) => imageInfo.get(reference) ?? null,
      })
      const folderSegments = sectionFolders ? page.sectionPath : []
      const directory = path.join(destination.physical, ...folderSegments)
      if (!isInside(destination.physical, directory)) throw new Error('Ein OneNote-Abschnittsname ist ungültig.')
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
      let markdown = converted.markdown
      let famdText = null
      let inkDocument = null
      if (converted.strokes.length) {
        // Free-form page: text blocks and images keep their OneNote positions in the same
        // coordinate space as the ink, so strokes stay on the text they were written on.
        const layout = converted.layout
        inkDocument = buildInkDocument(converted.strokes, { title: converted.title, createdAt: converted.createdAt ?? undefined, extent: { x: layout.extentX + 48, y: layout.extentY } })
        const width = inkDocument.sourceWidth
        const height = inkDocument.sourceHeight
        const unit = (value) => Math.max(0, Math.min(1, Math.round(value * 1e6) / 1e6))
        const stamp = Date.now()
        const textFields = layout.fields.map((field, number) => ({
          id: `on-t${number + 1}`,
          page: 1,
          x: unit(field.x / width),
          y: unit(field.y / height),
          width: Math.max(0.12, Math.min(0.92, Math.round((field.width / width) * 1e4) / 1e4)),
          fontSize: field.fontSize,
          text: field.text,
          ...(field.bold ? { bold: true } : {}),
          updatedAt: stamp,
        }))
        const annotations = []
        const flowImages = [...layout.flowImages]
        let budget = 6_000_000
        for (const image of layout.images) {
          const info = imageInfo.get(image.ref)
          if (!info?.dataUrl || annotations.length >= 12 || info.dataUrl.length > budget) { flowImages.push(`![${image.alt}](${image.ref})`); continue }
          budget -= info.dataUrl.length
          annotations.push({ kind: 'image', id: `on-i${annotations.length + 1}`, page: 1, x: unit(image.x / width), y: unit(image.y / height), w: Math.max(0.05, Math.min(1, image.width / width)), aspect: image.width / image.height, opacity: 1, locked: true, src: info.dataUrl, title: image.alt.slice(0, 80) })
        }
        if (layout.fields.length >= 190) result.warnings.push(`„${page.title}“: Textblöcke über dem Limit stehen nur in der Suche.`)
        inkDocument.searchTranscript = layout.fields.map((field) => field.text).join('\n').slice(0, 20000)
        markdown = `# ${converted.markdown.split('\n', 1)[0].replace(/^#\s+/u, '')}\n${flowImages.length ? `\n${flowImages.join('\n\n')}\n` : ''}`
        const { serializeFamd } = require('./famd.cjs')
        const { packV2Ink } = require('./famdV2.mjs')
        const updatedAt = new Date().toISOString()
        famdText = serializeFamd(markdown, { updatedAt, ink: packV2Ink(inkDocument), worksheets: [], textFields, annotations }, 'v2')
        result.layoutPages += 1
      }
      const written = await writeNoteFiles(directory, page.title, markdown, famdText, converted.updatedAt ?? converted.createdAt)
      const logical = [destination.logical, ...folderSegments, `${written.name}.md`].filter(Boolean).join('/')
      index.pages[page.pageKey] = { path: logical, paths: [...new Set([logical, ...(existing?.paths ?? [])])].slice(0, 20), importedAt: new Date().toISOString() }
      result.imported.push({ id: page.id, title: page.title, path: logical, ink: Boolean(inkDocument), strokes: converted.strokes.length })
      result.imageCount += converted.stats.images
      result.strokeCount += converted.strokes.length
      if (inkDocument) result.inkPages += 1
      if (converted.stats.missingImages) result.warnings.push(`„${page.title}“: ${converted.stats.missingImages} Bild(er) konnten nicht übernommen werden.`)
      if (converted.strokesDropped) result.warnings.push(`„${page.title}“: ${converted.strokesDropped} Handschrift-Striche über dem Limit wurden ausgelassen.`)
    } catch (error) {
      result.failed.push({ id: page.id, title: page.title, error: error instanceof Error ? error.message : 'Unbekannter Fehler.' })
    }
    done += 1
    report(done, page.title, 'done')
  }
  if (result.imported.length) await writeImportIndex(vaultRoot, index)
  report(done, '', 'finished')
  return result
}

module.exports = {
  decodeHtmlEntities,
  sanitizeOneNoteHtml,
  describeSession,
  disposeSession,
  importOneNotePages,
  materializeOneNoteTools,
  readImportIndex,
  safeSegment,
  scanOneNote,
  TOOL_MANIFEST,
  writeNoteFiles,
}
