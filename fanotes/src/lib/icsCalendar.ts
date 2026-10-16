import {
  addDays,
  createEvent,
  dateKey,
  parseWall,
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

/** `\\` is one backslash, so `\\n` stays a backslash and the letter n. */
const icsUnescape = (value: string) => value.replace(/\\(.)/gu, (match, char: string) => {
  if (char === 'n' || char === 'N') return '\n'
  if (char === '\\' || char === ',' || char === ';') return char
  return match
})

const stamp = (date: Date) => {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`
}

const dateStamp = (date: Date) => {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

const civilTime = (year: number, month: number, day: number, hour: number, minute: number) => {
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(hour, minute, 0, 0)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) return null
  return date
}

/** Minutes east of UTC. `Z` is 0. `+0200` is 120. */
const icsOffsetMinutes = (zone: string) => {
  if (zone === 'Z' || zone === 'z') return 0
  const match = /^([+-])(\d{2})(\d{2})$/u.exec(zone)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 23 || minutes > 59) return null
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

/**
 * A floating clock stays as written. `Z` and a numeric offset become the
 * local wall time, so 09:00Z is not stored as 09:00.
 */
const parseIcsDate = (raw: string): { date: Date; allDay: boolean } | null => {
  const value = raw.trim()
  const day = /^(\d{4})(\d{2})(\d{2})$/u.exec(value)
  if (day) {
    const date = civilTime(Number(day[1]), Number(day[2]), Number(day[3]), 0, 0)
    return date ? { date, allDay: true } : null
  }
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z|z|[+-]\d{4})?$/u.exec(value)
  if (!timed) return null
  const year = Number(timed[1])
  const month = Number(timed[2])
  const dayNum = Number(timed[3])
  const hour = Number(timed[4])
  const minute = Number(timed[5])
  const zone = timed[7] ?? ''
  if (!zone) {
    const date = civilTime(year, month, dayNum, hour, minute)
    return date ? { date, allDay: false } : null
  }
  const offset = icsOffsetMinutes(zone)
  if (offset === null || !civilTime(year, month, dayNum, hour, minute)) return null
  const instant = new Date(Date.UTC(year, month - 1, dayNum, hour, minute) - offset * 60_000)
  return Number.isNaN(instant.getTime()) ? null : { date: instant, allDay: false }
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

/** Import VEVENT blocks into an existing calendar document. Unknown lines are ignored. */
export const importIcs = (ics: string, calendarId: string, previous?: CalendarDocument): CalendarEvent[] => {
  const events: CalendarEvent[] = []
  for (const lines of splitEvents(ics)) {
    const summary = field(lines, 'SUMMARY').trim().slice(0, 240)
    const startRaw = lines.find((entry) => entry.startsWith('DTSTART'))
    if (!summary || !startRaw) continue
    const startValue = startRaw.slice(startRaw.indexOf(':') + 1)
    const start = parseIcsDate(startValue)
    if (!start) continue
    const endRaw = lines.find((entry) => entry.startsWith('DTEND'))
    const end = endRaw ? parseIcsDate(endRaw.slice(endRaw.indexOf(':') + 1)) : null
    const untilRaw = /UNTIL=(\d{8})/u.exec(field(lines, 'RRULE'))
    const until = untilRaw ? `${untilRaw[1].slice(0, 4)}-${untilRaw[1].slice(4, 6)}-${untilRaw[1].slice(6, 8)}` : null
    const recurrence = recurrenceFromRule(field(lines, 'RRULE'))
    const uid = field(lines, 'UID').replace(/[^\w.-]/gu, '').slice(0, 80)
    const built = createEvent({
      calendarId,
      title: summary,
      start: start.date,
      end: end?.date ?? addDays(start.date, start.allDay ? 1 : 0),
      allDay: start.allDay,
      location: field(lines, 'LOCATION'),
      notes: field(lines, 'DESCRIPTION'),
    })
    events.push({
      ...built,
      id: uid || built.id,
      recurrence,
      recurrenceUntil: recurrence === 'none' ? null : until,
    })
  }
  if (previous && events.length > 2_000) return events.slice(0, 2_000)
  return events.slice(0, 2_000)
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
      'END:VEVENT',
    ].filter(Boolean).join('\n')
  }).filter(Boolean)
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FaNotes//Calendar//DE', ...body, 'END:VCALENDAR', ''].join('\n')
}

export const icsFileName = (name: string) => `${name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'kalender'}.ics`

export const dayKeyOf = dateKey
