import type { VaultEntry } from '../types'
import { parseFamd } from './famd'
import { parsePageStats, type PageStats } from './pageStats'
import { parseStoredCards } from './flashcards'
import { HOMEWORK_NOTE_PATH, loadHomeworkMarkdown, type HomeworkTask } from './homeworkStore'
import { sanitizeProgress } from '../writing/model/progress'
import {
  aggregateVault,
  countWords,
  dayKey,
  flattenVault,
  summarizeCards,
  type NoteFacts,
  type VaultStats,
} from './vaultStats.mjs'

export type StatsHost = {
  getTree: () => Promise<VaultEntry[]>
  readFile: (path: string) => Promise<string>
  /** Page statistics live in the `.famd` companion; `readFile` strips them. */
  readNotePageStats?: (path: string) => Promise<unknown>
  listNoteHistory?: (path: string) => Promise<Array<{ createdAt: string }>>
  storyList?: (path: string) => Promise<string[]>
  storyRead?: (path: string) => Promise<string | null>
}

export type StatsProgress = { phase: 'tree' | 'notes' | 'history' | 'stories' | 'done'; done: number; total: number }

/** Per-file facts, valid while mtime and size stay the same. Lives for the app session. */
const factCache = new Map<string, { sig: string; facts: NoteFacts }>()
/** Page statistics change without the note's mtime moving, so they expire instead. */
const statsCache = new Map<string, { at: number; stats: PageStats | null }>()
const STATS_TTL_MS = 5 * 60_000
const historyCache = new Map<string, { sig: string; stamps: string[] }>()
const storyCache = new Map<string, { sig: string; days: Record<string, number> }>()

const CONCURRENCY = 4
const SLICE_MS = 10
const HISTORY_WINDOW_MS = 365 * 86_400_000
const HISTORY_MAX_NOTES = 400

const yieldToUi = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

/** Runs `work` over `items` with a small pool, yielding to the UI between slices and stopping on abort. */
const pool = async <T>(items: readonly T[], signal: AbortSignal, work: (item: T) => Promise<void>, onStep?: (done: number) => void) => {
  let next = 0
  let done = 0
  let sliceStart = performance.now()
  const worker = async () => {
    while (!signal.aborted) {
      const index = next
      next += 1
      if (index >= items.length) return
      try { await work(items[index]) } catch { /* one unreadable file must not hide the rest */ }
      done += 1
      if (performance.now() - sliceStart > SLICE_MS) {
        onStep?.(done)
        await yieldToUi()
        sliceStart = performance.now()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  onStep?.(done)
}

/** Desktop reads the companion in the main process; the browser vault serves it from its own store. */
const readPageStats = async (host: StatsHost, path: string): Promise<PageStats | null> => {
  try {
    const raw = await host.readNotePageStats?.(path)
    return raw ? parsePageStats(raw) : null
  } catch {
    return null
  }
}

export const factsFromNote = (content: string, now: Date, pageStats?: PageStats | null): NoteFacts => {
  const parsed = parseFamd(content)
  const stats = pageStats ?? parsed.payload?.pageStats
  const cards = parseStoredCards(parsed.markdown)
  const today = dayKey(now)
  return {
    words: countWords(parsed.markdown),
    ink: (stats?.ink?.strokes ?? 0) > 0,
    cards: summarizeCards(cards, today),
    stats: stats
      ? {
        dwellMs: stats.dwellMs,
        wordsTyped: stats.typing.wordsTyped,
        strokes: stats.ink.strokes,
        penMs: stats.ink.penDownMs,
        activeDays: stats.activeDays,
        dwellByWeekday: stats.dwellByWeekday,
      }
      : null,
  }
}

/**
 * Reads the vault in the renderer, in small time slices with a few files in
 * flight. `onUpdate` receives a complete result after the quick tree pass and
 * then again as note contents arrive, so the page fills in while it works.
 * Aborting stops all further reads. Nothing is sent anywhere.
 */
export const loadVaultStats = async (host: StatsHost, signal: AbortSignal, onUpdate: (stats: VaultStats, progress: StatsProgress) => void, options: { force?: boolean; now?: Date } = {}) => {
  if (options.force) { factCache.clear(); statsCache.clear(); historyCache.clear(); storyCache.clear() }
  // Injectable so checks do not depend on the day they run.
  const now = options.now ?? new Date()
  const tree = await host.getTree()
  if (signal.aborted) return
  const { files } = flattenVault(tree) as unknown as { files: Array<{ path: string; size: number; mtime: number; extension?: string }> }
  const facts: Record<string, NoteFacts> = {}
  const history: Record<string, string[]> = {}
  const stories: Record<string, Record<string, number>> = {}
  let homework: HomeworkTask[] | null = null
  let lastEmit = 0
  const emit = (progress: StatsProgress, force = false) => {
    const at = performance.now()
    if (!force && at - lastEmit < 250) return
    lastEmit = at
    onUpdate(aggregateVault({ tree, facts, history, stories, homework, now }) as VaultStats, progress)
  }
  emit({ phase: 'tree', done: 0, total: files.length }, true)

  try {
    const loaded = loadHomeworkMarkdown(await host.readFile(HOMEWORK_NOTE_PATH))
    homework = loaded.ok ? loaded.document.tasks : null
  } catch { homework = null }

  const notes = files.filter((file) => /\.(?:md|markdown)$/iu.test(file.path) && file.path !== HOMEWORK_NOTE_PATH)
  await pool(notes, signal, async (file) => {
    const sig = `${file.mtime}:${file.size}`
    const cached = factCache.get(file.path)
    const statsHit = statsCache.get(file.path)
    const statsFresh = Boolean(statsHit && Date.now() - statsHit.at < STATS_TTL_MS)
    if (cached?.sig === sig && statsFresh) { facts[file.path] = cached.facts; return }
    let pageStats: PageStats | null | undefined
    if (statsHit && Date.now() - statsHit.at < STATS_TTL_MS) pageStats = statsHit.stats
    else {
      pageStats = await readPageStats(host, file.path)
      statsCache.set(file.path, { at: Date.now(), stats: pageStats })
    }
    const content = cached?.sig === sig ? null : await host.readFile(file.path)
    const value = content === null ? { ...cached!.facts, ...factsFromNote('', now, pageStats), words: cached!.facts.words, cards: cached!.facts.cards } : factsFromNote(content, now, pageStats)
    factCache.set(file.path, { sig, facts: value })
    facts[file.path] = value
  }, (done) => emit({ phase: 'notes', done, total: notes.length }))
  if (signal.aborted) return
  emit({ phase: 'notes', done: notes.length, total: notes.length }, true)

  if (host.listNoteHistory) {
    const recent = notes.filter((file) => file.mtime >= now.getTime() - HISTORY_WINDOW_MS).sort((a, b) => b.mtime - a.mtime).slice(0, HISTORY_MAX_NOTES)
    await pool(recent, signal, async (file) => {
      const sig = `${file.mtime}:${file.size}`
      const cached = historyCache.get(file.path)
      if (cached?.sig === sig) { history[file.path] = cached.stamps; return }
      const stamps = (await host.listNoteHistory!(file.path)).map((snapshot) => snapshot.createdAt)
      historyCache.set(file.path, { sig, stamps })
      history[file.path] = stamps
    }, (done) => emit({ phase: 'history', done, total: recent.length }))
    if (signal.aborted) return
  }

  const storyFiles = files.filter((file) => /\.story$/iu.test(file.path))
  if (host.storyList && host.storyRead && storyFiles.length) {
    const reader = host.storyRead
    await pool(storyFiles, signal, async (file) => {
      const sig = `${file.mtime}`
      const cached = storyCache.get(file.path)
      if (cached?.sig === sig) { stories[file.path] = cached.days; return }
      const days: Record<string, number> = {}
      for (const relative of (await host.storyList!(file.path)).filter((name) => /^progress\/[0-9a-z]{4,40}\.json$/u.test(name))) {
        if (signal.aborted) return
        const raw = await reader(`${file.path}/${relative}`)
        const progress = raw ? sanitizeProgress(JSON.parse(raw)) : null
        for (const [day, entry] of Object.entries(progress?.days ?? {})) days[day] = (days[day] ?? 0) + Math.max(0, entry.words)
      }
      storyCache.set(file.path, { sig, days })
      stories[file.path] = days
    }, (done) => emit({ phase: 'stories', done, total: storyFiles.length }))
  }
  if (signal.aborted) return
  emit({ phase: 'done', done: files.length, total: files.length }, true)
}
