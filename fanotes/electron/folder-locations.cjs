'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const MAX_PATHS = 8
const MAX_FOLDERS = 200
const FILE_NAME = 'folder-locations.json'

function storePath(userData) {
  return path.join(userData, FILE_NAME)
}

function emptyStore() {
  return { version: 1, vaults: {} }
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function loadStore(userData) {
  try {
    const info = fs.lstatSync(storePath(userData))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(storePath(userData), 'utf8'))
    if (!parsed || parsed.version !== 1 || !parsed.vaults || typeof parsed.vaults !== 'object' || Array.isArray(parsed.vaults)) {
      return emptyStore()
    }
    return { version: 1, vaults: parsed.vaults }
  } catch {
    return emptyStore()
  }
}

function saveStore(userData, store) {
  const file = storePath(userData)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const snapshot = `${JSON.stringify({ version: 1, vaults: store.vaults }, null, 2)}\n`
  if (Buffer.byteLength(snapshot, 'utf8') > 512 * 1024) {
    throw new Error('Zu viele Ordnerpfade.')
  }
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, snapshot, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function vaultKey(vaultPath) {
  return path.resolve(vaultPath)
}

function mapFor(store, vaultPath) {
  const stored = store.vaults[vaultKey(vaultPath)]
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const map = {}
  for (const [folder, paths] of Object.entries(stored)) {
    if (!Array.isArray(paths)) continue
    const clean = paths.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096)
    if (clean.length) map[folder] = clean.slice(0, MAX_PATHS)
  }
  return map
}

function writeMap(store, vaultPath, map) {
  const key = vaultKey(vaultPath)
  if (!map || Object.keys(map).length === 0) delete store.vaults[key]
  else store.vaults[key] = map
}

function longestPrefix(map, logical) {
  let best = null
  for (const folder of Object.keys(map)) {
    if (logical === folder || logical.startsWith(`${folder}/`)) {
      if (!best || folder.length > best.length) best = folder
    }
  }
  return best
}

function contentRoots(map, vaultPath, logicalFolder) {
  const folder = logicalFolder ? longestPrefix(map, logicalFolder) : null
  if (!folder) {
    const primary = logicalFolder ? path.resolve(vaultPath, ...logicalFolder.split('/')) : path.resolve(vaultPath)
    return { mapped: false, roots: [primary], primary, folder: null }
  }
  const bases = map[folder]
  const remainder = logicalFolder === folder ? '' : logicalFolder.slice(folder.length + 1)
  const roots = bases.map((root) => (remainder ? path.resolve(root, ...remainder.split('/')) : path.resolve(root)))
  return { mapped: true, roots, primary: roots[0], folder }
}

function exactPaths(map, logicalFolder) {
  const paths = logicalFolder ? map[logicalFolder] : null
  return Array.isArray(paths) && paths.length ? paths : null
}

function enoent(target) {
  const error = new Error(`ENOENT: no such file or directory, lstat '${target}'`)
  error.code = 'ENOENT'
  return error
}

async function assertRealDirectory(candidate) {
  let info
  try {
    info = await fsp.lstat(candidate)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Der Ordnerpfad wurde nicht gefunden.')
    throw error
  }
  if (info.isSymbolicLink()) throw new Error('Symbolische Links sind als Ordnerpfad nicht erlaubt.')
  if (!info.isDirectory()) throw new Error('Der Ordnerpfad ist kein Ordner.')
  const real = await fsp.realpath(candidate)
  return real
}

async function validateLocation(vaultPath, candidate, accepted, map, logicalFolder) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0') || candidate.length > 4096) {
    throw new Error('Die Ordnerpfade sind ungültig.')
  }
  if (!path.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) {
    throw new Error('Ein Ordnerpfad muss ein absoluter Ordner sein.')
  }
  const real = await assertRealDirectory(candidate)
  const vault = await fsp.realpath(vaultPath)
  if (real === vault || isInsideRoot(vault, real)) throw new Error('Der Ordnerpfad darf nicht im Vault liegen.')
  if (isInsideRoot(real, vault)) throw new Error('Der Ordnerpfad darf den Vault nicht enthalten.')
  for (const previous of accepted) {
    if (previous === real || isInsideRoot(previous, real) || isInsideRoot(real, previous)) {
      throw new Error('Die Ordnerpfade dürfen sich nicht überlappen.')
    }
  }
  for (const [folder, paths] of Object.entries(map)) {
    if (folder === logicalFolder) continue
    for (const other of paths) {
      let otherReal = other
      try {
        otherReal = await fsp.realpath(other)
      } catch {
        otherReal = path.resolve(other)
      }
      if (otherReal === real || isInsideRoot(otherReal, real) || isInsideRoot(real, otherReal)) {
        throw new Error('Dieser Ordner ist bereits einem anderen FaNotes-Ordner zugeordnet.')
      }
    }
  }
  return real
}

async function resolveLocated({ vault, logical, map, allowMissing = false, expected = null, asContent = false }) {
  if (!logical || logical === '.fanotes' || logical.startsWith('.fanotes/')) return null
  const exact = exactPaths(map, logical)
  if (exact && !asContent && expected !== 'file') return null
  const base = longestPrefix(map, logical)
  if (!base) return null
  const bases = map[base]
  const remainder = logical === base ? '' : logical.slice(base.length + 1)
  if (!remainder) {
    const primary = await assertRealDirectory(bases[0]).catch((error) => {
      if (allowMissing && error?.message === 'Der Ordnerpfad wurde nicht gefunden.') return path.resolve(bases[0])
      throw new Error('Der verknüpfte Ordner wurde nicht gefunden.')
    })
    return { target: primary, anchor: primary }
  }
  const segments = remainder.split('/')
  let rejected = null
  for (const root of bases) {
    const candidate = path.resolve(root, ...segments)
    let info
    try {
      info = await fsp.lstat(candidate)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      rejected = error
      continue
    }
    if (info.isSymbolicLink()) {
      rejected = new Error('Symbolische Links sind innerhalb des Vaults nicht erlaubt.')
      continue
    }
    if (expected === 'file' && !info.isFile()) continue
    if (expected === 'directory' && !info.isDirectory()) continue
    let anchor
    try {
      anchor = await fsp.realpath(root)
      const real = await fsp.realpath(candidate)
      if (!isInsideRoot(anchor, real)) {
        throw new Error('Der Pfad verlässt den verknüpften Ordner über einen Link.')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    return { target: candidate, anchor }
  }
  if (!allowMissing) {
    if (rejected && rejected.code !== 'ENOENT' && !rejected.message?.startsWith('Symbolische')) throw rejected
    if (rejected?.message?.startsWith('Symbolische')) throw rejected
    throw enoent(path.resolve(bases[0], ...segments))
  }
  const anchor = await fsp.realpath(bases[0])
  const target = path.resolve(bases[0], ...segments)
  if (!isInsideRoot(anchor, target) && path.dirname(target) !== anchor && !isInsideRoot(anchor, path.dirname(target))) {
    throw new Error('Der Pfad liegt außerhalb des verknüpften Ordners.')
  }
  return { target, anchor }
}

function identityPath(vaultPath, absolutePath, map) {
  const absolute = path.resolve(absolutePath)
  const vault = path.resolve(vaultPath)
  if (isInsideRoot(vault, absolute)) return path.relative(vault, absolute).split(path.sep).join('/')
  for (const [folder, roots] of Object.entries(map || {})) {
    for (const root of roots) {
      const base = path.resolve(root)
      if (absolute === base) return folder
      if (isInsideRoot(base, absolute)) {
        const rest = path.relative(base, absolute).split(path.sep).join('/')
        return rest ? `${folder}/${rest}` : folder
      }
    }
  }
  return null
}

function allowsPhysical(vaultPath, absolutePath, map) {
  const absolute = path.resolve(absolutePath)
  if (isInsideRoot(path.resolve(vaultPath), absolute)) return true
  for (const roots of Object.values(map || {})) {
    for (const root of roots) {
      if (isInsideRoot(path.resolve(root), absolute)) return true
    }
  }
  return false
}

function retargetMap(map, oldRelative, nextRelative) {
  let changed = false
  const next = { ...map }
  for (const key of Object.keys(map)) {
    if (key !== oldRelative && !key.startsWith(`${oldRelative}/`)) continue
    const paths = next[key]
    delete next[key]
    const renamed = key === oldRelative ? nextRelative : `${nextRelative}${key.slice(oldRelative.length)}`
    next[renamed] = paths
    changed = true
  }
  return changed ? next : map
}

function forgetMap(map, relative) {
  const next = {}
  let changed = false
  for (const [key, paths] of Object.entries(map)) {
    if (key === relative || key.startsWith(`${relative}/`)) {
      changed = true
      continue
    }
    next[key] = paths
  }
  return changed ? next : map
}

async function occupiedNames(directories, excluding = null) {
  const occupied = new Set()
  for (const directory of directories) {
    let entries = []
    try {
      entries = await fsp.readdir(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry === excluding) continue
      occupied.add(entry.normalize('NFC').toLocaleLowerCase('de-DE'))
    }
  }
  return occupied
}

async function moveContents(from, to) {
  let fromInfo
  try {
    fromInfo = await fsp.lstat(from)
  } catch (error) {
    if (error?.code === 'ENOENT') return { moved: 0, conflicts: [] }
    throw error
  }
  if (fromInfo.isSymbolicLink() || !fromInfo.isDirectory()) return { moved: 0, conflicts: [] }
  await fsp.mkdir(to, { recursive: true, mode: 0o700 })
  const fromReal = await fsp.realpath(from)
  const toReal = await fsp.realpath(to)
  if (fromReal === toReal) return { moved: 0, conflicts: [] }
  if (isInsideRoot(fromReal, toReal)) throw new Error('Der neue Ordner liegt im bisherigen Ordner.')
  const conflicts = []
  let moved = 0

  async function relocate(source, destination) {
    try {
      await fsp.rename(source, destination)
      return
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    const info = await fsp.lstat(source)
    if (info.isDirectory()) {
      await fsp.mkdir(destination, { recursive: true, mode: 0o700 })
      await walk(source, destination, 1)
      await fsp.rmdir(source).catch(() => {})
      return
    }
    await fsp.copyFile(source, destination)
    await fsp.rm(source, { force: true })
  }

  async function walk(source, destination, depth) {
    if (depth > 80) return
    const entries = await fsp.readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const src = path.join(source, entry.name)
      const dst = path.join(destination, entry.name)
      const info = await fsp.lstat(src).catch(() => null)
      if (!info || info.isSymbolicLink()) continue
      const relative = path.relative(from, src).split(path.sep).join('/')
      if (info.isDirectory()) {
        const existing = await fsp.lstat(dst).catch(() => null)
        if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
          conflicts.push(relative)
          continue
        }
        await fsp.mkdir(dst, { recursive: true, mode: 0o700 })
        await walk(src, dst, depth + 1)
        await fsp.rmdir(src).catch(() => {})
        continue
      }
      if (!info.isFile()) continue
      const existing = await fsp.lstat(dst).catch(() => null)
      if (existing) {
        conflicts.push(relative)
        continue
      }
      await relocate(src, dst)
      moved += 1
    }
  }

  await walk(from, to, 0)
  return { moved, conflicts }
}

function assignLogical(entry, parentPath, name) {
  const parent = String(parentPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  entry.name = name
  entry.relativePath = parent ? `${parent}/${name}` : name
  return entry
}

module.exports = {
  MAX_FOLDERS,
  MAX_PATHS,
  allowsPhysical,
  assignLogical,
  contentRoots,
  exactPaths,
  forgetMap,
  identityPath,
  isInsideRoot,
  loadStore,
  longestPrefix,
  mapFor,
  moveContents,
  occupiedNames,
  resolveLocated,
  retargetMap,
  saveStore,
  validateLocation,
  writeMap,
}
