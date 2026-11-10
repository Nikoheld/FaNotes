// The app's demo (DemoData.kt), the same invented school, built relative to "today" so the current
// week and the coming weeks always have lessons. Nothing here is read from or sent to anywhere.
import { addDays, weekMonday } from '@shared/schulnetz-logic'
import type { AgendaEvent, SchoolGrade, Snapshot } from '../types'

export const DEMO_ID_PREFIX = 'demo-'
const WEEKS_BACK = 2
const WEEKS_AHEAD = 10

interface DemoSubject { name: string; code: string; room: string; teacher: string }
const SUBJECTS: Record<string, DemoSubject> = Object.fromEntries([
  ['Deutsch', 'D', 'D101', 'Lehrperson A'],
  ['Mathematik', 'M', 'M204', 'Lehrperson B'],
  ['Englisch', 'E', 'E112', 'Lehrperson C'],
  ['Französisch', 'F', 'F108', 'Lehrperson D'],
  ['Biologie', 'B', 'N301', 'Lehrperson E'],
  ['Chemie', 'C', 'N305', 'Lehrperson F'],
  ['Physik', 'P', 'N310', 'Lehrperson G'],
  ['Geschichte', 'G', 'G020', 'Lehrperson H'],
  ['Geografie', 'GG', 'G024', 'Lehrperson I'],
  ['Wirtschaft und Recht', 'WR', 'W015', 'Lehrperson J'],
  ['Bildnerisches Gestalten', 'BG', 'A001', 'Lehrperson K'],
  ['Musik', 'MU', 'A010', 'Lehrperson L'],
  ['Sport', 'S', 'Halle 1', 'Lehrperson M'],
].map(([name, code, room, teacher]) => [name, { name, code, room, teacher }]))

const SLOTS: [string, string][] = [['07:45', '08:30'], ['08:35', '09:20'], ['09:40', '10:25'], ['10:30', '11:15'], ['11:25', '12:10'], ['13:15', '14:00']]

const WEEK: (string | null)[][] = [
  ['Deutsch', 'Mathematik', 'Englisch', 'Englisch', 'Biologie', 'Sport'],
  ['Mathematik', 'Französisch', 'Geschichte', 'Chemie', 'Chemie', null],
  ['Physik', 'Deutsch', 'Mathematik', 'Bildnerisches Gestalten', 'Bildnerisches Gestalten', null],
  ['Englisch', 'Geografie', 'Deutsch', 'Französisch', 'Musik', 'Sport'],
  ['Biologie', 'Mathematik', 'Wirtschaft und Recht', 'Physik', 'Geschichte', null],
]

const weekday = (day: string) => {
  const weekdayIndex = new Date(`${day}T00:00:00Z`).getUTCDay()
  if (weekdayIndex === 6) return addDays(day, 2)
  if (weekdayIndex === 0) return addDays(day, 1)
  return day
}

const lesson = (day: string, slot: number, subject: DemoSubject, status = '', comment = '', teacher = subject.teacher): AgendaEvent => ({
  id: `${DEMO_ID_PREFIX}lesson-${day}-${slot}`,
  start: `${day}T${SLOTS[slot][0]}:00`,
  end: `${day}T${SLOTS[slot][1]}:00`,
  text: subject.name,
  comment,
  room: subject.room,
  teachers: [teacher],
  courseId: `${DEMO_ID_PREFIX}${subject.code}`,
  courseName: subject.name,
  status,
  eventType: '0_stp',
  color: '',
  timetableText: subject.name,
})

const exam = (day: string, slot: number, subject: DemoSubject, topic: string): AgendaEvent => ({
  id: `${DEMO_ID_PREFIX}exam-${day}-${subject.code}`,
  start: `${day}T${SLOTS[slot][0]}:00`,
  end: `${day}T${SLOTS[slot][1]}:00`,
  text: `${subject.name}: ${topic}`,
  comment: topic,
  room: subject.room,
  teachers: [subject.teacher],
  courseId: `${DEMO_ID_PREFIX}${subject.code}`,
  courseName: subject.name,
  status: '',
  eventType: 'exam',
  color: '',
  timetableText: `Prüfung ${subject.name}`,
})

const appointment = (day: string, id: string, title: string, room: string, from = '08:00', to = '12:00'): AgendaEvent => ({
  id: `${DEMO_ID_PREFIX}event-${id}`,
  start: `${day}T${from}:00`,
  end: `${day}T${to}:00`,
  text: title,
  comment: '',
  room,
  teachers: [],
  courseId: '',
  courseName: '',
  status: '',
  eventType: 'event',
  color: '',
  timetableText: '',
})

const grade = (id: string, subject: string, title: string, date: string, mark: number, weight = 1): SchoolGrade => {
  const s = SUBJECTS[subject]
  return {
    id: `${DEMO_ID_PREFIX}grade-${id}`,
    course: `${s.code}-K26A`,
    courseId: `${DEMO_ID_PREFIX}${s.code}`,
    subject: s.name,
    title,
    date,
    mark,
    weight,
    confirmed: true,
    courseGrade: null,
    comment: '',
    targetId: `${DEMO_ID_PREFIX}${id}`,
  }
}

/** The demo snapshot for [today] (an ISO date), as the app's demoSnapshot builds it. */
export const demoSnapshot = (today: string, now = new Date(`${today}T06:00:00Z`)): Snapshot => {
  const monday = weekMonday(today)
  const nextMonday = addDays(monday, 7)
  const stamp = now.toISOString()
  const reportDay = weekday(addDays(today, -3))
  const reportSubjects = WEEK[(new Date(`${reportDay}T00:00:00Z`).getUTCDay() + 6) % 7]
  const weeks = Array.from({ length: WEEKS_BACK + WEEKS_AHEAD + 1 }, (_, index) => addDays(monday, (index - WEEKS_BACK) * 7))
  const lessons = weeks.flatMap((week) => WEEK.flatMap((slots, dayIndex) => {
    const day = addDays(week, dayIndex)
    return slots.flatMap((name, slot) => {
      if (!name) return []
      const subject = SUBJECTS[name]
      if (week === nextMonday && dayIndex === 3 && slot === 4) return [lesson(day, slot, subject, 'entfällt', 'Lektion fällt aus')]
      if (week === nextMonday && dayIndex === 4 && slot === 3) return [lesson(day, slot, subject, '', 'Vertretung', 'Lehrperson Z')]
      return [lesson(day, slot, subject)]
    })
  }))
  const exams = [
    exam(weekday(addDays(today, -9)), 1, SUBJECTS.Englisch, 'Vocabulary Unit 4'),
    exam(weekday(addDays(today, 2)), 1, SUBJECTS.Mathematik, 'Funktionen'),
    exam(weekday(addDays(today, 8)), 0, SUBJECTS.Biologie, 'Zellbiologie'),
    exam(weekday(addDays(today, 15)), 2, SUBJECTS.Geschichte, 'Industrialisierung'),
    exam(weekday(addDays(today, 23)), 3, SUBJECTS['Französisch'], 'Passé composé'),
  ]
  const appointments = [
    appointment(weekday(addDays(today, 5)), 'sporttag', 'Sporttag (Demo)', 'Sportanlage'),
    appointment(weekday(addDays(today, 19)), 'elternabend', 'Elternabend (Demo)', 'Aula', '19:00', '20:30'),
    appointment(weekday(addDays(today, 33)), 'exkursion', 'Exkursion Geografie (Demo)', 'Treffpunkt Bahnhof'),
  ]
  const grades = [
    grade('m1', 'Mathematik', 'Prüfung Gleichungen', addDays(today, -52), 5.0),
    grade('m2', 'Mathematik', 'Prüfung Geometrie', addDays(today, -24), 4.5),
    grade('d1', 'Deutsch', 'Aufsatz', addDays(today, -40), 5.5),
    grade('d2', 'Deutsch', 'Lektüreprüfung', addDays(today, -12), 5.0, 0.5),
    grade('e1', 'Englisch', 'Vocabulary Unit 3', addDays(today, -31), 4.75),
    grade('f1', 'Französisch', 'Compréhension', addDays(today, -35), 4.0),
    grade('b1', 'Biologie', 'Ökologie', addDays(today, -28), 5.25),
    grade('c1', 'Chemie', 'Laborbericht', addDays(today, -20), 5.5, 0.5),
    grade('p1', 'Physik', 'Mechanik', addDays(today, -44), 3.75),
    grade('p2', 'Physik', 'Energie', addDays(today, -6), 4.5),
    grade('g1', 'Geschichte', 'Antike', addDays(today, -38), 5.0),
    grade('w1', 'Wirtschaft und Recht', 'Marktformen', addDays(today, -16), 4.5),
  ]
  const read = Object.fromEntries(weeks.map((week) => [week, stamp]))
  return {
    revision: 1,
    fetchedAt: stamp,
    profile: { id: `${DEMO_ID_PREFIX}profile`, firstName: 'Demo', lastName: 'Schüler:in', className: 'K26A', email: '' },
    grades,
    events: [...lessons, ...appointments],
    exams,
    // As in the app's demo: a booked entry and an open double lesson (estimated 2 + 1 = 3) of 30.
    absences: [
      { id: `${DEMO_ID_PREFIX}absence-1`, dateFrom: weekday(addDays(today, -18)), dateTo: weekday(addDays(today, -18)), hourFrom: '', hourTo: '', subject: '', reason: 'Krankheit', excused: false, acknowledged: true, status: 'gebucht', points: 5 },
      { id: `${DEMO_ID_PREFIX}absence-2`, dateFrom: reportDay, dateTo: reportDay, hourFrom: SLOTS[0][0], hourTo: SLOTS[0][1], subject: reportSubjects[0] || 'Lektion', reason: '', excused: false, acknowledged: false, status: 'offen', excuseUntil: weekday(addDays(today, 4)), pending: true },
      { id: `${DEMO_ID_PREFIX}absence-3`, dateFrom: reportDay, dateTo: reportDay, hourFrom: SLOTS[1][0], hourTo: SLOTS[1][1], subject: reportSubjects[1] || 'Lektion', reason: '', excused: false, acknowledged: false, status: 'offen', pending: true },
    ],
    absenceQuota: 30,
    absenceRemaining: 25,
    absenceParser: 2,
    homework: [],
    messages: [{ id: `${DEMO_ID_PREFIX}message-1`, title: 'Willkommen im Demo-Modus', body: 'Alle Angaben in diesem Modus sind erfunden. Kanti+ liest im Demo-Modus nichts aus Schulnetz und sendet nichts an einen Server.', at: stamp }],
    vacations: [],
    konto: [
      { date: addDays(today, -40), label: 'Kopierkosten (Demo)', amount: '-12.50', balance: '37.50' },
      { date: addDays(today, -60), label: 'Einzahlung (Demo)', amount: '50.00', balance: '50.00' },
    ],
    startMessages: [],
    weekFetched: read,
    weekRead: read,
    examWeekFetched: read,
    weekSpanStart: weeks[0],
    weekSpanEnd: addDays(weeks[weeks.length - 1], 4),
  }
}
