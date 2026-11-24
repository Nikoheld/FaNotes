// The own calendar (Kalender.md): recurrence and series edits, ported from android/core desk/CalendarEdit.kt
// so the browser and the app agree on which days an event covers and what "only this one" does.
import { newId, type CalendarDocument, type CalendarEvent } from './files'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u
const WALL_KEY = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/u

/** Wall-clock text as milliseconds, read as UTC so no time zone or daylight-saving shift gets in. */
export const dayMs = (day: string): number | null => {
  if (!DAY_KEY.test(day)) return null
  const ms = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day ? null : ms
}
export const wallMs = (value: string): number | null => {
  const match = WALL_KEY.exec(value)
  if (!match) return null
  const day = dayMs(match[1])
  const hour = Number(match[2])
  const minute = Number(match[3])
  return day === null || hour > 23 || minute > 59 ? null : day + hour * 3_600_000 + minute * MINUTE_MS
}
export const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const wallText = (ms: number): string => new Date(ms).toISOString().slice(0, 16)

/** A short month clamps that one instance; the next month uses the original day again. */
export const monthShift = (origin: number, months: number): number => {
  const date = new Date(origin)
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
  const length = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), length))
}

/** The nth repeat, counted from the original start rather than from the previous clamped day. */
export const instanceStart = (origin: number, step: number, recurrence: string): number => {
  const day = origin - (origin % DAY_MS)
  const time = origin - day
  const moved = recurrence === 'weekly' ? day + 7 * step * DAY_MS
    : recurrence === 'monthly' ? monthShift(day, step)
      : recurrence === 'yearly' ? monthShift(day, 12 * step)
        : day + step * DAY_MS
  return moved + time
}

const isRecurring = (recurrence: string) => recurrence === 'daily' || recurrence === 'weekly' || recurrence === 'monthly' || recurrence === 'yearly'

export interface Span { key: string; event: CalendarEvent; start: number; end: number }

/** First start and (exclusive) end of an event; an all-day event ends at the start of the day after its last day. */
export const spanBounds = (event: CalendarEvent): { start: number; end: number } | null => {
  if (event.allDay || !event.start.includes('T')) {
    const start = dayMs(event.start.slice(0, 10))
    if (start === null) return null
    const inclusive = dayMs(event.end.slice(0, 10)) ?? start
    return { start, end: Math.max(inclusive, start) + DAY_MS }
  }
  const start = wallMs(event.start)
  if (start === null) return null
  const parsedEnd = wallMs(event.end)
  return { start, end: parsedEnd === null || parsedEnd <= start ? start + 30 * MINUTE_MS : parsedEnd }
}

/** Every occurrence that touches [rangeStart, rangeEnd), series expanded, skipped days left out. */
export const occurrenceSpans = (document: CalendarDocument, rangeStart: number, rangeEnd: number, onlyVisible = true): Span[] => {
  const visible = new Set(document.calendars.filter((calendar) => calendar.visible || !onlyVisible).map((calendar) => calendar.id))
  const spans: Span[] = []
  for (const event of document.events) {
    if (!visible.has(event.calendarId)) continue
    const bounds = spanBounds(event)
    if (!bounds) continue
    const duration = bounds.end - bounds.start
    if (duration <= 0) continue
    const until = event.recurrenceUntil ? dayMs(event.recurrenceUntil) : null
    const untilEnd = until === null ? null : until + DAY_MS
    const skipped = new Set(event.exceptionDates)
    let step = 0
    let cursor = bounds.start
    for (let guard = 0; cursor < rangeEnd && guard < 500; guard += 1) {
      if (untilEnd !== null && cursor >= untilEnd) break
      const end = cursor + duration
      const day = dayText(cursor)
      if (!skipped.has(day) && end > rangeStart && cursor < rangeEnd) spans.push({ key: `${event.id}@${day}`, event, start: cursor, end })
      if (!isRecurring(event.recurrence)) break
      step += 1
      const next = instanceStart(bounds.start, step, event.recurrence)
      if (next <= cursor) break
      cursor = next
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.event.title.toLowerCase().localeCompare(b.event.title.toLowerCase(), 'de'))
}

// ── Edits ────────────────────────────────────────────────────────────────────

const clean = (value: string, max: number) => value.replace(/\s+/gu, ' ').trim().slice(0, max)
const validDay = (value: string) => dayMs(value) !== null

const upsert = (document: CalendarDocument, event: CalendarEvent): CalendarDocument => ({
  ...document,
  events: document.events.some((item) => item.id === event.id) ? document.events.map((item) => (item.id === event.id ? event : item)) : [...document.events, event],
})

const normalizeBounds = (startRaw: string, endRaw: string, allDay: boolean): { start: string; end: string } | null => {
  if (allDay) {
    const start = dayMs(startRaw.slice(0, 10))
    const end = dayMs(endRaw.slice(0, 10))
    if (start === null || end === null) return null
    return { start: dayText(start), end: dayText(Math.max(start, end)) }
  }
  const start = wallMs(startRaw)
  if (start === null) return null
  const parsedEnd = wallMs(endRaw)
  const end = parsedEnd === null || parsedEnd <= start ? start + 30 * MINUTE_MS : parsedEnd
  return { start: wallText(start), end: wallText(end) }
}

/** Kotlin sanitizeCalendarEvent: null when the title, the calendar or the dates are not usable. */
export const sanitizeEvent = (event: CalendarEvent, calendarIds: Set<string>): CalendarEvent | null => {
  const title = clean(event.title, 240)
  if (!title) return null
  const calendarId = clean(event.calendarId, 80)
  if (!calendarIds.has(calendarId)) return null
  const bounds = normalizeBounds(event.start, event.end, event.allDay)
  if (!bounds) return null
  const recurrence = isRecurring(event.recurrence) ? event.recurrence : 'none'
  return {
    ...event,
    id: clean(event.id, 80) || newId(),
    calendarId,
    title,
    start: bounds.start,
    end: bounds.end,
    location: clean(event.location, 160),
    notes: event.notes.slice(0, 4000),
    notePath: clean(event.notePath, 400),
    recurrence,
    recurrenceUntil: recurrence !== 'none' && event.recurrenceUntil && validDay(event.recurrenceUntil) ? event.recurrenceUntil : null,
    exceptionDates: recurrence === 'none' ? [] : [...new Set(event.exceptionDates.filter(validDay))].slice(0, 400),
  }
}

export const deleteEvent = (document: CalendarDocument, id: string): CalendarDocument => ({ ...document, events: document.events.filter((event) => event.id !== id) })

const advance = (value: string, allDay: boolean, recurrence: string): string => {
  const dateOnly = allDay || !value.includes('T')
  const moment = dateOnly ? dayMs(value.slice(0, 10)) : wallMs(value)
  if (moment === null) return value
  const next = recurrence === 'weekly' ? moment + 7 * DAY_MS : recurrence === 'monthly' ? monthShift(moment - (moment % DAY_MS), 1) + (moment % DAY_MS) : recurrence === 'yearly' ? monthShift(moment - (moment % DAY_MS), 12) + (moment % DAY_MS) : moment + DAY_MS
  return dateOnly ? dayText(next) : wallText(next)
}

/**
 * Drop one day of an event. A single event is deleted. A later repeat is recorded as an exception. The first
 * day of a daily or weekly series moves to the next repeat; a monthly or yearly series keeps its original day
 * and records the first day as an exception (so a short month does not stick).
 */
export const skipOccurrence = (document: CalendarDocument, id: string, day: string): CalendarDocument => {
  const event = document.events.find((item) => item.id === id)
  if (!event) return document
  if (!isRecurring(event.recurrence)) return deleteEvent(document, id)
  const patch = (change: (item: CalendarEvent) => CalendarEvent): CalendarDocument => ({ ...document, events: document.events.map((item) => (item.id === id ? change(item) : item)) })
  if (event.start.slice(0, 10) === day) {
    if (event.recurrence === 'monthly' || event.recurrence === 'yearly') return event.exceptionDates.includes(day) ? document : patch((item) => ({ ...item, exceptionDates: [...item.exceptionDates, day] }))
    return patch((item) => ({ ...item, start: advance(item.start, item.allDay, item.recurrence), end: advance(item.end, item.allDay, item.recurrence) }))
  }
  return event.exceptionDates.includes(day) ? document : patch((item) => ({ ...item, exceptionDates: [...item.exceptionDates, day] }))
}

/**
 * Writes an editor save. `key` is `eventId@YYYY-MM-DD` (a series' occurrence) or null for a new event.
 * Editing a later repeat detaches it as its own event and the series skips that day; editing the series'
 * first day (or a single event) edits the event itself. A blank or unusable edit changes nothing.
 */
export const saveOccurrence = (document: CalendarDocument, key: string | null, next: CalendarEvent, detachedId: string = newId()): CalendarDocument => {
  const ids = new Set(document.calendars.map((calendar) => calendar.id))
  const eventId = key ? key.split('@')[0] : ''
  const day = key && key.includes('@') ? key.slice(key.indexOf('@') + 1) : ''
  const master = document.events.find((event) => event.id === eventId)
  if (!master || !DAY_KEY.test(day)) {
    const cleaned = sanitizeEvent(next, ids)
    return cleaned ? upsert(document, cleaned) : document
  }
  if (!isRecurring(master.recurrence) || master.start.slice(0, 10) === day) {
    const cleaned = sanitizeEvent({ ...next, id: master.id, exceptionDates: isRecurring(master.recurrence) ? next.exceptionDates : [] }, ids)
    return cleaned ? upsert(document, cleaned) : document
  }
  const skipped: CalendarDocument = { ...document, events: document.events.map((item) => (item.id !== master.id || item.exceptionDates.includes(day) ? item : { ...item, exceptionDates: [...item.exceptionDates, day] })) }
  const detached = sanitizeEvent({ ...next, id: detachedId.slice(0, 80) || newId(), recurrence: 'none', recurrenceUntil: null, exceptionDates: [] }, ids)
  return detached ? upsert(skipped, detached) : document
}

/** Copies a school exam into the "Schule" calendar (Kotlin importExam); it is not added twice. */
export const addExam = (document: CalendarDocument, exam: { id: string; title: string; start: string; end: string; room: string; comment: string }): CalendarDocument => {
  const id = `schulnetz-${exam.id}`
  if (document.events.some((event) => event.id === id)) return document
  const calendars = document.calendars.some((calendar) => calendar.id === 'school') ? document.calendars : [...document.calendars, { id: 'school', name: 'Schule', color: '#3d8bfd', visible: true }]
  const allDay = !exam.start.includes('T')
  const event: CalendarEvent = { id, calendarId: 'school', title: exam.title, start: exam.start, end: exam.end || exam.start, allDay, location: exam.room, notes: exam.comment, notePath: '', recurrence: 'none', recurrenceUntil: null, exceptionDates: [] }
  return { calendars, events: [...document.events, event] }
}
