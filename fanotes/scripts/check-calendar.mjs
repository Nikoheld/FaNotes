import assert from 'node:assert/strict'
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

const month = viewRange('month', monday)
assert.equal(month.days.length, 42)
assert.equal(month.days[0].getDay(), 1)

await server.close()
console.log(JSON.stringify({
  events: roundTrip.events.length,
  weekOccurrences: occurrences.length,
  overlapColumns: slices[0].columns,
  detached: detached.events.length,
}, null, 2))
console.log('calendar ok')
