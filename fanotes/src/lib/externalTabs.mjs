// What to do with an open note when its file changes outside FaNotes (Explorer,
// another editor, a sync tool). Everything here is pure: no DOM, no IPC. App
// gathers the facts (what the tab holds, what the file holds now) and carries
// the decision out, so the rules can be checked in plain Node.

/** The vault watcher cuts each list at this many paths; a list this long may be incomplete. */
export const WATCH_LIST_LIMIT = 500
/** How many of this app's own recent writes per note are remembered, so an autosave never looks like an outside edit. */
export const OWN_WRITE_MEMORY = 4
/** Without a matching file signature, rename candidates are only read when there are at most this many. */
export const BLIND_RENAME_LIMIT = 6

/** Line endings and trailing whitespace carry no meaning when two versions of a note are compared (the vault trims them on read). */
export const normalizeNoteText = (text) => (typeof text === 'string' ? text : '')
  .replace(/\r\n?/gu, '\n')
  .replace(/\s+$/u, '')

export const sameNoteText = (left, right) => normalizeNoteText(left) === normalizeNoteText(right)

/** A short stand-in for a note text, so the memory of own writes does not hold several copies of a large note. */
export const noteTextFingerprint = (text) => {
  const body = normalizeNoteText(text)
  let hash = 0x811c9dc5
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${body.length}:${(hash >>> 0).toString(16)}`
}

/** The newest-first list of own writes with `body` added. */
export const rememberOwnWrite = (list, body) => {
  const mark = noteTextFingerprint(body)
  return [mark, ...(Array.isArray(list) ? list : []).filter((entry) => entry !== mark)].slice(0, OWN_WRITE_MEMORY)
}

export const isOwnWrite = (list, text) => (Array.isArray(list) ? list : []).includes(noteTextFingerprint(text))

/**
 * The change list of the vault watcher as App may rely on it. The payload crosses
 * IPC unchecked; a list that reached the cap may be incomplete.
 */
export const normalizeVaultChange = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {}
  const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry).slice(0, WATCH_LIST_LIMIT) : [])
  const capped = [source.added, source.removed, source.changed].some((value) => Array.isArray(value) && value.length >= WATCH_LIST_LIMIT)
  return {
    added: list(source.added),
    removed: list(source.removed),
    changed: list(source.changed),
    unreliable: capped || source.truncated === true || !raw || typeof raw !== 'object',
  }
}

const NOTE_FILE = /\.(md|markdown|famd|pdf)$/iu

export const noteStemOf = (path) => String(path).replace(NOTE_FILE, '')

/** `md` for Markdown notes, `famd` for handwriting notes, `pdf` for PDF notes, '' for everything else. */
export const noteFamily = (path) => {
  const extension = /\.([^./\\]+)$/u.exec(String(path))?.[1]?.toLowerCase() ?? ''
  if (extension === 'md' || extension === 'markdown') return 'md'
  if (extension === 'famd' || extension === 'pdf') return extension
  return ''
}

/** The vault paths that make up one open tab: its note and the `.famd` companion that holds the ink, links and text fields. */
export const tabVaultPaths = (path) => {
  const companion = `${noteStemOf(path)}.famd`
  return companion === path ? [path] : [path, companion]
}

/** The open notes a change list is about. A list that may be incomplete, or no list at all, means all of them. */
export const implicatedTabPaths = (tabPaths, change) => {
  if (!change || change.unreliable) return [...tabPaths]
  const named = new Set([...change.added, ...change.removed, ...change.changed])
  return tabPaths.filter((path) => tabVaultPaths(path).some((candidate) => named.has(candidate)))
}

/**
 * What to do with one open note, given what its file holds now.
 *
 * `content` is the text the editor holds (typed text not yet saved included),
 * `savedContent` the text last read from or written to the file, `ownWrites` the
 * fingerprints of what this app wrote lately, `disk` what the file holds now
 * (`null` when it could not be read) and `hold` why the tab was paused earlier.
 *
 * The answer is one of
 *  - `none`      leave the tab alone,
 *  - `reload`    nothing unsaved: take the text from the file,
 *  - `adopt`     the unsaved text already equals the file: it counts as saved,
 *  - `release`   the file agrees with what the tab was based on again: lift the pause,
 *  - `deleted`   the file is gone: keep the text, pause saving,
 *  - `conflict`  unsaved text and an outside edit: keep the text, pause saving.
 * Neither side is ever overwritten by a decision.
 */
export const decideTabReconcile = (facts) => {
  const { content, savedContent, disk, hold = null, heldExternal = null } = facts
  const ownWrites = Array.isArray(facts.ownWrites) ? facts.ownWrites : []
  if (!disk) return { action: 'none' }
  if (!disk.exists) return hold === 'deleted' ? { action: 'none' } : { action: 'deleted' }
  const onDisk = disk.content
  // The file is what this tab last read or wrote (the watcher also reports the app's own autosaves).
  if (sameNoteText(onDisk, savedContent) || isOwnWrite(ownWrites, onDisk)) return hold ? { action: 'release' } : { action: 'none' }
  // Somebody else wrote it. The typed text may already be the same.
  if (sameNoteText(onDisk, content)) return { action: 'adopt' }
  if (sameNoteText(content, savedContent)) return { action: 'reload', content: onDisk }
  // Unsaved text and an outside edit: only a choice by the user may settle this.
  if (hold === 'conflict' && heldExternal !== null && sameNoteText(heldExternal, onDisk)) return { action: 'none' }
  return { action: 'conflict', external: onDisk }
}

const sameSignature = (left, right) => Boolean(
  left && right && left.modifiedAt && left.modifiedAt === right.modifiedAt
  && typeof left.size === 'number' && left.size === right.size,
)

/**
 * Where a note that vanished may have gone, from the paths that appeared in the
 * same change. `before` is the file's signature (modifiedAt, size) from the tree
 * before the change, `after` the signatures of the new tree. A rename keeps
 * both. Without a matching signature a few candidates of the same kind are
 * offered anyway; the caller then compares the text. A PDF has no text to
 * compare, so only a signature match counts for it.
 */
export const renameCandidates = ({ from, added, before = null, after = new Map(), taken = [] }) => {
  const family = noteFamily(from)
  if (!family) return []
  const blocked = new Set(taken)
  const same = (Array.isArray(added) ? added : []).filter((path) => path !== from && !blocked.has(path) && noteFamily(path) === family)
  const strict = before ? same.filter((path) => sameSignature(before, after.get(path))) : []
  if (strict.length) return strict
  return family !== 'pdf' && same.length <= BLIND_RENAME_LIMIT ? same : []
}

/**
 * Renaming only `a.md` outside FaNotes leaves its `.famd` companion (ink, links,
 * text fields) behind as `a.famd`, and the tree then lists it as a note of its
 * own. Where that file belongs after the rename so that it follows the note, or
 * null when there is nothing to move. Whether the files exist is for the caller.
 */
export const companionToFollow = ({ from, to }) => {
  const stale = `${noteStemOf(from)}.famd`
  const fresh = `${noteStemOf(to)}.famd`
  return stale === from || stale === fresh ? null : { from: stale, to: fresh }
}

/** The note a conflict copy is made of: Markdown notes keep their name, other notes (handwriting, PDF) become a `.md` file of their text. */
export const conflictCopyBase = (path) => (noteFamily(path) === 'md' ? path : `${noteStemOf(path)}.md`)

/** The device name a conflict copy carries (the same default the sync engine uses). */
export const conflictDeviceName = (configured, platform) => {
  const name = typeof configured === 'string' ? configured.trim() : ''
  if (name) return name
  if (platform === 'web' || platform === 'browser-preview') return 'Browser'
  if (platform === 'win32') return 'Windows-Gerät'
  if (platform === 'darwin') return 'Mac'
  if (platform === 'linux') return 'Linux-Gerät'
  return 'Gerät'
}
