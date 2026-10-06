export const CALENDAR_NOTE_PATH = 'Kalender.md'
export const CALENDAR_NOTE_TITLE = 'Kalender'
export const CALENDAR_MARKER_START = '<!-- fanotes-calendar-v1'
export const CALENDAR_MARKER_END = '-->'

export const CALENDAR_COLORS = [
  '#7f6df2',
  '#3d8bfd',
  '#2f9e6b',
  '#e0ac39',
  '#e15b64',
  '#d06ad6',
  '#5aa6a6',
  '#c47b4a',
] as const

export const CALENDAR_VIEWS = ['day', 'three', 'week', 'month', 'agenda'] as const
export type CalendarViewId = (typeof CALENDAR_VIEWS)[number]
export type RecurrenceFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export type CalendarDef = {
  id: string
  name: string
  color: string
  visible: boolean
}

export type CalendarEvent = {
  id: string
  calendarId: string
  title: string
  /** Local wall time `YYYY-MM-DDTHH:mm`, or `YYYY-MM-DD` when all-day. */
  start: string
  /** Local wall time, or inclusive `YYYY-MM-DD` when all-day. */
  end: string
  allDay: boolean
  location: string
  notes: string
  notePath: string
  recurrence: RecurrenceFreq
  /** Inclusive last day `YYYY-MM-DD`, or null for open-ended. */
  recurrenceUntil: string | null
  /** Skipped instance days `YYYY-MM-DD`. */
  exceptionDates: string[]
}

export type CalendarDocument = {
  version: 1
  calendars: CalendarDef[]
  events: CalendarEvent[]
}

export type CalendarOccurrence = {
  event: CalendarEvent
  start: Date
  end: Date
  /** Stable id for this instance: `${eventId}@YYYY-MM-DD`. */
  key: string
}

export type LaidOutSlice = {
  key: string
  event: CalendarEvent
  start: Date
  end: Date
  column: number
  columns: number
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u
const RECURRENCE = new Set<RecurrenceFreq>(['none', 'daily', 'weekly', 'monthly', 'yearly'])

const pad = (value: number) => String(value).padStart(2, '0')

export const dateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

export const wallKey = (date: Date) => `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`

export const parseDateKey = (value: string) => {
  const match = DATE_RE.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

export const parseWall = (value: string, allDay = false) => {
  if (allDay || DATE_RE.test(value)) {
    const date = parseDateKey(value.slice(0, 10))
    return date
  }
  const match = WALL_RE.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
  return Number.isNaN(date.getTime()) ? null : date
}

export const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

export const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000)

export const startOfWeek = (date: Date) => {
  const day = startOfDay(date)
  const offset = (day.getDay() + 6) % 7
  return addDays(day, -offset)
}

export const addMonths = (date: Date, months: number) => {
  const next = new Date(date)
  const day = next.getDate()
  next.setDate(1)
  next.setMonth(next.getMonth() + months)
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  next.setDate(Math.min(day, last))
  return next
}

export const snapMinutes = (date: Date, step = 15) => {
  const snapped = new Date(date)
  const minutes = snapped.getHours() * 60 + snapped.getMinutes()
  const next = Math.round(minutes / step) * step
  snapped.setHours(0, 0, 0, 0)
  snapped.setMinutes(next)
  return snapped
}

export const isoWeek = (date: Date) => {
  const tmp = startOfDay(date)
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7))
  const week1 = new Date(tmp.getFullYear(), 0, 4)
  return 1 + Math.round(((tmp.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
}

export const sameDay = (left: Date, right: Date) => dateKey(left) === dateKey(right)

const newId = () => {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `cal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const cleanText = (value: unknown, max: number) => (
  typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : ''
)

const cleanColor = (value: unknown, fallback: string) => (
  typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback
)

export const defaultCalendars = (): CalendarDef[] => [
  { id: 'personal', name: 'Persönlich', color: CALENDAR_COLORS[0], visible: true },
  { id: 'school', name: 'Schule', color: CALENDAR_COLORS[1], visible: true },
  { id: 'work', name: 'Arbeit', color: CALENDAR_COLORS[2], visible: true },
]

export const emptyCalendarDocument = (): CalendarDocument => ({
  version: 1,
  calendars: defaultCalendars(),
  events: [],
})

const sanitizeCalendar = (raw: unknown, index: number): CalendarDef | null => {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<CalendarDef>
  const name = cleanText(candidate.name, 80)
  if (!name) return null
  const id = cleanText(candidate.id, 80) || `calendar-${index + 1}`
  return {
    id,
    name,
    color: cleanColor(candidate.color, CALENDAR_COLORS[index % CALENDAR_COLORS.length]),
    visible: candidate.visible !== false,
  }
}

const sanitizeEvent = (raw: unknown, calendarIds: Set<string>): CalendarEvent | null => {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<CalendarEvent>
  const title = cleanText(candidate.title, 240)
  if (!title) return null
  const allDay = Boolean(candidate.allDay)
  const start = typeof candidate.start === 'string' ? candidate.start : ''
  const end = typeof candidate.end === 'string' ? candidate.end : ''
  const startDate = parseWall(start, allDay)
  const endDate = parseWall(end, allDay)
  if (!startDate || !endDate) return null
  const calendarId = cleanText(candidate.calendarId, 80)
  if (!calendarIds.has(calendarId)) return null
  let normalizedEnd = endDate
  if (allDay) {
    if (dateKey(endDate) < dateKey(startDate)) normalizedEnd = startDate
  } else if (endDate.getTime() <= startDate.getTime()) {
    normalizedEnd = addMinutes(startDate, 30)
  }
  const recurrence = RECURRENCE.has(candidate.recurrence as RecurrenceFreq)
    ? candidate.recurrence as RecurrenceFreq
    : 'none'
  const until = typeof candidate.recurrenceUntil === 'string' && DATE_RE.test(candidate.recurrenceUntil)
    ? candidate.recurrenceUntil
    : null
  const exceptionDates = Array.isArray(candidate.exceptionDates)
    ? [...new Set(candidate.exceptionDates.filter((entry): entry is string => typeof entry === 'string' && DATE_RE.test(entry)))].slice(0, 400)
    : []
  return {
    id: cleanText(candidate.id, 80) || newId(),
    calendarId,
    title,
    start: allDay ? dateKey(startDate) : wallKey(startDate),
    end: allDay ? dateKey(normalizedEnd) : wallKey(normalizedEnd),
    allDay,
    location: cleanText(candidate.location, 160),
    notes: typeof candidate.notes === 'string' ? candidate.notes.slice(0, 4_000) : '',
    notePath: cleanText(candidate.notePath, 400),
    recurrence,
    recurrenceUntil: recurrence === 'none' ? null : until,
    exceptionDates: recurrence === 'none' ? [] : exceptionDates,
  }
}

export const sanitizeCalendarDocument = (raw: unknown): CalendarDocument => {
  const source = raw && typeof raw === 'object' ? raw as Partial<CalendarDocument> : {}
  const calendars = (Array.isArray(source.calendars) ? source.calendars : [])
    .map(sanitizeCalendar)
    .filter((calendar): calendar is CalendarDef => Boolean(calendar))
    .slice(0, 24)
  const unique = new Map<string, CalendarDef>()
  for (const calendar of calendars) unique.set(calendar.id, calendar)
  const list = unique.size ? [...unique.values()] : defaultCalendars()
  const ids = new Set(list.map((calendar) => calendar.id))
  const events = (Array.isArray(source.events) ? source.events : [])
    .map((event) => sanitizeEvent(event, ids))
    .filter((event): event is CalendarEvent => Boolean(event))
    .slice(0, 2_000)
  return { version: 1, calendars: list, events }
}

export const parseCalendarMarkdown = (markdown: string): CalendarDocument => {
  if (typeof markdown !== 'string' || !markdown.includes(CALENDAR_MARKER_START)) return emptyCalendarDocument()
  const start = markdown.indexOf(CALENDAR_MARKER_START)
  const end = markdown.indexOf(CALENDAR_MARKER_END, start + CALENDAR_MARKER_START.length)
  if (end < 0) return emptyCalendarDocument()
  try {
    return sanitizeCalendarDocument(JSON.parse(markdown.slice(start + CALENDAR_MARKER_START.length, end)))
  } catch {
    return emptyCalendarDocument()
  }
}

export const serializeCalendarMarkdown = (document: CalendarDocument): string => {
  const payload = sanitizeCalendarDocument(document)
  return [
    `# ${CALENDAR_NOTE_TITLE}`,
    '',
    'Diese Notiz wird von der **Kalender-Ansicht** in FaNotes verwaltet.',
    'Termine bleiben lokal in deinem Vault. Ziehe sie im Kalender — nicht in dieser Datei.',
    '',
    CALENDAR_MARKER_START,
    JSON.stringify(payload, null, 2),
    CALENDAR_MARKER_END,
    '',
  ].join('\n')
}

export const createCalendar = (document: CalendarDocument, name: string): CalendarDocument => {
  const clean = cleanText(name, 80)
  if (!clean) return document
  const calendar: CalendarDef = {
    id: newId(),
    name: clean,
    color: CALENDAR_COLORS[document.calendars.length % CALENDAR_COLORS.length],
    visible: true,
  }
  return sanitizeCalendarDocument({ ...document, calendars: [...document.calendars, calendar] })
}

export const createEvent = (input: {
  calendarId: string
  title: string
  start: Date
  end: Date
  allDay?: boolean
  location?: string
  notes?: string
  notePath?: string
  recurrence?: RecurrenceFreq
}): CalendarEvent => {
  const allDay = Boolean(input.allDay)
  const start = input.start
  const end = input.end.getTime() <= start.getTime() ? addMinutes(start, allDay ? 24 * 60 : 30) : input.end
  return sanitizeEvent({
    id: newId(),
    calendarId: input.calendarId,
    title: input.title || 'Neuer Termin',
    start: allDay ? dateKey(start) : wallKey(start),
    end: allDay ? dateKey(startOfDay(addDays(end, -1))) : wallKey(end),
    allDay,
    location: input.location ?? '',
    notes: input.notes ?? '',
    notePath: input.notePath ?? '',
    recurrence: input.recurrence ?? 'none',
    recurrenceUntil: null,
    exceptionDates: [],
  }, new Set([input.calendarId])) ?? {
    id: newId(),
    calendarId: input.calendarId,
    title: 'Neuer Termin',
    start: wallKey(start),
    end: wallKey(addMinutes(start, 30)),
    allDay: false,
    location: '',
    notes: '',
    notePath: '',
    recurrence: 'none',
    recurrenceUntil: null,
    exceptionDates: [],
  }
}

const nextInstanceStart = (cursor: Date, frequency: RecurrenceFreq) => {
  if (frequency === 'daily') return addDays(cursor, 1)
  if (frequency === 'weekly') return addDays(cursor, 7)
  if (frequency === 'monthly') return addMonths(cursor, 1)
  if (frequency === 'yearly') return addMonths(cursor, 12)
  return addDays(cursor, 1)
}

const eventBounds = (event: CalendarEvent) => {
  const start = parseWall(event.start, event.allDay)
  if (!start) return null
  if (event.allDay) {
    const inclusive = parseWall(event.end, true) ?? start
    const end = addDays(startOfDay(inclusive), 1)
    return { start: startOfDay(start), end }
  }
  const end = parseWall(event.end, false)
  if (!end || end.getTime() <= start.getTime()) return { start, end: addMinutes(start, 30) }
  return { start, end }
}

export const expandOccurrences = (
  document: CalendarDocument,
  rangeStart: Date,
  rangeEnd: Date,
): CalendarOccurrence[] => {
  const visible = new Set(document.calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id))
  const occurrences: CalendarOccurrence[] = []
  for (const event of document.events) {
    if (!visible.has(event.calendarId)) continue
    const bounds = eventBounds(event)
    if (!bounds) continue
    const duration = bounds.end.getTime() - bounds.start.getTime()
    if (duration <= 0) continue
    const until = event.recurrenceUntil ? parseDateKey(event.recurrenceUntil) : null
    const untilEnd = until ? addDays(startOfDay(until), 1) : null
    const skipped = new Set(event.exceptionDates)
    let cursor = bounds.start
    let guard = 0
    while (cursor < rangeEnd && guard < 500) {
      if (untilEnd && cursor >= untilEnd) break
      const end = new Date(cursor.getTime() + duration)
      const key = `${event.id}@${dateKey(cursor)}`
      if (!skipped.has(dateKey(cursor)) && end > rangeStart && cursor < rangeEnd) {
        occurrences.push({ event, start: new Date(cursor), end, key })
      }
      if (event.recurrence === 'none') break
      const next = nextInstanceStart(cursor, event.recurrence)
      if (next.getTime() <= cursor.getTime()) break
      cursor = next
      guard += 1
    }
  }
  return occurrences.sort((left, right) => left.start.getTime() - right.start.getTime() || left.event.title.localeCompare(right.event.title, 'de'))
}

export const occurrenceOnDay = (occurrence: CalendarOccurrence, day: Date) => {
  const start = startOfDay(day)
  const end = addDays(start, 1)
  return occurrence.end > start && occurrence.start < end
}

export const sliceOnDay = (occurrence: CalendarOccurrence, day: Date) => {
  const dayStart = startOfDay(day)
  const dayEnd = addDays(dayStart, 1)
  const start = occurrence.start < dayStart ? dayStart : occurrence.start
  const end = occurrence.end > dayEnd ? dayEnd : occurrence.end
  if (end.getTime() <= start.getTime()) return null
  return { ...occurrence, start, end }
}

export const layoutDayColumns = (items: Array<{ key: string, event: CalendarEvent, start: Date, end: Date }>): LaidOutSlice[] => {
  const sorted = [...items].sort((left, right) => left.start.getTime() - right.start.getTime() || right.end.getTime() - left.end.getTime())
  const laid: LaidOutSlice[] = []
  let cluster: typeof sorted = []
  let clusterEnd = 0
  const flush = () => {
    const columnEnds: number[] = []
    const assigned = cluster.map((item) => {
      const start = item.start.getTime()
      let column = columnEnds.findIndex((end) => end <= start)
      if (column < 0) {
        column = columnEnds.length
        columnEnds.push(item.end.getTime())
      } else columnEnds[column] = item.end.getTime()
      return { ...item, column }
    })
    const columns = Math.max(1, columnEnds.length)
    for (const item of assigned) laid.push({ ...item, columns })
    cluster = []
    clusterEnd = 0
  }
  for (const item of sorted) {
    if (cluster.length && item.start.getTime() >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.end.getTime())
  }
  if (cluster.length) flush()
  return laid
}

const replaceEvent = (document: CalendarDocument, event: CalendarEvent): CalendarDocument => (
  sanitizeCalendarDocument({
    ...document,
    events: document.events.map((item) => item.id === event.id ? event : item),
  })
)

export const upsertEvent = (document: CalendarDocument, event: CalendarEvent): CalendarDocument => {
  const exists = document.events.some((item) => item.id === event.id)
  return sanitizeCalendarDocument({
    ...document,
    events: exists ? document.events.map((item) => item.id === event.id ? event : item) : [...document.events, event],
  })
}

export const deleteEvent = (document: CalendarDocument, eventId: string): CalendarDocument => (
  sanitizeCalendarDocument({ ...document, events: document.events.filter((event) => event.id !== eventId) })
)

export const duplicateEvent = (document: CalendarDocument, eventId: string): CalendarDocument => {
  const event = document.events.find((item) => item.id === eventId)
  if (!event) return document
  const bounds = eventBounds(event)
  if (!bounds) return document
  const start = addDays(bounds.start, 1)
  const end = addDays(bounds.end, 1)
  const copy = createEvent({
    calendarId: event.calendarId,
    title: event.title,
    start,
    end,
    allDay: event.allDay,
    location: event.location,
    notes: event.notes,
    notePath: event.notePath,
    recurrence: event.recurrence,
  })
  return upsertEvent(document, { ...copy, recurrenceUntil: event.recurrenceUntil })
}

const findOccurrence = (document: CalendarDocument, key: string, around: Date) => {
  const [eventId, day] = key.split('@')
  const event = document.events.find((item) => item.id === eventId)
  if (!event || !day) return null
  const rangeStart = addDays(parseDateKey(day) ?? around, -1)
  const rangeEnd = addDays(rangeStart, 3)
  return expandOccurrences({ ...document, calendars: document.calendars.map((calendar) => ({ ...calendar, visible: true })) }, rangeStart, rangeEnd)
    .find((occurrence) => occurrence.key === key) ?? null
}

export const moveOccurrence = (document: CalendarDocument, key: string, nextStart: Date): CalendarDocument => {
  const occurrence = findOccurrence(document, key, nextStart)
  if (!occurrence) return document
  const delta = nextStart.getTime() - occurrence.start.getTime()
  if (!delta) return document
  const masterDay = dateKey(parseWall(occurrence.event.start, occurrence.event.allDay) ?? occurrence.start)
  const instanceDay = key.split('@')[1]
  const nextEnd = new Date(occurrence.end.getTime() + delta)
  if (occurrence.event.recurrence === 'none' || masterDay === instanceDay) {
    return replaceEvent(document, {
      ...occurrence.event,
      start: occurrence.event.allDay ? dateKey(nextStart) : wallKey(nextStart),
      end: occurrence.event.allDay ? dateKey(addDays(startOfDay(nextEnd), -1)) : wallKey(nextEnd),
    })
  }
  const detached = createEvent({
    calendarId: occurrence.event.calendarId,
    title: occurrence.event.title,
    start: nextStart,
    end: nextEnd,
    allDay: occurrence.event.allDay,
    location: occurrence.event.location,
    notes: occurrence.event.notes,
    notePath: occurrence.event.notePath,
  })
  return upsertEvent(replaceEvent(document, {
    ...occurrence.event,
    exceptionDates: [...occurrence.event.exceptionDates, instanceDay],
  }), detached)
}

export const resizeOccurrence = (document: CalendarDocument, key: string, nextEnd: Date): CalendarDocument => {
  const occurrence = findOccurrence(document, key, nextEnd)
  if (!occurrence) return document
  if (nextEnd.getTime() <= occurrence.start.getTime()) return document
  const masterDay = dateKey(parseWall(occurrence.event.start, occurrence.event.allDay) ?? occurrence.start)
  const instanceDay = key.split('@')[1]
  if (occurrence.event.recurrence === 'none' || masterDay === instanceDay) {
    return replaceEvent(document, {
      ...occurrence.event,
      end: occurrence.event.allDay ? dateKey(addDays(startOfDay(nextEnd), -1)) : wallKey(nextEnd),
    })
  }
  const detached = createEvent({
    calendarId: occurrence.event.calendarId,
    title: occurrence.event.title,
    start: occurrence.start,
    end: nextEnd,
    allDay: occurrence.event.allDay,
    location: occurrence.event.location,
    notes: occurrence.event.notes,
    notePath: occurrence.event.notePath,
  })
  return upsertEvent(replaceEvent(document, {
    ...occurrence.event,
    exceptionDates: [...occurrence.event.exceptionDates, instanceDay],
  }), detached)
}

export const skipOccurrence = (document: CalendarDocument, key: string): CalendarDocument => {
  const [eventId, day] = key.split('@')
  const event = document.events.find((item) => item.id === eventId)
  if (!event || !day) return document
  if (event.recurrence === 'none') return deleteEvent(document, event.id)
  const masterDay = dateKey(parseWall(event.start, event.allDay) ?? new Date())
  if (masterDay === day) {
    const bounds = eventBounds(event)
    if (!bounds) return deleteEvent(document, event.id)
    const next = nextInstanceStart(bounds.start, event.recurrence)
    const duration = bounds.end.getTime() - bounds.start.getTime()
    const nextEnd = new Date(next.getTime() + duration)
    return replaceEvent(document, {
      ...event,
      start: event.allDay ? dateKey(next) : wallKey(next),
      end: event.allDay ? dateKey(addDays(startOfDay(nextEnd), -1)) : wallKey(nextEnd),
    })
  }
  return replaceEvent(document, { ...event, exceptionDates: [...event.exceptionDates, day] })
}

export const viewRange = (view: CalendarViewId, cursor: Date) => {
  const day = startOfDay(cursor)
  if (view === 'day') return { start: day, end: addDays(day, 1), days: [day] }
  if (view === 'three') {
    return { start: day, end: addDays(day, 3), days: [day, addDays(day, 1), addDays(day, 2)] }
  }
  if (view === 'week') {
    const start = startOfWeek(day)
    return { start, end: addDays(start, 7), days: Array.from({ length: 7 }, (_, index) => addDays(start, index)) }
  }
  if (view === 'month') {
    const first = new Date(day.getFullYear(), day.getMonth(), 1)
    const start = startOfWeek(first)
    const days = Array.from({ length: 42 }, (_, index) => addDays(start, index))
    return { start, end: addDays(start, 42), days }
  }
  const start = addDays(day, -1)
  const days = Array.from({ length: 21 }, (_, index) => addDays(start, index))
  return { start, end: addDays(start, 21), days }
}

export const shiftCursor = (view: CalendarViewId, cursor: Date, delta: number) => {
  if (view === 'month') return addMonths(cursor, delta)
  if (view === 'week') return addDays(cursor, delta * 7)
  if (view === 'three') return addDays(cursor, delta * 3)
  if (view === 'agenda') return addDays(cursor, delta * 7)
  return addDays(cursor, delta)
}

export const searchOccurrences = (occurrences: CalendarOccurrence[], query: string, calendars: CalendarDef[]) => {
  const needle = query.trim().toLocaleLowerCase('de')
  if (!needle) return occurrences
  const names = new Map(calendars.map((calendar) => [calendar.id, calendar.name.toLocaleLowerCase('de')]))
  return occurrences.filter((occurrence) => {
    const haystack = [
      occurrence.event.title,
      occurrence.event.location,
      occurrence.event.notes,
      occurrence.event.notePath,
      names.get(occurrence.event.calendarId) ?? '',
    ].join('\n').toLocaleLowerCase('de')
    return haystack.includes(needle)
  })
}

export const minutesSinceMidnight = (date: Date) => date.getHours() * 60 + date.getMinutes()

export const calendarById = (document: CalendarDocument, id: string) => (
  document.calendars.find((calendar) => calendar.id === id) ?? document.calendars[0]
)

/** Writes a popover edit. A later repeat instance becomes its own event; the series skips that day. */
export const saveOccurrenceEdit = (
  document: CalendarDocument,
  key: string | null,
  next: CalendarEvent,
): CalendarDocument => {
  if (!key) return upsertEvent(document, next)
  const [eventId, day] = key.split('@')
  const master = document.events.find((event) => event.id === eventId)
  if (!master || !day) return upsertEvent(document, next)
  const masterStart = parseWall(master.start, master.allDay)
  const masterDay = masterStart ? dateKey(masterStart) : day
  if (master.recurrence === 'none' || masterDay === day) {
    return upsertEvent(document, { ...next, id: master.id, exceptionDates: master.recurrence === 'none' ? [] : next.exceptionDates })
  }
  const skipped = replaceEvent(document, {
    ...master,
    exceptionDates: [...master.exceptionDates, day],
  })
  const detached = sanitizeEvent({
    ...next,
    id: newId(),
    recurrence: 'none',
    recurrenceUntil: null,
    exceptionDates: [],
  }, new Set(skipped.calendars.map((calendar) => calendar.id)))
  return detached ? upsertEvent(skipped, detached) : skipped
}
