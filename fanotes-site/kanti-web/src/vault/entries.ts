// The student's own data merged into the school's agenda entries: hidden lessons leave, subject aliases
// apply, own calendar events and open tasks with a due date join as entries.
import { useMemo } from 'react'
import { addDays } from '@shared/schulnetz-logic'
import { allEntries, type Entry } from '../lib/agenda'
import { useKanti } from '../state'
import type { AgendaEvent } from '../types'
import { dayMs, dayText, occurrenceSpans, wallText } from './calendar'
import type { HomeworkTask } from './files'
import type { OwnData } from './own'
import { courseAlias, lessonHidden } from './school'
import { useVault } from './store'

const DAY_MS = 86_400_000

const synthetic = (id: string, title: string, start: string, end: string, comment: string, room: string): AgendaEvent => ({
  id, start, end, text: title, comment, room, teachers: [], courseId: '', courseName: '', status: '', eventType: 'appointment', color: '', timetableText: '', marker: '',
})

const eventEntries = (own: OwnData, from: string, to: string): Entry[] => {
  const start = dayMs(from)
  const end = dayMs(to)
  if (start === null || end === null) return []
  const out: Entry[] = []
  for (const span of occurrenceSpans(own.calendar, start, end + DAY_MS)) {
    const { event } = span
    const first = dayText(span.start)
    const allDay = event.allDay || !event.start.includes('T')
    const dayStart = span.start - (span.start % DAY_MS)
    const days = allDay ? Math.max(1, Math.round((span.end - span.start) / DAY_MS)) : 1
    for (let offset = 0; offset < days; offset += 1) {
      const day = dayText(dayStart + offset * DAY_MS)
      if (day < from || day > to) continue
      const timed = !allDay
      const startClock = timed ? wallText(span.start).slice(11) : ''
      const endClock = timed ? wallText(span.end).slice(11) : ''
      out.push({
        key: `own:event:${span.key}:${day}`, kind: 'appointment', day, start: startClock, end: endClock === '00:00' ? '' : endClock, title: event.title, room: event.location, teachers: [],
        comment: event.notes, cancelled: false, substitution: false, marker: '', substitute: '',
        event: synthetic(event.id, event.title, timed ? `${first}T${startClock}:00` : first, timed ? `${dayText(span.end)}T${endClock}:00` : event.end, event.notes, event.location),
        own: { type: 'event', id: event.id, occurrence: span.key.split('@')[1] },
      })
    }
  }
  return out
}

export const taskEntry = (task: HomeworkTask): Entry | null => {
  if (!task.dueDate) return null
  const time = task.dueTime || ''
  return {
    key: `own:task:${task.id}`, kind: 'appointment', day: task.dueDate, start: time, end: '', title: task.title, room: '',
    teachers: task.subject ? [task.subject] : [], comment: task.notes, cancelled: false, substitution: false, marker: '', substitute: '',
    event: synthetic(task.id, task.title, time ? `${task.dueDate}T${time}:00` : task.dueDate, '', task.notes, ''),
    own: { type: 'task', id: task.id },
  }
}

export interface OwnEntryOptions { from: string; to: string }

/** School entries with the student's own data applied. Pure, so it is tested without a page. */
export const withOwn = (entries: Entry[], own: OwnData, range: OwnEntryOptions): Entry[] => {
  const hasAlias = Object.keys(own.desk.courseAliases).length > 0
  const shown = entries
    .filter((entry) => !(entry.kind === 'lesson' && lessonHidden(entry.event, own.hidden)))
    .map((entry) => (hasAlias && entry.kind === 'lesson' ? { ...entry, title: courseAlias(entry.title, own.desk.courseAliases) } : entry))
  const added = [
    ...eventEntries(own, range.from, range.to),
    ...own.tasks.filter((task) => !task.done).map(taskEntry).filter((entry): entry is Entry => entry !== null),
  ]
  if (!added.length && shown.length === entries.length && !hasAlias) return entries
  return [...shown, ...added].sort((left, right) => left.day.localeCompare(right.day) || (left.start || '00:00').localeCompare(right.start || '00:00') || left.title.localeCompare(right.title))
}

/** `allEntries` of the shown connection plus the student's own entries (a year back, two years ahead). */
export const useEntries = (): Entry[] => {
  const { data } = useKanti()
  const { own } = useVault()
  const today = new Date().toISOString().slice(0, 10)
  return useMemo(() => withOwn(allEntries(data.snapshot), own, { from: addDays(today, -400), to: addDays(today, 800) }), [data.snapshot, own, today])
}
