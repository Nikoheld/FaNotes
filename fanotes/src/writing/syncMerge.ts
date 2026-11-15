// How the sync engine treats the files of a `.story` folder when both this
// device and another one changed the same file. Pure functions on bytes, used
// by the desktop/web engine (`src/lib/sync/engine.ts`); Android's
// `StorySync.kt` implements the same rules on the same fixtures
// (`scripts/fixtures/writing-sync/`).
//
//   scenes/<id>.json           paragraph merge (`mergeScenes`), no conflict copy
//   story.json                 manifest merge (`mergeManifests`), no conflict copy
//   bible/<kind>/<id>.json     the newer `updatedAt` keeps the path, the other is a conflict copy
//   bible/notes/<id>.md        the newer file keeps the path, the other is a conflict copy
//   progress/**, snapshots/**  per device / immutable: today's rules (both kept)
//
// A file that does not parse as what its path says is never merged: the
// engine falls back to keeping both versions as files.
import { mergeManifests, mergeScenes } from './model/merge'
import { SCENE_FORMAT, STORY_FORMAT, type Scene, type StoryManifest } from './model/types'

export type StoryRole = 'manifest' | 'scene' | 'entity' | 'note' | 'progress' | 'snapshot' | 'other'

const STORY_ROOT = /^(.+?\.story)\/(.+)$/iu

/** The `.story` folder a vault path lies in, and the path inside it. */
export const storyPartOf = (path: string): { root: string; relative: string } | null => {
  const match = STORY_ROOT.exec(path)
  return match ? { root: match[1], relative: match[2] } : null
}

export const storyRoleOf = (path: string): StoryRole | null => {
  const part = storyPartOf(path)
  if (!part) return null
  const relative = part.relative
  if (relative === 'story.json') return 'manifest'
  if (/^scenes\/[0-9a-z]{6,40}\.json$/u.test(relative)) return 'scene'
  if (/^bible\/(?:characters|places|events)\/[0-9a-z]{6,40}\.json$/u.test(relative)) return 'entity'
  if (/^bible\/notes\/[0-9a-z]{6,40}\.md$/u.test(relative)) return 'note'
  if (relative.startsWith('progress/')) return 'progress'
  if (relative.startsWith('snapshots/')) return 'snapshot'
  return 'other'
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

const parse = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isVector = (value: unknown) => isRecord(value) && Object.values(value).every((count) => typeof count === 'number' && Number.isFinite(count))

/**
 * A scene the merge can work on: every paragraph has a unique id, a key, a
 * style, a version vector and runs. Anything else is left to the conflict copy.
 */
export const mergeableScene = (value: unknown, expectedId?: string): Scene | null => {
  if (!isRecord(value) || value.format !== SCENE_FORMAT || typeof value.id !== 'string' || !Array.isArray(value.paragraphs)) return null
  if (expectedId && value.id !== expectedId) return null
  const seen = new Set<string>()
  for (const paragraph of value.paragraphs) {
    if (!isRecord(paragraph) || typeof paragraph.id !== 'string' || typeof paragraph.key !== 'string' || typeof paragraph.style !== 'string') return null
    if (!isVector(paragraph.v) || !Array.isArray(paragraph.runs) || seen.has(paragraph.id)) return null
    seen.add(paragraph.id)
  }
  if (value.footnotes !== undefined && !isRecord(value.footnotes)) return null
  if (value.comments !== undefined && !isRecord(value.comments)) return null
  return value as unknown as Scene
}

/** A manifest the merge can work on (the editor repairs the rest when it opens it). */
export const mergeableManifest = (value: unknown): StoryManifest | null => {
  if (!isRecord(value) || value.format !== STORY_FORMAT || typeof value.id !== 'string' || typeof value.updatedAt !== 'string' || !Array.isArray(value.binder)) return null
  const ok = (nodes: unknown[], depth: number): boolean => depth < 12 && nodes.every((node) => isRecord(node) && typeof node.id === 'string' && (node.children === undefined || (Array.isArray(node.children) && ok(node.children, depth + 1))))
  return ok(value.binder, 0) ? value as unknown as StoryManifest : null
}

/** Footnotes and comments by id; when both sides have one id, the larger JSON wins on every device alike. */
const mergeById = <T>(left: Record<string, T> | undefined, right: Record<string, T> | undefined) => {
  const out: Record<string, T> = {}
  for (const source of [right ?? {}, left ?? {}]) {
    for (const [id, value] of Object.entries(source)) {
      const current = out[id]
      out[id] = current === undefined || JSON.stringify(value) > JSON.stringify(current) ? value : current
    }
  }
  // Sorted, so both devices write the same bytes.
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
}

/** The paragraph merge plus deterministic footnotes and comments, so both devices write the same scene. */
export const mergeSceneVersions = (left: Scene, right: Scene) => {
  const result = mergeScenes(left, right)
  const footnotes = mergeById(left.footnotes, right.footnotes)
  const comments = mergeById(left.comments, right.comments)
  const scene: Scene = {
    format: SCENE_FORMAT,
    id: result.scene.id,
    paragraphs: result.scene.paragraphs,
    ...(Object.keys(footnotes).length ? { footnotes } : {}),
    ...(Object.keys(comments).length ? { comments } : {}),
  }
  return { scene, conflicts: result.conflicts }
}

/** What the editor writes (`storage.ts`), so a merged file looks like a saved one. */
export const serializeScene = (scene: Scene) => `${JSON.stringify(scene)}\n`
export const serializeManifest = (manifest: StoryManifest) => `${JSON.stringify(manifest, null, 1)}\n`

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export type StoryMergeOutcome =
  /** Both versions merged into one file. `sameAsRemote`: the remote already holds everything. */
  | { kind: 'merged'; bytes: Uint8Array; sameAsRemote: boolean; sameAsLocal: boolean; conflicts: number }
  /** Per-entity file: which version keeps the path. The other becomes a conflict copy. */
  | { kind: 'pick'; keep: 'local' | 'remote' }
  /** The remote file is damaged or not a story file; the local one keeps the path. */
  | { kind: 'keep-local' }

/**
 * Both sides changed a story file. Null: not a story file, or nothing to merge
 * (the engine keeps today's behaviour, a conflict copy of the local version).
 */
export const mergeStoryFile = (
  path: string,
  local: Uint8Array,
  remote: Uint8Array,
  times: { localMtimeMs: number; remoteMtimeMs: number },
): StoryMergeOutcome | null => {
  const role = storyRoleOf(path)
  if (role === 'scene') {
    const id = path.slice(path.lastIndexOf('/') + 1, -5)
    const mine = mergeableScene(parse(local), id)
    const theirs = mergeableScene(parse(remote), id)
    if (!mine) return null
    if (!theirs) return { kind: 'keep-local' }
    const { scene, conflicts } = mergeSceneVersions(mine, theirs)
    return { kind: 'merged', bytes: encoder.encode(serializeScene(scene)), sameAsRemote: sameJson(scene, theirs), sameAsLocal: sameJson(scene, mine), conflicts }
  }
  if (role === 'manifest') {
    const mine = mergeableManifest(parse(local))
    const theirs = mergeableManifest(parse(remote))
    if (!mine) return null
    if (!theirs) return { kind: 'keep-local' }
    if (mine.id !== theirs.id) return null
    const { manifest } = mergeManifests(mine, theirs)
    return { kind: 'merged', bytes: encoder.encode(serializeManifest(manifest)), sameAsRemote: sameJson(manifest, theirs), sameAsLocal: sameJson(manifest, mine), conflicts: 0 }
  }
  if (role === 'entity') {
    const mine = parse(local)
    const theirs = parse(remote)
    const stamp = (value: unknown) => (isRecord(value) && typeof value.updatedAt === 'string' ? value.updatedAt : '')
    if (!isRecord(mine)) return null
    if (!isRecord(theirs)) return { kind: 'keep-local' }
    const a = stamp(mine)
    const b = stamp(theirs)
    if (a !== b) return { kind: 'pick', keep: a > b ? 'local' : 'remote' }
    return { kind: 'pick', keep: times.localMtimeMs > times.remoteMtimeMs ? 'local' : 'remote' }
  }
  if (role === 'note') return { kind: 'pick', keep: times.localMtimeMs > times.remoteMtimeMs ? 'local' : 'remote' }
  return null
}

export type ShrinkVerdict =
  /** A deliberate cut: every paragraph the server has is still here (live or as a tombstone). Upload as it is. */
  | { kind: 'cut' }
  /** The local file lost paragraphs without a trace; upload this merge instead. */
  | { kind: 'merge'; bytes: Uint8Array }
  /** Not provable: keep the guard (the server copy stays, the local one is kept beside it). */
  | { kind: 'guard' }

/**
 * The shrink guard saw a much smaller story file. A scene that keeps a
 * tombstone for every paragraph of the server's version is a cut the writer
 * made; one that is missing paragraphs is merged with the server's version so
 * nothing is lost. A manifest with the same story id that is at least as new
 * is the editor's own save (it never writes one it could not load).
 */
export const judgeStoryShrink = (path: string, local: Uint8Array, server: Uint8Array): ShrinkVerdict => {
  const role = storyRoleOf(path)
  if (role === 'scene') {
    const id = path.slice(path.lastIndexOf('/') + 1, -5)
    const mine = mergeableScene(parse(local), id)
    const theirs = mergeableScene(parse(server), id)
    if (!mine || !theirs) return { kind: 'guard' }
    const present = new Set(mine.paragraphs.map((paragraph) => paragraph.id))
    if (theirs.paragraphs.every((paragraph) => present.has(paragraph.id))) return { kind: 'cut' }
    return { kind: 'merge', bytes: encoder.encode(serializeScene(mergeSceneVersions(mine, theirs).scene)) }
  }
  if (role === 'manifest') {
    const mine = mergeableManifest(parse(local))
    const theirs = mergeableManifest(parse(server))
    if (!mine || !theirs || mine.id !== theirs.id) return { kind: 'guard' }
    if (mine.updatedAt >= theirs.updatedAt) return { kind: 'cut' }
    return { kind: 'merge', bytes: encoder.encode(serializeManifest(mergeManifests(mine, theirs).manifest)) }
  }
  return { kind: 'guard' }
}
