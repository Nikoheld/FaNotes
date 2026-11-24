// Synthetic own data for the demo: a vault in memory, nothing leaves the page.
import { addDays, zurichToday } from '@shared/schulnetz-logic'
import { CALENDAR_NOTE_PATH, GRADE_BOOK_PATH, HOMEWORK_NOTE_PATH, emptyCalendar, serializeCalendar, serializeGradeBook, serializeHomework } from './files'

export const demoVaultFiles = (today = zurichToday()): Record<string, string> => ({
  [GRADE_BOOK_PATH]: serializeGradeBook({
    own: [{ id: 'demo-own-1', courseId: 'Mathematik', title: 'Vortrag', mark: 5.5, weight: 1, date: addDays(today, -6) }],
    collective: [], adjustments: [], archivedCourseIds: [],
  }),
  [HOMEWORK_NOTE_PATH]: serializeHomework({
    publishedIds: [],
    tasks: [
      { id: 'demo-task-1', title: 'Aufgaben S. 42', notes: '', subject: 'Mathematik', dueDate: addDays(today, 1), dueTime: null, done: false, kind: 'homework', priority: 'normal', createdAt: '', updatedAt: '' },
      { id: 'demo-task-2', title: 'Vokabeln lernen', notes: '', subject: 'Französisch', dueDate: addDays(today, 3), dueTime: '08:00', done: false, kind: 'homework', priority: 'high', createdAt: '', updatedAt: '' },
    ],
  }),
  'Mathematik/Ableitungen.md': '# Ableitungen\n\nDie **Ableitung** von $x^2$ ist `2x`.\n\n- Potenzregel\n- Produktregel\n\n> Üben, üben, üben.\n',
  [CALENDAR_NOTE_PATH]: serializeCalendar({
    ...emptyCalendar(),
    events: [{ id: 'demo-event-1', calendarId: 'personal', title: 'Training', start: `${addDays(today, 2)}T18:00`, end: `${addDays(today, 2)}T19:30`, allDay: false, location: '', notes: '', notePath: '', recurrence: 'weekly', recurrenceUntil: null, exceptionDates: [] }],
  }),
})
