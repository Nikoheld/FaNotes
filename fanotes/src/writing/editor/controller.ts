// Holds the editor state, the undo history and what is saved. The UI calls
// `apply` with the result of a command; saving writes only scenes that changed
// since the last save, after stamping this writer's edits for the merge.
import { mergeManifests, stampEdits } from '../model/merge'
import { mergeSceneVersions } from '../syncMerge'
import type { Scene, StoryManifest } from '../model/types'
import { clampPos, makeDoc, samePos, type Doc, type Selection } from './doc'
import type { EditorState } from './commands'

export type EditKind = 'typing' | 'delete' | 'format' | 'structure' | 'paste' | 'other'

type Snapshot = { manifest: StoryManifest; scenes: Map<string, Scene> }
type HistoryEntry = { before: Snapshot; after: Snapshot; selectionBefore: Selection; selectionAfter: Selection; kind: EditKind; at: number; typedSpace: boolean }

export type StorageAdapter = {
  writeManifest: (manifest: StoryManifest) => Promise<void>
  writeScene: (scene: Scene) => Promise<void>
  /**
   * What is on disk now. When it is not what this editor last wrote (sync wrote
   * another device's version meanwhile), the save merges it in instead of
   * writing over it.
   */
  readScene?: (id: string) => Promise<Scene | null>
  readManifest?: () => Promise<StoryManifest | null>
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

const HISTORY_LIMIT = 500
const GROUP_MS = 1500

export class WritingController {
  state: EditorState
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private savedScenes: Map<string, Scene>
  private savedManifest: StoryManifest
  private listeners = new Set<() => void>()
  private saving: Promise<void> | null = null
  /** Monotonic counter of document changes (for the view and autosave). */
  version = 0
  lastSaveError: string | null = null

  constructor(doc: Doc, private writer: string, selection?: Selection) {
    // Without a remembered position the caret starts in the text, not in a chapter title.
    const firstText = doc.flow.find((block) => block.ref.kind === 'para')
    const start = clampPos(doc, selection?.head ?? { block: firstText?.key ?? '', offset: 0 })
    this.state = { doc, selection: selection ?? { anchor: start, head: start }, storedMarks: null }
    this.savedScenes = new Map(doc.scenes)
    this.savedManifest = doc.manifest
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit() {
    for (const listener of [...this.listeners]) listener()
  }

  /** Applies a command result. A changed document becomes an undo step. */
  apply(next: EditorState | null, kind: EditKind = 'other', typed?: string) {
    if (!next) return false
    const previous = this.state
    const docChanged = next.doc !== previous.doc
    this.state = next
    if (docChanged) {
      this.version += 1
      const now = Date.now()
      const last = this.undoStack[this.undoStack.length - 1]
      const typedSpace = Boolean(typed && /\s/u.test(typed))
      const continues = kind === 'typing' && last?.kind === 'typing' && now - last.at < GROUP_MS && samePos(last.selectionAfter.head, previous.selection.head) && !(!typedSpace && last.typedSpace)
      if (continues) {
        last.after = { manifest: next.doc.manifest, scenes: next.doc.scenes }
        last.selectionAfter = next.selection
        last.at = now
        last.typedSpace = typedSpace
      } else {
        this.undoStack.push({
          before: { manifest: previous.doc.manifest, scenes: previous.doc.scenes },
          after: { manifest: next.doc.manifest, scenes: next.doc.scenes },
          selectionBefore: previous.selection,
          selectionAfter: next.selection,
          kind,
          at: now,
          typedSpace,
        })
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
      }
      this.redoStack = []
    }
    this.emit()
    return true
  }

  /** Moves the selection only (no undo step). */
  select(selection: Selection, keepStoredMarks = false) {
    this.state = { ...this.state, selection, storedMarks: keepStoredMarks ? this.state.storedMarks : null }
    this.emit()
  }

  canUndo() { return this.undoStack.length > 0 }
  canRedo() { return this.redoStack.length > 0 }

  undo() {
    const entry = this.undoStack.pop()
    if (!entry) return false
    this.redoStack.push(entry)
    this.restore(entry.before, entry.selectionBefore)
    return true
  }

  redo() {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.undoStack.push(entry)
    this.restore(entry.after, entry.selectionAfter)
    return true
  }

  private restore(snapshot: Snapshot, selection: Selection) {
    const doc = makeDoc(snapshot.manifest, snapshot.scenes)
    this.state = { doc, selection: { anchor: clampPos(doc, selection.anchor), head: clampPos(doc, selection.head) }, storedMarks: null }
    this.version += 1
    this.emit()
  }

  /**
   * Replaces the document from outside (a sync merge, a binder edit made in a
   * panel) without losing the undo history of the editor.
   */
  replaceDoc(doc: Doc, recordUndo = true) {
    this.apply({ ...this.state, doc, selection: { anchor: clampPos(doc, this.state.selection.anchor), head: clampPos(doc, this.state.selection.head) } }, recordUndo ? 'structure' : 'other')
  }

  dirtyScenes() {
    return [...this.state.doc.scenes.values()].filter((scene) => this.savedScenes.get(scene.id) !== scene)
  }

  isDirty() {
    return this.state.doc.manifest !== this.savedManifest || this.dirtyScenes().length > 0
  }

  /** Dirty scenes and manifest as JSON, for the crash journal. */
  journal(): { manifest: StoryManifest | null; scenes: Scene[] } | null {
    if (!this.isDirty()) return null
    return { manifest: this.state.doc.manifest !== this.savedManifest ? this.state.doc.manifest : null, scenes: this.dirtyScenes() }
  }

  /** Writes what changed. Concurrent calls wait for the running save and then save again. */
  async save(storage: StorageAdapter): Promise<boolean> {
    while (this.saving) await this.saving
    if (!this.isDirty()) return true
    let ok = true
    this.saving = (async () => {
      const doc = this.state.doc
      const stamped = new Map<string, Scene>()
      for (const scene of this.dirtyScenes()) stamped.set(scene.id, stampEdits(scene, this.savedScenes.get(scene.id) ?? null, this.writer))
      let manifest = doc.manifest !== this.savedManifest ? { ...doc.manifest, updatedAt: new Date().toISOString() } : null
      try {
        // Another device's version on disk (written by sync since our last save) is merged, never overwritten.
        let merged = false
        // Our own stamped versions, before anything from disk is merged in: the base the
        // editor's later typing is stamped against if it has to be merged with them.
        const own = new Map(stamped)
        for (const [id, scene] of stamped) {
          const disk = storage.readScene ? await storage.readScene(id) : null
          const saved = this.savedScenes.get(id)
          if (disk && saved && !sameJson(disk, saved)) {
            stamped.set(id, mergeSceneVersions(scene, disk).scene)
            merged = true
          }
        }
        if (manifest && storage.readManifest) {
          const disk = await storage.readManifest()
          if (disk && disk.id === manifest.id && !sameJson(disk, this.savedManifest)) {
            manifest = { ...mergeManifests(manifest, disk).manifest, updatedAt: manifest.updatedAt }
            merged = true
          }
        }
        for (const scene of stamped.values()) await storage.writeScene(scene)
        if (manifest) await storage.writeManifest(manifest)
        for (const scene of stamped.values()) this.savedScenes.set(scene.id, scene)
        if (manifest) this.savedManifest = manifest
        this.lastSaveError = null
        // Keep the stamped versions in the editor so the next save compares against them.
        if (this.state.doc === doc) {
          const scenes = new Map(doc.scenes)
          for (const scene of stamped.values()) scenes.set(scene.id, scene)
          const nextDoc = makeDoc(manifest ?? doc.manifest, scenes)
          this.state = { ...this.state, doc: nextDoc, selection: merged ? { anchor: clampPos(nextDoc, this.state.selection.anchor), head: clampPos(nextDoc, this.state.selection.head) } : this.state.selection }
          // Stamped and saved are the same objects now.
          for (const scene of stamped.values()) this.savedScenes.set(scene.id, nextDoc.scenes.get(scene.id)!)
          this.savedManifest = nextDoc.manifest
          this.rebaseHistory(doc, nextDoc)
          if (merged) this.version += 1
        } else if (merged) {
          // The writer went on typing during the save: what was merged in still has to reach the editor.
          this.mergeIn([...stamped.values()], manifest, false, own)
        }
      } catch (error) {
        ok = false
        this.lastSaveError = error instanceof Error ? error.message : String(error)
      }
    })()
    try {
      await this.saving
    } finally {
      this.saving = null
      this.emit()
    }
    return ok
  }

  isSaving() { return this.saving !== null }

  /**
   * Versions sync wrote to disk (another device's edits, already merged with
   * ours on disk) are merged into the open document. A scene or manifest with no
   * unsaved edits counts as saved afterwards; one with unsaved edits stays dirty
   * and its next save writes the merge.
   */
  absorb(scenes: Scene[], manifest: StoryManifest | null) {
    const changed = this.mergeIn(scenes, manifest, true)
    if (changed) {
      this.redoStack = []
      this.emit()
    }
    return changed
  }

  /**
   * `bases`: per scene, the version the editor's current text was made from (default: the
   * last saved one). Unsaved edits are stamped against it first, so the merge sees them as
   * newer, and paragraphs only the other version has are not taken for deletions.
   */
  private mergeIn(scenes: Scene[], manifest: StoryManifest | null, markSaved = false, bases?: Map<string, Scene>) {
    const doc = this.state.doc
    const nextScenes = new Map(doc.scenes)
    let changed = false
    for (const disk of scenes) {
      const current = doc.scenes.get(disk.id)
      const saved = this.savedScenes.get(disk.id)
      const clean = current !== undefined && current === saved
      const base = bases?.get(disk.id) ?? saved ?? null
      const ours = current && !clean ? stampEdits(current, base, this.writer) : current
      const next = ours ? mergeSceneVersions(ours, disk).scene : disk
      if (current && sameJson(next, current)) {
        if (markSaved && clean) this.savedScenes.set(disk.id, current)
        continue
      }
      nextScenes.set(disk.id, next)
      if (markSaved && (clean || !current)) this.savedScenes.set(disk.id, next)
      changed = true
    }
    let nextManifest = doc.manifest
    if (manifest && manifest.id === doc.manifest.id) {
      const clean = doc.manifest === this.savedManifest
      // Unsaved manifest edits are the newest: they get today's stamp before the merge.
      const ours = clean ? doc.manifest : { ...doc.manifest, updatedAt: new Date().toISOString() }
      const merged = mergeManifests(ours, manifest).manifest
      if (!sameJson(merged, doc.manifest)) {
        nextManifest = merged
        if (markSaved && clean) this.savedManifest = merged
        changed = true
      }
    }
    if (!changed) return false
    const nextDoc = makeDoc(nextManifest, nextScenes)
    this.state = { ...this.state, doc: nextDoc, selection: { anchor: clampPos(nextDoc, this.state.selection.anchor), head: clampPos(nextDoc, this.state.selection.head) } }
    this.version += 1
    return true
  }

  /** History entries that pointed at the unstamped doc now point at the stamped one. */
  private rebaseHistory(from: Doc, to: Doc) {
    for (const entry of [...this.undoStack, ...this.redoStack]) {
      if (entry.after.scenes === from.scenes) entry.after = { manifest: to.manifest, scenes: to.scenes }
      if (entry.before.scenes === from.scenes) entry.before = { manifest: to.manifest, scenes: to.scenes }
    }
  }
}
