// Days and weeks out of a snapshot: the browser's view of the app's agenda. Times are Zurich wall
// clock times, as Schulnetz and TAM give them ("2026-11-16T07:40:00").
import {
  addDays, cleanSchulnetzText, eventDate, eventLabel, isCancelled, isExamLike, isLesson, isSubstitution,
  schulnetzClock, weekMonday, weekMondayKey, zurichClock, zurichToday,
} from '@shared/schulnetz-logic'
import type { AgendaEvent, Snapshot } from '../types'

export type EntryKind = 'lesson' | 'exam' | 'appointment'

export interface Entry {
  key: string
  kind: EntryKind
  day: string
  start: string
  end: string
  title: string
  room: string
  teachers: string[]
  comment: string
  cancelled: boolean
  substitution: boolean
  event: AgendaEvent
}

export const clockMinutes = (clock: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/u.exec(clock)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

const kindOf = (event: AgendaEvent): EntryKind => (isExamLike(event) ? 'exam' : isLesson(event) ? 'lesson' : 'appointment')

const toEntry = (event: AgendaEvent, kind = kindOf(event)): Entry => {
  const day = eventDate(event.start)
  const start = schulnetzClock(event.start)
  const end = schulnetzClock(event.end)
  return {
    key: `${kind}:${event.id}:${event.start}`,
    kind,
    day,
    start: start === '00:00' && (!end || end === '00:00' || end === '23:59') ? '' : start,
    end: end === '00:00' || end === '23:59' ? '' : end,
    title: kind === 'exam' ? examTitle(event) : eventLabel(event),
    room: cleanSchulnetzText(event.room),
    teachers: (event.teachers || []).map((teacher) => cleanSchulnetzText(teacher)).filter(Boolean),
    comment: cleanSchulnetzText(event.comment),
    cancelled: isCancelled(event),
    substitution: isSubstitution(event),
    event,
  }
}

const examTitle = (event: AgendaEvent) => cleanSchulnetzText(event.text) || cleanSchulnetzText(event.timetableText) || eventLabel(event)

/** Every dated entry of the snapshot, exams once even when a lesson row and the exam list both carry it. */
export const allEntries = (snapshot: Snapshot | null): Entry[] => {
  if (!snapshot) return []
  const out: Entry[] = []
  const seen = new Set<string>()
  const push = (entry: Entry) => {
    if (!entry.day) return
    const identity = entry.kind === 'exam' ? `exam:${entry.day}:${entry.start}:${entry.title.toLowerCase()}` : entry.key
    if (seen.has(identity)) return
    seen.add(identity)
    out.push(entry)
  }
  for (const exam of snapshot.exams || []) push(toEntry(exam, 'exam'))
  for (const event of snapshot.events || []) push(toEntry(event))
  return out.sort(compareEntries)
}

export const compareEntries = (left: Entry, right: Entry) =>
  left.day.localeCompare(right.day) || (left.start || '00:00').localeCompare(right.start || '00:00') || left.title.localeCompare(right.title)

export const byDay = (entries: Entry[]): Map<string, Entry[]> => {
  const map = new Map<string, Entry[]>()
  for (const entry of entries) {
    const list = map.get(entry.day) || []
    list.push(entry)
    map.set(entry.day, list)
  }
  return map
}

export const weekDays = (monday: string, weekend = false) => Array.from({ length: weekend ? 7 : 5 }, (_, index) => addDays(monday, index))

export type WeekState = 'read' | 'unread' | 'empty' | 'holiday'

/** Whether a week was read, so an unread week never looks free. */
export const weekState = (snapshot: Snapshot | null, monday: string, entries: Entry[]): WeekState => {
  const days = new Set(weekDays(monday, true))
  const lessons = entries.some((entry) => entry.kind === 'lesson' && days.has(entry.day))
  if (lessons) return 'read'
  if (vacationOn(snapshot, monday) && vacationOn(snapshot, addDays(monday, 4))) return 'holiday'
  if (snapshot?.weekRead?.[monday]) return 'empty'
  return 'unread'
}

export const vacationOn = (snapshot: Snapshot | null, day: string) =>
  (snapshot?.vacations || []).find((vacation) => {
    const start = eventDate(vacation.start)
    const end = eventDate(vacation.end) || start
    return start && start <= day && day <= end
  }) || null

/** The weeks the timetable can show: the snapshot's span, widened to every week with an entry. */
export const weekRange = (snapshot: Snapshot | null, entries: Entry[], today: string): string[] => {
  const mondays = new Set<string>([weekMonday(today)])
  if (snapshot?.weekSpanStart) mondays.add(weekMonday(snapshot.weekSpanStart))
  if (snapshot?.weekSpanEnd) mondays.add(weekMonday(snapshot.weekSpanEnd))
  for (const entry of entries) mondays.add(weekMonday(entry.day))
  const sorted = [...mondays].filter(Boolean).sort()
  const out: string[] = []
  for (let monday = sorted[0]; monday && monday <= sorted[sorted.length - 1] && out.length < 80; monday = addDays(monday, 7)) out.push(monday)
  return out
}

export interface Clock { today: string; minutes: number }

export const zurichNow = (now = new Date()): Clock => ({ today: zurichToday(now), minutes: clockMinutes(zurichClock(now)) ?? 0 })

/** The lesson, exam or event that is running or comes next, looking two weeks ahead. Cancelled lessons are skipped. */
export const nextCommitment = (entries: Entry[], clock: Clock): Entry | null => {
  const horizon = addDays(clock.today, 14)
  for (const entry of entries) {
    if (entry.day < clock.today || entry.day > horizon) continue
    if (entry.kind === 'lesson' && entry.cancelled) continue
    if (entry.day === clock.today) {
      const end = clockMinutes(entry.end) ?? clockMinutes(entry.start)
      if (end != null && end <= clock.minutes) continue
      if (end == null && !entry.start && entry.kind === 'lesson') continue
    }
    return entry
  }
  return null
}

export const isRunning = (entry: Entry, clock: Clock) => {
  if (entry.day !== clock.today) return false
  const start = clockMinutes(entry.start)
  const end = clockMinutes(entry.end)
  return start != null && start <= clock.minutes && (end == null || clock.minutes < end)
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export { weekMonday, weekMondayKey, addDays }
