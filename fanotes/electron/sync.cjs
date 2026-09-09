'use strict'

// Sync host for the desktop app: raw file access to the whole vault for the
// renderer-side sync engine (electron/../src/lib/sync/engine.ts), the engine's
// per-vault state under userData, and the account secrets protected with the
// OS keychain via safeStorage where available.
//
// Everything the renderer hands in is treated as untrusted: paths are
// normalised, confined to the vault root and rejected when any component is a
// symbolic link, so a synced file can never land outside the vault.

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const INTERNAL_DIRECTORY = '.fanotes'
const SKIPPED_INTERNAL = new Set(['history', 'tree-cache'])
const MAX_ENTRIES = 100_000
const MAX_DEPTH = 40
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_STATE_BYTES = 64 * 1024 * 1024
const SECRETS_PREFIX_ENCRYPTED = 'safe1:'
const SECRETS_PREFIX_PLAIN = 'plain1:'

const normalizeRelative = (raw) => {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || raw.includes('\0')) throw new Error('Ungültiger Sync-Pfad.')
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const segments = normalized.split('/')
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Ungültiger Sync-Pfad.')
  return segments
}

const isInsideRoot = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** Resolves a vault-relative path and refuses symlinks anywhere along the way. */
const resolveInside = async (root, raw, { allowMissing = false } = {}) => {
  const segments = normalizeRelative(raw)
  const target = path.resolve(root, ...segments)
  if (!isInsideRoot(root, target)) throw new Error('Der Pfad liegt außerhalb des Vaults.')
  let cursor = root
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index])
    let info
    try {
      info = await fsp.lstat(cursor)
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) return { target, relativePath: segments.join('/'), exists: false }
      throw error
    }
    if (info.isSymbolicLink()) throw new Error('Symbolische Links sind im Vault nicht erlaubt.')
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error('Ein Pfadbestandteil ist kein Ordner.')
  }
  return { target, relativePath: segments.join('/'), exists: true }
}

const toPosix = (root, absolute) => path.relative(root, absolute).split(path.sep).join('/')

async function scanDirectory(root, directory, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
  let entries
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return
    if (entry.isSymbolicLink()) continue
    const absolute = path.join(directory, entry.name)
    const relative = toPosix(root, absolute)
    if (entry.name.startsWith('.')) {
      // Only the shared FaNotes metadata folder at the vault root takes part; every other dotfile is local.
      if (!(depth === 0 && entry.name === INTERNAL_DIRECTORY)) continue
    }
    if (depth === 1 && relative.startsWith(`${INTERNAL_DIRECTORY}/`) && SKIPPED_INTERNAL.has(entry.name)) continue
    if (entry.isDirectory()) {
      await scanDirectory(root, absolute, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    if (/\.tmp$/iu.test(entry.name)) continue
    let info
    try {
      info = await fsp.lstat(absolute)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
    out.push({ path: relative, size: info.size, mtimeMs: Math.round(info.mtimeMs) })
  }
}

async function atomicWriteBytes(target, bytes, mtimeMs) {
  const directory = path.dirname(target)
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let handle
  try {
    handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
      const when = new Date(mtimeMs)
      await fsp.utimes(temporary, when, when).catch(() => undefined)
    }
    await fsp.rename(temporary, target)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.vaultRoot  resolves the active vault root
 * @param {string} deps.userDataDirectory
 * @param {import('electron').SafeStorage} deps.safeStorage
 * @param {(absolutePath: string) => Promise<void>} [deps.trashItem]
 */
function createSyncHost({ vaultRoot, userDataDirectory, safeStorage, trashItem }) {
  const stateDirectory = path.join(userDataDirectory, 'sync')
  const statePath = (vaultId) => {
    if (typeof vaultId !== 'string' || !/^[a-f0-9]{16,64}$/u.test(vaultId)) throw new Error('Ungültige Vault-ID.')
    return path.join(stateDirectory, `state-${vaultId}.json`)
  }
  const secretsPath = path.join(stateDirectory, 'account.secret')

  return {
    async vaultId() {
      const root = await vaultRoot()
      return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 32)
    },
    async scan() {
      const root = await vaultRoot()
      const out = []
      await scanDirectory(root, root, 0, out)
      return out
    },
    async read(relativePath) {
      const root = await vaultRoot()
      const { target } = await resolveInside(root, relativePath)
      const info = await fsp.lstat(target)
      if (!info.isFile()) throw new Error('Die Datei ist keine reguläre Datei.')
      if (info.size > MAX_FILE_BYTES) throw new Error('Die Datei ist zu groß für den Sync.')
      const handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      try {
        return new Uint8Array(await handle.readFile())
      } finally {
        await handle.close()
      }
    },
    async write(relativePath, bytes, mtimeMs) {
      if (!(bytes instanceof Uint8Array)) throw new Error('Der Sync-Inhalt muss binär sein.')
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Die Datei ist zu groß für den Sync.')
      const root = await vaultRoot()
      const { target, relativePath: normalized } = await resolveInside(root, relativePath, { allowMissing: true })
      await atomicWriteBytes(target, bytes, Number(mtimeMs))
      const info = await fsp.lstat(target)
      return { path: normalized, size: info.size, mtimeMs: Math.round(info.mtimeMs) }
    },
    async remove(relativePath) {
      const root = await vaultRoot()
      const { target, exists } = await resolveInside(root, relativePath, { allowMissing: true })
      if (!exists) return
      const info = await fsp.lstat(target)
      if (!info.isFile()) throw new Error('Nur Dateien können über den Sync entfernt werden.')
      if (trashItem) {
        try {
          await trashItem(target)
          return
        } catch {
          // No trash on this desktop: fall through to a plain unlink.
        }
      }
      await fsp.unlink(target)
    },
    async readState(vaultId) {
      try {
        const info = await fsp.lstat(statePath(vaultId))
        if (!info.isFile() || info.size > MAX_STATE_BYTES) return null
        return await fsp.readFile(statePath(vaultId), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    },
    async writeState(vaultId, json) {
      const target = statePath(vaultId)
      if (json === null) {
        await fsp.rm(target, { force: true })
        return
      }
      if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_STATE_BYTES) throw new Error('Der Sync-Zustand ist ungültig.')
      await atomicWriteBytes(target, Buffer.from(json, 'utf8'), 0)
    },
    async readSecrets() {
      let raw
      try {
        raw = await fsp.readFile(secretsPath, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      if (raw.startsWith(SECRETS_PREFIX_ENCRYPTED)) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Die Sync-Anmeldung ist mit dem Schlüsselbund dieses Systems geschützt, der gerade nicht verfügbar ist.')
        return safeStorage.decryptString(Buffer.from(raw.slice(SECRETS_PREFIX_ENCRYPTED.length), 'base64'))
      }
      if (raw.startsWith(SECRETS_PREFIX_PLAIN)) return raw.slice(SECRETS_PREFIX_PLAIN.length)
      return null
    },
    async writeSecrets(json) {
      if (json === null) {
        await fsp.rm(secretsPath, { force: true })
        return
      }
      if (typeof json !== 'string' || json.length > 64 * 1024) throw new Error('Die Sync-Anmeldedaten sind ungültig.')
      const encoded = safeStorage.isEncryptionAvailable()
        ? `${SECRETS_PREFIX_ENCRYPTED}${safeStorage.encryptString(json).toString('base64')}`
        : `${SECRETS_PREFIX_PLAIN}${json}`
      await atomicWriteBytes(secretsPath, Buffer.from(encoded, 'utf8'), 0)
    },
  }
}

const SYNC_CHANNELS = Object.freeze({
  vaultId: 'fanotes:sync-vault-id',
  scan: 'fanotes:sync-scan',
  read: 'fanotes:sync-read',
  write: 'fanotes:sync-write',
  remove: 'fanotes:sync-remove',
  readState: 'fanotes:sync-read-state',
  writeState: 'fanotes:sync-write-state',
  readSecrets: 'fanotes:sync-read-secrets',
  writeSecrets: 'fanotes:sync-write-secrets',
})

function registerSyncIpc(handle, host) {
  handle(SYNC_CHANNELS.vaultId, () => host.vaultId())
  handle(SYNC_CHANNELS.scan, () => host.scan())
  handle(SYNC_CHANNELS.read, (_event, relativePath) => host.read(relativePath))
  handle(SYNC_CHANNELS.write, (_event, relativePath, bytes, mtimeMs) => host.write(relativePath, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mtimeMs))
  handle(SYNC_CHANNELS.remove, (_event, relativePath) => host.remove(relativePath))
  handle(SYNC_CHANNELS.readState, (_event, vaultId) => host.readState(vaultId))
  handle(SYNC_CHANNELS.writeState, (_event, vaultId, json) => host.writeState(vaultId, json))
  handle(SYNC_CHANNELS.readSecrets, () => host.readSecrets())
  handle(SYNC_CHANNELS.writeSecrets, (_event, json) => host.writeSecrets(json))
}

module.exports = { createSyncHost, registerSyncIpc, SYNC_CHANNELS, resolveInside, normalizeRelative }
