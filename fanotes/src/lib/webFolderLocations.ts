import type { VaultEntry } from '../types'

export const MAX_WEB_FOLDER_PATHS = 8

export type FolderLocationMap = Record<string, string[]>

const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')

const overlaps = (left: string, right: string) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)

export const sanitizeFolderLocationMap = (value: unknown): FolderLocationMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const map: FolderLocationMap = {}
  for (const [folder, paths] of Object.entries(value)) {
    if (!folder || folder.startsWith('.') || folder.includes('\0')) continue
    if (!Array.isArray(paths)) continue
    const clean = paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096 && !entry.includes('\0'))
    if (clean.length) map[folder] = clean.slice(0, MAX_WEB_FOLDER_PATHS)
  }
  return map
}

export const longestFolderPrefix = (map: FolderLocationMap, logical: string) => {
  let best: string | null = null
  for (const folder of Object.keys(map)) {
    if (logical === folder || logical.startsWith(`${folder}/`)) {
      if (!best || folder.length > best.length) best = folder
    }
  }
  return best
}

export const isPlaceholderDescendant = (path: string, map: FolderLocationMap) =>
  Object.keys(map).some((folder) => path.startsWith(`${folder}/`))

export const contentRoots = (map: FolderLocationMap, logicalFolder: string) => {
  const exact = logicalFolder ? map[logicalFolder] : undefined
  if (exact?.length) return exact
  const base = logicalFolder ? longestFolderPrefix(map, logicalFolder) : null
  if (!base) return [logicalFolder]
  const rest = logicalFolder.slice(base.length + 1)
  return map[base].map((source) => (rest ? `${source}/${rest}` : source))
}

export const contentDirectory = (
  map: FolderLocationMap,
  logicalFolder: string,
  folderExists: (path: string) => boolean,
) => {
  const roots = contentRoots(map, logicalFolder)
  const base = logicalFolder ? longestFolderPrefix(map, logicalFolder) : null
  if (base && logicalFolder !== base) {
    const found = roots.find((root) => folderExists(root))
    if (found !== undefined) return found
  }
  return roots[0] ?? logicalFolder
}

export const resolveWebStoredPath = (
  map: FolderLocationMap,
  logical: string,
  exists: (path: string) => boolean,
  allowMissing: boolean,
) => {
  const base = longestFolderPrefix(map, logical)
  if (!base || logical === base) return logical
  const rest = logical.slice(base.length + 1)
  const sources = map[base] ?? []
  for (const source of sources) {
    if (exists(`${source}/${rest}`)) return `${source}/${rest}`
  }
  if (!allowMissing) return sources[0] ? `${sources[0]}/${rest}` : logical
  const stem = rest.replace(/\.[^.]+$/u, '')
  const dir = parentPath(rest)
  for (const source of sources) {
    const folder = dir ? `${source}/${dir}` : source
    if (exists(`${folder}/${stem}.md`) || exists(`${folder}/${stem}.famd`) || exists(`${folder}/${stem}.pdf`)) {
      return `${source}/${rest}`
    }
  }
  if (dir) {
    for (const source of sources) {
      if (exists(`${source}/${dir}`)) return `${source}/${rest}`
    }
  }
  return sources[0] ? `${sources[0]}/${rest}` : logical
}

export const logicalPathForStored = (map: FolderLocationMap, stored: string) => {
  let best: { length: number; logical: string } | null = null
  for (const [folder, sources] of Object.entries(map)) {
    for (const source of sources) {
      if (stored !== source && !stored.startsWith(`${source}/`)) continue
      if (best && source.length <= best.length) continue
      const rest = stored === source ? '' : stored.slice(source.length + 1)
      best = { length: source.length, logical: rest ? `${folder}/${rest}` : folder }
    }
  }
  return best?.logical ?? stored
}

export const validateWebFolderPaths = (
  logical: string,
  rawPaths: string[],
  map: FolderLocationMap,
  folderExists: (path: string) => boolean,
  normalize: (value: string) => string,
) => {
  if (!Array.isArray(rawPaths) || rawPaths.length > MAX_WEB_FOLDER_PATHS) throw new Error('Zu viele Ordnerpfade.')
  const accepted: string[] = []
  for (const raw of rawPaths) {
    if (typeof raw !== 'string') throw new Error('Die Ordnerpfade sind ungültig.')
    const source = normalize(raw)
    if (!source || !folderExists(source)) throw new Error('Der Ordnerpfad wurde nicht gefunden.')
    if (overlaps(source, logical)) throw new Error('Der Ordnerpfad darf nicht im selben Ordner liegen.')
    if (accepted.some((previous) => overlaps(previous, source))) throw new Error('Die Ordnerpfade dürfen sich nicht überlappen.')
    for (const [folder, paths] of Object.entries(map)) {
      if (folder === logical) continue
      if (paths.some((other) => overlaps(other, source))) {
        throw new Error('Dieser Ordner ist bereits einem anderen FaNotes-Ordner zugeordnet.')
      }
    }
    accepted.push(source)
  }
  return accepted
}

export const retargetFolderLocations = (map: FolderLocationMap, from: string, to: string): FolderLocationMap => {
  let changed = false
  const next: FolderLocationMap = {}
  for (const [key, paths] of Object.entries(map)) {
    if (key !== from && !key.startsWith(`${from}/`)) {
      next[key] = paths
      continue
    }
    changed = true
    const renamed = key === from ? to : `${to}${key.slice(from.length)}`
    next[renamed] = paths
  }
  return changed ? next : map
}

export const forgetFolderLocations = (map: FolderLocationMap, relative: string): FolderLocationMap => {
  let changed = false
  const next: FolderLocationMap = {}
  for (const [key, paths] of Object.entries(map)) {
    if (key === relative || key.startsWith(`${relative}/`)) {
      changed = true
      continue
    }
    next[key] = paths
  }
  return changed ? next : map
}

export type StoredMove = { from: string; to: string }

export const planFolderContentMove = (fromRoot: string, toRoot: string, files: string[], folders: string[]) => {
  if (!fromRoot || fromRoot === toRoot) return { fileMoves: [] as StoredMove[], folderMoves: [] as StoredMove[], conflicts: [] as string[] }
  if (toRoot.startsWith(`${fromRoot}/`)) throw new Error('Der neue Ordner liegt im bisherigen Ordner.')
  const folderSet = new Set(folders)
  const fileSet = new Set(files)
  const conflicts: string[] = []
  const folderMoves: StoredMove[] = []
  const fileMoves: StoredMove[] = []
  const blocked = (rest: string) => conflicts.some((conflict) => rest === conflict || rest.startsWith(`${conflict}/`))
  const hidden = (rest: string) => rest.split('/').some((part) => !part || part.startsWith('.'))
  const descendantFolders = folders.filter((path) => path.startsWith(`${fromRoot}/`)).sort((left, right) => left.length - right.length)
  for (const path of descendantFolders) {
    const rest = path.slice(fromRoot.length + 1)
    if (hidden(rest) || blocked(rest)) continue
    const target = `${toRoot}/${rest}`
    if (fileSet.has(target)) {
      conflicts.push(rest)
      continue
    }
    if (folderSet.has(target)) continue
    folderMoves.push({ from: path, to: target })
    folderSet.add(target)
  }
  for (const path of files) {
    if (!path.startsWith(`${fromRoot}/`)) continue
    const rest = path.slice(fromRoot.length + 1)
    if (hidden(rest) || blocked(rest)) continue
    const target = `${toRoot}/${rest}`
    if (fileSet.has(target) || folderSet.has(target)) {
      conflicts.push(rest)
      continue
    }
    fileMoves.push({ from: path, to: target })
  }
  return { fileMoves, folderMoves, conflicts }
}

const nameKey = (name: string) => name.normalize('NFC').toLocaleLowerCase('de-DE')

export const locatedChildren = (
  logicalFolder: string,
  map: FolderLocationMap,
  list: (parent: string) => VaultEntry[],
  depth = 0,
): VaultEntry[] => {
  const sources = map[logicalFolder]
  if (!sources?.length || depth > 40) return []
  const seen = new Set<string>()
  const children: VaultEntry[] = []
  for (const source of sources) {
    for (const child of list(source)) {
      if (!child.name || child.name.startsWith('.')) continue
      const key = nameKey(child.name)
      if (seen.has(key)) continue
      seen.add(key)
      const logical = `${logicalFolder}/${child.name}`
      if (child.kind === 'folder') {
        const nestedMap = map[logical]
        children.push({
          ...child,
          relativePath: logical,
          children: nestedMap ? locatedChildren(logical, map, list, depth + 1) : rewriteStoredChildren(logical, `${source}/${child.name}`, map, list, depth + 1),
          ...(nestedMap ? { locations: nestedMap } : {}),
        })
      } else {
        children.push({ ...child, relativePath: logical })
      }
    }
  }
  return children
}

const rewriteStoredChildren = (
  logicalFolder: string,
  sourceFolder: string,
  map: FolderLocationMap,
  list: (parent: string) => VaultEntry[],
  depth: number,
): VaultEntry[] => {
  if (depth > 40) return []
  if (map[logicalFolder]) return locatedChildren(logicalFolder, map, list, depth)
  const children: VaultEntry[] = []
  for (const child of list(sourceFolder)) {
    if (!child.name || child.name.startsWith('.')) continue
    const logical = `${logicalFolder}/${child.name}`
    if (child.kind === 'folder') {
      const nestedMap = map[logical]
      children.push({
        ...child,
        relativePath: logical,
        children: nestedMap ? locatedChildren(logical, map, list, depth + 1) : rewriteStoredChildren(logical, `${sourceFolder}/${child.name}`, map, list, depth + 1),
        ...(nestedMap ? { locations: nestedMap } : {}),
      })
    } else {
      children.push({ ...child, relativePath: logical })
    }
  }
  return children
}

export const applyFolderLocations = (entries: VaultEntry[], map: FolderLocationMap, list: (parent: string) => VaultEntry[]) => {
  const visit = (items: VaultEntry[]) => {
    for (const entry of items) {
      if (entry.kind !== 'folder') continue
      const linked = map[entry.relativePath]
      if (linked?.length) {
        entry.locations = linked
        entry.children = locatedChildren(entry.relativePath, map, list)
      } else {
        visit(entry.children ?? [])
      }
    }
  }
  visit(entries)
}
