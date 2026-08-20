'use strict'

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const path = require('node:path')

const HISTORY_LIMIT = 30
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

const historyFolderName = (relativePath) => crypto
  .createHash('sha1')
  .update(relativePath.replace(/\\/gu, '/'))
  .digest('hex')

const historyRoot = (vaultRoot) => path.join(vaultRoot, '.fanotes', 'history')

const snapshotDir = (vaultRoot, relativePath) => path.join(historyRoot(vaultRoot), historyFolderName(relativePath))

const indexPath = (directory) => path.join(directory, 'index.json')

const readIndex = async (directory) => {
  try {
    const raw = await fsp.readFile(indexPath(directory), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.format !== 'fanotes-history-v1' || !Array.isArray(parsed.snapshots)) return { format: 'fanotes-history-v1', snapshots: [] }
    return parsed
  } catch {
    return { format: 'fanotes-history-v1', snapshots: [] }
  }
}

const writeIndex = async (directory, index) => {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.index-${process.pid}.tmp`)
  await fsp.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temporary, indexPath(directory))
}

const recordNoteHistorySnapshot = async (vaultRoot, relativePath, content) => {
  if (typeof content !== 'string' || !content.trim()) return
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes <= 0 || bytes > MAX_SNAPSHOT_BYTES) return
  const directory = snapshotDir(vaultRoot, relativePath)
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const index = await readIndex(directory)
  const last = index.snapshots.at(-1)
  if (last) {
    try {
      const previous = await fsp.readFile(path.join(directory, `${last.id}.md`), 'utf8')
      if (previous === content) return
    } catch {
      // continue
    }
  }
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/gu, '-')}-${crypto.randomBytes(3).toString('hex')}`
  await fsp.writeFile(path.join(directory, `${id}.md`), content, { encoding: 'utf8', mode: 0o600 })
  index.path = relativePath
  index.snapshots.push({ id, createdAt, bytes })
  while (index.snapshots.length > HISTORY_LIMIT) {
    const removed = index.snapshots.shift()
    if (removed) await fsp.rm(path.join(directory, `${removed.id}.md`), { force: true }).catch(() => {})
  }
  await writeIndex(directory, index)
}

const listNoteHistory = async (vaultRoot, relativePath) => {
  const directory = snapshotDir(vaultRoot, relativePath)
  const index = await readIndex(directory)
  return [...index.snapshots].reverse()
}

const readNoteHistory = async (vaultRoot, relativePath, snapshotId) => {
  if (!/^[A-Za-z0-9._-]+$/u.test(snapshotId)) throw new Error('Ungültiger Verlaufseintrag.')
  const directory = snapshotDir(vaultRoot, relativePath)
  const index = await readIndex(directory)
  const entry = index.snapshots.find((item) => item.id === snapshotId)
  if (!entry) throw new Error('Dieser Verlaufseintrag existiert nicht mehr.')
  const content = await fsp.readFile(path.join(directory, `${entry.id}.md`), 'utf8')
  return { id: entry.id, createdAt: entry.createdAt, content }
}

module.exports = {
  recordNoteHistorySnapshot,
  listNoteHistory,
  readNoteHistory,
}
