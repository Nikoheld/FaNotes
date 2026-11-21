/**
 * Remembers which Markdown headings are folded in a note. The state lives in the
 * local profile (localStorage), never in the note file. A fold is keyed by the
 * heading's level, its text and which occurrence of that heading it is, so edits
 * that shift line numbers keep the right sections folded.
 */
/** v2 keys entries by vault scope + note path; v1 (path only, could collide across vaults) is ignored and never read. */
export const HEADING_FOLDS_KEY = 'fanotes.headingFolds.v2'
export const HEADING_FOLDS_MAX_NOTES = 500

export type HeadingInfo = { line: number; level: number; text: string; key: string }
export type HeadingFoldStore = Record<string, { keys: string[]; at: number }>

type StorageLike = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }

const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/

/** ATX headings outside fenced code, 1-based line numbers. */
export const listHeadings = (text: string): HeadingInfo[] => {
  const headings: HeadingInfo[] = []
  const seen = new Map<string, number>()
  let fence: string | null = null
  text.split(/\r?\n/).forEach((line, index) => {
    const fenceMatch = FENCE_LINE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return
    }
    if (fence !== null) return
    const match = HEADING_LINE.exec(line)
    if (!match) return
    const level = match[1].length
    const label = match[2].replace(/\s+/g, ' ').trim()
    const base = `${level}:${label}`
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    headings.push({ line: index + 1, level, text: label, key: `${base}#${occurrence}` })
  })
  return headings
}

/** Keys of the headings whose 1-based line numbers are in `foldedLines`. */
export const foldKeysForLines = (text: string, foldedLines: Iterable<number>): string[] => {
  const wanted = new Set(foldedLines)
  return listHeadings(text).filter((heading) => wanted.has(heading.line)).map((heading) => heading.key)
}

/** Line numbers of the headings that the stored keys still match, in document order. */
export const linesForFoldKeys = (text: string, keys: readonly string[]): number[] => {
  const wanted = new Set(keys)
  return listHeadings(text).filter((heading) => wanted.has(heading.key)).map((heading) => heading.line)
}

const resolveStorage = (storage?: StorageLike | null): StorageLike | null => {
  if (storage) return storage
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export const parseHeadingFolds = (raw: string | null | undefined): HeadingFoldStore => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const store: HeadingFoldStore = {}
    for (const [path, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const record = entry as { keys?: unknown; at?: unknown } | null
      if (!record || !Array.isArray(record.keys)) continue
      const keys = record.keys.filter((key): key is string => typeof key === 'string')
      if (keys.length) store[path] = { keys, at: typeof record.at === 'number' ? record.at : 0 }
    }
    return store
  } catch { return {} }
}

export const loadHeadingFolds = (storage?: StorageLike | null): HeadingFoldStore => {
  const target = resolveStorage(storage)
  if (!target) return {}
  try { return parseHeadingFolds(target.getItem(HEADING_FOLDS_KEY)) } catch { return {} }
}

export const saveHeadingFolds = (store: HeadingFoldStore, storage?: StorageLike | null) => {
  const target = resolveStorage(storage)
  if (!target) return false
  const entries = Object.entries(store).sort((a, b) => b[1].at - a[1].at).slice(0, HEADING_FOLDS_MAX_NOTES)
  try { target.setItem(HEADING_FOLDS_KEY, JSON.stringify(Object.fromEntries(entries))); return true } catch { return false }
}

/** Short stable hash of the vault path; two vaults with the same relative note path get different scopes. */
export const headingFoldScope = (vaultPath: string | null | undefined): string => {
  let hash = 5381
  for (const char of vaultPath ?? '') hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0
  return hash.toString(36)
}

/** Storage key of a note: vault scope plus note path. */
export const headingFoldKey = (scope: string, path: string) => `${scope}|${path}`

export const recallHeadingFolds = (path: string, storage?: StorageLike | null): string[] => loadHeadingFolds(storage)[path]?.keys ?? []

/** An empty list forgets the note. */
export const rememberHeadingFolds = (path: string, keys: readonly string[], storage?: StorageLike | null, now = Date.now()) => {
  const store = loadHeadingFolds(storage)
  if (keys.length) store[path] = { keys: [...keys], at: now }
  else if (path in store) delete store[path]
  else return false
  return saveHeadingFolds(store, storage)
}

const underPath = (candidate: string, path: string) => candidate === path || candidate.startsWith(`${path}/`)

/** A renamed or moved note (or folder) keeps its folds; `to === null` (trashed) drops them. */
export const remapHeadingFolds = (scope: string, from: string, to: string | null, storage?: StorageLike | null) => {
  const store = loadHeadingFolds(storage)
  let changed = false
  for (const key of Object.keys(store)) {
    if (!key.startsWith(`${scope}|`)) continue
    const path = key.slice(scope.length + 1)
    if (!underPath(path, from)) continue
    const entry = store[key]
    delete store[key]
    changed = true
    if (to !== null) store[headingFoldKey(scope, path === from ? to : `${to}${path.slice(from.length)}`)] = entry
  }
  return changed ? saveHeadingFolds(store, storage) : false
}

/** Drops entries of this vault for notes that no longer exist; other vaults are untouched. */
export const pruneHeadingFolds = (scope: string, existingPaths: ReadonlySet<string>, storage?: StorageLike | null) => {
  const store = loadHeadingFolds(storage)
  let changed = false
  for (const key of Object.keys(store)) {
    if (key.startsWith(`${scope}|`) && !existingPaths.has(key.slice(scope.length + 1))) { delete store[key]; changed = true }
  }
  return changed ? saveHeadingFolds(store, storage) : false
}
