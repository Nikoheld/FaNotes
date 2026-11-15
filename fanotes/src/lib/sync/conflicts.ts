// Conflict copies: their names, how to find them in a vault, and how the copies
// of one note (its `.md` and `.famd` files) belong together.
//
// When two devices changed the same file, the version on the server keeps the
// path and the other one is saved next to it as
// `Name (Konflikt <Gerät> <YYYY-MM-DD HH-MM>).ext` (Android adds ` 2`, ` 3` …
// inside the bracket when a copy from the same minute already exists). Every
// device gets both files through sync, so any device can resolve the conflict:
// the copies are found by name, not only through the device that made them.

import { identitySyncBytes } from '../famd'
import { sha256Hex } from './crypto'

export type ConflictPair = { path: string; copyPath: string }

export type ConflictGroup = {
  /** Stable key: the copy's path without its extension. */
  id: string
  /** The document's name as the tree shows it. */
  title: string
  /** The file that kept the original path (the note's `.md` when it has one). */
  path: string
  copyPath: string
  /** Every original/copy pair of the document, e.g. `Note.md` and `Note.famd`. */
  pairs: ConflictPair[]
  /** Device named in the copy, the one whose version was set aside. */
  device: string | null
  /** When the copy was made (ISO). */
  at: string | null
  /** The original path no longer exists; only the copy is left. */
  originalMissing: boolean
  /** A FaNotes data file under `.fanotes/` (handwriting record, settings). */
  internal: boolean
  /** Size and modification time of each file, when the engine listed them. */
  files?: Record<string, { size: number; mtimeMs: number }>
}

export type ConflictKeep = 'original' | 'copy' | 'both'

type Recorded = { path: string; copyPath: string; at: string }

const COPY_STEM = /^(.+) \(Konflikt (.+?) (\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})(?: (\d{1,13}))?\)$/u

const splitPath = (path: string) => {
  const slash = path.lastIndexOf('/')
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')
  return { directory, name, stem: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot) : '' }
}

export type ParsedConflictCopy = { originalPath: string; device: string; at: string | null; copyStem: string }

/** The original path, device and time a conflict copy's name records, or null for any other file. */
export const parseConflictCopyPath = (path: string): ParsedConflictCopy | null => {
  const { directory, stem, extension } = splitPath(path)
  const match = COPY_STEM.exec(stem)
  if (!match) return null
  const [, original, device, year, month, day, hour, minute] = match
  const when = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  return {
    originalPath: `${directory}${original}${extension}`,
    device: device.trim(),
    at: Number.isFinite(when.getTime()) ? when.toISOString() : null,
    copyStem: `${directory}${stem}`,
  }
}

export const isConflictCopyPath = (path: string) => parseConflictCopyPath(path) !== null

/**
 * The name a conflict copy gets when both versions are kept:
 * `Name (Fassung <Gerät> <Datum>).ext`. It is an ordinary file from then on.
 */
export const keptVersionPath = (copyPath: string) => {
  const { directory, stem, extension } = splitPath(copyPath)
  return `${directory}${stem.replace(/ \(Konflikt (.+)\)$/u, ' (Fassung $1)')}${extension}`
}

/** `Name (… 2).ext` for `Name (…).ext`: the numbering Android uses for a second copy in the same minute. */
export const numberedVariant = (path: string, number: number) => {
  const { directory, stem, extension } = splitPath(path)
  const open = stem.endsWith(')') ? stem.slice(0, -1) : `${stem} (`
  return `${directory}${open} ${number})${extension}`
}

const NOTE_TEXT = /\.(?:md|markdown)$/iu
const noteTitle = (path: string) => splitPath(path).name.replace(/\.(?:md|markdown|famd|pdf)$/iu, '')

/**
 * Open conflicts in a vault: every conflict copy in `present`, grouped by
 * document. `recorded` adds the time this device noted for its own copies.
 */
export const groupConflicts = (present: ReadonlySet<string>, recorded: readonly Recorded[] = []): ConflictGroup[] => {
  const recordedAt = new Map(recorded.map((entry) => [entry.copyPath, entry.at]))
  const groups = new Map<string, { pairs: ConflictPair[]; device: string; at: string | null }>()
  for (const copyPath of present) {
    const parsed = parseConflictCopyPath(copyPath)
    if (!parsed) continue
    const group = groups.get(parsed.copyStem) ?? { pairs: [], device: parsed.device, at: parsed.at }
    group.pairs.push({ path: parsed.originalPath, copyPath })
    // The time this device recorded is exact; the name only has minutes.
    const noted = recordedAt.get(copyPath)
    if (noted) group.at = noted
    groups.set(parsed.copyStem, group)
  }
  return [...groups.entries()].map(([id, group]) => {
    const pairs = group.pairs.sort((left, right) => left.path.localeCompare(right.path))
    const primary = pairs.find((pair) => NOTE_TEXT.test(pair.path)) ?? pairs[0]
    return {
      id,
      title: noteTitle(primary.path),
      path: primary.path,
      copyPath: primary.copyPath,
      pairs,
      device: group.device || null,
      at: group.at,
      originalMissing: pairs.every((pair) => !present.has(pair.path)),
      internal: primary.path.startsWith('.fanotes/'),
    }
  }).sort((left, right) => (right.at ?? '').localeCompare(left.at ?? '') || left.title.localeCompare(right.title))
}

/**
 * What "the version the user saw" means: the note's text, handwriting and
 * fields. Page statistics and save timestamps, which the app rewrites on its
 * own, do not count. Null for a missing file.
 */
export const conflictFingerprint = async (path: string, bytes: Uint8Array | null) => (
  bytes ? sha256Hex(identitySyncBytes(path, bytes) ?? bytes) : null
)
