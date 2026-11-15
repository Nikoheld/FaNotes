// State of the story tools around the manuscript: bible entries, writing
// progress and scene snapshots. Bible edits are written per entry (debounced),
// progress at most every 20 s and on close, snapshots immediately.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { biblePath, type BibleEntry, type BibleKind } from '../model/bible'
import { localDate, progressPath, recordProgress, wordsPerDay, type ProgressFile } from '../model/progress'
import { makeSnapshot, snapshotPath, type Snapshot, type SnapshotReason } from '../model/snapshots'
import type { Scene } from '../model/types'
import { loadBible, loadProgress, readSnapshot, snapshotStamps, writeBibleEntry, writeProgress, writeSnapshot, type StoryHost } from '../storage'

type Options = {
  host: StoryHost | null
  path: string
  /** Story files from loading (null until loaded). */
  files: string[] | null
  writer: string
  /** Manuscript words now (null until loaded). */
  totalWords: number | null
  onWritten?: (paths: string[]) => void
  onError?: (message: string) => void
}

const PROGRESS_INTERVAL_MS = 20_000

export function useStoryTools({ host, path, files, writer, totalWords, onWritten, onError }: Options) {
  const [bible, setBible] = useState<Map<string, BibleEntry>>(new Map())
  const [bibleReady, setBibleReady] = useState(false)
  const [progressFiles, setProgressFiles] = useState<ProgressFile[]>([])
  const [ownProgress, setOwnProgress] = useState<ProgressFile | null>(null)
  const [extraSnapshots, setExtraSnapshots] = useState<string[]>([])
  const [sessionStart, setSessionStart] = useState<number | null>(null)
  const timers = useRef(new Map<string, number>())
  const pendingEntries = useRef(new Map<string, BibleEntry>())
  const progressWrite = useRef<{ last: number; timer: number | null; latest: ProgressFile | null }>({ last: 0, timer: null, latest: null })
  const callbacks = useRef({ onWritten, onError })
  callbacks.current = { onWritten, onError }

  // ── Load ──
  useEffect(() => {
    if (!host || !files) return
    let alive = true
    void (async () => {
      const [entries, progress] = await Promise.all([loadBible(host, path, files), loadProgress(host, path, files)])
      if (!alive) return
      setBible(entries)
      setBibleReady(true)
      setProgressFiles(progress.filter((file) => file.writer !== writer))
      setOwnProgress(progress.find((file) => file.writer === writer) ?? null)
    })().catch((error) => callbacks.current.onError?.(error instanceof Error ? error.message : String(error)))
    return () => { alive = false }
  }, [host, path, files, writer])

  // ── Bible ──
  const flushEntry = useCallback(async (id: string) => {
    const entry = pendingEntries.current.get(id)
    if (!entry || !host) return
    pendingEntries.current.delete(id)
    const timer = timers.current.get(id)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(id)
    try {
      await writeBibleEntry(host, path, entry)
      callbacks.current.onWritten?.([biblePath(path, entry.kind, entry.id)])
    } catch (error) {
      callbacks.current.onError?.(error instanceof Error ? error.message : String(error))
    }
  }, [host, path])

  const saveEntry = useCallback((entry: BibleEntry) => {
    const stamped = { ...entry, updatedAt: new Date().toISOString(), updatedBy: writer }
    setBible((current) => new Map(current).set(stamped.id, stamped))
    pendingEntries.current.set(stamped.id, stamped)
    const previous = timers.current.get(stamped.id)
    if (previous) window.clearTimeout(previous)
    timers.current.set(stamped.id, window.setTimeout(() => { void flushEntry(stamped.id) }, 600))
  }, [flushEntry, writer])

  const entriesOf = useCallback((kind: BibleKind) => [...bible.values()]
    .filter((entry) => entry.kind === kind && !entry.archived)
    .sort((left, right) => (kind === 'event' ? (left.order ?? 0) - (right.order ?? 0) : 0) || left.name.localeCompare(right.name, 'de')), [bible])

  // ── Progress ──
  const writeOwnProgress = useCallback(async (file: ProgressFile) => {
    if (!host) return
    progressWrite.current.last = Date.now()
    progressWrite.current.latest = null
    try {
      await writeProgress(host, path, file)
      callbacks.current.onWritten?.([progressPath(path, file.writer)])
    } catch {
      // Progress is a convenience; a failed write is retried with the next one.
      progressWrite.current.latest = file
    }
  }, [host, path])

  useEffect(() => {
    if (totalWords === null || !bibleReady) return
    setSessionStart((value) => value ?? totalWords)
    setOwnProgress((current) => {
      const next = recordProgress(current, writer, totalWords)
      if (next === current) return current
      progressWrite.current.latest = next
      const wait = PROGRESS_INTERVAL_MS - (Date.now() - progressWrite.current.last)
      if (!current || wait <= 0) void writeOwnProgress(next)
      else if (progressWrite.current.timer === null) {
        progressWrite.current.timer = window.setTimeout(() => {
          progressWrite.current.timer = null
          if (progressWrite.current.latest) void writeOwnProgress(progressWrite.current.latest)
        }, wait)
      }
      return next
    })
  }, [totalWords, bibleReady, writer, writeOwnProgress])

  const days = useMemo(() => wordsPerDay([...progressFiles, ...(ownProgress ? [ownProgress] : [])]), [progressFiles, ownProgress])

  // ── Snapshots ──
  const stampsFor = useCallback((sceneId: string) => snapshotStamps([...(files ?? []), ...extraSnapshots], sceneId), [files, extraSnapshots])

  const takeSnapshot = useCallback(async (scene: Scene, title: string, reason: SnapshotReason, note = ''): Promise<Snapshot | null> => {
    if (!host) return null
    const snapshot = makeSnapshot(scene, title, writer, reason, note)
    await writeSnapshot(host, path, snapshot)
    const relative = snapshotPath('', snapshot.sceneId, snapshot.stamp).slice(1)
    setExtraSnapshots((current) => [...current, relative])
    callbacks.current.onWritten?.([snapshotPath(path, snapshot.sceneId, snapshot.stamp)])
    return snapshot
  }, [host, path, writer])

  const openSnapshot = useCallback((sceneId: string, stamp: string) => (host ? readSnapshot(host, path, sceneId, stamp) : Promise.resolve(null)), [host, path])

  /** Writes everything that is still pending (on close). */
  const flush = useCallback(async () => {
    await Promise.all([...pendingEntries.current.keys()].map((id) => flushEntry(id)))
    if (progressWrite.current.timer !== null) { window.clearTimeout(progressWrite.current.timer); progressWrite.current.timer = null }
    if (progressWrite.current.latest) await writeOwnProgress(progressWrite.current.latest)
  }, [flushEntry, writeOwnProgress])

  useEffect(() => () => { void flush() }, [flush])

  return {
    bible,
    bibleReady,
    saveEntry,
    entriesOf,
    days,
    sessionWords: totalWords !== null && sessionStart !== null ? totalWords - sessionStart : 0,
    /** Today over all devices. */
    todayWords: days.get(localDate()) ?? 0,
    stampsFor,
    takeSnapshot,
    openSnapshot,
    flush,
  }
}

export type StoryTools = ReturnType<typeof useStoryTools>
