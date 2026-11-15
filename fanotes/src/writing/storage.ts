// Story projects in the vault: `Name.story/story.json` and
// `Name.story/scenes/<id>.json`. The host (Electron main, the browser vault)
// only allows reads and writes inside a `.story` folder.
import type { StorageAdapter } from './editor/controller'
import { newStory, type NewStoryOptions } from './model/defaults'
import { mergeScenes } from './model/merge'
import { mergeableManifest, mergeableScene } from './syncMerge'
import { binderSceneIds, sanitizeManifest, sanitizeScene } from './model/sanitize'
import { newId } from './model/ids'
import { STORY_EXTENSION, type BinderNode, type Scene, type StoryManifest, type StoryProject } from './model/types'
import { L } from './ui/i18n'
import { bibleFileOf, biblePath, sanitizeBibleEntry, serializeBibleEntry, type BibleEntry } from './model/bible'
import { isProgressFile, progressPath, sanitizeProgress, type ProgressFile } from './model/progress'
import { sanitizeSnapshot, snapshotFileOf, snapshotPath, type Snapshot } from './model/snapshots'

export type StoryHost = {
  read: (path: string) => Promise<string | null>
  write: (path: string, content: string) => Promise<void>
  list: (storyPath: string) => Promise<string[]>
  create: (parentFolder: string, name: string) => Promise<string>
}

export const storyHost = (): StoryHost | null => {
  const api = typeof window !== 'undefined' ? window.fanotes : undefined
  if (!api?.storyRead || !api.storyWrite || !api.storyList || !api.storyCreate) return null
  return {
    read: (path) => api.storyRead!(path),
    write: (path, content) => api.storyWrite!(path, content),
    list: (storyPath) => api.storyList!(storyPath),
    create: (parent, name) => api.storyCreate!(parent, name),
  }
}

export const isStoryPath = (path: string) => path.toLocaleLowerCase('en-US').endsWith(STORY_EXTENSION)
export const storyTitleFromPath = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.story$/iu, '')
export const manifestPath = (storyPath: string) => `${storyPath}/story.json`
export const scenePath = (storyPath: string, sceneId: string) => `${storyPath}/scenes/${sceneId}.json`

export type LoadedProject = StoryProject & {
  /** Scenes the binder names whose file is not here (yet): kept out of the editor, never overwritten. */
  missing: string[]
  /** Scene files that no binder node named; they were added to a "found" folder. */
  recovered: string[]
  /** The manifest was repaired or extended and should be saved. */
  manifestChanged: boolean
  /** Every file in the story folder, relative to it (bible, snapshots, progress are loaded from this). */
  files: string[]
}

export const loadProject = async (host: StoryHost, path: string, labels: { recovered: string }): Promise<LoadedProject> => {
  const raw = await host.read(manifestPath(path))
  if (raw === null) throw new Error(L('Diese Geschichte ist (noch) nicht vollständig auf diesem Gerät: story.json fehlt.', 'This story is not (yet) complete on this device: story.json is missing.'))
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(L('story.json ist beschädigt. Die Szenen sind unverändert.', 'story.json is damaged. The scenes are unchanged.'))
  }
  let manifest = sanitizeManifest(parsed)
  if (!manifest) throw new Error(L('story.json ist keine FaNotes-Geschichte.', 'story.json is not a FaNotes story.'))
  const files = await host.list(path)
  const sceneFiles = files.filter((file) => /^scenes\/[0-9a-z]{6,40}\.json$/u.test(file))
  const scenes = new Map<string, Scene>()
  for (const file of sceneFiles) {
    const id = file.slice(7, -5)
    const text = await host.read(`${path}/${file}`)
    if (text === null) continue
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    const scene = sanitizeScene(value, id)
    if (scene) scenes.set(scene.id, scene)
  }
  const named = new Set(binderSceneIds(manifest.binder))
  const missing = [...named].filter((id) => !scenes.has(id))
  const recovered = [...scenes.keys()].filter((id) => !named.has(id))
  let manifestChanged = false
  if (recovered.length) {
    const folder: BinderNode = {
      id: newId(),
      kind: 'folder',
      title: labels.recovered,
      children: recovered.map((id, index) => ({ id, kind: 'scene', title: `${labels.recovered} ${index + 1}` })),
    }
    manifest = { ...manifest, binder: [...manifest.binder, folder] }
    manifestChanged = true
  }
  return { path, manifest, scenes, missing, recovered, manifestChanged, files }
}

const readJson = async (host: StoryHost, path: string): Promise<unknown> => {
  const text = await host.read(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Reads many files, a few at a time. */
const readAll = async <T>(paths: string[], read: (path: string) => Promise<T | null>, concurrency = 8) => {
  const out: T[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (next < paths.length) {
      const value = await read(paths[next++])
      if (value !== null) out.push(value)
    }
  }))
  return out
}

/** Characters, places and events by id (a damaged file is skipped, not overwritten). */
export const loadBible = async (host: StoryHost, path: string, files: string[]) => {
  const entries = await readAll(files.filter((file) => bibleFileOf(file)), async (file) => {
    const entry = sanitizeBibleEntry(await readJson(host, `${path}/${file}`))
    return entry && entry.id === bibleFileOf(file)!.id ? entry : null
  })
  return new Map(entries.map((entry) => [entry.id, entry]))
}

export const writeBibleEntry = (host: StoryHost, path: string, entry: BibleEntry) => host.write(biblePath(path, entry.kind, entry.id), serializeBibleEntry(entry))

/** Snapshot stamps of a scene, newest first (the files are read when opened). */
export const snapshotStamps = (files: string[], sceneId: string) => files.flatMap((file) => {
  const found = snapshotFileOf(file)
  return found && found.sceneId === sceneId ? [found.stamp] : []
}).sort().reverse()

export const readSnapshot = async (host: StoryHost, path: string, sceneId: string, stamp: string): Promise<Snapshot | null> => {
  const snapshot = sanitizeSnapshot(await readJson(host, snapshotPath(path, sceneId, stamp)))
  return snapshot && snapshot.sceneId === sceneId ? snapshot : null
}

export const writeSnapshot = (host: StoryHost, path: string, snapshot: Snapshot) => host.write(snapshotPath(path, snapshot.sceneId, snapshot.stamp), `${JSON.stringify(snapshot)}\n`)

/** Every device's progress file. */
export const loadProgress = (host: StoryHost, path: string, files: string[]) => readAll(files.filter(isProgressFile), async (file) => sanitizeProgress(await readJson(host, `${path}/${file}`)))

export const writeProgress = (host: StoryHost, path: string, progress: ProgressFile) => host.write(progressPath(path, progress.writer), `${JSON.stringify(progress)}\n`)

const readOrNull = async <T>(host: StoryHost, file: string, accept: (value: unknown) => T | null): Promise<T | null> => {
  try {
    const text = await host.read(file)
    return text === null ? null : accept(JSON.parse(text))
  } catch {
    return null
  }
}

export const storageAdapter = (host: StoryHost, path: string): StorageAdapter => ({
  writeManifest: (manifest: StoryManifest) => host.write(manifestPath(path), `${JSON.stringify(manifest, null, 1)}\n`),
  writeScene: (scene: Scene) => host.write(scenePath(path, scene.id), `${JSON.stringify(scene)}\n`),
  readScene: (id: string) => readOrNull(host, scenePath(path, id), (value) => mergeableScene(value, id)),
  readManifest: () => readOrNull(host, manifestPath(path), mergeableManifest),
})

/** Creates `Title.story` in a folder with its first chapter and scene. */
export const createProject = async (host: StoryHost, parentFolder: string, options: Omit<NewStoryOptions, 'deviceId'> & { deviceId: string }) => {
  const safe = options.title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120) || 'Geschichte'
  const path = await host.create(parentFolder, `${safe}${STORY_EXTENSION}`)
  const created = newStory(options)
  const adapter = storageAdapter(host, path)
  for (const scene of created.scenes) await adapter.writeScene(scene)
  await adapter.writeManifest(created.manifest)
  return path
}

/** Writes an imported story (DOCX, Markdown, text) as `Title.story` in a folder. */
export const saveImportedProject = async (host: StoryHost, parentFolder: string, story: { manifest: StoryManifest; scenes: Scene[] }) => {
  const safe = story.manifest.title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120) || 'Geschichte'
  const path = await host.create(parentFolder, `${safe}${STORY_EXTENSION}`)
  const adapter = storageAdapter(host, path)
  for (const scene of story.scenes) await adapter.writeScene(scene)
  await adapter.writeManifest(story.manifest)
  return path
}

// ── Crash journal ──────────────────────────────────────────────────────────

const journalKey = (path: string) => `fanotes.writing.journal.v1:${path}`

export const writeJournal = (path: string, entry: { manifest: StoryManifest | null; scenes: Scene[] } | null) => {
  try {
    if (!entry) localStorage.removeItem(journalKey(path))
    else localStorage.setItem(journalKey(path), JSON.stringify({ at: Date.now(), ...entry }))
  } catch {
    // Storage full or blocked: the autosave still runs.
  }
}

/**
 * Unsaved edits from a session that ended before its last save. They are
 * merged into the files paragraph by paragraph (nothing is overwritten).
 */
export const recoverJournal = (path: string, project: LoadedProject): { scenes: Map<string, Scene>; manifest: StoryManifest; recovered: number } => {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(journalKey(path))
  } catch {
    raw = null
  }
  if (!raw) return { scenes: project.scenes, manifest: project.manifest, recovered: 0 }
  let parsed: { manifest?: unknown; scenes?: unknown[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { scenes: project.scenes, manifest: project.manifest, recovered: 0 }
  }
  const scenes = new Map(project.scenes)
  let recovered = 0
  for (const value of parsed.scenes ?? []) {
    const scene = sanitizeScene(value)
    if (!scene) continue
    const disk = scenes.get(scene.id)
    const merged = disk ? mergeScenes(scene, disk) : null
    if (!merged || merged.changedFromRight) {
      scenes.set(scene.id, merged?.scene ?? scene)
      recovered += 1
    }
  }
  const journalManifest = parsed.manifest ? sanitizeManifest(parsed.manifest) : null
  const manifest = journalManifest && journalManifest.updatedAt >= project.manifest.updatedAt ? journalManifest : project.manifest
  return { scenes, manifest, recovered }
}
