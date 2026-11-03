import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { emptyPersonalModel, learnPage, personalStyle, validModel, summarizeObservations, fitPopulation } from '../src/lib/personalHandwriting.mjs'
import { schoolScript } from '../src/lib/schoolScript.mjs'
const require = createRequire(import.meta.url)
const { parseFamd } = require('./famd.cjs')
const { root, cache, userData } = workerData
const folderLocations = require('./folder-locations.cjs')
const key = text => createHash('sha256').update(text).digest('hex')
let model = emptyPersonalModel(), busy = false, enabled = true, error = null, stopped = false
let templates = schoolScript, scanned = 0, pending = false, epoch = 0
const forced = new Map(); let changedTimer = null, changeSequence = 0
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await fs.open(`${file}.tmp`, 'w', 0o600)
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync() } finally { await handle.close() }
  await fs.rename(`${file}.tmp`, file)
}
async function read(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw Error('Invalid local learning file')
  return fs.readFile(file, 'utf8')
}
async function walk(directory, result = [], logical = '', map = {}, active = new Set()) {
  const locations = folderLocations.exactPaths(map, logical) || [directory]
  const seen = new Set()
  for (const location of locations) {
    const real = await fs.realpath(location)
    if (active.has(real)) continue
    const ancestors = new Set([...active, real])
    const entries = await fs.readdir(location, { withFileTypes: true })
    for (const entry of entries) {
      if (stopped) return result
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || seen.has(entry.name)) continue
      seen.add(entry.name)
      const file = path.join(location, entry.name), id = logical ? `${logical}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(file, result, id, map, ancestors)
      else if (entry.isFile() && /\.(famd|md|markdown)$/iu.test(entry.name)) result.push({ file, id })
    }
  }
  return result
}
let cachedStyle = null, cachedStyleRevision = -1, selectionKey = ''
function snapshot(includeModel = true) {
  if (cachedStyleRevision !== model.revision) { cachedStyle = personalStyle(model); cachedStyleRevision = model.revision }
  const style = cachedStyle
  // Bounded inference snapshot, independent from durable per-page contributions.
  const observations = style.observations.filter((_, i) => i % Math.max(1, Math.ceil(style.observations.length / 2048)) === 0)
  const byLabel = new Map()
  for (const u of style.units) { const list = byLabel.get(u.label) ?? []; if (list.length < 8) list.push(u); byLabel.set(u.label, list) }
  const units = [...byLabel.values()].flat().slice(0, 1500)
  const pages = {}
  for (let i = 0; i < Math.max(observations.length / 48, units.length / 96, 1); i++) pages[`snapshot-${i}`] = { fingerprint: `${model.revision}-${i}`, observations: observations.slice(i * 48, i * 48 + 48), units: units.slice(i * 96, i * 96 + 96), joins: style.joins.slice(i * 32, i * 32 + 32) }
  const compact = { version: 2, revision: model.revision, pages, population: model.population }
  return { vaultId: key(root), model: includeModel ? compact : null, unchanged: !includeModel, pageCount: new Set([...index.values()].filter(r => r.observations).map(r => r.fingerprint)).size, observationCount: style.observations.length, unitCount: style.units.length, busy, enabled, error, scanned }
}
let manifest = {}, index = new Map()
const metadata = (id, stamp, contribution) => ({ id, stamp, fingerprint: contribution.fingerprint, observations: contribution.observations.length, units: contribution.units.length, summary: summarizeObservations(contribution.observations) })
async function selectRepresentatives() {
  const seen = new Set()
  const selected = [...index.values()].filter(r => r.observations || r.units).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)).filter(r => {
    if (seen.has(r.fingerprint)) return false
    seen.add(r.fingerprint); return true
  }).slice(0, 48)
  const pages = {}
  for (const entry of selected) {
    if (model.pages[entry.id]?.fingerprint === entry.fingerprint) pages[entry.id] = model.pages[entry.id]
    else {
      try {
        const checkpoint = JSON.parse(await read(path.join(cache, `${key(entry.id)}.json`)))
        if (validModel({ version: 2, revision: 0, pages: { check: checkpoint.contribution } })) pages[entry.id] = checkpoint.contribution
      } catch {}
    }
  }
  const fit = fitPopulation([...index.values()], model.population)
  const nextKey = JSON.stringify([selected.map(p => [p.id, p.fingerprint]), fit.population])
  if (selectionKey !== nextKey) { model.revision++; selectionKey = nextKey }
  model = { ...model, pages, population: fit.population, validation: fit.validation }
}
async function scan() {
  if (!enabled || stopped) return
  if (busy) { pending = true; return }
  busy = true; error = null
  const ticket = epoch
  try {
    const locationMap = userData ? folderLocations.mapFor(folderLocations.loadStore(userData), root) : {}
    const discovered = await walk(root, [], '', locationMap)
    const companions = new Set(discovered.filter(f => /\.famd$/iu.test(f.id)).map(f => f.id.replace(/\.famd$/iu, '')))
    const files = discovered.filter(f => /\.famd$/iu.test(f.id) || !companions.has(f.id.replace(/\.(md|markdown)$/iu, '')))
    const live = new Set(files.map(f => f.id))
    for (const { file, id } of files) {
      if (stopped || !enabled || ticket !== epoch) return
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      let stamp = `${stat.mtimeMs}:${stat.size}`
      let doc
      if (!/\.famd$/iu.test(file)) {
        const source = await read(file)
        doc = parseFamd(source).payload?.ink
        if (!doc) {
          const inkId = /<!--\s*fanotes-ink:([a-zA-Z0-9_-]{1,96})\s*-->/u.exec(source)?.[1]
          if (inkId) {
            const asset = path.join(root, '.fanotes', 'assets', `${inkId}.json`)
            try {
              const info = await fs.lstat(asset)
              stamp += `:${info.mtimeMs}:${info.size}`
              if (manifest[id] !== stamp || forced.has(id)) doc = JSON.parse(await read(asset))
            } catch { continue }
          } else doc = { sourceWidth: 900, sourceHeight: 1273, strokes: [] }
        }
      }
      const forcedTicket = forced.get(id)
      if (manifest[id] === stamp && !forcedTicket) continue
      try {
        if (!doc) {
          const parsed = parseFamd(await read(file))
          doc = parsed.payload?.ink ?? (parsed.payload ? { sourceWidth: 900, sourceHeight: 1273, strokes: [] } : null)
        }
        // Invalid/unavailable pages retain their last good contribution and retry next pass.
        if (!doc || !Array.isArray(doc.strokes)) { error = 'Some pages could not be processed; they will be retried.'; continue }
        const contribution = learnPage(doc, templates)
        if (ticket !== epoch || !enabled) return
        const next = { version: 2, revision: 0, pages: { check: contribution } }
        if (!validModel(next)) throw Error('Invalid trajectory update')
        // Checkpoint one page at a time. Interrupted collections resume from this file.
        await atomic(path.join(cache, `${key(id)}.json`), { id, stamp, contribution })
        model = { ...model, revision: model.revision + 1, pages: id in model.pages || Object.keys(model.pages).length < 48 ? { ...model.pages, [id]: contribution } : model.pages }; manifest[id] = stamp; index.set(id, metadata(id, stamp, contribution)); scanned++
        if (scanned % 16 === 0) await selectRepresentatives()
        if (forced.get(id) === forcedTicket) forced.delete(id)
      } catch { error = 'Some pages could not be processed; they will be retried.' }
      // Yield between files; worker termination is the cancellation boundary.
      await new Promise(resolve => setImmediate(resolve))
    }
    for (const id of index.keys()) if (!live.has(id)) {
      delete model.pages[id]; delete manifest[id]; index.delete(id); model.population = null; model.revision++
      await fs.unlink(path.join(cache, `${key(id)}.json`)).catch(() => {})
    }
    await selectRepresentatives()
    await atomic(path.join(cache, 'aggregate.json'), { population: model.population })
    await atomic(path.join(cache, 'settings.json'), { enabled })
  } catch { error = 'The handwriting collection is temporarily unavailable.' }
  finally { busy = false; if (pending) { pending = false; setTimeout(scan, 2000) } }
}
parentPort.on('message', async ({ id, op, value }) => {
  try {
    if (op === 'enabled') { enabled = value === true; epoch++; await atomic(path.join(cache, 'settings.json'), { enabled }); if (enabled) void scan() }
    if (op === 'scan') void scan()
    if (op === 'changed' && typeof value === 'string') {
      forced.set(value.replace(/\.(md|markdown)$/iu, '.famd'), ++changeSequence)
      clearTimeout(changedTimer); changedTimer = setTimeout(scan, 12000)
    }
    if (op === 'templates' && Array.isArray(value) && value.length <= 4000) {
      await atomic(path.join(cache, 'templates.json'), value)
      templates = [...value.filter(s => s?.strokes?.length && typeof s.label === 'string'), ...schoolScript]
      // Reconsider unlabeled pages once explicit templates change, not every preview.
      manifest = {}; void scan()
    }
    parentPort.postMessage({ id, result: snapshot(!(op === 'snapshot' && value?.revision === model.revision && value?.vaultId === key(root))) })
  } catch { parentPort.postMessage({ id, error: 'Local handwriting learning failed.' }) }
})
try {
  await fs.mkdir(cache, { recursive: true, mode: 0o700 })
  try { const aggregate = JSON.parse(await read(path.join(cache, 'aggregate.json'))); if (validModel({ ...model, population: aggregate.population })) model.population = aggregate.population } catch {}
  try { enabled = JSON.parse(await read(path.join(cache, 'settings.json'))).enabled !== false } catch {}
  try { templates = [...JSON.parse(await read(path.join(cache, 'templates.json'))), ...schoolScript] } catch {}
  for (const file of await fs.readdir(cache)) if (/^[a-f0-9]{64}\.json$/u.test(file)) {
    try {
      const { id, stamp, contribution } = JSON.parse(await read(path.join(cache, file)))
      const candidate = { version: 2, revision: 0, pages: { check: contribution } }
      if (validModel(candidate)) { index.set(id, metadata(id, stamp, contribution)); model.revision++; manifest[id] = stamp }
    } catch { /* Recover all other page checkpoints; retry this page on next scan. */ }
  }
} catch {}
await selectRepresentatives()
void scan()
const timer = setInterval(scan, 120000)
parentPort.on('close', () => { stopped = true; clearInterval(timer) })
