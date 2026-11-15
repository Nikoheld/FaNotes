export const STATS_HEATMAP_WEEKS: number
export type StatsKind = 'markdown' | 'handwriting' | 'pdf' | 'story' | 'image' | 'media'
export type StatsFileRow = { path: string; name: string; kind: StatsKind; size: number; mtime: number; ctime: number; subject: string }
export type NoteFacts = {
  words: number
  ink: boolean
  cards: { total: number; due: number; reviewed: number; reps: number; lapses: number } | null
  stats: { dwellMs: number; wordsTyped: number; strokes: number; penMs: number; activeDays: string[]; dwellByWeekday: number[] } | null
}
export type StatsSubject = { name: string; color: string | null; count: number; bytes: number; words: number; dwellMs: number; kinds: Record<StatsKind, number> }
export type HeatCell = { date: string; count: number; future: boolean; active: boolean; words: number; level: number }
export type VaultStats = {
  generatedAt: number
  totals: { files: number; bytes: number; folders: number; notes: number }
  kinds: Record<StatsKind, { count: number; bytes: number }>
  subjects: StatsSubject[]
  largest: StatsFileRow[]
  newest: StatsFileRow[]
  recent: StatsFileRow[]
  activity: { cells: HeatCell[]; weeks: Array<{ start: string; edited: number; created: number }>; streak: { current: number; longest: number; activeDays: number }; total: number }
  writing: { wordsInNotes: number; wordsTyped: number; storyWords: number; strokes: number; penMs: number }
  time: { dwellMs: number; byWeekday: number[]; notesMeasured: number; bySubject: Array<{ name: string; color: string | null; dwellMs: number }> }
  cards: { total: number; due: number; reviewed: number; reps: number; lapses: number; notes: number; retention: number | null }
  school: null | {
    done: number; open: number; overdue: number
    bySubject: Array<{ name: string; done: number; open: number; overdue: number }>
    upcoming: Array<{ title: string; subject: string; date: string; time: string | null; exam: boolean }>
    exams: Array<{ title: string; subject: string; date: string; time: string | null; exam: boolean }>
  }
}
export function dayKey(date: Date): string
export function countWords(markdown: string): number
export function noteKindOf(entry: { extension?: string }, hasInk?: boolean): StatsKind
export function flattenVault(tree: unknown[]): { files: Array<Record<string, unknown>>; folders: number }
export function summarizeCards(cards: Array<{ due: string; reps: number; lapses: number }>, today: string): NoteFacts['cards']
export function streaks(activeDays: Iterable<string>, today: Date): { current: number; longest: number; activeDays: number }
export function aggregateVault(input: {
  tree: unknown[]
  facts?: Record<string, NoteFacts>
  history?: Record<string, string[]>
  stories?: Record<string, Record<string, number>>
  homework?: Array<{ title: string; subject: string; dueDate: string | null; dueTime: string | null; done: boolean; kind: string }> | null
  now?: Date
}): VaultStats
