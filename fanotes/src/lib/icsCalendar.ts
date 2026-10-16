import {
  addDays,
  createEvent,
  dateKey,
  parseDateKey,
  parseWall,
  sanitizeCalendarDocument,
  type CalendarDocument,
  type CalendarEvent,
  type RecurrenceFreq,
} from './calendarModel'

const unfold = (value: string) => value.replace(/\r\n/gu, '\n').replace(/\n[ \t]/gu, '')

const icsEscape = (value: string) => value
  .replace(/\\/gu, '\\\\')
  .replace(/\n/gu, '\\n')
  .replace(/,/gu, '\\,')
  .replace(/;/gu, '\\;')

/** One pass, so a written `\\n` stays a backslash plus n instead of becoming a newline. */
const icsUnescape = (value: string) => value.replace(/\\(.)/gu, (_match, char: string) => {
  if (char === 'n' || char === 'N') return '\n'
  if (char === '\\' || char === ',' || char === ';') return char
  return char
})

const stamp = (date: Date) => {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`
}

const dateStamp = (date: Date) => {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

const realCivilTime = (year: number, monthIndex: number, day: number, hour: number, minute: number, second: number) => {
  const date = new Date(0)
  date.setFullYear(year, monthIndex, day)
  date.setHours(hour, minute, second, 0)
  return date.getFullYear() === year
    && date.getMonth() === monthIndex
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
    && date.getSeconds() === second
}

/** A `Z` or numeric offset is UTC, so a local daylight-saving gap does not reject it. */
const realUtcTime = (year: number, monthIndex: number, day: number, hour: number, minute: number, second: number) => {
  const date = new Date(Date.UTC(year, monthIndex, day, hour, minute, second))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === monthIndex
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second
}

/** Minutes east of UTC. `+0200` is 120. */
const icsOffsetMinutes = (zone: string) => {
  const match = /^([+-])(\d{2})(\d{2})$/u.exec(zone)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 23 || minutes > 59) return null
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

const parseIcsDate = (raw: string): { date: Date; allDay: boolean } | null => {
  const value = raw.trim()
  const day = /^(\d{4})(\d{2})(\d{2})$/u.exec(value)
  if (day) {
    const year = Number(day[1])
    const month = Number(day[2])
    const dayNum = Number(day[3])
    if (!realCivilTime(year, month - 1, dayNum, 0, 0, 0)) return null
    const date = parseDateKey(`${day[1]}-${day[2]}-${day[3]}`)
    return date ? { date, allDay: true } : null
  }
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(?:(\d{2})(?:\.\d+)?)?(Z|[+-]\d{4})?$/iu.exec(value)
  if (!timed) return null
  const year = Number(timed[1])
  const month = Number(timed[2]) - 1
  const dayOfMonth = Number(timed[3])
  const hour = Number(timed[4])
  const minute = Number(timed[5])
  const second = Number(timed[6] ?? 0)
  const zone = timed[7] ?? ''
  if (!zone) {
    if (!realCivilTime(year, month, dayOfMonth, hour, minute, second)) return null
    return { date: new Date(year, month, dayOfMonth, hour, minute, second), allDay: false }
  }
  if (!realUtcTime(year, month, dayOfMonth, hour, minute, second)) return null
  const offset = /^z$/iu.test(zone) ? 0 : icsOffsetMinutes(zone)
  if (offset === null) return null
  const date = new Date(Date.UTC(year, month, dayOfMonth, hour, minute, second) - offset * 60_000)
  return Number.isNaN(date.getTime()) ? null : { date, allDay: false }
}

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/iu

/** ICS duration. All-day week/day lengths follow the calendar, not a fixed 24 hours. */
const applyIcsDuration = (start: Date, allDay: boolean, raw: string): Date | null => {
  const match = DURATION_RE.exec(raw.trim())
  if (!match) return null
  const sign = match[1] === '-' ? -1 : 1
  const weeks = Number(match[2] ?? 0)
  const days = Number(match[3] ?? 0)
  const hours = Number(match[4] ?? 0)
  const minutes = Number(match[5] ?? 0)
  const seconds = Number(match[6] ?? 0)
  if (![weeks, days, hours, minutes, seconds].some((part) => part > 0)) return null
  if (allDay && hours === 0 && minutes === 0 && seconds === 0) return addDays(start, sign * (weeks * 7 + days))
  return new Date(start.getTime() + sign * ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000)
}

const recurrenceFromRule = (rule: string): RecurrenceFreq => {
  const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/iu.exec(rule)?.[1]?.toLowerCase()
  if (freq === 'daily' || freq === 'weekly' || freq === 'monthly' || freq === 'yearly') return freq
  return 'none'
}

const splitEvents = (text: string) => {
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') {
      current = []
      continue
    }
    if (line === 'END:VEVENT') {
      if (current) blocks.push(current)
      current = null
      continue
    }
    if (current) current.push(line)
  }
  return blocks
}

const field = (lines: string[], name: string) => {
  const prefix = `${name}`
  const line = lines.find((entry) => entry.startsWith(`${prefix}:`) || entry.startsWith(`${prefix};`))
  if (!line) return ''
  const index = line.indexOf(':')
  return index >= 0 ? icsUnescape(line.slice(index + 1)) : ''
}

const eventUid = (lines: string[]) => field(lines, 'UID').replace(/[^\w.-]/gu, '').slice(0, 80)

/** Skipped recurrence days. Several EXDATE lines and comma-separated values count. */
const exceptionDatesFrom = (lines: string[]): string[] => {
  const dates: string[] = []
  for (const line of lines) {
    if (!line.startsWith('EXDATE')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const dateOnly = /VALUE=DATE/iu.test(line.slice(0, colon))
    for (const part of line.slice(colon + 1).split(',')) {
      const raw = part.trim()
      if (!raw) continue
      if (dateOnly || /^\d{8}$/u.test(raw)) {
        const day = /^(\d{4})(\d{2})(\d{2})$/u.exec(raw)
        if (!day || !realCivilTime(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 0, 0, 0)) continue
        dates.push(`${day[1]}-${day[2]}-${day[3]}`)
        continue
      }
      const parsed = parseIcsDate(raw)
      if (parsed) dates.push(dateKey(parsed.date))
    }
  }
  return [...new Set(dates)].slice(0, 400)
}

const parseIcs = (ics: string, calendarId: string): { events: CalendarEvent[], cancelledIds: string[] } => {
  const events: CalendarEvent[] = []
  const cancelledIds: string[] = []
  for (const lines of splitEvents(ics)) {
    const uid = eventUid(lines)
    if (field(lines, 'STATUS').trim().toUpperCase() === 'CANCELLED') {
      if (uid) cancelledIds.push(uid)
      continue
    }
    const summary = field(lines, 'SUMMARY').trim().slice(0, 240)
    const startRaw = lines.find((entry) => entry.startsWith('DTSTART'))
    if (!summary || !startRaw) continue
    const start = parseIcsDate(startRaw.slice(startRaw.indexOf(':') + 1))
    if (!start) continue
    const endRaw = lines.find((entry) => entry.startsWith('DTEND'))
    const end = endRaw ? parseIcsDate(endRaw.slice(endRaw.indexOf(':') + 1)) : null
    const durationEnd = end ? null : applyIcsDuration(start.date, start.allDay, field(lines, 'DURATION'))
    const untilRaw = /UNTIL=(\d{8})/u.exec(field(lines, 'RRULE'))
    const until = untilRaw ? `${untilRaw[1].slice(0, 4)}-${untilRaw[1].slice(4, 6)}-${untilRaw[1].slice(6, 8)}` : null
    const recurrence = recurrenceFromRule(field(lines, 'RRULE'))
    const built = createEvent({
      calendarId,
      title: summary,
      start: start.date,
      end: end?.date ?? durationEnd ?? addDays(start.date, start.allDay ? 1 : 0),
      allDay: start.allDay,
      location: field(lines, 'LOCATION'),
      notes: field(lines, 'DESCRIPTION'),
    })
    events.push({
      ...built,
      id: uid || built.id,
      recurrence,
      recurrenceUntil: recurrence === 'none' ? null : until,
      exceptionDates: recurrence === 'none' ? [] : exceptionDatesFrom(lines),
    })
  }
  return { events: events.slice(0, 2_000), cancelledIds }
}

/** Import VEVENT blocks. Unknown lines are ignored. `previous` is accepted for existing callers. */
export const importIcs = (ics: string, calendarId: string, previous?: CalendarDocument): CalendarEvent[] => {
  const { events } = parseIcs(ics, calendarId)
  if (previous && events.length > 2_000) return events.slice(0, 2_000)
  return events
}

export type IcsImportResult = {
  document: CalendarDocument
  added: number
  updated: number
  removed: number
}

/** Fold an ICS file into a calendar. The same UID updates in place and keeps its calendar. */
export const applyIcsImport = (document: CalendarDocument, ics: string, calendarId: string): IcsImportResult => {
  const { events, cancelledIds } = parseIcs(ics, calendarId)
  const cancelled = new Set(cancelledIds)
  const incoming = new Map<string, CalendarEvent>()
  for (const event of events) {
    if (!cancelled.has(event.id)) incoming.set(event.id, event)
  }
  let removed = 0
  let updated = 0
  const kept: CalendarEvent[] = []
  for (const event of document.events) {
    if (cancelled.has(event.id)) {
      removed += 1
      continue
    }
    const next = incoming.get(event.id)
    if (!next) {
      kept.push(event)
      continue
    }
    incoming.delete(event.id)
    updated += 1
    kept.push({
      ...next,
      calendarId: event.calendarId,
      notePath: event.notePath || next.notePath,
      exceptionDates: [...new Set([...event.exceptionDates, ...next.exceptionDates])].slice(0, 400),
    })
  }
  const addedEvents = [...incoming.values()]
  const room = Math.max(0, 2_000 - kept.length)
  const added = addedEvents.slice(0, room)
  return {
    document: sanitizeCalendarDocument({ ...document, events: [...kept, ...added] }),
    added: added.length,
    updated,
    removed,
  }
}

const ruleFor = (event: CalendarEvent) => {
  if (event.recurrence === 'none') return ''
  const freq = event.recurrence.toUpperCase()
  const until = event.recurrenceUntil ? `;UNTIL=${event.recurrenceUntil.replace(/-/gu, '')}` : ''
  return `RRULE:FREQ=${freq}${until}\n`
}

/** Export one calendar's events. Recurrence is daily, weekly, monthly or yearly. */
export const exportIcs = (document: CalendarDocument, calendarId?: string) => {
  const events = document.events.filter((event) => !calendarId || event.calendarId === calendarId)
  const body = events.map((event) => {
    const start = parseWall(event.start, event.allDay)
    const end = parseWall(event.end, event.allDay)
    if (!start || !end) return ''
    const endDate = event.allDay ? addDays(end, 1) : end
    const dtStart = event.allDay ? `DTSTART;VALUE=DATE:${dateStamp(start)}` : `DTSTART:${stamp(start)}`
    const dtEnd = event.allDay ? `DTEND;VALUE=DATE:${dateStamp(endDate)}` : `DTEND:${stamp(endDate)}`
    return [
      'BEGIN:VEVENT',
      `UID:${event.id}@fanotes`,
      `SUMMARY:${icsEscape(event.title)}`,
      dtStart,
      dtEnd,
      event.location ? `LOCATION:${icsEscape(event.location)}` : '',
      event.notes ? `DESCRIPTION:${icsEscape(event.notes)}` : '',
      ruleFor(event).trimEnd(),
      event.recurrence !== 'none' && event.exceptionDates.length
        ? `EXDATE;VALUE=DATE:${event.exceptionDates.map((day) => day.replace(/-/gu, '')).join(',')}`
        : '',
      'END:VEVENT',
    ].filter(Boolean).join('\n')
  }).filter(Boolean)
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FaNotes//Calendar//DE', ...body, 'END:VCALENDAR', ''].join('\n')
}

export const icsFileName = (name: string) => `${name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'kalender'}.ics`

export const dayKeyOf = dateKey
