// Days and weeks out of a snapshot: the browser's view of the app's agenda. Times are Zurich wall
// clock times, as Schulnetz and TAM give them ("2026-11-16T07:40:00").
import {
  addDays, cleanSchulnetzText, eventDate, eventLabel, isCancelled, isExamLike, isLesson, isSubstitution,
  schulnetzClock, weekMonday, weekMondayKey, zurichClock, zurichToday,
} from '@shared/schulnetz-logic'
import type { AgendaEvent, Snapshot } from '../types'
import { visibleLessons, type GroupChoices } from './groups'

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
  /** '' | 'cancelled' | 'added' | 'moved' | 'changed' */
  marker: string
  substitute: string
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
    cancelled: isCancelled(event) || event.marker === 'cancelled',
    substitution: isSubstitution(event),
    marker: cleanSchulnetzText(event.marker).toLowerCase(),
    substitute: cleanSchulnetzText(event.substitute),
    event,
  }
}

const examTitle = (event: AgendaEvent) => cleanSchulnetzText(event.text) || cleanSchulnetzText(event.timetableText) || eventLabel(event)

const lessonKey = (event: AgendaEvent) => `${event.id}|${event.start}`
const examKey = (event: AgendaEvent) => `${event.id}|${event.start}|${eventLabel(event)}`

export interface ExamInSlot { original: AgendaEvent; shown: AgendaEvent }
export interface ExamSlotMerge { dropped: Set<string>; exams: ExamInSlot[] }

const lowerClean = (...parts: string[]) => parts.map((part) => cleanSchulnetzText(part)).join(' ').toLowerCase()

const belongsToCourse = (exam: AgendaEvent, lesson: AgendaEvent): boolean => {
  if (exam.courseId && exam.courseId === lesson.courseId) return true
  const name = cleanSchulnetzText(lesson.courseName).toLowerCase()
  if (name && lowerClean(exam.text, exam.courseName, exam.timetableText).includes(name)) return true
  const full = eventLabel(lesson).trim().toLowerCase()
  const token = full.split(' ')[0].split('(')[0].trim()
  return token.length >= 2 && eventLabel(exam).toLowerCase().startsWith(token)
}

/**
 * Exams scheduled for exactly one lesson, or two consecutive lessons, of one course take that slot
 * (Kotlin: examsInLessonSlots). The lessons are dropped; the exam starts with the first lesson, ends
 * with the last and borrows the lesson's room when it has none.
 */
export const examsInLessonSlots = (lessons: AgendaEvent[], exams: AgendaEvent[]): ExamSlotMerge => {
  const byDay = new Map<string, { from: number; to: number; event: AgendaEvent }[]>()
  for (const event of lessons) {
    if (!isLesson(event) || isCancelled(event)) continue
    const day = eventDate(event.start)
    const from = clockMinutes(schulnetzClock(event.start))
    const to = clockMinutes(schulnetzClock(event.end))
    if (!day || from === null || to === null || to <= from) continue
    byDay.set(day, [...(byDay.get(day) || []), { from, to, event }])
  }
  for (const list of byDay.values()) list.sort((a, b) => a.from - b.from)
  const dropped = new Set<string>()
  const merged: ExamInSlot[] = []
  for (const exam of exams) {
    const day = eventDate(exam.start)
    const from = clockMinutes(schulnetzClock(exam.start))
    const to = clockMinutes(schulnetzClock(exam.end))
    if (!day || from === null || to === null || to <= from) continue
    const hits = (byDay.get(day) || []).map((item, index) => ({ ...item, index })).filter((item) => item.from < to && item.to > from)
    if (hits.length < 1 || hits.length > 2) continue
    if (hits.length === 2 && hits[1].index !== hits[0].index + 1) continue
    const first = hits[0].event
    const last = hits[hits.length - 1].event
    if (hits.some((hit) => eventLabel(hit.event) !== eventLabel(first))) continue
    if (!belongsToCourse(exam, first)) continue
    for (const hit of hits) dropped.add(lessonKey(hit.event))
    merged.push({ original: exam, shown: { ...exam, start: first.start, end: last.end, room: exam.room || first.room, eventType: isExamLike(exam) ? exam.eventType : 'exam' } })
  }
  return { dropped, exams: merged }
}

/** Every dated entry of the snapshot, exams once even when a lesson row and the exam list both carry it. */
export const allEntries = (snapshot: Snapshot | null, groupChoices: GroupChoices = {}): Entry[] => {
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
  const events = visibleLessons(snapshot.events || [], groupChoices)
  const exams = snapshot.exams || []
  const merge = examsInLessonSlots(events.filter(isLesson), [...exams, ...events.filter(isExamLike)])
  const shown = (exam: AgendaEvent) => merge.exams.find((item) => examKey(item.original) === examKey(exam))?.shown || exam
  for (const exam of exams) push(toEntry(shown(exam), 'exam'))
  for (const event of events) {
    if (merge.dropped.has(lessonKey(event)) && !isExamLike(event)) continue
    push(toEntry(shown(event)))
  }
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
