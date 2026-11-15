// Snapshots of a scene (`snapshots/<sceneId>/<stamp>.json`): taken by hand,
// and automatically before a restore or "replace all". They are immutable
// files, so they sync without conflicts. Restoring goes through the normal
// edit path (paragraph ids kept, removed paragraphs become tombstones), so a
// restore merges with other devices like any other edit.
import { runsText } from './runs'
import { sanitizeScene } from './sanitize'
import { SCENE_FORMAT, type Comment, type Footnote, type Paragraph, type Scene } from './types'

export const SNAPSHOT_FORMAT = 'fanotes-story-snapshot-v1' as const
export type SnapshotReason = 'manual' | 'restore' | 'replace'

export type Snapshot = {
  format: typeof SNAPSHOT_FORMAT
  sceneId: string
  /** File stamp: UTC time plus the writer, e.g. 20261115T153012Z-ab12cd. */
  stamp: string
  takenAt: string
  takenBy?: string
  /** Scene title at the time. */
  title: string
  note?: string
  reason: SnapshotReason
  paragraphs: Paragraph[]
  footnotes?: Record<string, Footnote>
  comments?: Record<string, Comment>
}

export const snapshotStamp = (date: Date, writer: string) => `${date.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')}-${writer.slice(0, 8)}`
export const snapshotPath = (storyPath: string, sceneId: string, stamp: string) => `${storyPath}/snapshots/${sceneId}/${stamp}.json`
export const snapshotFileOf = (relative: string) => {
  const match = /^snapshots\/([0-9a-z]{6,40})\/(\d{8}T\d{6}Z-[0-9a-z]{1,16})\.json$/u.exec(relative)
  return match ? { sceneId: match[1], stamp: match[2] } : null
}

export const makeSnapshot = (scene: Scene, title: string, writer: string, reason: SnapshotReason, note = '', now = new Date()): Snapshot => ({
  format: SNAPSHOT_FORMAT,
  sceneId: scene.id,
  stamp: snapshotStamp(now, writer),
  takenAt: now.toISOString(),
  takenBy: writer,
  title,
  ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}),
  reason,
  paragraphs: scene.paragraphs.filter((paragraph) => !paragraph.deleted),
  ...(scene.footnotes && Object.keys(scene.footnotes).length ? { footnotes: scene.footnotes } : {}),
  ...(scene.comments && Object.keys(scene.comments).length ? { comments: scene.comments } : {}),
})

export const sanitizeSnapshot = (value: unknown): Snapshot | null => {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  if (source.format !== SNAPSHOT_FORMAT || typeof source.stamp !== 'string' || !/^\d{8}T\d{6}Z-[0-9a-z]{1,16}$/u.test(source.stamp)) return null
  const scene = sanitizeScene({ format: SCENE_FORMAT, id: source.sceneId, paragraphs: source.paragraphs, footnotes: source.footnotes, comments: source.comments })
  if (!scene) return null
  const reason = (['manual', 'restore', 'replace'] as const).find((value) => value === source.reason) ?? 'manual'
  return {
    format: SNAPSHOT_FORMAT,
    sceneId: scene.id,
    stamp: source.stamp,
    takenAt: typeof source.takenAt === 'string' ? source.takenAt.slice(0, 40) : '',
    ...(typeof source.takenBy === 'string' ? { takenBy: source.takenBy.slice(0, 40) } : {}),
    title: typeof source.title === 'string' ? source.title.slice(0, 300) : '',
    ...(typeof source.note === 'string' && source.note ? { note: source.note.slice(0, 500) } : {}),
    reason,
    paragraphs: scene.paragraphs.filter((paragraph) => !paragraph.deleted),
    ...(scene.footnotes ? { footnotes: scene.footnotes } : {}),
    ...(scene.comments ? { comments: scene.comments } : {}),
  }
}

export type WordPiece = { text: string; kind: 'same' | 'added' | 'removed' }
export type DiffRow =
  | { kind: 'same'; id: string; text: string }
  | { kind: 'changed'; id: string; before: string; after: string; pieces: WordPiece[] }
  | { kind: 'added'; id: string; text: string }
  | { kind: 'removed'; id: string; text: string }

/** Word-level diff (longest common subsequence over words and spaces). */
export const diffWords = (before: string, after: string): WordPiece[] => {
  const a = before.match(/\s+|[^\s]+/gu) ?? []
  const b = after.match(/\s+|[^\s]+/gu) ?? []
  if (a.length * b.length > 400_000) return [{ text: before, kind: 'removed' }, { text: after, kind: 'added' }]
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const out: WordPiece[] = []
  const push = (text: string, kind: WordPiece['kind']) => {
    const last = out.at(-1)
    if (last && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(a[i], 'same'); i += 1; j += 1 }
    else if (table[i + 1][j] >= table[i][j + 1]) { push(a[i], 'removed'); i += 1 }
    else { push(b[j], 'added'); j += 1 }
  }
  while (i < a.length) { push(a[i], 'removed'); i += 1 }
  while (j < b.length) { push(b[j], 'added'); j += 1 }
  return out
}

const paragraphText = (paragraph: Paragraph) => runsText(paragraph.runs)

/** Paragraph rows of "then" (a snapshot) against "now", in reading order. */
export const diffScene = (then: Paragraph[], now: Paragraph[]): DiffRow[] => {
  const before = new Map(then.filter((paragraph) => !paragraph.deleted).map((paragraph) => [paragraph.id, paragraph]))
  const after = new Map(now.filter((paragraph) => !paragraph.deleted).map((paragraph) => [paragraph.id, paragraph]))
  const ids = [...new Set([...before.keys(), ...after.keys()])]
  const keyOf = (id: string) => (after.get(id) ?? before.get(id))!.key
  ids.sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : x.localeCompare(y)))
  return ids.map((id): DiffRow => {
    const old = before.get(id)
    const current = after.get(id)
    if (old && current) {
      const a = paragraphText(old)
      const b = paragraphText(current)
      return a === b && old.style === current.style ? { kind: 'same', id, text: b } : { kind: 'changed', id, before: a, after: b, pieces: diffWords(a, b) }
    }
    return current ? { kind: 'added', id, text: paragraphText(current) } : { kind: 'removed', id, text: paragraphText(old!) }
  })
}

/**
 * The scene as it was in the snapshot, expressed as edits of the current
 * scene: same paragraph ids, paragraphs added since become tombstones,
 * paragraphs deleted since come back. Version vectors are kept; the save
 * stamps the changed paragraphs (stampEdits), so other devices merge it.
 */
export const restoreSnapshot = (current: Scene, snapshot: Snapshot): Scene => {
  const wanted = new Map(snapshot.paragraphs.map((paragraph) => [paragraph.id, paragraph]))
  const seen = new Set<string>()
  const paragraphs: Paragraph[] = current.paragraphs.map((paragraph): Paragraph => {
    seen.add(paragraph.id)
    const target = wanted.get(paragraph.id)
    if (!target) return paragraph.deleted ? paragraph : { id: paragraph.id, key: paragraph.key, v: paragraph.v, style: paragraph.style, runs: [], deleted: true }
    const restored: Paragraph = { id: paragraph.id, key: target.key, v: paragraph.v, style: target.style, runs: target.runs }
    if (target.lang) restored.lang = target.lang
    if (target.align) restored.align = target.align
    if (target.breakBefore) restored.breakBefore = target.breakBefore
    return restored
  })
  for (const paragraph of snapshot.paragraphs) if (!seen.has(paragraph.id)) paragraphs.push(paragraph)
  paragraphs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id.localeCompare(y.id)))
  return {
    ...current,
    paragraphs,
    footnotes: { ...(current.footnotes ?? {}), ...(snapshot.footnotes ?? {}) },
    comments: { ...(current.comments ?? {}), ...(snapshot.comments ?? {}) },
  }
}
