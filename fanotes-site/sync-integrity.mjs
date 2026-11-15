// Read-only integrity report for one sync account. This module never deletes
// or rewrites a file. Hashes are of ciphertext, and the report has no metadata,
// names, or note bytes.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

const FILE_ID_PATTERN = /^[a-f0-9]{64}$/u
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u
const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/u

const contained = (root, target) => target === root || target.startsWith(`${root}${sep}`)

const joinInside = (root, ...parts) => {
  const target = resolve(root, ...parts)
  if (!contained(root, target)) throw new Error('path escapes the account directory')
  return target
}

export const hashFile = async (path) => {
  const handle = await fs.open(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(64 * 1024)
  try {
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

const listDir = async (path) => {
  try {
    return await fs.readdir(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

const regularFile = async (path) => {
  const info = await fs.lstat(path).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  if (!info?.isFile()) return null
  return info
}

const loadEntries = async (accountDirectory) => {
  const entries = new Map()
  let snapshot = { revision: 0, entries: {} }
  try {
    snapshot = JSON.parse(await fs.readFile(joinInside(accountDirectory, 'index.json'), 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let revision = Number(snapshot?.revision) || 0
  for (const [id, entry] of Object.entries(snapshot?.entries ?? {})) {
    if (FILE_ID_PATTERN.test(id) && entry) entries.set(id, entry)
  }
  let log = ''
  try {
    log = await fs.readFile(joinInside(accountDirectory, 'changes.jsonl'), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || !FILE_ID_PATTERN.test(entry.id) || !(Number(entry.revision) > revision)) continue
    entries.set(entry.id, entry)
    revision = Number(entry.revision)
  }
  return entries
}

/** A JSON report. The caller passes the account directory's parent root (`FANOTES_SYNC_DIR`). */
export const inspectSyncAccount = async (syncRoot, accountId) => {
  if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) throw new Error('The account id is not valid.')
  const root = resolve(syncRoot)
  const accountDirectory = joinInside(root, 'accounts', accountId)
  const entries = await loadEntries(accountDirectory)
  const blobsMissing = []
  const hashMismatch = []
  const blobsOrphan = []
  let filesChecked = 0
  for (const [id, entry] of entries) {
    if (entry.deleted) {
      // A tombstone has no live blob. One left behind is an orphan, not a note.
      const leftover = await regularFile(joinInside(accountDirectory, 'blobs', id))
      if (leftover) blobsOrphan.push({ id, bytes: leftover.size, deleted: true })
      continue
    }
    filesChecked += 1
    const path = joinInside(accountDirectory, 'blobs', id)
    const info = await regularFile(path)
    if (!info) {
      blobsMissing.push({ id, revision: entry.revision })
      continue
    }
    const actual = await hashFile(path)
    if (actual !== entry.sha256) hashMismatch.push({ id, revision: entry.revision, expected: entry.sha256, actual })
  }
  const known = new Set(entries.keys())
  for (const name of await listDir(joinInside(accountDirectory, 'blobs'))) {
    if (!FILE_ID_PATTERN.test(name) || known.has(name)) continue
    const info = await regularFile(joinInside(accountDirectory, 'blobs', name))
    if (info) blobsOrphan.push({ id: name, bytes: info.size })
  }
  const revisionsOrphan = []
  for (const name of await listDir(joinInside(accountDirectory, 'revisions'))) {
    if (!FILE_ID_PATTERN.test(name) || known.has(name)) continue
    for (const revisionName of await listDir(joinInside(accountDirectory, 'revisions', name))) {
      if (!/^(?:c-)?\d+$/u.test(revisionName)) continue
      const info = await regularFile(joinInside(accountDirectory, 'revisions', name, revisionName))
      if (info) revisionsOrphan.push({ id: name, name: revisionName, bytes: info.size })
    }
  }
  const incoming = []
  for (const name of await listDir(joinInside(accountDirectory, 'incoming'))) {
    if (!name.endsWith('.part')) continue
    const info = await regularFile(joinInside(accountDirectory, 'incoming', name))
    if (info) incoming.push({ name, bytes: info.size })
  }
  const uploads = []
  const now = Date.now()
  for (const uploadId of await listDir(joinInside(accountDirectory, 'partials'))) {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) continue
    const metaPath = joinInside(accountDirectory, 'partials', uploadId, 'meta.json')
    const info = await regularFile(metaPath)
    if (!info) continue
    let meta
    try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) } catch { continue }
    const created = Date.parse(meta.createdAt)
    uploads.push({
      uploadId,
      fileId: FILE_ID_PATTERN.test(meta.fileId) ? meta.fileId : null,
      received: Number(meta.received) || 0,
      size: Number(meta.size) || 0,
      ageSeconds: Number.isFinite(created) ? Math.max(0, Math.round((now - created) / 1000)) : null,
    })
  }
  const quarantine = []
  for (const id of await listDir(joinInside(accountDirectory, 'quarantine'))) {
    if (!FILE_ID_PATTERN.test(id)) continue
    let bytes = 0
    let count = 0
    for (const name of await listDir(joinInside(accountDirectory, 'quarantine', id))) {
      const info = await regularFile(joinInside(accountDirectory, 'quarantine', id, name))
      if (!info) continue
      bytes += info.size
      count += 1
    }
    if (count) quarantine.push({ id, count, bytes })
  }
  const problems = blobsMissing.length + hashMismatch.length + blobsOrphan.length + revisionsOrphan.length
  return {
    accountId,
    ok: problems === 0,
    filesChecked,
    blobsMissing,
    hashMismatch,
    blobsOrphan,
    revisionsOrphan,
    incoming,
    uploads,
    quarantine,
  }
}
