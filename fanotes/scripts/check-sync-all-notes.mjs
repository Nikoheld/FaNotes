// Sync uploads every note: a synthetic vault on a real directory (through the
// desktop sync host, electron/sync.cjs) is synced to the real server module and
// pulled by a second device. Every file that should reach the server must be there,
// and every file that cannot (too large, unreadable, server refused) must be
// reported by the engine instead of vanishing silently.
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

globalThis.window = Object.assign(Object.create(null), {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  fanotes: { platform: 'test' },
  location: { origin: 'http://127.0.0.1' },
})
const nodeFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  if (!headers.has('accept-language')) headers.set('Accept-Language', 'de-CH,de;q=0.9')
  return nodeFetch(input, { ...init, headers })
}

const scratch = mkdtempSync(join(tmpdir(), 'fanotes-sync-notes-'))
process.env.FANOTES_SYNC_DIR = join(scratch, 'server')
process.env.FANOTES_MCP_DIR = join(scratch, 'server', 'mcp')
const PORT = 18_900 + Math.floor(Math.random() * 300)
const ORIGIN = `http://127.0.0.1:${PORT}`
process.env.FANOTES_PUBLIC_ORIGIN = ORIGIN
const { handleSyncRequest } = await import('../../fanotes-site/sync-api.mjs')
const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (await handleSyncRequest(request, response, url)) return
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => httpServer.listen(PORT, '127.0.0.1', resolve))
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const { SyncApi } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
const { SyncEngine } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
const { createSyncHost } = require('../electron/sync.cjs')

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const vaultDir = join(scratch, 'vault')
const userData = join(scratch, 'userData')
const linkedDir = join(scratch, 'external-linked')
mkdirSync(vaultDir, { recursive: true })
const safeStorage = { isEncryptionAvailable: () => false }
const folderMap = {}
const makeHost = (root = vaultDir, data = userData) => createSyncHost({ vaultRoot: async () => root, userDataDirectory: data, safeStorage, folderLocations: () => ({ ...folderMap }) })

const famd = (text) => `${text}\n`
const put = (relative, content = `note ${relative}`, root = vaultDir) => {
  const target = join(root, ...relative.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

// ── The matrix ────────────────────────────────────────────────────────────
const longName = `${'Lange Notiz '.repeat(15)}ende.md`
const nfd = 'Café Résumé'
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 7), Buffer.from('\n%%EOF\n')])
/** Paths that must reach the server with the default ("notes + attachments") scope. */
const expectedNotes = [
  'Start.md', 'Aufgabe.famd', 'Aufgabe.md',
  'a/b/c/d/e/tief.md', 'a/b/c/d/e/tief.famd', 'a/b/c/d/e/f/g/sehr tief.md',
  'Ordner mit Leerzeichen/Notiz eins.md', 'Ordner mit Leerzeichen/Unterordner  doppelt/zwei  Leerzeichen.md',
  'Übungen/Größe äöü ß.md', 'Übungen/Straße.famd',
  `${nfd}/${nfd}.md`,
  'Ideen 💡/🚀 Start 👩‍🔬.md', 'Ideen 💡/🚀 Start 👩‍🔬.famd',
  `Lang/${longName}`, `Lang/${'ü'.repeat(110)}.md`,
  'Docs/Skript.famd', '.fanotes/pdf-side/Docs/Skript.pdf.famd', '.fanotes/pdf-side/a/b/Lehrbuch.pdf.famd',
  'Upper/GROSS.MD', 'Upper/Mixed.FaMd', 'Docs/Rohdaten.markdown',
  'Verknüpft/extern.md', 'Verknüpft/sub/extern tief.famd',
  '.fanotes/assets/abc123.json',
]
const expectedAttachments = ['Docs/Skript.pdf', 'Docs/Bild.png', 'Docs/Ordner mit Ü/Scan.pdf', 'a/b/c/d/Anhang.jpg', 'Verknüpft/extern.pdf', 'Docs/Gross.bin']
const intendedLocal = ['.versteckt/geheim.md', '.fanotes/history/x/1.md', '.fanotes/trash/alt.md', 'Ordner/.Notiz.md', 'Ordner/Entwurf.tmp', '.fanotes/onboarding.json']

const buildVault = () => {
  for (const path of expectedNotes) {
    if (path.startsWith('Verknüpft/')) put(path.slice('Verknüpft/'.length), `# ${path}`, linkedDir)
    else put(path, path.endsWith('.json') ? '{"a":1}' : `# ${path}\n\nInhalt ${path}\n`)
  }
  for (const path of expectedAttachments) {
    if (path.startsWith('Verknüpft/')) put(path.slice('Verknüpft/'.length), pdfBytes, linkedDir)
    else put(path, pdfBytes)
  }
  for (const path of intendedLocal) put(path)
  mkdirSync(join(vaultDir, 'Verknüpft'), { recursive: true })
  folderMap['Verknüpft'] = [linkedDir]
}

// ── Engines ───────────────────────────────────────────────────────────────
const attach = (host, name, extra = {}) => {
  const engine = new SyncEngine(new SyncApi(ORIGIN))
  engine.attach(host, { platform: 'linux', deviceName: () => name, automatic: () => false, ...extra })
  return engine
}

/** Device B: an in-memory vault that only pulls. */
const memoryHost = () => {
  const files = new Map()
  const store = { state: new Map(), secrets: null }
  return {
    files, store,
    async vaultId() { return 'memoryvault00000000000000000000' },
    async scan() { return [...files.entries()].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtimeMs: file.mtimeMs })) },
    async read(path) { if (!files.has(path)) throw new Error('missing'); return files.get(path).bytes },
    async write(path, bytes, mtimeMs) { files.set(path, { bytes: new Uint8Array(bytes), mtimeMs: mtimeMs || Date.now() }); return { path, size: bytes.byteLength, mtimeMs: mtimeMs || 1 } },
    async remove(path) { files.delete(path) },
    async readState(id) { return store.state.get(id) ?? null },
    async writeState(id, json) { if (json === null) store.state.delete(id); else store.state.set(id, json) },
    async readSecrets() { return store.secrets },
    async writeSecrets(json) { store.secrets = json },
  }
}

const password = 'korrektes pferd batterie'
let reader = null
const freshReader = async () => {
  const host = memoryHost()
  const engine = attach(host, 'Leser')
  await engine.start()
  await engine.login('notes@example.com', password)
  await engine.syncNow('manual')
  engine.dispose()
  return host
}
const serverHas = async (paths) => {
  const host = await freshReader()
  return { present: new Set(host.files.keys()), host }
}
const missing = (present, expected) => expected.filter((path) => !present.has(path))

const problems = []
const expectNone = (label, list) => {
  if (list.length) problems.push(`${label}: ${JSON.stringify(list)}`)
  else console.log(`ok   ${label}`)
}
const expectTrue = (label, value) => {
  if (!value) problems.push(label)
  else console.log(`ok   ${label}`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  buildVault()
  // A second copy of the first-sync vault for the notes-only scope, taken before anything else changes.
  const notesOnlyVault = join(scratch, 'vault-notes-only')
  cpSync(vaultDir, notesOnlyVault, { recursive: true })

  // 1. First sync of a vault that existed before sync was switched on.
  const hostA = makeHost()
  let A = attach(hostA, 'Laptop')
  await A.start()
  await A.register('notes@example.com', password)
  await A.syncNow('manual')
  let { present } = await serverHas()
  expectNone('first sync uploads every note and attachment (nested, spaces, umlauts, NFD, emoji, long names, .famd, side pages, linked folders)', missing(present, [...expectedNotes, ...expectedAttachments]))
  expectNone('local-only files (dot folders, history, trash, .tmp) stay local', intendedLocal.filter((path) => present.has(path)))
  expectTrue('no failures reported after a clean first sync', A.getState().failed.length === 0)
  A.dispose()

  // 2. The app was closed: new files, new nested folders, an empty note, external edits, renames and moves.
  const closed = ['Neu nach Start.md', 'Neuer Ordner/Tief/Tiefer/Tiefst/neu.md', 'Neuer Ordner/Tief/neu.famd', '.fanotes/pdf-side/Neu/Buch.pdf.famd', 'Neu 🧪/Ünï.md', 'Verknüpft/nachträglich.md']
  for (const path of closed) put(path.startsWith('Verknüpft/') ? path.slice(10) : path, `# ${path}`, path.startsWith('Verknüpft/') ? linkedDir : vaultDir)
  put('Leer.md', '')
  put('Start.md', '# Start extern geändert, länger\n')
  renameSync(join(vaultDir, 'Ordner mit Leerzeichen'), join(vaultDir, 'Umbenannt'))
  renameSync(join(vaultDir, 'a/b/c'), join(vaultDir, 'a/b/c2'))
  A = attach(hostA, 'Laptop')
  await A.start()
  await A.syncNow('manual')
  ;({ present } = await serverHas())
  expectNone('files created while the app was closed upload', missing(present, [...closed, 'Leer.md']))
  expectNone('renamed and moved folders upload under the new path', missing(present, ['Umbenannt/Notiz eins.md', 'a/b/c2/d/e/tief.md']))

  // 3. An external tool edits a note and restores its modification time.
  const startFile = join(vaultDir, 'Start.md')
  const original = readFileSync(startFile, 'utf8')
  const stat = statSync(startFile)
  writeFileSync(startFile, original.replace('extern', 'EXTERN'))
  utimesSync(startFile, stat.atime, stat.mtime)
  await A.syncNow('manual')
  const afterTouch = await serverHas()
  expectTrue('an edit that keeps size and modification time still uploads', decoder.decode(afterTouch.host.files.get('Start.md').bytes).includes('EXTERN'))

  // 4. Files that cannot upload are reported and never keep the other files back.
  const sparse = join(vaultDir, 'Docs', 'Riesig.pdf')
  writeFileSync(sparse, '')
  truncateSync(sparse, 101 * 1024 * 1024)
  put('Aaa Kaputt.md', 'k'.repeat(7777))
  const later = [0, 1, 2, 3, 4, 5].map((i) => `Zzz Danach ${i}.md`)
  for (const [index, path] of later.entries()) put(path, `danach ${index}`)
  const unreadable = process.getuid?.() === 0 ? null : 'Aab Gesperrt.md'
  if (unreadable) { put(unreadable, 'gesperrt'); chmodSync(join(vaultDir, unreadable), 0o000) }
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init = {}) => {
    if (init.method === 'PUT' && Number(new Headers(init.headers).get('content-length')) === 7777 + 28) return Promise.resolve(new Response(JSON.stringify({ error: 'Der Server lehnt diese Datei ab.' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    return realFetch(input, init)
  }
  await A.syncNow('manual')
  ;({ present } = await serverHas())
  expectNone('a refused file does not starve the files after it', missing(present, later))
  const failed = new Map(A.getState().failed.map((item) => [item.path, item.reason]))
  expectTrue('the refused file is listed with the server reason', /lehnt diese Datei ab/u.test(failed.get('Aaa Kaputt.md') ?? ''))
  expectTrue('a file above 100 MB is listed with the limit', /100 MB/u.test(failed.get('Docs/Riesig.pdf') ?? ''))
  if (unreadable) expectTrue('an unreadable file is listed', failed.has(unreadable))
  expectTrue('the failure count is exposed for the status line', A.getState().failed.length >= 2)
  globalThis.fetch = realFetch
  await A.retryFailed()
  expectTrue('retry uploads the previously refused file once the server accepts it', (await serverHas()).present.has('Aaa Kaputt.md'))
  expectTrue('failures that are fixed leave the list', !A.getState().failed.some((item) => item.path === 'Aaa Kaputt.md'))
  if (unreadable) chmodSync(join(vaultDir, unreadable), 0o644)
  A.dispose()

  // 5. Reconciliation: the local manifest claims a file the server does not have (restored server, lost upload).
  const phantomContent = '# Phantom\n'
  put('Phantom.md', phantomContent)
  const phantomStat = statSync(join(vaultDir, 'Phantom.md'))
  const stateHost = makeHost()
  const vaultId = await stateHost.vaultId()
  const state = JSON.parse(await stateHost.readState(vaultId))
  const phantomSha = await (async () => { const bytes = encoder.encode(phantomContent); const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') })()
  state.files['Phantom.md'] = { id: 'f'.repeat(64), revision: 5, sha256: phantomSha, size: phantomStat.size, mtimeMs: Math.round(phantomStat.mtimeMs) }
  await stateHost.writeState(vaultId, JSON.stringify(state))
  A = attach(makeHost(), 'Laptop')
  await A.start()
  await A.syncNow('manual')
  expectTrue('reconciliation on start uploads a file the server lacks although the manifest says it is synced', (await serverHas()).present.has('Phantom.md'))
  A.dispose()

  // 6. Notes-only scope: all note files, PDFs and side pages upload; attachments do not.
  const notesHost = makeHost(notesOnlyVault, join(scratch, 'userData-notes'))
  const N = attach(notesHost, 'Notizen', { includeAttachments: () => false })
  await N.start()
  await N.register('notes-only@example.com', password)
  await N.syncNow('manual')
  const notesReader = memoryHost()
  const R = attach(notesReader, 'Leser 2')
  await R.start()
  await R.login('notes-only@example.com', password)
  await R.syncNow('manual')
  const notesPresent = new Set(notesReader.files.keys())
  expectNone('notes-only scope uploads every note file, companion and side page', missing(notesPresent, expectedNotes))
  expectNone('notes-only scope keeps images and other attachments on the device', expectedAttachments.filter((path) => notesPresent.has(path) && !/\.pdf$/iu.test(path)))
  expectTrue('notes-only scope still uploads PDF notes', notesPresent.has('Docs/Skript.pdf'))
  N.dispose(); R.dispose()

  // 7. Reconnect: the first cycle after an offline period compares the manifests again.
  A = attach(makeHost(), 'Laptop')
  await A.start()
  await A.syncNow('manual')
  put('Nach Ausfall.md', '# offline entstanden')
  globalThis.fetch = () => Promise.reject(new TypeError('offline'))
  await A.syncNow('manual')
  expectTrue('an offline cycle reports offline', A.getState().status === 'offline')
  globalThis.fetch = realFetch
  await A.syncNow('manual')
  expectTrue('the note written while offline uploads after the connection is back', (await serverHas()).present.has('Nach Ausfall.md'))
  A.dispose()
} catch (error) {
  problems.push(`crashed: ${error?.stack ?? error}`)
} finally {
  await vite.close()
  httpServer.close()
  rmSync(scratch, { recursive: true, force: true })
  if (problems.length) {
    console.error(`\ncheck-sync-all-notes FAILED (${problems.length})`)
    for (const problem of problems) console.error(` - ${problem}`)
    process.exit(1)
  }
  console.log('\ncheck-sync-all-notes ok')
  process.exit(0)
}
