// The own-data rules, ported from the Kotlin core's tests (GradeBookTest, DeskTest, PlannedAbsencesTest)
// with the same cases and numbers, plus the vault file shapes the app and the desktop write.
import { describe, expect, it } from 'vitest'
import { gradeTargetId } from '@shared/schulnetz-logic'
import { activeCourses, collectiveValue, courseSummaries, overallAverage, promotionTotals, wishFor } from '../src/lib/grades'
import {
  emptyGradeBook, loadCalendar, loadHomework, parseColors, parseDeskSettings, parseGradeBook, parseGradeDate, parseHiddenLessons, parseHypothetical, parsePlannedAbsences,
  serializeCalendar, serializeGradeBook, serializeHiddenLessons, serializeHomework, serializeHypothetical, serializePlannedAbsences, slotVaultPath, slotsInVault,
  type GradeBook,
} from '../src/vault/files'
import { courseAlias, hideOnce, hideSeries, lessonHidden, matchPlanned, overrideColor, planAbsence, plannedFor, provisionalTally, stableId } from '../src/vault/school'
import type { AgendaEvent, SchoolGrade } from '../src/types'

const school: SchoolGrade = { id: 'g', course: 'Mathematik', courseId: 'math', subject: 'Mathematik', title: 'Probe', date: '2026-10-01', mark: 4, weight: 1, confirmed: true }
const withBook = (book: Partial<GradeBook>) => ({ book: { ...emptyGradeBook(), ...book } })

describe('own marks in the grade math (GradeBookTest)', () => {
  it('own grades count in the average, the Pluspunkte and the target calculator', () => {
    const summary = courseSummaries([school], withBook({ own: [{ id: 'o', courseId: 'math', title: 'Essay', mark: 6, weight: 1, date: '2026-11-04' }] }))[0]
    expect(summary.average).toBe(5)
    expect(summary.zeugnis).toBe(5)
    expect(summary.pluspunkte).toBe(1)
    expect(summary.marks.find((mark) => !mark.own)?.mark).toBe(4)
    expect(summary.marks.find((mark) => mark.own)?.grade.title).toBe('Essay')
    const withOwn = wishFor(summary, 5, 1)
    expect(withOwn.needed).toBe(5)
    expect(withOwn.neededHalf).toBe(5)
    const without = wishFor(courseSummaries([school])[0], 5, 1)
    expect(without.needed).toBe(6)
    expect(without.alreadyMet).toBe(false)
  })

  it('a collective grade counts once, as the weighted average of its parts', () => {
    const parts = [{ id: 'p1', title: 'Part A', mark: 4, weight: 1 }, { id: 'p2', title: 'Part B', mark: 6, weight: 1 }]
    expect(collectiveValue(parts)).toBe(5)
    expect(collectiveValue(parts.slice(0, 1))).toBeNull()
    const summary = courseSummaries([school], withBook({ collective: [{ id: 'c', courseId: 'math', title: 'Reading', date: '2026-11-04', weight: 2, parts }] }))[0]
    expect(summary.marks.filter((mark) => mark.collective)).toHaveLength(1)
    expect(summary.marks).toHaveLength(2)
    expect(Math.round((summary.average as number) * 1000) / 1000).toBe(4.667)
    expect(summary.zeugnis).toBe(4.5)
    expect(summary.pluspunkte).toBe(0.5)
    expect(summary.weight).toBe(3)
  })

  it('an adjustment changes only the calculation, restoring drops it', () => {
    const id = gradeTargetId(school)
    const changed = courseSummaries([school], withBook({ adjustments: [{ targetId: id, mark: 5.5, weight: 2, excluded: false }] }))[0]
    const mark = changed.marks[0]
    expect(changed.average).toBe(5.5)
    expect(mark.mark).toBe(5.5)
    expect(mark.weight).toBe(2)
    expect(mark.displayMark).toBe(4)
    expect(mark.displayWeight).toBe(1)
    expect(mark.adjusted).toBe(true)
    expect(mark.excluded).toBe(false)
    const excluded = courseSummaries([school], withBook({ adjustments: [{ targetId: id, excluded: true }] }))[0]
    expect(excluded.average).toBeNull()
    expect(excluded.marks[0].displayMark).toBe(4)
    expect(excluded.marks[0].excluded).toBe(true)
    expect(excluded.marks[0].counted).toBe(false)
    const restored = courseSummaries([school], withBook({}))[0]
    expect(restored.average).toBe(4)
    expect(restored.marks[0].adjusted).toBe(false)
  })

  it('archived subjects leave the averages', () => {
    const deutsch: SchoolGrade = { ...school, id: 'd', course: 'Deutsch', courseId: 'de', subject: 'Deutsch', mark: 3 }
    const courses = courseSummaries([school, deutsch], withBook({ archivedCourseIds: ['de'] }))
    const active = activeCourses(courses)
    expect(active.map((course) => course.key)).toEqual(['math'])
    expect(courses.find((course) => course.key === 'de')?.archived).toBe(true)
    expect(promotionTotals(active).total).toBe(0)
    expect(promotionTotals(courses).total).toBe(-2)
    expect(overallAverage(active)).toBe(4)
  })

  it('a hidden mark (kept on the server) stays out of the average', () => {
    const older: SchoolGrade = { ...school, id: 'g0', title: 'Alte Probe', date: '2026-09-01' }
    const hidden: SchoolGrade = { ...school, id: 'g1', mark: null, hidden: true, targetId: 'h' }
    const masked = courseSummaries([older, hidden])[0]
    expect(masked.average).toBe(4)
    expect(masked.marks).toHaveLength(2)
    expect(masked.marks.find((mark) => mark.hidden)?.counted).toBe(false)
  })

  it('what-if marks only count when asked for (the scenario of a subject page)', () => {
    const plain = courseSummaries([school])[0]
    const guess = courseSummaries([school], { hypothetical: [{ id: 'h', courseId: 'math', title: 'nächste', mark: 6, weight: 1 }] })[0]
    expect(plain.average).toBe(4)
    expect(guess.average).toBe(5)
    expect(guess.marks.find((mark) => mark.hypothetical)?.own).toBe(true)
    expect(courseSummaries([school], { hypothetical: [{ id: 'h', courseId: 'math', title: 'x', mark: 6, weight: 0 }] })[0].average).toBe(4)
  })

  it('normalizing drops marks outside 1 to 6 and parts without weight', () => {
    const book = parseGradeBook(serializeGradeBook({ ...emptyGradeBook(), own: [{ id: 'bad', courseId: 'math', title: 'x', mark: 7, weight: 1, date: '2026-01-01' }, { id: 'ok', courseId: 'math', title: 'y', mark: 5, weight: 1, date: '2026-01-02' }] }))
    expect(book.own.map((grade) => grade.id)).toEqual(['ok'])
  })
})

describe('vault file shapes (the Kotlin serializers)', () => {
  // Exactly what GradeBook.kt writes.
  const kotlinGradeBook = '{"version":1,"own":[{"id":"o","courseId":"math","title":"Say \\"hi\\"","mark":5.5,"weight":1.0,"date":"2026-11-04"}],"collective":[{"id":"c","courseId":"math","title":"Reading","date":"2026-11-04","weight":1.0,"parts":[{"id":"a","title":"A","mark":4.0,"weight":1.0},{"id":"b","title":"B","mark":5.0,"weight":2.0}]}],"adjustments":[{"targetId":"target","mark":6.0,"excluded":false}],"archived":["de"]}'

  it('reads and writes grade-book.json byte for byte like the app', () => {
    const book = parseGradeBook(kotlinGradeBook)
    expect(book.own[0]).toEqual({ id: 'o', courseId: 'math', title: 'Say "hi"', mark: 5.5, weight: 1, date: '2026-11-04' })
    expect(book.collective[0].parts).toHaveLength(2)
    expect(book.adjustments).toEqual([{ targetId: 'target', mark: 6, weight: null, excluded: false }])
    expect(book.archivedCourseIds).toEqual(['de'])
    expect(serializeGradeBook(book)).toBe(kotlinGradeBook)
    expect(parseGradeBook('nope')).toEqual(emptyGradeBook())
    expect(parseGradeBook(null)).toEqual(emptyGradeBook())
  })

  it('drops empty adjustments and duplicate archive ids', () => {
    const book = parseGradeBook('{"adjustments":[{"targetId":"t","mark":6},{"targetId":"gone"}],"archived":["de","de"," "]}')
    expect(book.adjustments).toEqual([{ targetId: 't', mark: 6, weight: null, excluded: false }])
    expect(book.archivedCourseIds).toEqual(['de'])
  })

  it('what-if marks, hidden lessons and planned absences round-trip', () => {
    const grades = [{ id: 'h', courseId: 'math', title: 'Say "x"', mark: 5.5, weight: 2 }]
    expect(parseHypothetical(serializeHypothetical(grades))).toEqual(grades)
    expect(serializeHypothetical(grades)).toBe('{"version":1,"grades":[{"id":"h","courseId":"math","title":"Say \\"x\\"","mark":5.5,"weight":2.0}]}')
    const rules = [{ id: 'series:chor|1|07:45', mode: 'series' as const, eventId: 'e1', date: '', subject: 'Chor', weekday: 1, start: '07:45' }]
    expect(parseHiddenLessons(serializeHiddenLessons(rules))).toEqual(rules)
    expect(serializeHiddenLessons(rules)).toBe('{"items":[{"id":"series:chor|1|07:45","mode":"series","eventId":"e1","date":"","subject":"Chor","weekday":1,"start":"07:45"}]}')
    const planned = [{ id: 'a', date: '2026-11-11', start: '08:00', end: '08:45', subject: 'Mathe "2"', lessonId: 'a', createdAt: 1 }, { id: 'b', date: '2026-11-12', start: '09:00', end: '09:45', subject: 'geo', lessonId: '', createdAt: 0 }]
    expect(parsePlannedAbsences(serializePlannedAbsences(planned))).toEqual(planned)
    expect(parsePlannedAbsences('nope')).toEqual([])
    expect(parsePlannedAbsences('{"items":[{"id":"x","date":"bad"},{"id":"y","date":"2026-11-11","start":"08:00","end":"08:45","subject":"s"}]}')).toHaveLength(1)
  })

  it('colours and the desk file (aliases) are read like the app reads them', () => {
    expect(parseColors('{"mathematik":"#112233","x":4}')).toEqual({ mathematik: '#112233' })
    expect(overrideColor('Mathematik', { mathematik: '#112233' })).toBe('#112233')
    expect(overrideColor('MAT_K26A_LehAa', { 'mat_k26a_lehaa mathematik': '#112233' })).toBe('#112233')
    const desk = parseDeskSettings('{"courseAliases":{"M4A":"Mathematik"},"gradeDecimals":9,"showPluspunkte":false,"gradeSort":"average"}')
    expect(desk.courseAliases).toEqual({ m4a: 'Mathematik' })
    expect(desk.gradeDecimals).toBe(3)
    expect(desk.showPluspunkte).toBe(false)
    expect(courseAlias('Mathematik (M4a)', desk.courseAliases)).toBe('Mathematik')
    expect(courseAlias('Biologie', desk.courseAliases)).toBe('Biologie')
    expect(parseDeskSettings(null).gradeDecimals).toBe(2)
  })

  it('reads the school files of the first connection at the original path and others in their slot', () => {
    expect(slotVaultPath('', '.fanotes/schulnetz/grade-book.json')).toBe('.fanotes/schulnetz/grade-book.json')
    expect(slotVaultPath('cabc123def', '.fanotes/schulnetz/grade-book.json')).toBe('.fanotes/schulnetz/connections/cabc123def/grade-book.json')
    expect(slotVaultPath('cabc123def', 'Hausaufgaben.md')).toBe('Hausaufgaben.md')
    expect(slotsInVault(['x.md', '.fanotes/schulnetz/connections/cabc123def/colors.json', '.fanotes/schulnetz/grade-book.json'])).toEqual(['cabc123def'])
  })

  it('parses grade dates in both forms', () => {
    expect(parseGradeDate('4.11.2026')).toBe('2026-11-04')
    expect(parseGradeDate('2026-11-04')).toBe('2026-11-04')
    expect(parseGradeDate('31.2.2026')).toBeNull()
    expect(parseGradeDate('')).toBeNull()
  })

  it('Hausaufgaben.md and Kalender.md keep the app\'s marker layout and survive a round trip', () => {
    const task = { id: 't1', title: 'Aufgaben "S. 42"', notes: 'Zeile 1\nZeile 2', subject: 'Mathematik', dueDate: '2026-11-12', dueTime: null, done: false, kind: 'homework' as const, priority: 'high' as const, createdAt: '2026-11-01T08:00:00Z', updatedAt: '2026-11-02T08:00:00Z' }
    const text = serializeHomework({ tasks: [task], publishedIds: ['p1'] })
    expect(text.startsWith('# Hausaufgaben\n\nDiese Notiz wird von der **Hausaufgaben-Ansicht** in FaNotes verwaltet.')).toBe(true)
    expect(text).toContain('<!-- fanotes-homework-v1\n{\n  "version": 1,\n  "tasks": [\n{"id":"t1","title":"Aufgaben \\"S. 42\\"","notes":"Zeile 1\\nZeile 2","subject":"Mathematik","dueDate":"2026-11-12","dueTime":null,"done":false,"kind":"homework","priority":"high","createdAt":"2026-11-01T08:00:00Z","updatedAt":"2026-11-02T08:00:00Z"}\n  ],"publishedIds":["p1"]\n}\n-->')
    expect(loadHomework(text)).toEqual({ tasks: [task], publishedIds: ['p1'] })
    expect(loadHomework(null)).toEqual({ tasks: [], publishedIds: [] })
    expect(loadHomework('# nur Text')).toEqual({ tasks: [], publishedIds: [] })
    // A marker that does not parse must stay untouched: null tells the caller not to write.
    expect(loadHomework('<!-- fanotes-homework-v1\n{ kaputt')).toBeNull()
    expect(loadHomework('<!-- fanotes-homework-v1\n{ kaputt\n-->')).toBeNull()

    const calendar = loadCalendar(null)!
    const event = { id: 'e1', calendarId: 'personal', title: 'Training', start: '2026-11-12T18:00', end: '2026-11-12T19:30', allDay: false, location: 'Halle', notes: '', notePath: '', recurrence: 'weekly' as const, recurrenceUntil: null, exceptionDates: ['2026-11-19'] }
    const stored = serializeCalendar({ ...calendar, events: [event] })
    expect(stored).toContain('<!-- fanotes-calendar-v1')
    expect(stored).toContain('{"id":"personal","name":"Persönlich","color":"#7f6df2","visible":true}')
    expect(loadCalendar(stored)).toEqual({ ...calendar, events: [event] })
    expect(loadCalendar('<!-- fanotes-calendar-v1\n[1')).toBeNull()
  })
})

const lesson = (id: string, day: string, from: string, to: string, name = 'geo 2.3'): AgendaEvent => ({
  id, start: `${day}T${from}:00`, end: `${day}T${to}:00`, text: name, comment: '', room: '', teachers: [], courseId: id, courseName: name, status: '', eventType: '0_stp', color: '', timetableText: name,
})

describe('hidden lessons (DeskTest, WeekRangeTest)', () => {
  const chor = lesson('e1', '2026-11-02', '07:45', '08:30', 'Freifach Chor')
  const later = { ...chor, id: 'e2', start: '2026-11-09T07:45:00', end: '2026-11-09T08:30:00' }
  it('hiding one lesson stays on that week; hiding the series hides every week', () => {
    const once = hideOnce(chor, [])
    expect(lessonHidden(chor, once)).toBe(true)
    expect(lessonHidden(later, once)).toBe(false)
    const series = hideSeries(chor, [])
    expect(lessonHidden(later, series)).toBe(true)
    expect(series[0].id).toBe('series:freifach chor|1|07:45')
    expect(once[0].id).toBe('once:e1:2026-11-02')
    expect(hideOnce(chor, once)).toHaveLength(1)
  })
})

describe('planned absences (PlannedAbsencesTest)', () => {
  const today = '2026-11-10'
  const lessons = [
    lesson('1', '2026-11-11', '08:00', '08:45'), lesson('2', '2026-11-11', '08:45', '09:30'),
    lesson('3', '2026-11-11', '09:45', '10:30', 'mat 2.1'), lesson('4', '2026-11-11', '13:15', '14:00', 'bio 2.1'),
  ]
  const snapshot = { revision: 1, fetchedAt: '', grades: [], events: lessons, exams: [], absences: [], absenceQuota: 30, absenceRemaining: 30, homework: [], messages: [], vacations: [], konto: [], startMessages: [] }
  const plan = (id: string, day: string, from: string, to: string, subject = 'geo 2.3') => ({ id, date: day, start: from, end: to, subject, lessonId: id, createdAt: 1 })
  const open = (id: string, day: string, from: string, to: string) => ({ id, dateFrom: day, dateTo: day, hourFrom: from, hourTo: to, subject: 'geo 2.3', reason: '', excused: false, acknowledged: false, status: 'offen', pending: true })

  it('a planned double lesson costs three', () => {
    const result = provisionalTally(snapshot, [plan('a', '2026-11-11', '08:00', '08:45'), plan('b', '2026-11-11', '08:45', '09:30')], today)
    expect(result.tally.estimated).toBe(3)
    expect(result.current.estimated).toBe(0)
    expect(result.plannedPoints).toBe(3)
    expect(result.tally.remaining).toBe(27)
    expect(result.tally.estimates['planned:a'].points).toBe(3)
    expect(result.items.every((item) => item.state === 'upcoming')).toBe(true)
  })

  it('a planned lesson next to an open report joins its block', () => {
    const withOpen = { ...snapshot, absences: [open('o1', '11.11.2026', '08:00', '08:45')] }
    expect(provisionalTally(withOpen, [], today).tally.estimated).toBe(2)
    const result = provisionalTally(withOpen, [plan('b', '2026-11-11', '08:45', '09:30')], today)
    expect(result.tally.estimated).toBe(3)
    expect(result.plannedPoints).toBe(1)
  })

  it('a plan that later appears as an open report is not counted twice', () => {
    const planned = [plan('a', '2026-11-11', '08:00', '08:45')]
    const result = provisionalTally({ ...snapshot, absences: [open('o1', '11.11.2026', '08:00', '08:45')] }, planned, today)
    expect(result.items[0].state).toBe('matched')
    expect(result.tally.estimated).toBe(2)
    expect(result.plannedPoints).toBe(0)
  })

  it('a booked entry on that day matches', () => {
    const booked = { id: 'abs-1', dateFrom: '11.11.2026', dateTo: '11.11.2026', hourFrom: '', hourTo: '', subject: '', reason: 'Krankheit', excused: false, acknowledged: true, status: 'gebucht', points: 3 }
    const result = provisionalTally({ ...snapshot, absences: [booked], absenceRemaining: 27 }, [plan('a', '2026-11-11', '08:00', '08:45')], today)
    expect(result.items[0].state).toBe('matched')
    expect(result.tally.estimated).toBe(0)
    expect(result.tally.booked).toBe(3)
    expect(result.tally.remaining).toBe(27)
  })

  it('a non-overlapping time on the same day does not match', () => {
    const withOpen = { ...snapshot, absences: [open('o1', '11.11.2026', '13:15', '14:00')] }
    expect(matchPlanned([plan('a', '2026-11-11', '08:00', '08:45')], withOpen, today)[0].state).toBe('upcoming')
  })

  it('a past plan without a real absence is not entered and not counted; today still counts', () => {
    const result = provisionalTally(snapshot, [plan('a', '2026-11-09', '08:00', '08:45')], today)
    expect(result.items[0].state).toBe('notEntered')
    expect(result.tally.estimated).toBe(0)
    expect(matchPlanned([plan('t', '2026-11-10', '08:00', '08:45')], snapshot, today)[0].state).toBe('upcoming')
  })

  it('a planned exam lesson costs ten', () => {
    const exam: AgendaEvent = { ...lesson('exam-1', '2026-11-11', '13:15', '14:00', 'bio 2.1 Prüfung'), eventType: 'exam', courseId: '' }
    const result = provisionalTally({ ...snapshot, exams: [exam] }, [plan('e', '2026-11-11', '13:15', '14:00', 'bio 2.1')], today)
    expect(result.tally.estimated).toBe(10)
    expect(result.tally.remaining).toBe(20)
  })

  it('marking a lesson stores it once and finds it again', () => {
    const marked = planAbsence(lessons[0], [], 5)
    expect(marked).toHaveLength(1)
    expect(marked[0]).toMatchObject({ date: '2026-11-11', start: '08:00', end: '08:45', lessonId: '1', createdAt: 5 })
    expect(marked[0].id).toBe(stableId('planned', '2026-11-11', '08:00', '1'))
    expect(planAbsence(lessons[0], marked, 6)).toEqual(marked)
    expect(plannedFor(lessons[0], marked)).not.toBeNull()
    expect(plannedFor(lessons[1], marked)).toBeNull()
  })
})
