// Paragraph-level merge of two versions of one scene, for sync. Every
// paragraph carries a version vector (device → edit count). For each
// paragraph id:
//   - one version's vector dominates the other's → that version wins;
//   - the vectors are concurrent (both devices changed it) → the version with
//     the larger vector sum (then the larger content string) keeps the id, and
//     the other is kept right after it as a new paragraph marked `conflictOf`;
//   - an edit concurrent with a delete keeps the edit;
//   - present on one side only → kept (a new paragraph or a tombstone).
// The result is the same whichever side is "local", so two devices that merge
// each other's versions converge, and no text is ever dropped.
import { SCENE_FORMAT, type Paragraph, type Scene, type StoryManifest } from './types'

type Order = 'equal' | 'left' | 'right' | 'concurrent'

export const compareVectors = (left: Record<string, number>, right: Record<string, number>): Order => {
  let leftAhead = false
  let rightAhead = false
  for (const device of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const a = left[device] ?? 0
    const b = right[device] ?? 0
    if (a > b) leftAhead = true
    if (b > a) rightAhead = true
  }
  if (leftAhead && rightAhead) return 'concurrent'
  if (leftAhead) return 'left'
  if (rightAhead) return 'right'
  return 'equal'
}

export const mergeVectors = (left: Record<string, number>, right: Record<string, number>) => {
  const out: Record<string, number> = { ...left }
  for (const [device, count] of Object.entries(right)) out[device] = Math.max(out[device] ?? 0, count)
  return out
}

const content = (paragraph: Paragraph) => JSON.stringify([paragraph.deleted ? 1 : 0, paragraph.style, paragraph.align ?? '', paragraph.lang ?? '', paragraph.breakBefore ?? '', paragraph.runs])
const vectorSum = (vector: Record<string, number>) => Object.values(vector).reduce((sum, count) => sum + count, 0)

/** Deterministic preference between two concurrent versions. */
const prefer = (left: Paragraph, right: Paragraph) => {
  const sums = vectorSum(left.v) - vectorSum(right.v)
  if (sums !== 0) return sums > 0 ? left : right
  return content(left) >= content(right) ? left : right
}

/** A stable short hash, so both devices give the kept copy the same id. */
const shortHash = (value: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

export type SceneMerge = { scene: Scene; conflicts: number; changedFromLeft: boolean; changedFromRight: boolean }

export const mergeScenes = (left: Scene, right: Scene): SceneMerge => {
  const leftById = new Map(left.paragraphs.map((paragraph) => [paragraph.id, paragraph]))
  const rightById = new Map(right.paragraphs.map((paragraph) => [paragraph.id, paragraph]))
  const merged: Paragraph[] = []
  let conflicts = 0
  for (const id of new Set([...leftById.keys(), ...rightById.keys()])) {
    const a = leftById.get(id)
    const b = rightById.get(id)
    if (!a || !b) {
      merged.push({ ...(a ?? b)! })
      continue
    }
    const order = compareVectors(a.v, b.v)
    if (order === 'left' || (order === 'equal' && content(a) === content(b))) {
      merged.push({ ...a })
      continue
    }
    if (order === 'right') {
      merged.push({ ...b })
      continue
    }
    if (content(a) === content(b)) {
      merged.push({ ...a, v: mergeVectors(a.v, b.v) })
      continue
    }
    // Both changed it. An edit wins over a delete; two edits are both kept.
    if (a.deleted || b.deleted) {
      const kept = a.deleted ? b : a
      merged.push({ ...kept, v: mergeVectors(a.v, b.v) })
      continue
    }
    const winner = prefer(a, b)
    const other = winner === a ? b : a
    conflicts += 1
    merged.push({ ...winner, v: mergeVectors(a.v, b.v) })
    const copyId = `${id.slice(0, 24)}x${shortHash(content(other))}`
    if (!leftById.has(copyId) && !rightById.has(copyId)) {
      merged.push({ ...other, id: copyId, key: `${winner.key}V${shortHash(copyId).replace(/0+$/u, '') || 'V'}`, conflictOf: id })
    }
  }
  merged.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id.localeCompare(y.id)))
  const footnotes = { ...(right.footnotes ?? {}), ...(left.footnotes ?? {}) }
  const comments = { ...(right.comments ?? {}), ...(left.comments ?? {}) }
  const scene: Scene = {
    format: SCENE_FORMAT,
    id: left.id,
    paragraphs: merged,
    ...(Object.keys(footnotes).length ? { footnotes } : {}),
    ...(Object.keys(comments).length ? { comments } : {}),
  }
  const same = (x: Scene, y: Scene) => JSON.stringify(x.paragraphs) === JSON.stringify(y.paragraphs)
  return { scene, conflicts, changedFromLeft: !same(scene, left), changedFromRight: !same(scene, right) }
}

/**
 * Bumps this writer's counter on every paragraph that differs from the last
 * saved version (text, style, order, deletion). Run before each save.
 */
export const stampEdits = (current: Scene, saved: Scene | null, writer: string): Scene => {
  const before = new Map((saved?.paragraphs ?? []).map((paragraph) => [paragraph.id, paragraph]))
  let changed = false
  const paragraphs = current.paragraphs.map((paragraph) => {
    const previous = before.get(paragraph.id)
    if (previous && previous.key === paragraph.key && content(previous) === content(paragraph)) {
      // Unchanged, but the saved copy may carry newer counters (saved while this was being edited elsewhere in the doc).
      if (compareVectors(previous.v, paragraph.v) === 'equal') return paragraph
      changed = true
      return { ...paragraph, v: mergeVectors(previous.v, paragraph.v) }
    }
    changed = true
    const base = previous ? mergeVectors(previous.v, paragraph.v) : paragraph.v
    return { ...paragraph, v: { ...base, [writer]: (base[writer] ?? 0) + 1 } }
  })
  // A paragraph that is gone without a tombstone would come back on the next
  // merge with a device that still has it; record the delete.
  const present = new Set(current.paragraphs.map((paragraph) => paragraph.id))
  for (const previous of saved?.paragraphs ?? []) {
    if (present.has(previous.id)) continue
    changed = true
    paragraphs.push({ id: previous.id, key: previous.key, style: previous.style, runs: [], deleted: true, v: { ...previous.v, [writer]: (previous.v[writer] ?? 0) + 1 } })
  }
  if (!changed) return current
  paragraphs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id.localeCompare(y.id)))
  return { ...current, paragraphs }
}

// ── Manifest merge ─────────────────────────────────────────────────────────

type BinderRecord = { id: string; children?: BinderRecord[] } & Record<string, unknown>

const binderIds = (nodes: readonly BinderRecord[], into = new Set<string>()) => {
  for (const node of nodes) {
    into.add(node.id)
    if (Array.isArray(node.children)) binderIds(node.children, into)
  }
  return into
}

/**
 * The newer binder decides structure, titles and attributes; every node only
 * the older one has is kept, at its place among its older siblings. Nothing
 * is dropped, so a node deleted on one side and edited on the other stays.
 */
const mergeBinders = (newer: readonly BinderRecord[], older: readonly BinderRecord[]): BinderRecord[] => {
  const inNewer = binderIds(newer)
  const placed = new Set<string>()
  // Older-only nodes with their older-only descendants.
  const olderOnly = (node: BinderRecord): BinderRecord => {
    placed.add(node.id)
    const out: BinderRecord = { ...node }
    if (Array.isArray(node.children)) out.children = node.children.filter((child) => !inNewer.has(child.id) && !placed.has(child.id)).map(olderOnly)
    return out
  }
  const olderChildren = new Map<string | null, BinderRecord[]>()
  const indexOlder = (nodes: readonly BinderRecord[], parent: string | null) => {
    olderChildren.set(parent, [...nodes])
    for (const node of nodes) if (Array.isArray(node.children)) indexOlder(node.children, node.id)
  }
  indexOlder(older, null)
  /** Inserts a parent's older-only children after their nearest older sibling that is already in the list. */
  const weave = (list: BinderRecord[], parent: string | null): BinderRecord[] => {
    const extra = olderChildren.get(parent) ?? []
    const out = [...list]
    let anchor: string | null = null
    for (const node of extra) {
      if (inNewer.has(node.id)) { anchor = node.id; continue }
      if (placed.has(node.id)) continue
      const kept = olderOnly(node)
      const at = anchor === null ? -1 : out.findIndex((entry) => entry.id === anchor)
      out.splice(at + 1, 0, kept)
      anchor = node.id
    }
    return out
  }
  const walk = (nodes: readonly BinderRecord[], parent: string | null): BinderRecord[] => {
    const own: BinderRecord[] = []
    for (const node of nodes) {
      if (placed.has(node.id)) continue
      placed.add(node.id)
      const out: BinderRecord = { ...node }
      const children = walk(Array.isArray(node.children) ? node.children : [], node.id)
      if (Array.isArray(node.children) || children.length) out.children = children
      own.push(out)
    }
    return weave(own, parent)
  }
  return walk(newer, null)
}

const unionList = (first: unknown, second: unknown): string[] | undefined => {
  const lists = [first, second].filter((value): value is unknown[] => Array.isArray(value))
  if (!lists.length) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) for (const value of list) if (typeof value === 'string' && !seen.has(value)) { seen.add(value); out.push(value) }
  return out
}

export type ManifestMerge = { manifest: StoryManifest; changedFromLeft: boolean; changedFromRight: boolean }

/**
 * Merges two versions of `story.json`. The version with the newer `updatedAt`
 * (ties: the larger JSON, so both devices pick the same) gives titles,
 * attributes, page setup, goals and styles; styles only the older one has are
 * kept. The binder is merged by node id (see `mergeBinders`), the story
 * dictionary and ignored findings are unioned. Fields this version of the app
 * does not know are carried over. The result is the same whichever side is
 * "left", so two devices converge.
 */
export const mergeManifests = (left: StoryManifest, right: StoryManifest): ManifestMerge => {
  const leftJson = JSON.stringify(left)
  const rightJson = JSON.stringify(right)
  const leftNewer = left.updatedAt !== right.updatedAt ? left.updatedAt > right.updatedAt : leftJson >= rightJson
  const newer = leftNewer ? left : right
  const older = leftNewer ? right : left
  const merged = { ...older, ...newer } as StoryManifest & Record<string, unknown>
  merged.createdAt = older.createdAt && older.createdAt < newer.createdAt ? older.createdAt : newer.createdAt
  merged.updatedAt = newer.updatedAt
  if (newer.styles || older.styles) merged.styles = { ...(older.styles ?? {}), ...(newer.styles ?? {}) }
  merged.binder = mergeBinders((newer.binder ?? []) as unknown as BinderRecord[], (older.binder ?? []) as unknown as BinderRecord[]) as unknown as StoryManifest['binder']
  const dictionary = unionList(newer.dictionary, older.dictionary)
  if (dictionary) merged.dictionary = dictionary
  const ignored = unionList(newer.ignored, older.ignored)
  if (ignored) merged.ignored = ignored
  const json = JSON.stringify(merged)
  return { manifest: merged, changedFromLeft: json !== leftJson, changedFromRight: json !== rightJson }
}
