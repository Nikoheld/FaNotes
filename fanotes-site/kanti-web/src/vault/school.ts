// The app's own-data rules on top of a school snapshot, ported from android/core (CompanionDesk.kt,
// PlannedAbsences.kt, SchulnetzModels.kt): hidden lessons, planned absences and subject aliases.
import { absenceTally, eventDate, eventLabel, schulnetzClock, type AbsenceTally } from '@shared/schulnetz-logic'
import type { AgendaEvent, SchoolAbsence, Snapshot } from '../types'
import type { HiddenLesson, PlannedAbsence } from './files'

/** Kotlin colorKeys: the whole lower-case name and its first token (before a space or a bracket). */
export const colorKeys = (name: string): string[] => {
  const full = name.trim().toLowerCase()
  if (!full) return []
  const token = full.split(' ')[0].split('(')[0].trim()
  return [...new Set([full, token].filter(Boolean))]
}

const COURSE_CODE_SUFFIX = /\(([^)]+)\)\s*$/u

/** The student's own name for a subject (desk.json courseAliases), or the school's name. */
export const courseAlias = (name: string, aliases: Record<string, string>): string => {
  const keys = colorKeys(name)
  const code = COURSE_CODE_SUFFIX.exec(name.trim())?.[1] || ''
  if (code) keys.push(...colorKeys(code))
  for (const key of keys) {
    const alias = aliases[key]?.trim()
    if (alias) return alias
  }
  return name
}

/** The subject colour the student chose (colors.json), as Kotlin overrideColor, or null. */
export const overrideColor = (name: string, overrides: Record<string, string>): string | null => {
  const hex = (value: string | undefined) => (value && /^#[0-9a-f]{6}$/iu.test(value.trim()) ? value.trim().toLowerCase() : null)
  const keys = colorKeys(name)
  for (const key of keys) { const found = hex(overrides[key]); if (found) return found }
  const code = keys[1] ?? keys[0]
  if (!code || code.length < 3) return null
  let best: { length: number; color: string } | null = null
  for (const [stored, value] of Object.entries(overrides)) {
    const color = hex(value)
    const storedCode = stored.split(' ')[0].split('(')[0].trim()
    if (!color || storedCode.length < 3) continue
    if (storedCode.startsWith(code) || code.startsWith(storedCode)) { if (!best || storedCode.length > best.length) best = { length: storedCode.length, color } }
  }
  return best?.color ?? null
}

// ── Hidden lessons ───────────────────────────────────────────────────────────

const isoWeekday = (day: string): number => {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? 0 : ((date.getUTCDay() + 6) % 7) + 1
}

export const lessonDate = (event: AgendaEvent): string => eventDate(event.start)
export const lessonWeekday = (event: AgendaEvent): number => isoWeekday(lessonDate(event))
/** "HH:MM" of the start, or '' for an all-day entry. */
export const lessonClock = (event: AgendaEvent): string => {
  const start = schulnetzClock(event.start)
  const end = schulnetzClock(event.end)
  if (start === '00:00' && (!end || end === '00:00')) return ''
  return start
}

export const hideOnce = (event: AgendaEvent, existing: HiddenLesson[]): HiddenLesson[] => {
  const rule: HiddenLesson = { id: `once:${event.id}:${lessonDate(event)}`, mode: 'once', eventId: event.id, date: lessonDate(event), subject: eventLabel(event), weekday: lessonWeekday(event), start: lessonClock(event) }
  return [...existing.filter((item) => item.id !== rule.id), rule]
}

export const hideSeries = (event: AgendaEvent, existing: HiddenLesson[]): HiddenLesson[] => {
  const rule: HiddenLesson = { id: `series:${eventLabel(event).toLowerCase().trim()}|${lessonWeekday(event)}|${lessonClock(event)}`, mode: 'series', eventId: event.id, date: '', subject: eventLabel(event), weekday: lessonWeekday(event), start: lessonClock(event) }
  return [...existing.filter((item) => item.id !== rule.id), rule]
}

export const lessonHidden = (event: AgendaEvent, rules: HiddenLesson[]): boolean => {
  if (!rules.length) return false
  const date = lessonDate(event)
  const weekday = lessonWeekday(event)
  const start = lessonClock(event)
  const label = eventLabel(event)
  const subject = label.trim().toLowerCase()
  return rules.some((rule) => {
    if (rule.mode === 'once') return rule.eventId === event.id && (!rule.date.trim() || rule.date === date)
    const sameSubject = rule.subject.trim().toLowerCase() === subject || colorKeys(rule.subject).some((key) => colorKeys(label).includes(key))
    return sameSubject && rule.weekday === weekday && rule.start === start
  })
}

/** The rule that hides this lesson, for "show again". */
export const hidingRules = (event: AgendaEvent, rules: HiddenLesson[]): HiddenLesson[] => rules.filter((rule) => lessonHidden(event, [rule]))

// ── Planned absences ─────────────────────────────────────────────────────────

export type PlannedState = 'matched' | 'upcoming' | 'notEntered'
export interface PlannedItem { absence: PlannedAbsence; state: PlannedState }

const minutes = (clock: string): number | null => {
  const match = /^\s*([01]?\d|2[0-3]):([0-5]\d)/u.exec(clock)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/** Kotlin stableId: FNV-1a over the UTF-16 units, as `prefix-hex`. */
export const stableId = (prefix: string, ...parts: string[]): string => {
  let hash = 2166136261
  for (const char of parts.join('|')) {
    for (let index = 0; index < char.length; index += 1) hash = Math.imul(hash ^ char.charCodeAt(index), 16777619) >>> 0
  }
  return `${prefix}-${hash.toString(16)}`
}

export const planAbsence = (lesson: AgendaEvent, existing: PlannedAbsence[], now = Date.now()): PlannedAbsence[] => {
  const day = eventDate(lesson.start)
  if (!day) return existing
  const start = schulnetzClock(lesson.start)
  const end = schulnetzClock(lesson.end) || start
  if (!start) return existing
  if (existing.some((item) => item.date === day && item.start === start && item.end === end)) return existing
  return [...existing, { id: stableId('planned', day, start, lesson.id), date: day, start, end, subject: eventLabel(lesson), lessonId: lesson.id, createdAt: now }]
}

export const plannedFor = (lesson: AgendaEvent, planned: PlannedAbsence[]): PlannedAbsence | null => {
  const day = eventDate(lesson.start)
  if (!day) return null
  const start = schulnetzClock(lesson.start)
  return planned.find((item) => (item.lessonId && item.lessonId === lesson.id && item.date === day) || (item.date === day && item.start === start)) ?? null
}

/** Kotlin matchPlanned: a real open or booked absence on that day with overlapping times covers a plan. */
export const matchPlanned = (planned: PlannedAbsence[], snapshot: Pick<Snapshot, 'absences'> | null, today: string): PlannedItem[] => {
  const real = (snapshot?.absences || []).filter((absence) => absence.pending || absence.points != null)
  return planned.map((item) => {
    const day = /^\d{4}-\d{2}-\d{2}$/u.test(item.date) ? item.date : ''
    const from = minutes(item.start)
    const to = minutes(item.end)
    const matched = day !== '' && real.some((entry) => {
      const first = eventDate(entry.dateFrom)
      if (!first) return false
      const toDay = eventDate(entry.dateTo)
      const last = toDay && toDay >= first ? toDay : first
      if (day < first || day > last) return false
      const eFrom = minutes(entry.hourFrom)
      const eTo = minutes(entry.hourTo)
      if (first === last && eFrom != null && eTo != null && eTo > eFrom && from != null && to != null && to > from) return eFrom < to && from < eTo
      return true
    })
    const state: PlannedState = matched ? 'matched' : day !== '' && day >= today ? 'upcoming' : 'notEntered'
    return { absence: item, state }
  })
}

export interface ProvisionalTally { tally: AbsenceTally; current: AbsenceTally; items: PlannedItem[]; plannedPoints: number }

/** The points the student would have with the planned absences entered as open reports (Kotlin provisionalTally). */
export const provisionalTally = (snapshot: Snapshot | null, planned: PlannedAbsence[], today: string): ProvisionalTally => {
  const items = matchPlanned(planned, snapshot, today)
  const current = absenceTally(snapshot)
  const rows: SchoolAbsence[] = items.filter((item) => item.state === 'upcoming').map(({ absence }) => ({
    id: `planned:${absence.id}`, dateFrom: absence.date, dateTo: absence.date, hourFrom: absence.start, hourTo: absence.end,
    subject: absence.subject, reason: '', excused: false, acknowledged: false, status: 'geplant', pending: true,
  }))
  if (!rows.length || !snapshot) return { tally: current, current, items, plannedPoints: 0 }
  const tally = absenceTally({ ...snapshot, absences: [...snapshot.absences, ...rows] })
  return { tally, current, items, plannedPoints: tally.estimated - current.estimated }
}
