import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const model = await server.ssrLoadModule('/src/lib/calendarModel.ts')
const {
  addDays,
  createEvent,
  dateKey,
  emptyCalendarDocument,
  expandOccurrences,
  layoutDayColumns,
  moveOccurrence,
  healCalendarNames,
  isMissingNoteError,
  loadCalendarMarkdown,
  parseCalendarMarkdown,
  resizeOccurrence,
  saveOccurrenceEdit,
  serializeCalendarMarkdown,
  skipOccurrence,
  startOfDay,
  viewRange,
} = model

const at = (day, hours, minutes = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes)
const monday = startOfDay(new Date(2026, 8, 14))
const doc = emptyCalendarDocument()
const personal = doc.calendars[0].id
const school = doc.calendars[1].id

const lecture = createEvent({
  calendarId: school,
  title: 'Vorlesung',
  start: at(monday, 9, 0),
  end: at(monday, 10, 30),
  recurrence: 'weekly',
})
const focus = createEvent({
  calendarId: personal,
  title: 'Fokus',
  start: at(monday, 9, 15),
  end: at(monday, 10, 0),
})
const allDay = createEvent({
  calendarId: personal,
  title: 'Abgabe',
  start: monday,
  end: addDays(monday, 1),
  allDay: true,
})
let stored = {
  ...doc,
  events: [lecture, focus, allDay],
}
const roundTrip = parseCalendarMarkdown(serializeCalendarMarkdown(stored))
assert.equal(roundTrip.events.length, 3)
assert.equal(roundTrip.events.find((event) => event.title === 'Abgabe').allDay, true)
assert.equal(roundTrip.events.find((event) => event.title === 'Abgabe').end, dateKey(monday))

const week = viewRange('week', monday)
const occurrences = expandOccurrences(roundTrip, week.start, week.end)
const lectures = occurrences.filter((item) => item.event.title === 'Vorlesung')
assert.equal(lectures.length, 1, 'one weekly instance inside this week')
const nextWeek = expandOccurrences(roundTrip, addDays(week.start, 7), addDays(week.end, 7))
assert.equal(nextWeek.filter((item) => item.event.title === 'Vorlesung').length, 1)

const hidden = {
  ...roundTrip,
  calendars: roundTrip.calendars.map((calendar) => calendar.id === school ? { ...calendar, visible: false } : calendar),
}
assert.equal(expandOccurrences(hidden, week.start, week.end).some((item) => item.event.calendarId === school), false)

const slices = layoutDayColumns([
  { key: 'a', event: lecture, start: at(monday, 9, 0), end: at(monday, 10, 30) },
  { key: 'b', event: focus, start: at(monday, 9, 15), end: at(monday, 10, 0) },
])
assert.equal(slices.length, 2)
assert.equal(new Set(slices.map((item) => item.column)).size, 2)
assert.ok(slices.every((item) => item.columns === 2))

const moved = moveOccurrence(roundTrip, `${focus.id}@${dateKey(monday)}`, at(monday, 11, 0))
const movedEvent = moved.events.find((event) => event.id === focus.id)
assert.equal(movedEvent.start.endsWith('T11:00'), true)
assert.equal(movedEvent.end.endsWith('T11:45'), true)

const resized = resizeOccurrence(moved, `${focus.id}@${dateKey(monday)}`, at(monday, 12, 0))
assert.equal(resized.events.find((event) => event.id === focus.id).end.endsWith('T12:00'), true)

const laterKey = nextWeek.find((item) => item.event.title === 'Vorlesung').key
const detached = moveOccurrence(roundTrip, laterKey, at(addDays(monday, 7), 15, 0))
const master = detached.events.find((event) => event.id === lecture.id)
assert.ok(master.exceptionDates.includes(dateKey(addDays(monday, 7))))
assert.equal(detached.events.filter((event) => event.title === 'Vorlesung' && event.recurrence === 'none').length, 1)

const edited = saveOccurrenceEdit(roundTrip, laterKey, {
  ...lecture,
  title: 'Sprechstunde',
  start: '2026-09-21T15:00',
  end: '2026-09-21T16:00',
})
assert.equal(edited.events.some((event) => event.title === 'Sprechstunde' && event.recurrence === 'none'), true)

const skipped = skipOccurrence(roundTrip, `${focus.id}@${dateKey(monday)}`)
assert.equal(skipped.events.some((event) => event.id === focus.id), false)

const clearedName = {
  ...doc,
  calendars: doc.calendars.map((calendar) => calendar.id === personal ? { ...calendar, name: '' } : calendar),
  events: [createEvent({ calendarId: personal, title: 'Zahnarzt', start: at(monday, 9), end: at(monday, 10) })],
}
const dropped = parseCalendarMarkdown(serializeCalendarMarkdown(clearedName))
assert.equal(dropped.calendars.some((calendar) => calendar.id === personal), false)
assert.equal(dropped.events.some((event) => event.title === 'Zahnarzt'), false)
const healed = healCalendarNames(clearedName, doc)
const kept = parseCalendarMarkdown(serializeCalendarMarkdown(healed))
assert.equal(kept.calendars.find((calendar) => calendar.id === personal)?.name, 'Persönlich')
assert.equal(kept.events.some((event) => event.title === 'Zahnarzt' && event.calendarId === personal), true)
const removed = healCalendarNames({
  ...doc,
  calendars: doc.calendars.filter((calendar) => calendar.id !== personal),
  events: [],
}, doc)
assert.equal(removed.calendars.some((calendar) => calendar.id === personal), false)

const brokenJson = serializeCalendarMarkdown(stored).replace('{\n', '{\n,')
assert.equal(loadCalendarMarkdown(brokenJson).ok, false, 'broken calendar JSON is not an empty calendar')
assert.equal(loadCalendarMarkdown(serializeCalendarMarkdown(stored).replace('-->', '')).ok, false, 'an unclosed calendar marker is not empty')
assert.equal(loadCalendarMarkdown('').ok, true)
assert.equal(isMissingNoteError(new Error('ENOENT: no such file or directory')), true)
assert.equal(isMissingNoteError(new Error('Die Notiz wurde im Browser-Vault nicht gefunden.')), true)
assert.equal(isMissingNoteError(new Error('EIO: i/o error')), false)

const homeworkStore = await server.ssrLoadModule('/src/lib/homeworkStore.ts')
const homeworkSync = await server.ssrLoadModule('/src/lib/homeworkCalendar.ts')
assert.equal(homeworkStore.loadHomeworkMarkdown('<!-- fanotes-homework-v1\n{').ok, false)
assert.equal(homeworkStore.loadHomeworkMarkdown('').ok, true)
assert.equal(homeworkSync.calendarMarkdownWithHomework(brokenJson, { version: 1, tasks: [] }), null)
assert.equal(typeof homeworkSync.calendarMarkdownWithHomework('', { version: 1, tasks: [] }), 'string')

const rent = createEvent({
  calendarId: personal,
  title: 'Miete',
  start: new Date(2026, 0, 31, 9, 0),
  end: new Date(2026, 0, 31, 10, 0),
  recurrence: 'monthly',
})
const rentDoc = { ...doc, events: [rent] }
const february = expandOccurrences(rentDoc, new Date(2026, 1, 1), new Date(2026, 2, 1))
const march = expandOccurrences(rentDoc, new Date(2026, 2, 1), new Date(2026, 3, 1))
assert.equal(dateKey(february[0].start), '2026-02-28')
assert.equal(february[0].start.getHours(), 9)
assert.equal(dateKey(march[0].start), '2026-03-31')
const skippedRent = skipOccurrence(rentDoc, `${rent.id}@2026-01-31`)
const rentMaster = skippedRent.events.find((event) => event.id === rent.id)
assert.equal(rentMaster.start, '2026-01-31T09:00')
assert.ok(rentMaster.exceptionDates.includes('2026-01-31'))
assert.equal(dateKey(expandOccurrences(skippedRent, new Date(2026, 2, 1), new Date(2026, 3, 1))[0].start), '2026-03-31')

const leap = createEvent({
  calendarId: personal,
  title: 'Schaltjahr',
  start: new Date(2024, 1, 29, 8, 0),
  end: new Date(2024, 1, 29, 9, 0),
  recurrence: 'yearly',
})
const leapDoc = { ...doc, events: [leap] }
assert.equal(dateKey(expandOccurrences(leapDoc, new Date(2025, 1, 1), new Date(2025, 2, 1))[0].start), '2025-02-28')
assert.equal(dateKey(expandOccurrences(leapDoc, new Date(2028, 1, 1), new Date(2028, 2, 1))[0].start), '2028-02-29')

const month = viewRange('month', monday)
assert.equal(month.days.length, 42)
assert.equal(month.days[0].getDay(), 1)

const ics = await server.ssrLoadModule('/src/lib/icsCalendar.ts')
const timed = ics.importIcs([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:lesson',
  'SUMMARY:Hello\\, Welt',
  'DESCRIPTION:Zeile\\\\n2',
  'DTSTART:20261014T153000',
  'DURATION:PT45M',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:gone',
  'STATUS:CANCELLED',
  'SUMMARY:Entfällt',
  'DTSTART:20261014T180000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal)
assert.equal(timed.length, 1)
assert.equal(timed[0].title, 'Hello, Welt')
assert.equal(timed[0].notes, 'Zeile\\n2')
assert.equal(timed[0].start, '2026-10-14T15:30')
assert.equal(timed[0].end, '2026-10-14T16:15')

const utcStart = new Date(Date.UTC(2026, 9, 16, 7, 0, 0))
const utc = ics.importIcs([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:utc-call',
  'SUMMARY:Anruf',
  'DTSTART:20261016T070000Z',
  'DURATION:PT90M',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal)
const utcWall = (date) => {
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
assert.equal(utc[0].start, utcWall(utcStart), 'UTC stamp becomes the local clock')
assert.equal(utc[0].end, utcWall(new Date(utcStart.getTime() + 90 * 60_000)))
if (utcStart.getTimezoneOffset() !== 0) assert.notEqual(utc[0].start, '2026-10-16T07:00')

const wallOf = (date) => {
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const offsetEvents = ics.importIcs([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Versetzt',
  'DTSTART:20261020T090000+0200',
  'DTEND:20261020T093000+0200',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal)
assert.equal(offsetEvents[0].start, wallOf(new Date(Date.UTC(2026, 9, 20, 7, 0))))
assert.equal(offsetEvents[0].end, wallOf(new Date(Date.UTC(2026, 9, 20, 7, 30))))
assert.equal(ics.importIcs([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Nein',
  'DTSTART:20260231T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal).length, 0)

const existing = {
  ...doc,
  events: [{
    ...focus,
    id: 'lesson',
    calendarId: school,
    title: 'Alt',
    notePath: 'Schule/Mathe.md',
    recurrence: 'weekly',
    exceptionDates: ['2026-10-21'],
  }],
}
const merged = ics.applyIcsImport(existing, [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:lesson',
  'SUMMARY:Neu',
  'DTSTART:20261014T153000',
  'DURATION:PT45M',
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal)
assert.equal(merged.updated, 1)
assert.equal(merged.added, 0)
assert.equal(merged.document.events.length, 1)
assert.equal(merged.document.events[0].title, 'Neu')
assert.equal(merged.document.events[0].calendarId, school)
assert.equal(merged.document.events[0].notePath, 'Schule/Mathe.md')
assert.deepEqual(merged.document.events[0].exceptionDates, ['2026-10-21'])
const again = ics.applyIcsImport(merged.document, [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:lesson',
  'SUMMARY:Neu',
  'DTSTART:20261014T153000',
  'DURATION:PT45M',
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal)
assert.equal(again.document.events.length, 1)
const cancelled = ics.applyIcsImport(again.document, [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:lesson',
  'STATUS:CANCELLED',
  'SUMMARY:Neu',
  'DTSTART:20261014T153000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal)
assert.equal(cancelled.removed, 1)
assert.equal(cancelled.document.events.length, 0)

const reminders = await server.ssrLoadModule('/src/lib/calendarReminders.ts')
const soon = { title: 'Mathe', minutesUntil: 5 }
assert.equal(reminders.formatReminder(soon, 'de'), 'Mathe beginnt in 5 min.')
assert.equal(reminders.formatReminder({ title: 'Math', minutesUntil: 0 }, 'en'), 'Math starts now.')
assert.equal(reminders.formatReminder({ title: 'Math', minutesUntil: 1 }, 'en'), 'Math starts in 1 minute.')
assert.equal(reminders.formatReminder(soon, 'en'), 'Mathe starts in 5 minutes.')
assert.equal(reminders.formatMoreReminders(0, 'en'), '')
assert.equal(reminders.formatMoreReminders(1, 'de'), 'Noch 1 Termin.')
assert.equal(reminders.formatMoreReminders(2, 'en'), '2 more events.')
const calendarView = readFileSync(join(root, 'src/components/CalendarView.tsx'), 'utf8')
assert.match(calendarView, /formatReminder\(reminders\[0\], getUiLanguage\(\)\)/)
assert.match(calendarView, /\{copy\.close\}/)
assert.doesNotMatch(calendarView, /beginnt/)

const reminderNow = new Date(2026, 9, 16, 23, 50, 0)
const allDayTomorrow = createEvent({
  calendarId: personal,
  title: 'Abgabe',
  start: new Date(2026, 9, 17),
  end: new Date(2026, 9, 18),
  allDay: true,
})
const call = createEvent({
  calendarId: personal,
  title: 'Anruf',
  start: new Date(2026, 9, 16, 23, 55, 0),
  end: new Date(2026, 9, 17, 0, 25, 0),
})
const due = reminders.dueReminders({ ...doc, events: [allDayTomorrow, call] }, reminderNow, 15)
assert.equal(due.some((item) => item.title === 'Abgabe'), false)
assert.equal(due.some((item) => item.title === 'Anruf' && item.minutesUntil === 5), true)

const seriesIcs = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:series',
  'SUMMARY:Kurs',
  'DTSTART:20261014T153000',
  'DURATION:PT45M',
  'RRULE:FREQ=WEEKLY',
  'EXDATE;VALUE=DATE:20261021',
  'EXDATE:20261028T153000,20261104T153000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n')
const series = ics.importIcs(seriesIcs, personal)
assert.deepEqual(series[0].exceptionDates, ['2026-10-21', '2026-10-28', '2026-11-04'])
const utcSkip = new Date(Date.UTC(2026, 9, 21, 23, 0, 0))
const zoned = ics.importIcs([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:zoned',
  'SUMMARY:Kurs',
  'DTSTART:20261014T153000',
  'RRULE:FREQ=WEEKLY',
  'EXDATE:20261021T230000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n'), personal)
assert.deepEqual(zoned[0].exceptionDates, [dateKey(utcSkip)])
const united = ics.applyIcsImport({
  ...doc,
  events: [{ ...series[0], calendarId: school, exceptionDates: ['2026-10-14'] }],
}, seriesIcs, personal)
assert.deepEqual(united.document.events[0].exceptionDates, ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04'])
const exported = ics.exportIcs({ ...doc, events: series })
assert.match(exported, /EXDATE;VALUE=DATE:20261021,20261028,20261104/)
assert.deepEqual(ics.importIcs(exported, personal)[0].exceptionDates, series[0].exceptionDates)
const shown = expandOccurrences({ ...doc, events: series }, startOfDay(new Date(2026, 9, 14)), addDays(startOfDay(new Date(2026, 9, 14)), 21))
assert.equal(shown.some((item) => item.key.endsWith('@2026-10-14')), true)
assert.equal(shown.some((item) => item.key.endsWith('@2026-10-21')), false)

await server.close()
console.log(JSON.stringify({
  events: roundTrip.events.length,
  weekOccurrences: occurrences.length,
  overlapColumns: slices[0].columns,
  detached: detached.events.length,
}, null, 2))
console.log('calendar ok')
