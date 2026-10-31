// A stored quote, card, task, or event may contain the comment closer "-->".
// Cutting the block at the first closer rewrites the note or drops the record.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const bodyBefore = (markdown, marker) => {
  const at = markdown.indexOf(marker)
  assert.ok(at > 0, `missing ${marker}`)
  return markdown.slice(0, at)
}

try {
  const marks = await server.ssrLoadModule('/src/lib/pdfTextMarks.ts')
  const cards = await server.ssrLoadModule('/src/lib/flashcards.ts')
  const homework = await server.ssrLoadModule('/src/lib/homeworkStore.ts')
  const calendar = await server.ssrLoadModule('/src/lib/calendarModel.ts')

  const note = '# Titel\n\nSiehe A --> B im Fliesstext.\n\nNach dem Block bleibt auch.\n'
  const quote = 'Schliesse den Kommentar mit --> ab'
  const once = marks.writePdfMarks(note, marks.addPdfMark([], { page: 1, quote, kind: 'highlight' }))
  const readOnce = marks.readPdfMarks(once)
  assert.equal(readOnce.length, 1, 'a highlight quote containing --> must stay readable')
  assert.equal(readOnce[0].quote, quote)
  const twice = marks.writePdfMarks(once, marks.addPdfMark(readOnce, {
    page: 2,
    quote: 'zweite Stelle ohne Pfeil',
    kind: 'underline',
  }))
  const markBody = bodyBefore(twice, marks.PDF_MARKS_START)
  assert.match(markBody, /Siehe A --> B im Fliesstext/)
  assert.match(markBody, /Nach dem Block bleibt auch/)
  assert.doesNotMatch(markBody, /"marks"/)
  assert.deepEqual(marks.readPdfMarks(twice).map((mark) => mark.quote), [quote, 'zweite Stelle ohne Pfeil'])

  const card = {
    id: 'c1',
    front: 'A --> B',
    back: 'Antwort',
    ease: 2.5,
    intervalDays: 1,
    due: '2026-11-01',
    reps: 1,
    lapses: 0,
  }
  const stored = cards.embedCards('# Lernen\n\nText bleibt.\n\nNach dem Block bleibt auch.\n', [card])
  const parsedCards = cards.parseStoredCards(stored)
  assert.equal(parsedCards.length, 1, 'a flashcard containing --> must stay readable')
  assert.equal(parsedCards[0].front, 'A --> B')
  const again = cards.embedCards(stored, parsedCards)
  const cardBody = bodyBefore(again, '<!-- fanotes-cards-v1')
  assert.match(cardBody, /Text bleibt/)
  assert.match(cardBody, /Nach dem Block bleibt auch/)
  assert.doesNotMatch(cardBody, /"front"/)
  assert.equal(cards.parseStoredCards(again)[0].front, 'A --> B')

  const added = homework.addHomeworkTask({ version: 1, tasks: [] }, {
    title: 'HTML Kommentar --> schliessen',
    notes: 'A --> B',
  })
  const homeworkMarkdown = homework.serializeHomeworkMarkdown(added.document)
  const loadedHomework = homework.loadHomeworkMarkdown(homeworkMarkdown)
  assert.equal(loadedHomework.ok, true, 'homework containing --> must stay readable')
  assert.equal(loadedHomework.document.tasks.length, 1)
  assert.equal(loadedHomework.document.tasks[0].title, 'HTML Kommentar --> schliessen')
  assert.equal(loadedHomework.document.tasks[0].notes, 'A --> B')

  const calendarMarkdown = calendar.serializeCalendarMarkdown({
    version: 1,
    calendars: [{ id: 'school', name: 'Schule', color: '#3d8bfd', visible: true }],
    events: [{
      id: 'e1',
      calendarId: 'school',
      title: 'Abgabe A --> B',
      start: '2026-11-02T09:00',
      end: '2026-11-02T10:00',
      allDay: false,
      location: '',
      notes: 'Kommentar --> Ende',
      notePath: '',
      recurrence: 'none',
      recurrenceUntil: null,
      exceptionDates: [],
    }],
  })
  const loadedCalendar = calendar.loadCalendarMarkdown(calendarMarkdown)
  assert.equal(loadedCalendar.ok, true, 'a calendar event containing --> must stay readable')
  assert.equal(loadedCalendar.document.events[0].title, 'Abgabe A --> B')
  assert.equal(loadedCalendar.document.events[0].notes, 'Kommentar --> Ende')

  console.log('embedded-json-comment ok')
} finally {
  await server.close()
}
