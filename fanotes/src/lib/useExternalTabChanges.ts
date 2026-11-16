// Open notes whose files change outside FaNotes (Explorer, another editor, a
// sync tool): the tab follows a rename, reloads an outside edit, and never
// writes over either side. The decisions live in externalTabs.mjs; this file
// gathers the facts and carries them out.

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { NoteTab, VaultEntry } from '../types'
import { isPdfNotePath } from './famd'
import { conflictCopyPath } from './sync/engine'
import { numberedVariant } from './sync/conflicts'
import {
  companionToFollow,
  conflictCopyBase,
  conflictDeviceName,
  decideTabReconcile,
  implicatedTabPaths,
  isOwnWrite,
  noteFamily,
  noteTextFingerprint,
  normalizeVaultChange,
  rememberOwnWrite,
  renameCandidates,
  sameNoteText,
  tabVaultPaths,
  type FileSignature,
  type NormalizedVaultChange,
  type TabDiskState,
} from './externalTabs.mjs'

/**
 * Why a tab is paused. While it is, nothing is written to its file: `deleted`
 * (the file is gone) or `conflict` (the file was edited outside while the tab
 * holds unsaved text, `external` is what the file held then).
 */
export type TabHold = { kind: 'deleted' | 'conflict'; external?: string; at: number }
export type TabHolds = Record<string, TabHold>

/** The paused tabs and the memory of what this app wrote itself. App needs both before it can save anything. */
export function useTabHolds() {
  const [holds, setHolds] = useState<TabHolds>({})
  const holdsRef = useRef<TabHolds>(holds)
  const ownWritesRef = useRef(new Map<string, string[]>())

  const setHold = useCallback((path: string, hold: TabHold | null) => {
    const current = holdsRef.current
    const existing = current[path]
    if (!hold ? !existing : (existing?.kind === hold.kind && existing.external === hold.external)) return
    const next = { ...current }
    if (hold) next[path] = hold
    else delete next[path]
    holdsRef.current = next
    setHolds(next)
  }, [])

  /** Book what is about to be written to a note, so the watcher's report of that write is not taken for an outside edit. */
  const noteOwnWrite = useCallback((path: string, body: string) => {
    ownWritesRef.current.set(path, rememberOwnWrite(ownWritesRef.current.get(path), body))
  }, [])

  /** The tab's pause and its memory of own writes belong to its path; they follow it or end. */
  const moveTabState = useCallback((from: string, to: string) => {
    const own = ownWritesRef.current.get(from)
    ownWritesRef.current.delete(from)
    if (own) ownWritesRef.current.set(to, own)
    setHold(from, null)
    setHold(to, null)
  }, [setHold])

  /** A closed tab, or a vault left behind, takes its state with it. */
  const pruneTabState = useCallback((open: ReadonlySet<string>) => {
    for (const path of Object.keys(holdsRef.current)) if (!open.has(path)) setHold(path, null)
    for (const path of [...ownWritesRef.current.keys()]) if (!open.has(path)) ownWritesRef.current.delete(path)
  }, [setHold])

  return { holds, holdsRef, ownWritesRef, setHold, noteOwnWrite, moveTabState, pruneTabState }
}

export type ExternalTabChangeDeps = {
  holdsRef: MutableRefObject<TabHolds>
  setHold: (path: string, hold: TabHold | null) => void
  ownWritesRef: MutableRefObject<Map<string, string[]>>
  tabsRef: MutableRefObject<NoteTab[]>
  setTabs: Dispatch<SetStateAction<NoteTab[]>>
  pendingWrites: MutableRefObject<Map<string, string>>
  saveTimers: MutableRefObject<Map<string, number>>
  treeRef: MutableRefObject<VaultEntry[]>
  mutatingEntryPathsRef: MutableRefObject<Set<string>>
  vaultSessionGenerationRef: MutableRefObject<number>
  activePathRef: MutableRefObject<string | null>
  /** Hand the keystrokes the editors still buffer to the app, so that "nothing unsaved" is true. */
  flushEditors: () => void
  flushDocumentLayers: () => Promise<boolean>
  /** Take the text from disk for a tab without unsaved text; also reloads ink and statistics when `famdTouched`. */
  reloadCleanTab: (path: string, famdTouched: boolean, content?: string) => Promise<boolean>
  /** Move an open note's tab, split, history and statistics to a new path; returns the unsaved text that now belongs to it. */
  retargetOpenNote: (from: string, to: string) => Array<[string, string]>
  saveContent: (path: string, content: string, options?: { quiet?: boolean }) => Promise<boolean>
  refreshTree: () => Promise<unknown>
  toast: (message: string, kind?: 'success' | 'error' | 'info') => void
  /** The device name the user set for sync, or ''. */
  deviceName: () => string
}

type Job = {
  /** What the vault watcher reported; null checks every open note (the window got focus). */
  change: NormalizedVaultChange | null
  /** Signatures of the open notes the change removed, taken from the tree as it was before. */
  before: Map<string, FileSignature>
}
type TreeSnapshot = { present: Set<string>; signatures: Map<string, FileSignature> }

const isMissingFileError = (error: unknown) => /ENOENT|no such file|nicht gefunden/iu.test(error instanceof Error ? error.message : String(error ?? ''))
const fileNameOf = (path: string) => path.split('/').pop() ?? path
const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

const readDisk = async (path: string): Promise<TabDiskState> => {
  try {
    return { exists: true, content: await window.fanotes.readFile(path) }
  } catch (error) {
    // Anything but "not there" (locked, too large, unreadable): no opinion, leave the tab alone.
    return isMissingFileError(error) ? { exists: false } : null
  }
}

const snapshotTree = async (): Promise<TreeSnapshot | null> => {
  try {
    const present = new Set<string>()
    const signatures = new Map<string, FileSignature>()
    const walk = (entries: VaultEntry[]) => {
      for (const entry of entries) {
        present.add(entry.relativePath)
        if (entry.kind === 'folder') walk(entry.children ?? [])
        else signatures.set(entry.relativePath, { modifiedAt: entry.modifiedAt, size: entry.size })
      }
    }
    walk(await window.fanotes.getTree())
    return { present, signatures }
  } catch {
    return null
  }
}

const signaturesIn = (entries: VaultEntry[], wanted: ReadonlySet<string>) => {
  const found = new Map<string, FileSignature>()
  const walk = (list: VaultEntry[]) => {
    for (const entry of list) {
      if (found.size === wanted.size) return
      if (entry.kind === 'folder') walk(entry.children ?? [])
      else if (wanted.has(entry.relativePath)) found.set(entry.relativePath, { modifiedAt: entry.modifiedAt, size: entry.size })
    }
  }
  walk(entries)
  return found
}

export function useExternalTabChanges(deps: ExternalTabChangeDeps) {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const busyRef = useRef<string | null>(null)
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const focusQueuedRef = useRef(false)
  /** The text of a held tab that was already saved as a conflict copy, so closing twice does not write two copies. */
  const parkedRef = useRef(new Map<string, string>())

  const dropUnsaved = (path: string) => {
    const { pendingWrites, saveTimers } = depsRef.current
    const timer = saveTimers.current.get(path)
    if (timer) window.clearTimeout(timer)
    saveTimers.current.delete(path)
    pendingWrites.current.delete(path)
  }

  /** Pause a tab: its pending autosave must not fire into a file that is gone or was changed. Its text stays. */
  const putOnHold = (path: string, hold: TabHold) => {
    const { saveTimers, setHold } = depsRef.current
    const timer = saveTimers.current.get(path)
    if (timer) window.clearTimeout(timer)
    saveTimers.current.delete(path)
    setHold(path, hold)
  }

  /**
   * Save `text` next to `notePath` the way the sync engine keeps the version
   * it sets aside: `Name (Konflikt <Gerät> <Datum>).md`, numbered when that
   * name is taken. Resolves to the path, or null when nothing could be written.
   */
  const writeConflictCopy = async (notePath: string, text: string): Promise<string | null> => {
    const sync = window.fanotes.sync
    if (!sync) return null
    const at = new Date()
    const first = conflictCopyPath(conflictCopyBase(notePath), conflictDeviceName(depsRef.current.deviceName(), window.fanotes.platform), at)
    for (let number = 1; number < 1000; number += 1) {
      const candidate = number === 1 ? first : numberedVariant(first, number)
      const taken = await sync.read(candidate).then(() => true, () => false)
      if (taken) continue
      await sync.write(candidate, new TextEncoder().encode(text.endsWith('\n') ? text : `${text}\n`), at.getTime())
      return candidate
    }
    return null
  }

  const fileExists = async (path: string) => {
    const disk = await readDisk(path)
    return disk === null || disk.exists
  }

  /** The `.famd` companion an outside rename left behind goes after its note, so that the ink and text fields do not stay on a note of their own. */
  const followCompanion = async (from: string, to: string, snapshot: TreeSnapshot | null) => {
    const pair = companionToFollow({ from, to })
    if (!pair) return
    try {
      const stale = snapshot?.present.has(pair.from) || await fileExists(pair.from)
      if (!stale || await fileExists(pair.to)) return
      let current = pair.from
      if (folderOf(pair.from) !== folderOf(pair.to)) current = await window.fanotes.moveEntry(current, folderOf(pair.to))
      if (fileNameOf(current) !== fileNameOf(pair.to)) await window.fanotes.renameEntry(current, fileNameOf(pair.to))
    } catch {
      // The note moved on anyway; its handwriting file stays where it was and can be moved by hand.
    }
  }

  /** The one file a vanished note was renamed to, or null when there is none or more than one. */
  const findRenameTarget = async (tab: NoteTab, job: Job, snapshot: TreeSnapshot): Promise<string | null> => {
    const added = job.change?.added ?? []
    if (!added.length) return null
    const candidates = renameCandidates({
      from: tab.path,
      added,
      before: job.before.get(tab.path) ?? null,
      after: snapshot.signatures,
      taken: depsRef.current.tabsRef.current.map((open) => open.path),
    })
    if (!candidates.length) return null
    // A PDF note has no text of its own to compare; its signature has to be unique.
    if (isPdfNotePath(tab.path)) return candidates.length === 1 ? candidates[0] : null
    const ownWrites = depsRef.current.ownWritesRef.current.get(tab.path)
    const verified: string[] = []
    for (const candidate of candidates) {
      const disk = await readDisk(candidate)
      if (disk?.exists && (sameNoteText(disk.content, tab.savedContent) || isOwnWrite(ownWrites, disk.content))) verified.push(candidate)
    }
    return verified.length === 1 ? verified[0] : null
  }

  const followRename = async (from: string, to: string, snapshot: TreeSnapshot | null): Promise<boolean> => {
    const d = depsRef.current
    // Ink and text fields still belong to the old path: save them there first; the companion then follows.
    if (d.activePathRef.current === from && !await d.flushDocumentLayers()) return false
    await followCompanion(from, to, snapshot)
    const moved = d.retargetOpenNote(from, to)
    d.toast('Eine geöffnete Notiz wurde ausserhalb von FaNotes umbenannt. Der Tab folgt der Datei.', 'info')
    await d.refreshTree().catch(() => undefined)
    await Promise.all(moved.map(([path, content]) => d.saveContent(path, content)))
    return true
  }

  const isBusy = (path: string) => [...depsRef.current.mutatingEntryPathsRef.current].some((entry) => path === entry || path.startsWith(`${entry}/`))

  /** Decide for one open note and carry the decision out. `disk` is what its file held a moment ago. */
  const reconcileTab = async (path: string, disk: TabDiskState, job: Job, snapshot: TreeSnapshot | null, attempt = 0): Promise<void> => {
    const d = depsRef.current
    const tab = d.tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab || isBusy(path)) return
    const hold = d.holdsRef.current[path]
    const content = d.pendingWrites.current.get(path) ?? tab.content
    const decision = decideTabReconcile({
      content,
      savedContent: tab.savedContent,
      ownWrites: d.ownWritesRef.current.get(path),
      disk,
      hold: hold?.kind ?? null,
      heldExternal: hold?.external ?? null,
    })
    switch (decision.action) {
      case 'none':
        return
      case 'release':
        d.setHold(path, null)
        return
      case 'adopt': {
        // The typed text already is the file's text: nothing is unsaved any more.
        dropUnsaved(path)
        d.setTabs((current) => current.map((candidate) => (candidate.path === path ? { ...candidate, content, savedContent: content } : candidate)))
        d.setHold(path, null)
        return
      }
      case 'reload': {
        if (tab.content !== tab.savedContent && !d.pendingWrites.current.has(path)) {
          // Only trailing whitespace differs from what was saved: nothing is unsaved, and the strict check below must see that.
          const settled = (candidate: NoteTab): NoteTab => (candidate.path === path ? { ...candidate, savedContent: candidate.content } : candidate)
          d.tabsRef.current = d.tabsRef.current.map(settled)
          d.setTabs((current) => current.map(settled))
        }
        const change = job.change
        const companion = tabVaultPaths(path)[1]
        const famdTouched = noteFamily(path) === 'famd' || Boolean(companion && change && [...change.added, ...change.changed, ...change.removed].includes(companion))
        if (await d.reloadCleanTab(path, famdTouched, decision.content)) {
          d.setHold(path, null)
          return
        }
        // Text was typed while the file was read: decide again with the text that is there now (it becomes a conflict).
        if (attempt < 2) await reconcileTab(path, disk, job, snapshot, attempt + 1)
        return
      }
      case 'conflict': {
        putOnHold(path, { kind: 'conflict', external: decision.external, at: Date.now() })
        if (hold?.kind !== 'conflict') d.toast('Eine geöffnete Notiz wurde ausserhalb von FaNotes geändert. Deine ungespeicherten Änderungen bleiben erhalten; entscheide im Hinweis über dem Text.', 'info')
        return
      }
      case 'deleted': {
        const target = snapshot ? await findRenameTarget(tab, job, snapshot) : null
        if (target && await followRename(path, target, snapshot)) return
        putOnHold(path, { kind: 'deleted', at: Date.now() })
        if (hold?.kind !== 'deleted') d.toast('Eine geöffnete Notiz wurde ausserhalb von FaNotes gelöscht. Ihr Text bleibt im Tab erhalten.', 'info')
      }
    }
  }

  const runJob = async (job: Job) => {
    const d = depsRef.current
    const session = d.vaultSessionGenerationRef.current
    d.flushEditors()
    const open = d.tabsRef.current.map((tab) => tab.path).filter((path) => noteFamily(path) !== '')
    const targets = implicatedTabPaths(open, job.change).filter((path) => !isBusy(path))
    if (!targets.length) return
    let tree: TreeSnapshot | null | undefined
    const snapshotOnce = async () => {
      if (tree === undefined) tree = await snapshotTree()
      return tree
    }
    const reads = new Map<string, TabDiskState>()
    for (const path of targets) {
      if (isPdfNotePath(path)) {
        // A PDF note has no text to read. Only the tree can tell that it is gone, and only a change list can say it may be.
        const change = job.change
        if (!change || !(change.unreliable || change.removed.includes(path))) continue
        const snapshot = await snapshotOnce()
        if (snapshot && !snapshot.present.has(path)) reads.set(path, { exists: false })
        continue
      }
      reads.set(path, await readDisk(path))
    }
    if (session !== d.vaultSessionGenerationRef.current) return
    const vanished = [...reads.values()].some((disk) => disk && !disk.exists)
    const snapshot = vanished ? await snapshotOnce() : null
    if (session !== d.vaultSessionGenerationRef.current) return
    for (const [path, disk] of reads) await reconcileTab(path, disk, job, snapshot)
  }
  const runJobRef = useRef(runJob)
  runJobRef.current = runJob

  const enqueue = useCallback((job: Job): Promise<void> => {
    const run = chainRef.current.then(() => runJobRef.current(job)).catch(() => undefined)
    chainRef.current = run
    return run
  }, [])

  // The vault watcher: look at the open notes it names.
  useEffect(() => {
    if (!window.fanotes?.onVaultChanged) return undefined
    return window.fanotes.onVaultChanged((raw) => {
      const change = normalizeVaultChange(raw)
      const d = depsRef.current
      const implicated = implicatedTabPaths(d.tabsRef.current.map((tab) => tab.path).filter((path) => noteFamily(path) !== ''), change)
      if (!implicated.length) return
      // The tree is swapped for the new one as soon as the app has fetched it: take the old signatures now.
      const gone = new Set(implicated.filter((path) => change.unreliable || change.removed.includes(path)))
      const before = gone.size ? signaturesIn(d.treeRef.current, gone) : new Map<string, FileSignature>()
      void enqueue({ change, before })
    })
  }, [enqueue])

  // Back in the window: the watcher may still be a second behind, and the first keystroke must not save over an outside edit.
  useEffect(() => {
    if (!window.fanotes?.onVaultChanged) return undefined
    const check = () => {
      if (focusQueuedRef.current) return
      focusQueuedRef.current = true
      void enqueue({ change: null, before: new Map() }).finally(() => { focusQueuedRef.current = false })
    }
    const onVisible = () => { if (!document.hidden) check() }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enqueue])

  /**
   * Keep the unsaved text of a paused tab before the tab closes or the app quits:
   * as a conflict copy next to the note, so that neither side is lost. Resolves
   * false when it could not be written; the tab then stays open.
   */
  const parkHeldTab = useCallback(async (path: string): Promise<boolean> => {
    const d = depsRef.current
    const tab = d.tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab) return true
    const text = d.pendingWrites.current.get(path) ?? tab.content
    if (sameNoteText(text, tab.savedContent) || parkedRef.current.get(path) === noteTextFingerprint(text)) {
      dropUnsaved(path)
      return true
    }
    try {
      if (!await writeConflictCopy(path, text)) throw new Error('no copy')
      parkedRef.current.set(path, noteTextFingerprint(text))
      dropUnsaved(path)
      await d.refreshTree().catch(() => undefined)
      d.toast('Ungespeicherte Änderungen wurden als Konfliktkopie gesichert.', 'info')
      return true
    } catch {
      d.toast('Die ungespeicherten Änderungen konnten nicht als Konfliktkopie gesichert werden.', 'error')
      return false
    }
  }, [])

  const withBusy = async (path: string, task: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = path
    setBusyPath(path)
    try {
      await task()
    } finally {
      busyRef.current = null
      setBusyPath(null)
    }
  }

  /** The file vanished while a conflict was open: it is now a deleted note. */
  const turnedDeleted = (path: string) => {
    const d = depsRef.current
    putOnHold(path, { kind: 'deleted', at: Date.now() })
    d.toast('Die Datei wurde inzwischen gelöscht. Wähle „Wiederherstellen“ oder „Speichern unter“.', 'info')
  }

  /** Conflict: the typed text stays; the file's version is kept next to it as a conflict copy. */
  const keepMine = (path: string) => withBusy(path, async () => {
    const d = depsRef.current
    const hold = d.holdsRef.current[path]
    const tab = d.tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab || hold?.kind !== 'conflict') return
    const mine = d.pendingWrites.current.get(path) ?? tab.content
    const disk = await readDisk(path)
    if (disk && !disk.exists) { turnedDeleted(path); return }
    const theirs = disk?.exists ? disk.content : (hold.external ?? '')
    try {
      if (!sameNoteText(theirs, mine) && !await writeConflictCopy(path, theirs)) throw new Error('no copy')
    } catch {
      d.toast('Die andere Fassung konnte nicht als Konfliktkopie gesichert werden. Es wurde nichts überschrieben.', 'error')
      return
    }
    d.setHold(path, null)
    const saved = await d.saveContent(path, mine)
    await d.refreshTree().catch(() => undefined)
    if (saved) d.toast('Deine Fassung bleibt. Die andere Fassung liegt als Konfliktkopie daneben.', 'success')
  })

  /** Conflict: the file's version is loaded; the typed text is kept next to it as a conflict copy. */
  const loadExternal = (path: string) => withBusy(path, async () => {
    const d = depsRef.current
    const hold = d.holdsRef.current[path]
    const tab = d.tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab || hold?.kind !== 'conflict') return
    const mine = d.pendingWrites.current.get(path) ?? tab.content
    const disk = await readDisk(path)
    if (!disk) {
      d.toast('Die Datei konnte nicht gelesen werden. Es wurde nichts verändert.', 'error')
      return
    }
    if (!disk.exists) { turnedDeleted(path); return }
    try {
      if (!sameNoteText(disk.content, mine) && !await writeConflictCopy(path, mine)) throw new Error('no copy')
    } catch {
      d.toast('Deine Fassung konnte nicht als Konfliktkopie gesichert werden. Es wurde nichts überschrieben.', 'error')
      return
    }
    dropUnsaved(path)
    const text = disk.content
    d.tabsRef.current = d.tabsRef.current.map((candidate) => (candidate.path === path ? { ...candidate, content: text, savedContent: text } : candidate))
    d.setTabs((current) => current.map((candidate) => (candidate.path === path ? { ...candidate, content: text, savedContent: text } : candidate)))
    d.setHold(path, null)
    await d.reloadCleanTab(path, noteFamily(path) === 'famd', text)
    await d.refreshTree().catch(() => undefined)
    d.toast('Deine Fassung liegt jetzt als Konfliktkopie neben der Notiz.', 'success')
  })

  /** Deleted: write the note again under its old name; its text is the tab's. */
  const restoreTab = (path: string) => withBusy(path, async () => {
    const d = depsRef.current
    const tab = d.tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab || d.holdsRef.current[path]?.kind !== 'deleted' || isPdfNotePath(path)) return
    const text = d.pendingWrites.current.get(path) ?? tab.content
    try {
      const created = await window.fanotes.createNote(folderOf(path), fileNameOf(path))
      const target = created.relativePath
      if (target !== path) d.retargetOpenNote(path, target)
      d.setHold(path, null)
      d.setHold(target, null)
      await d.saveContent(target, text)
      await d.refreshTree().catch(() => undefined)
      d.toast('Notiz wiederhergestellt.', 'success')
    } catch (error) {
      d.toast(error instanceof Error ? error.message : 'Die Notiz konnte nicht wiederhergestellt werden.', 'error')
    }
  })

  /** Deleted: write the note under a new name in the same folder; the tab becomes that note. */
  const saveTabAs = (path: string, name: string) => withBusy(path, async () => {
    const d = depsRef.current
    const tab = d.tabsRef.current.find((candidate) => candidate.path === path)
    if (!tab || d.holdsRef.current[path]?.kind !== 'deleted' || isPdfNotePath(path)) return
    const stem = name.replace(/[\\/:*?"<>|\0-\x1f]/gu, ' ').replace(/\.(md|markdown|famd)$/iu, '').replace(/\s+/gu, ' ').trim()
    if (!stem) {
      d.toast('Gib einen Namen für die Notiz ein.', 'error')
      return
    }
    const text = d.pendingWrites.current.get(path) ?? tab.content
    try {
      const created = await window.fanotes.createNote(folderOf(path), `${stem}.md`)
      d.retargetOpenNote(path, created.relativePath)
      d.setHold(path, null)
      await d.saveContent(created.relativePath, text)
      await d.refreshTree().catch(() => undefined)
      d.toast('Notiz unter neuem Namen gespeichert.', 'success')
    } catch (error) {
      d.toast(error instanceof Error ? error.message : 'Die Notiz konnte nicht gespeichert werden.', 'error')
    }
  })

  return { busyPath, parkHeldTab, keepMine, loadExternal, restoreTab, saveTabAs }
}
