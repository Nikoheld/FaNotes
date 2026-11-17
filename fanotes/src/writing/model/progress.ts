// Writing progress for goals and the streak calendar. Each device writes only
// its own file (`progress/<writer>.json`), so progress never conflicts in
// sync; the totals are the sum over all devices' files.
import type { StoryGoals } from './types'

export const PROGRESS_FORMAT = 'fanotes-story-progress-v1' as const

export type ProgressDay = {
  /** Manuscript words when this device first opened the story that day. */
  start: number
  /** Words written that day on this device (manuscript total minus start, can be negative after cutting). */
  words: number
}

export type ProgressFile = {
  format: typeof PROGRESS_FORMAT
  writer: string
  days: Record<string, ProgressDay>
  updatedAt: string
}

export const progressPath = (storyPath: string, writer: string) => `${storyPath}/progress/${writer}.json`
export const isProgressFile = (relative: string) => /^progress\/[0-9a-z]{4,40}\.json$/u.test(relative)

/** Local calendar date (YYYY-MM-DD): a writing day is the writer's day, not UTC's. */
export const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const DATE = /^\d{4}-\d{2}-\d{2}$/u

export const sanitizeProgress = (value: unknown): ProgressFile | null => {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  if (source.format !== PROGRESS_FORMAT || typeof source.writer !== 'string' || !/^[0-9a-z]{4,40}$/u.test(source.writer)) return null
  const days: Record<string, ProgressDay> = {}
  if (source.days && typeof source.days === 'object') {
    for (const [date, day] of Object.entries(source.days as Record<string, unknown>).slice(-4000)) {
      const entry = day as Partial<ProgressDay> | null
      if (!DATE.test(date) || !entry || typeof entry.start !== 'number' || typeof entry.words !== 'number') continue
      if (!Number.isFinite(entry.start) || !Number.isFinite(entry.words)) continue
      days[date] = { start: Math.max(0, Math.round(entry.start)), words: Math.round(entry.words) }
    }
  }
  return { format: PROGRESS_FORMAT, writer: source.writer, days, updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt.slice(0, 40) : new Date(0).toISOString() }
}

/**
 * Records the manuscript's word total for today. The first call of a day
 * sets the baseline; later calls update the day's words. Returns the same
 * object when nothing changed (no write needed).
 */
export const recordProgress = (file: ProgressFile | null, writer: string, total: number, now = new Date()): ProgressFile => {
  const date = localDate(now)
  const current = file ?? { format: PROGRESS_FORMAT, writer, days: {}, updatedAt: now.toISOString() }
  const day = current.days[date]
  if (!day) return { ...current, days: { ...current.days, [date]: { start: total, words: 0 } }, updatedAt: now.toISOString() }
  const words = total - day.start
  if (words === day.words) return current
  return { ...current, days: { ...current.days, [date]: { ...day, words } }, updatedAt: now.toISOString() }
}

/** Words per date over all devices (negative days count as 0). */
export const wordsPerDay = (files: ProgressFile[]) => {
  const out = new Map<string, number>()
  for (const file of files) for (const [date, day] of Object.entries(file.days)) out.set(date, (out.get(date) ?? 0) + Math.max(0, day.words))
  return out
}

const shift = (date: string, days: number) => {
  const [year, month, day] = date.split('-').map(Number)
  return localDate(new Date(year, month - 1, day + days))
}

/** Current and longest streak: consecutive days with at least `goal` words (1 when there is no daily goal). Today still counts as open. */
export const streaks = (days: Map<string, number>, goal: number | undefined, today = localDate()) => {
  const need = Math.max(1, goal ?? 1)
  const met = (date: string) => (days.get(date) ?? 0) >= need
  let current = 0
  let cursor = met(today) ? today : shift(today, -1)
  while (met(cursor)) { current += 1; cursor = shift(cursor, -1) }
  let longest = 0
  let run = 0
  let previous: string | null = null
  for (const date of [...days.keys()].filter(met).sort()) {
    run = previous && shift(previous, 1) === date ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = date
  }
  return { current, longest: Math.max(longest, current), todayMet: met(today) }
}

/** Project goal figures: share done, words left, and words per day until the deadline. */
export const goalStatus = (total: number, goals: StoryGoals | undefined, today = localDate()) => {
  const project = goals?.project ?? 0
  const left = project ? Math.max(0, project - total) : 0
  let daysLeft: number | null = null
  if (goals?.deadline && DATE.test(goals.deadline)) {
    const [y1, m1, d1] = today.split('-').map(Number)
    const [y2, m2, d2] = goals.deadline.split('-').map(Number)
    daysLeft = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1
  }
  return {
    share: project ? Math.min(1, total / project) : null,
    left,
    daysLeft,
    perDay: project && daysLeft !== null && daysLeft > 0 ? Math.ceil(left / daysLeft) : null,
  }
}

/** The last `weeks` weeks as columns of 7 days (Monday first), for the calendar. */
export const calendarWeeks = (weeks: number, today = localDate()) => {
  const [year, month, day] = today.split('-').map(Number)
  const weekday = (new Date(year, month - 1, day).getDay() + 6) % 7
  const start = shift(today, -weekday - (weeks - 1) * 7)
  return Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, index) => shift(start, week * 7 + index)))
}
