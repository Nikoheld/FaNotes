'use strict'

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const path = require('node:path')
const {
  MAX_SNAPSHOT_BYTES,
  nextSnapshotTier,
  retainSnapshots,
  snapshotExtension,
} = require('./noteHistoryPolicy.mjs')

const historyFolderName = (relativePath) => crypto
  .createHash('sha1')
  .update(relativePath.replace(/\\/gu, '/'))
  .digest('hex')

const historyRoot = (vaultRoot) => path.join(vaultRoot, '.fanotes', 'history')

const snapshotDir = (vaultRoot, relativePath) => path.join(historyRoot(vaultRoot), historyFolderName(relativePath))

const indexPath = (directory) => path.join(directory, 'index.json')

const resolveNow = (now) => {
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'number' && Number.isFinite(now)) return now
  if (typeof now === 'string') {
    const parsed = Date.parse(now)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

const snapshotFileName = (entry) => `${entry.id}${entry.ext === '.famd' ? '.famd' : '.md'}`

const readIndex = async (directory) => {
  try {
    const raw = await fsp.readFile(indexPath(directory), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.format !== 'fanotes-history-v1' || !Array.isArray(parsed.snapshots)) return { format: 'fanotes-history-v1', snapshots: [] }
    return parsed
  } catch (error) {
    // A missing or unreadable index starts empty. An I/O error must not: the
    // next snapshot would replace the index and hide every earlier revision.
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return { format: 'fanotes-history-v1', snapshots: [] }
    }
    throw error
  }
}

const writeIndex = async (directory, index) => {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.index-${process.pid}.tmp`)
  await fsp.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temporary, indexPath(directory))
}

const deleteSnapshotFiles = async (directory, entry) => {
  await fsp.rm(path.join(directory, `${entry.id}.md`), { force: true }).catch(() => {})
  await fsp.rm(path.join(directory, `${entry.id}.famd`), { force: true }).catch(() => {})
}

const readSnapshotFile = async (directory, entry) => fsp.readFile(path.join(directory, snapshotFileName(entry)), 'utf8')

const indexesDiffer = (left, right) => JSON.stringify(left) !== JSON.stringify(right)

const applyRetention = async (directory, index, nowMs) => {
  const kept = retainSnapshots(index.snapshots, nowMs)
  const removed = index.snapshots.filter((snapshot) => !kept.some((item) => item.id === snapshot.id))
  return { kept, removed }
}

const commitIndex = async (directory, index, snapshots, removed) => {
  if (!indexesDiffer(index.snapshots, snapshots) && removed.length === 0) return
  const previous = index.snapshots
  index.snapshots = snapshots
  try {
    await writeIndex(directory, index)
  } catch (error) {
    index.snapshots = previous
    throw error
  }
  for (const entry of removed) await deleteSnapshotFiles(directory, entry)
}

const recordNoteHistorySnapshot = async (vaultRoot, relativePath, content, options = {}) => {
  const text = typeof content === 'string' ? content : ''
  const companion = typeof options.companion === 'string' && options.companion.trim() ? options.companion : ''
  const nowMs = resolveNow(options.now)
  const directory = snapshotDir(vaultRoot, relativePath)
  const exists = await fsp.stat(directory).then((info) => info.isDirectory()).catch(() => false)
  if (!text.trim() && !companion) {
    if (!exists) return
    const index = await readIndex(directory)
    const { kept, removed } = await applyRetention(directory, index, nowMs)
    await commitIndex(directory, index, kept, removed)
    return
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  const companionBytes = companion ? Buffer.byteLength(companion, 'utf8') : 0
  if (bytes > MAX_SNAPSHOT_BYTES) return
  if (!exists && bytes <= 0 && companionBytes === 0) return
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const index = await readIndex(directory)
  const { kept, removed } = await applyRetention(directory, index, nowMs)
  const ext = snapshotExtension(relativePath)
  const last = kept.at(-1)
  let changed = true
  if (last) {
    try {
      const previous = await readSnapshotFile(directory, last)
      const previousCompanion = last.companion && last.ext !== '.famd'
        ? await fsp.readFile(path.join(directory, `${last.id}.famd`), 'utf8')
        : ''
      changed = previous !== text || previousCompanion !== companion
    } catch {
      changed = true
    }
  }
  const tier = changed ? nextSnapshotTier(kept, nowMs) : null
  const canStoreCompanion = ext !== '.famd' && companion && companionBytes > 0 && companionBytes <= MAX_SNAPSHOT_BYTES
  if (!changed || !tier || (bytes <= 0 && !canStoreCompanion)) {
    index.path = index.path || relativePath
    await commitIndex(directory, index, kept, removed)
    return
  }
  const createdAt = new Date(nowMs).toISOString()
  const id = `${createdAt.replace(/[:.]/gu, '-')}-${crypto.randomBytes(3).toString('hex')}`
  const entry = {
    id,
    createdAt,
    bytes,
    tier,
    ext,
    ...(canStoreCompanion ? { companion: true } : {}),
  }
  const primaryPath = path.join(directory, snapshotFileName(entry))
  const companionPath = canStoreCompanion ? path.join(directory, `${id}.famd`) : ''
  await fsp.writeFile(primaryPath, text, { encoding: 'utf8', mode: 0o600 })
  if (companionPath) {
    try {
      await fsp.writeFile(companionPath, companion, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      await fsp.rm(primaryPath, { force: true }).catch(() => {})
      throw error
    }
  }
  const next = [...kept, entry]
  index.path = relativePath
  try {
    await commitIndex(directory, index, next, removed)
  } catch (error) {
    await fsp.rm(primaryPath, { force: true }).catch(() => {})
    if (companionPath) await fsp.rm(companionPath, { force: true }).catch(() => {})
    throw error
  }
}

const listNoteHistory = async (vaultRoot, relativePath, now = Date.now()) => {
  const directory = snapshotDir(vaultRoot, relativePath)
  const index = await readIndex(directory)
  const nowMs = resolveNow(now)
  const { kept, removed } = await applyRetention(directory, index, nowMs)
  if (removed.length > 0 || indexesDiffer(index.snapshots, kept)) {
    await commitIndex(directory, index, kept, removed)
  }
  return [...kept].reverse().map(({ id, createdAt, bytes }) => ({ id, createdAt, bytes }))
}

const readNoteHistory = async (vaultRoot, relativePath, snapshotId) => {
  if (!/^[A-Za-z0-9._-]+$/u.test(snapshotId)) throw new Error('Ungültiger Verlaufseintrag.')
  const directory = snapshotDir(vaultRoot, relativePath)
  const index = await readIndex(directory)
  const entry = index.snapshots.find((item) => item.id === snapshotId)
  if (!entry) throw new Error('Dieser Verlaufseintrag existiert nicht mehr.')
  let content
  try {
    content = await readSnapshotFile(directory, entry)
  } catch (error) {
    if (error?.code === 'ENOENT' && entry.ext !== '.famd') {
      content = await fsp.readFile(path.join(directory, `${entry.id}.md`), 'utf8')
    } else {
      throw error
    }
  }
  const result = { id: entry.id, createdAt: entry.createdAt, content }
  if (entry.companion && entry.ext !== '.famd') {
    result.companion = await fsp.readFile(path.join(directory, `${entry.id}.famd`), 'utf8')
  }
  return result
}

const pruneHistoryDirectory = async (directory, nowMs = Date.now()) => {
  const index = await readIndex(directory)
  const { kept, removed } = await applyRetention(directory, index, nowMs)
  if (removed.length === 0 && !indexesDiffer(index.snapshots, kept)) return
  await commitIndex(directory, index, kept, removed)
}

const pruneVaultHistory = async (vaultRoot, now = Date.now()) => {
  const root = historyRoot(vaultRoot)
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const nowMs = resolveNow(now)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await pruneHistoryDirectory(path.join(root, entry.name), nowMs)
    } catch (error) {
      console.warn('FaNotes: Verlauf konnte nicht aufgeräumt werden:', error?.message ?? error)
    }
  }
}

module.exports = {
  recordNoteHistorySnapshot,
  listNoteHistory,
  readNoteHistory,
  pruneVaultHistory,
}
