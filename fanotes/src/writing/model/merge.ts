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
import { SCENE_FORMAT, type Paragraph, type Scene } from './types'

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
    if (previous && previous.key === paragraph.key && content(previous) === content(paragraph)) return paragraph
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
