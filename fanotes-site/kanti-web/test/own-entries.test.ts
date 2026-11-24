import { describe, expect, it } from 'vitest'
import { allEntries, nextCommitment } from '../src/lib/agenda'
import { withOwn } from '../src/vault/entries'
import { emptyOwn, type OwnData } from '../src/vault/own'
import { emptyCalendar, type CalendarEvent } from '../src/vault/files'
import { occurrenceSpans, dayMs, skipOccurrence, saveOccurrence } from '../src/vault/calendar'
import type { AgendaEvent, Snapshot } from '../src/types'

const lesson = (id: string, day: string, from: string, to: string, name: string): AgendaEvent => ({
  id, start: `${day}T${from}:00`, end: `${day}T${to}:00`, text: name, comment: '', room: 'A1', teachers: [], courseId: id, courseName: name, status: '', eventType: 'lesson', color: '', timetableText: name,
})
const snapshot = (events: AgendaEvent[]): Snapshot => ({ revision: 1, fetchedAt: '', grades: [], events, exams: [], absences: [], homework: [], messages: [], vacations: [], konto: [], startMessages: [] })
const range = { from: '2026-11-01', to: '2026-12-31' }
const event = (patch: Partial<CalendarEvent>): CalendarEvent => ({ id: 'e1', calendarId: 'personal', title: 'Training', start: '2026-11-12T18:00', end: '2026-11-12T19:30', allDay: false, location: '', notes: '', notePath: '', recurrence: 'none', recurrenceUntil: null, exceptionDates: [], ...patch })
const own = (patch: Partial<OwnData>): OwnData => ({ ...emptyOwn(), ...patch })

describe('own entries in the agenda', () => {
  const entries = allEntries(snapshot([lesson('l1', '2026-11-12', '07:45', '08:30', 'Chor'), lesson('l2', '2026-11-12', '08:35', '09:20', 'Mathematik (M4a)')]))

  it('returns the school entries unchanged when there is nothing of one\'s own', () => {
    expect(withOwn(entries, emptyOwn(), range)).toBe(entries)
  })

  it('hidden lessons leave and subject aliases apply to lesson titles', () => {
    const hidden = [{ id: 'once:l1:2026-11-12', mode: 'once' as const, eventId: 'l1', date: '2026-11-12', subject: 'Chor', weekday: 4, start: '07:45' }]
    const shown = withOwn(entries, own({ hidden, desk: { courseAliases: { m4a: 'Mathe' }, gradeDecimals: 2, showPluspunkte: true, gradeSort: 'name' } }), range)
    expect(shown.map((entry) => entry.title)).toEqual(['Mathe'])
  })

  it('own events (also series) and open tasks with a due date join as entries', () => {
    const calendar = { ...emptyCalendar(), events: [event({ recurrence: 'weekly' })] }
    const tasks = [
      { id: 't1', title: 'Aufgaben', notes: '', subject: 'Mathematik', dueDate: '2026-11-13', dueTime: null, done: false, kind: 'homework' as const, priority: 'normal' as const, createdAt: '', updatedAt: '' },
      { id: 't2', title: 'Fertig', notes: '', subject: '', dueDate: '2026-11-13', dueTime: null, done: true, kind: 'homework' as const, priority: 'normal' as const, createdAt: '', updatedAt: '' },
      { id: 't3', title: 'Ohne Datum', notes: '', subject: '', dueDate: null, dueTime: null, done: false, kind: 'homework' as const, priority: 'normal' as const, createdAt: '', updatedAt: '' },
    ]
    const merged = withOwn(entries, own({ calendar, tasks }), range)
    const days = merged.filter((entry) => entry.own?.type === 'event').map((entry) => entry.day)
    expect(days.slice(0, 3)).toEqual(['2026-11-12', '2026-11-19', '2026-11-26'])
    expect(merged.find((entry) => entry.own?.type === 'event')).toMatchObject({ start: '18:00', end: '19:30', kind: 'appointment' })
    expect(merged.filter((entry) => entry.own?.type === 'task').map((entry) => entry.title)).toEqual(['Aufgaben'])
  })

  it('a task without a time is never "what comes next"; a timed own event can be', () => {
    const clock = { today: '2026-11-12', minutes: 10 * 60 }
    const tasks = [{ id: 't1', title: 'Aufgaben', notes: '', subject: '', dueDate: '2026-11-12', dueTime: null, done: false, kind: 'homework' as const, priority: 'normal' as const, createdAt: '', updatedAt: '' }]
    const calendar = { ...emptyCalendar(), events: [event({ id: 'e9', start: '2026-11-12T15:00', end: '2026-11-12T16:00' })] }
    const merged = withOwn(entries, own({ tasks, calendar }), range)
    expect(nextCommitment(merged, clock)?.title).toBe('Training')
  })

  it('an all-day event over several days fills each day', () => {
    const calendar = { ...emptyCalendar(), events: [event({ id: 'trip', title: 'Lager', allDay: true, start: '2026-11-16', end: '2026-11-18' })] }
    const days = withOwn([], own({ calendar }), range).map((entry) => entry.day)
    expect(days).toEqual(['2026-11-16', '2026-11-17', '2026-11-18'])
  })
})

describe('recurrence and series edits (CalendarEdit.kt)', () => {
  const doc = (e: CalendarEvent) => ({ ...emptyCalendar(), events: [e] })
  const span = (e: CalendarEvent, from: string, to: string) => occurrenceSpans(doc(e), dayMs(from)!, dayMs(to)!).map((item) => item.key.split('@')[1])

  it('a monthly series keeps its original day; a short month clamps only that instance', () => {
    expect(span(event({ start: '2026-01-31T10:00', end: '2026-01-31T11:00', recurrence: 'monthly' }), '2026-01-01', '2026-05-01')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('"until" is inclusive and exceptions are skipped', () => {
    expect(span(event({ recurrence: 'daily', recurrenceUntil: '2026-11-15', exceptionDates: ['2026-11-14'] }), '2026-11-01', '2026-12-01')).toEqual(['2026-11-12', '2026-11-13', '2026-11-15'])
  })

  it('skipping a later day records an exception; skipping the first day of a weekly series moves the start', () => {
    const weekly = event({ recurrence: 'weekly' })
    expect(skipOccurrence(doc(weekly), 'e1', '2026-11-19').events[0].exceptionDates).toEqual(['2026-11-19'])
    expect(skipOccurrence(doc(weekly), 'e1', '2026-11-12').events[0]).toMatchObject({ start: '2026-11-19T18:00', end: '2026-11-19T19:30' })
    expect(skipOccurrence(doc(event({})), 'e1', '2026-11-12').events).toEqual([])
    expect(skipOccurrence(doc(event({ recurrence: 'monthly' })), 'e1', '2026-11-12').events[0].exceptionDates).toEqual(['2026-11-12'])
  })

  it('editing a later repeat detaches it as its own event and the series skips that day', () => {
    const weekly = event({ recurrence: 'weekly' })
    const next = saveOccurrence(doc(weekly), 'e1@2026-11-19', { ...weekly, title: 'Training verlegt', start: '2026-11-19T19:00', end: '2026-11-19T20:00' }, 'detached-1')
    expect(next.events).toHaveLength(2)
    expect(next.events[0].exceptionDates).toEqual(['2026-11-19'])
    expect(next.events[1]).toMatchObject({ id: 'detached-1', title: 'Training verlegt', recurrence: 'none', recurrenceUntil: null, start: '2026-11-19T19:00' })
    // Editing the first day edits the series itself.
    const first = saveOccurrence(doc(weekly), 'e1@2026-11-12', { ...weekly, title: 'Neu' })
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ id: 'e1', title: 'Neu', recurrence: 'weekly' })
  })

  it('an unusable edit (blank title, unknown calendar, no date) leaves the document alone', () => {
    const original = doc(event({}))
    expect(saveOccurrence(original, 'e1@2026-11-12', event({ title: '  ' }))).toBe(original)
    expect(saveOccurrence(original, null, event({ calendarId: 'gone' }))).toBe(original)
    expect(saveOccurrence(original, null, event({ start: 'bad' }))).toBe(original)
    expect(saveOccurrence(original, null, event({ id: 'new', title: 'Neu', end: '2026-11-12T17:00' })).events.find((item) => item.id === 'new')?.end).toBe('2026-11-12T18:30')
  })
})
