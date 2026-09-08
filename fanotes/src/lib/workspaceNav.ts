/**
 * Pure helpers behind the workspace navigation: the visited-note history
 * (back/forward), the split-view layout, tab ordering and pinning, the
 * remembered workspace (open tabs, split, layout) per vault, and the fuzzy
 * note ranking of the quick switcher. Nothing here touches the DOM, so the
 * check scripts exercise every rule directly.
 */

// ─── Visited-note history ────────────────────────────────────────────────────

export type NoteHistory = {
  entries: string[]
  index: number
}

export const EMPTY_NOTE_HISTORY: NoteHistory = { entries: [], index: -1 }

/** Enough to walk back through a study session, small enough to never matter. */
export const NOTE_HISTORY_LIMIT = 120

/** Record a visit: drops any forward entries, skips a repeat of the current note. */
export const visitNote = (history: NoteHistory, path: string): NoteHistory => {
  if (!path) return history
  if (history.entries[history.index] === path) return history
  const kept = history.entries.slice(0, history.index + 1)
  kept.push(path)
  const overflow = Math.max(0, kept.length - NOTE_HISTORY_LIMIT)
  const entries = overflow ? kept.slice(overflow) : kept
  return { entries, index: entries.length - 1 }
}

export const canGoBack = (history: NoteHistory) => history.index > 0
export const canGoForward = (history: NoteHistory) => history.index >= 0 && history.index < history.entries.length - 1

/**
 * Step through the history, skipping entries that no longer exist (closed or
 * trashed notes stay in the list so a reopened note keeps its place).
 */
export const stepNoteHistory = (
  history: NoteHistory,
  direction: -1 | 1,
  exists: (path: string) => boolean = () => true,
): { history: NoteHistory; path: string | null } => {
  let index = history.index + direction
  while (index >= 0 && index < history.entries.length) {
    const path = history.entries[index]
    if (exists(path)) return { history: { ...history, index }, path }
    index += direction
  }
  return { history, path: null }
}

/** Rename or move: every visit of the old path (or a note inside a moved folder) follows. */
export const remapNoteHistory = (history: NoteHistory, from: string, to: string): NoteHistory => {
  const entries = history.entries.map((entry) => remapPath(entry, from, to) ?? entry)
  return collapseHistoryRepeats({ entries, index: history.index })
}

/** Trash: forget every visit of the path (or of notes inside a trashed folder). */
export const forgetNoteHistory = (history: NoteHistory, path: string): NoteHistory => {
  const entries: string[] = []
  let index = -1
  history.entries.forEach((entry, position) => {
    if (isSelfOrInside(entry, path)) return
    entries.push(entry)
    if (position <= history.index) index = entries.length - 1
  })
  return collapseHistoryRepeats({ entries, index })
}

const collapseHistoryRepeats = (history: NoteHistory): NoteHistory => {
  const entries: string[] = []
  let index = -1
  history.entries.forEach((entry, position) => {
    if (entries[entries.length - 1] === entry) {
      if (position <= history.index) index = entries.length - 1
      return
    }
    entries.push(entry)
    if (position <= history.index) index = entries.length - 1
  })
  return { entries, index: Math.min(index, entries.length - 1) }
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export const isSelfOrInside = (candidate: string, ancestor: string) => (
  candidate === ancestor || candidate.startsWith(`${ancestor}/`)
)

/** The path after `from` was renamed/moved to `to`, or null when unaffected. */
export const remapPath = (path: string, from: string, to: string): string | null => (
  isSelfOrInside(path, from) ? `${to}${path.slice(from.length)}` : null
)

export const folderSegments = (path: string) => path.split('/').filter(Boolean).slice(0, -1)

/** Breadcrumb trail: each folder with the path that reveals it, then the note itself. */
export const breadcrumbsFor = (path: string): { label: string; path: string; isNote: boolean }[] => {
  const parts = path.split('/').filter(Boolean)
  return parts.map((part, index) => {
    const isNote = index === parts.length - 1
    return {
      label: isNote ? part.replace(/\.(md|markdown|famd|pdf)$/i, '') : part,
      path: parts.slice(0, index + 1).join('/'),
      isNote,
    }
  })
}

// ─── Split view ─────────────────────────────────────────────────────────────

export type SplitOrientation = 'columns' | 'rows'

export type SplitLayout = {
  ratio: number
  orientation: SplitOrientation
}

export const SPLIT_MIN_RATIO = 0.2
export const SPLIT_MAX_RATIO = 0.8
export const SPLIT_RATIO_STEP = 0.05
export const DEFAULT_SPLIT_LAYOUT: SplitLayout = { ratio: 0.5, orientation: 'columns' }
export const SPLIT_LAYOUT_STORAGE_KEY = 'fanotes.splitLayout.v1'

export const clampSplitRatio = (ratio: number) => {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_LAYOUT.ratio
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio))
}

/** Where the divider lands for a pointer inside the split container. */
export const splitRatioFromPointer = (
  container: { left: number; top: number; width: number; height: number },
  pointer: { x: number; y: number },
  orientation: SplitOrientation,
) => {
  const along = orientation === 'columns'
    ? (pointer.x - container.left) / Math.max(1, container.width)
    : (pointer.y - container.top) / Math.max(1, container.height)
  return clampSplitRatio(along)
}

export const nudgeSplitRatio = (ratio: number, direction: -1 | 1) => (
  clampSplitRatio(Math.round((ratio + direction * SPLIT_RATIO_STEP) * 100) / 100)
)

export const normalizeSplitLayout = (value: unknown): SplitLayout => {
  if (!value || typeof value !== 'object') return DEFAULT_SPLIT_LAYOUT
  const raw = value as Partial<Record<keyof SplitLayout, unknown>>
  return {
    ratio: clampSplitRatio(typeof raw.ratio === 'number' ? raw.ratio : Number.NaN),
    orientation: raw.orientation === 'rows' ? 'rows' : 'columns',
  }
}

export const loadSplitLayout = (storage: Pick<Storage, 'getItem'> | null = safeStorage()): SplitLayout => {
  try {
    const raw = storage?.getItem(SPLIT_LAYOUT_STORAGE_KEY)
    return raw ? normalizeSplitLayout(JSON.parse(raw)) : DEFAULT_SPLIT_LAYOUT
  } catch {
    return DEFAULT_SPLIT_LAYOUT
  }
}

export const saveSplitLayout = (layout: SplitLayout, storage: Pick<Storage, 'setItem'> | null = safeStorage()) => {
  try {
    storage?.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify(normalizeSplitLayout(layout)))
  } catch {
    // Private mode or a full quota: the layout simply is not remembered.
  }
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

export type TabLike = { path: string; pinned?: boolean }

/** Pinned tabs sit first in their existing order; the rest keep theirs. */
export const sortPinnedFirst = <T extends TabLike>(tabs: T[]): T[] => {
  const pinned = tabs.filter((tab) => tab.pinned)
  if (!pinned.length) return tabs
  const rest = tabs.filter((tab) => !tab.pinned)
  return [...pinned, ...rest]
}

/**
 * Drop `fromPath` in front of `toPath` (or at the end when `toPath` is null).
 * A pinned tab stays in the pinned block and an unpinned one outside it.
 */
export const reorderTabs = <T extends TabLike>(tabs: T[], fromPath: string, toPath: string | null): T[] => {
  const fromIndex = tabs.findIndex((tab) => tab.path === fromPath)
  if (fromIndex === -1 || fromPath === toPath) return tabs
  const moving = tabs[fromIndex]
  const without = tabs.filter((tab) => tab.path !== fromPath)
  let insertAt = toPath === null ? without.length : without.findIndex((tab) => tab.path === toPath)
  if (insertAt === -1) insertAt = without.length
  const target = without[insertAt]
  if (target && Boolean(target.pinned) !== Boolean(moving.pinned)) return tabs
  if (!target && without.length && Boolean(without[without.length - 1].pinned) !== Boolean(moving.pinned)) return tabs
  const next = without.slice()
  next.splice(insertAt, 0, moving)
  return next
}

export const togglePinnedTab = <T extends TabLike>(tabs: T[], path: string): T[] => (
  sortPinnedFirst(tabs.map((tab) => tab.path === path ? { ...tab, pinned: !tab.pinned } : tab))
)

/** Ctrl+1..8 pick that tab, Ctrl+9 always the last one (browser convention). */
export const tabIndexForDigit = (digit: number, count: number): number | null => {
  if (!count || !Number.isInteger(digit) || digit < 1 || digit > 9) return null
  if (digit === 9) return count - 1
  return digit <= count ? digit - 1 : null
}

/** Tabs to close for "close others" / "close to the right"; pinned tabs stay. */
export const tabsToClose = <T extends TabLike>(tabs: T[], anchor: string, scope: 'others' | 'right'): string[] => {
  const anchorIndex = tabs.findIndex((tab) => tab.path === anchor)
  if (anchorIndex === -1) return []
  return tabs
    .filter((tab, index) => !tab.pinned && tab.path !== anchor && (scope === 'others' || index > anchorIndex))
    .map((tab) => tab.path)
}

export const CLOSED_TABS_LIMIT = 20

export const rememberClosedTab = (stack: string[], path: string): string[] => (
  [path, ...stack.filter((entry) => entry !== path)].slice(0, CLOSED_TABS_LIMIT)
)

// ─── Remembered workspace ───────────────────────────────────────────────────

export type WorkspaceMemory = {
  tabs: string[]
  pinned: string[]
  active: string | null
  split: string | null
}

export const WORKSPACE_STORAGE_PREFIX = 'fanotes.workspace.v1:'

export const workspaceStorageKey = (vaultPath: string) => `${WORKSPACE_STORAGE_PREFIX}${vaultPath || 'default'}`

export const normalizeWorkspaceMemory = (value: unknown): WorkspaceMemory | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Record<keyof WorkspaceMemory, unknown>>
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  const tabs = [...new Set(strings(raw.tabs))]
  return {
    tabs,
    pinned: strings(raw.pinned).filter((path) => tabs.includes(path)),
    active: typeof raw.active === 'string' && tabs.includes(raw.active) ? raw.active : null,
    split: typeof raw.split === 'string' && tabs.includes(raw.split) ? raw.split : null,
  }
}

/** Forget notes that no longer exist in the vault; the split needs two distinct notes. */
export const pruneWorkspaceMemory = (memory: WorkspaceMemory, exists: (path: string) => boolean): WorkspaceMemory => {
  const tabs = memory.tabs.filter(exists)
  const active = memory.active && tabs.includes(memory.active) ? memory.active : null
  const split = memory.split && tabs.includes(memory.split) && memory.split !== active ? memory.split : null
  return { tabs, pinned: memory.pinned.filter((path) => tabs.includes(path)), active, split }
}

export const loadWorkspaceMemory = (vaultPath: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): WorkspaceMemory | null => {
  try {
    const raw = storage?.getItem(workspaceStorageKey(vaultPath))
    return raw ? normalizeWorkspaceMemory(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export const saveWorkspaceMemory = (vaultPath: string, memory: WorkspaceMemory, storage: Pick<Storage, 'setItem'> | null = safeStorage()) => {
  try {
    storage?.setItem(workspaceStorageKey(vaultPath), JSON.stringify(memory))
  } catch {
    // Not remembering the tabs is the worst case here.
  }
}

// ─── Quick switcher ─────────────────────────────────────────────────────────

export type SwitcherNote = {
  path: string
  title: string
  folder: string
}

export const switcherNoteFor = (path: string): SwitcherNote => {
  const parts = path.split('/').filter(Boolean)
  const name = parts[parts.length - 1] ?? path
  return {
    path,
    title: name.replace(/\.(md|markdown|famd|pdf)$/i, ''),
    folder: parts.slice(0, -1).join(' › '),
  }
}

const normalizeForMatch = (text: string) => text
  .toLocaleLowerCase('de')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

/**
 * Subsequence match with a bias for word starts and tight runs. 0 = no match.
 * Higher is better; a title match outranks the same match deep in a folder.
 */
export const fuzzyScore = (query: string, text: string): number => {
  const needle = normalizeForMatch(query).replace(/\s+/g, '')
  if (!needle) return 1
  const haystack = normalizeForMatch(text)
  if (haystack.includes(needle)) {
    const at = haystack.indexOf(needle)
    const wordStart = at === 0 || /[\s\-_./›(]/.test(haystack[at - 1])
    return 1000 - at * 2 + (wordStart ? 200 : 0) + Math.min(200, needle.length * 20)
  }
  let score = 0
  let position = 0
  let previousHit = -2
  for (const char of needle) {
    const at = haystack.indexOf(char, position)
    if (at === -1) return 0
    const wordStart = at === 0 || /[\s\-_./›(]/.test(haystack[at - 1])
    score += 10 + (wordStart ? 25 : 0) + (at === previousHit + 1 ? 15 : 0) - Math.min(8, at - position)
    previousHit = at
    position = at + 1
  }
  return Math.max(1, score)
}

/**
 * Rank notes for the switcher: with an empty query the most recently visited
 * notes come first, then the rest alphabetically; with a query the best fuzzy
 * match on title, then path, decides, recency breaking ties.
 */
export const rankSwitcherNotes = (
  paths: readonly string[],
  query: string,
  recent: readonly string[] = [],
  limit = 40,
): SwitcherNote[] => {
  const recency = new Map<string, number>()
  recent.forEach((path, index) => { if (!recency.has(path)) recency.set(path, index) })
  const notes = paths.map(switcherNoteFor)
  const trimmed = query.trim()
  if (!trimmed) {
    const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
    return notes
      .sort((left, right) => {
        const leftRecent = recency.get(left.path) ?? Number.POSITIVE_INFINITY
        const rightRecent = recency.get(right.path) ?? Number.POSITIVE_INFINITY
        if (leftRecent !== rightRecent) return leftRecent - rightRecent
        return collator.compare(left.title, right.title) || collator.compare(left.path, right.path)
      })
      .slice(0, limit)
  }
  return notes
    .map((note) => ({
      note,
      score: Math.max(fuzzyScore(trimmed, note.title) * 2, fuzzyScore(trimmed, note.path)),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      const leftRecent = recency.get(left.note.path) ?? Number.POSITIVE_INFINITY
      const rightRecent = recency.get(right.note.path) ?? Number.POSITIVE_INFINITY
      return leftRecent - rightRecent
    })
    .slice(0, limit)
    .map((entry) => entry.note)
}

// ─── Storage ────────────────────────────────────────────────────────────────

const safeStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
