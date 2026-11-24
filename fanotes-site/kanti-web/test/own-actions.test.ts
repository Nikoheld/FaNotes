// The changes the forms make, against an in-memory vault: what is written, where, and what happens on a conflict.
import { describe, expect, it } from 'vitest'
import { MemoryBackend } from '../src/vault/backend'
import { createOwnActions } from '../src/vault/actions'
import { emptyOwn, loadOwn, type OwnData } from '../src/vault/own'
import {
  CALENDAR_NOTE_PATH, GRADE_BOOK_PATH, HIDDEN_PATH, HOMEWORK_NOTE_PATH, HYPOTHETICAL_PATH, PLANNED_PATH, emptyCalendar, loadCalendar, loadHomework, parseGradeBook, parseHiddenLessons,
  parseHypothetical, parsePlannedAbsences, serializeGradeBook, serializeHomework, textOf,
} from '../src/vault/files'
import { appendSchoolAssignment, prepareTask, sortTasks, upsertTask, classifyTask } from '../src/vault/tasks'
import type { AgendaEvent } from '../src/types'

const setup = (files: Record<string, string> = {}, slot: string | null = '') => {
  const backend = new MemoryBackend(files)
  let own: OwnData = emptyOwn()
  const failures: unknown[] = []
  const actions = createOwnActions(() => backend, (next) => { own = next }, () => own, { slot, onFailure: (problem) => failures.push(problem) })
  return { backend, actions, failures, own: () => own, text: (path: string) => textOf(backend.files.get(path)?.bytes ?? null) }
}

const lesson: AgendaEvent = { id: 'l1', start: '2026-11-11T08:00:00', end: '2026-11-11T08:45:00', text: 'geo 2.3', comment: '', room: '', teachers: [], courseId: 'l1', courseName: 'geo 2.3', status: '', eventType: 'lesson', color: '', timetableText: 'geo 2.3' }

describe('grade changes', () => {
  it('adds, edits and deletes an own mark in grade-book.json at the first connection\'s path', async () => {
    const { actions, text, own } = setup()
    expect(await actions.saveOwnGrade({ id: 'o1', courseId: 'math', title: 'Essay', mark: 6, weight: 1, date: '2026-11-04' })).toBe(true)
    expect(parseGradeBook(text(GRADE_BOOK_PATH)).own).toHaveLength(1)
    expect(own().book.own[0].title).toBe('Essay')
    await actions.saveOwnGrade({ id: 'o1', courseId: 'math', title: 'Essay 2', mark: 5, weight: 2, date: '2026-11-04' })
    expect(parseGradeBook(text(GRADE_BOOK_PATH)).own).toEqual([{ id: 'o1', courseId: 'math', title: 'Essay 2', mark: 5, weight: 2, date: '2026-11-04' }])
    await actions.deleteOwnGrade('o1')
    expect(parseGradeBook(text(GRADE_BOOK_PATH)).own).toEqual([])
  })

  it('a further connection\'s files live in its slot', async () => {
    const { actions, backend } = setup({}, 'cabc123def')
    await actions.addHypothetical('math', 'Test', 5, 1)
    expect([...backend.files.keys()]).toEqual(['.fanotes/schulnetz/connections/cabc123def/hypothetical.json'])
    const none = setup({}, null)
    expect(await none.actions.addHypothetical('math', 'x', 5, 1)).toBe(false)
    expect(none.backend.files.size).toBe(0)
    expect(none.failures).toHaveLength(1)
  })

  it('adjusts a school mark, drops an empty adjustment, archives and restores a subject', async () => {
    const { actions, text } = setup()
    await actions.saveAdjustment({ targetId: 't1', mark: 5.5, weight: null, excluded: false })
    await actions.saveAdjustment({ targetId: 't2', excluded: true })
    expect(parseGradeBook(text(GRADE_BOOK_PATH)).adjustments.map((item) => item.targetId)).toEqual(['t1', 't2'])
    await actions.saveAdjustment({ targetId: 't1', mark: null, weight: null, excluded: false })
    expect(parseGradeBook(text(GRADE_BOOK_PATH)).adjustments.map((item) => item.targetId)).toEqual(['t2'])
    await actions.restoreAdjustment('t2')
    await actions.archiveCourse('de')
    await actions.archiveCourse('de')
    expect(parseGradeBook(text(GRADE_BOOK_PATH))).toMatchObject({ adjustments: [], archivedCourseIds: ['de'] })
    await actions.restoreCourse('de')
    expect(parseGradeBook(text(GRADE_BOOK_PATH)).archivedCourseIds).toEqual([])
  })

  it('what-if marks are added and removed', async () => {
    const { actions, text } = setup()
    await actions.addHypothetical('math', 'nächste', 6, 1)
    const [stored] = parseHypothetical(text(HYPOTHETICAL_PATH))
    expect(stored).toMatchObject({ courseId: 'math', title: 'nächste', mark: 6, weight: 1 })
    await actions.removeHypothetical(stored.id)
    expect(parseHypothetical(text(HYPOTHETICAL_PATH))).toEqual([])
  })

  it('on a stale rejection the change is re-applied to what the other device wrote meanwhile', async () => {
    const other = parseGradeBook(null)
    const { actions, backend, text } = setup({ [GRADE_BOOK_PATH]: serializeGradeBook(other) })
    let interfered = false
    backend.beforeWrite = (path) => {
      if (interfered || path !== GRADE_BOOK_PATH) return
      interfered = true
      // The app archives a subject between our read and our write.
      backend.put(path, new TextEncoder().encode(serializeGradeBook({ ...other, archivedCourseIds: ['de'] })))
    }
    await actions.saveOwnGrade({ id: 'o1', courseId: 'math', title: 'Mine', mark: 5, weight: 1, date: '2026-11-04' })
    const book = parseGradeBook(text(GRADE_BOOK_PATH))
    expect(book.own.map((grade) => grade.id)).toEqual(['o1'])
    expect(book.archivedCourseIds).toEqual(['de'])
  })

  it('after three stale rejections the change fails, the other version stays and the failure is reported', async () => {
    const { actions, backend, failures, text } = setup({ [GRADE_BOOK_PATH]: serializeGradeBook(parseGradeBook(null)) })
    let round = 0
    backend.beforeWrite = (path) => { round += 1; backend.put(path, new TextEncoder().encode(serializeGradeBook({ own: [], collective: [], adjustments: [], archivedCourseIds: [`r${round}`] }))) }
    expect(await actions.saveOwnGrade({ id: 'o1', courseId: 'math', title: 'Mine', mark: 5, weight: 1, date: '2026-11-04' })).toBe(false)
    expect(failures).toHaveLength(1)
    expect(parseGradeBook(text(GRADE_BOOK_PATH))).toMatchObject({ own: [], archivedCourseIds: ['r3'] })
  })
})

describe('lessons and planned absences', () => {
  it('hides a lesson once or as a series, shows it again, plans and unplans an absence', async () => {
    const { actions, text } = setup()
    await actions.hideLesson(lesson, 'once')
    await actions.hideLesson(lesson, 'series')
    const rules = parseHiddenLessons(text(HIDDEN_PATH))
    expect(rules.map((rule) => rule.mode)).toEqual(['once', 'series'])
    await actions.showLesson(rules[0].id)
    expect(parseHiddenLessons(text(HIDDEN_PATH)).map((rule) => rule.mode)).toEqual(['series'])
    await actions.planAbsence(lesson)
    await actions.planAbsence(lesson)
    const planned = parsePlannedAbsences(text(PLANNED_PATH))
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ date: '2026-11-11', start: '08:00', end: '08:45' })
    await actions.unplanAbsence(planned[0].id)
    expect(parsePlannedAbsences(text(PLANNED_PATH))).toEqual([])
  })
})

describe('tasks and events', () => {
  it('creates, completes, edits and deletes a task in Hausaufgaben.md', async () => {
    const { actions, text, own } = setup()
    expect(await actions.saveTask({ title: '   ' })).toBe(false)
    expect(await actions.saveTask({ title: 'Aufgaben S. 42', subject: 'Mathematik', dueDate: '2026-11-12', priority: 'high' })).toBe(true)
    const [task] = loadHomework(text(HOMEWORK_NOTE_PATH))!.tasks
    expect(task).toMatchObject({ title: 'Aufgaben S. 42', subject: 'Mathematik', dueDate: '2026-11-12', done: false, priority: 'high', kind: 'homework' })
    expect(task.createdAt).not.toBe('')
    await actions.setTaskDone(task.id, true)
    expect(loadHomework(text(HOMEWORK_NOTE_PATH))!.tasks[0].done).toBe(true)
    await actions.saveTask({ title: 'Aufgaben S. 43', dueDate: '2026-11-13', dueTime: '08:00' }, task.id)
    expect(loadHomework(text(HOMEWORK_NOTE_PATH))!.tasks[0]).toMatchObject({ id: task.id, title: 'Aufgaben S. 43', dueTime: '08:00', done: true })
    await actions.deleteTask(task.id)
    expect(loadHomework(text(HOMEWORK_NOTE_PATH))!.tasks).toEqual([])
    expect(own().tasks).toEqual([])
  })

  it('never writes over a task file it cannot read', async () => {
    const broken = '# Hausaufgaben\n<!-- fanotes-homework-v1\n{ kaputt\n-->\n'
    const { actions, text, failures } = setup({ [HOMEWORK_NOTE_PATH]: broken })
    expect(await actions.saveTask({ title: 'Neu' })).toBe(false)
    expect(text(HOMEWORK_NOTE_PATH)).toBe(broken)
    expect(failures).toHaveLength(1)
  })

  it('copies a school assignment once', async () => {
    const { actions, text } = setup()
    const homework = { title: 'Lesen S. 10', courseName: 'Deutsch', dueDate: '12.11.2026', description: 'Kapitel 2' }
    expect(await actions.addSchoolHomework(homework)).toBe('added')
    expect(await actions.addSchoolHomework(homework)).toBe('exists')
    const tasks = loadHomework(text(HOMEWORK_NOTE_PATH))!.tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: 'Lesen S. 10', subject: 'Deutsch', dueDate: '2026-11-12', notes: 'Kapitel 2' })
    expect(tasks[0].id.startsWith('schulnetz-')).toBe(true)
  })

  it('a task change re-applies on top of a task the other device added meanwhile', async () => {
    const { actions, backend, text } = setup({ [HOMEWORK_NOTE_PATH]: serializeHomework({ tasks: [], publishedIds: [] }) })
    let once = false
    backend.beforeWrite = (path) => {
      if (once) return
      once = true
      backend.put(path, new TextEncoder().encode(serializeHomework(upsertTask({ tasks: [], publishedIds: [] }, prepareTask({ title: 'Von der App' })!, 'app-1', 'now'))))
    }
    await actions.saveTask({ title: 'Vom Browser' })
    expect(loadHomework(text(HOMEWORK_NOTE_PATH))!.tasks.map((task) => task.title)).toEqual(['Von der App', 'Vom Browser'])
  })

  it('creates an event, edits a later repeat as its own event, skips a day and deletes the series', async () => {
    const { actions, text } = setup()
    const base = { id: 'ev1', calendarId: 'personal', title: 'Training', start: '2026-11-12T18:00', end: '2026-11-12T19:00', allDay: false, location: '', notes: '', notePath: '', recurrence: 'weekly' as const, recurrenceUntil: null, exceptionDates: [] as string[] }
    expect(await actions.saveEvent(base, null)).toBe(true)
    await actions.saveEvent({ ...base, title: 'Training verlegt', start: '2026-11-19T19:00', end: '2026-11-19T20:00', recurrence: 'none' }, 'ev1@2026-11-19')
    let calendar = loadCalendar(text(CALENDAR_NOTE_PATH))!
    expect(calendar.events).toHaveLength(2)
    expect(calendar.events[0].exceptionDates).toEqual(['2026-11-19'])
    await actions.skipOccurrence('ev1', '2026-11-26')
    calendar = loadCalendar(text(CALENDAR_NOTE_PATH))!
    expect(calendar.events[0].exceptionDates).toEqual(['2026-11-19', '2026-11-26'])
    await actions.deleteEvent('ev1')
    expect(loadCalendar(text(CALENDAR_NOTE_PATH))!.events.map((event) => event.title)).toEqual(['Training verlegt'])
  })

  it('copies a school exam into the "Schule" calendar once', async () => {
    const { actions, text } = setup()
    const exam = { id: 'x1', title: 'Mathe Prüfung', start: '2026-11-20T10:30', end: '2026-11-20T11:15', room: 'X102', comment: '' }
    expect(await actions.addExam(exam)).toBe('added')
    expect(await actions.addExam(exam)).toBe('exists')
    const calendar = loadCalendar(text(CALENDAR_NOTE_PATH))!
    expect(calendar.events).toHaveLength(1)
    expect(calendar.events[0]).toMatchObject({ id: 'schulnetz-x1', calendarId: 'school', allDay: false, location: 'X102' })
    expect(calendar.calendars.map((item) => item.id)).toContain('school')
  })

  it('never writes over a calendar it cannot read', async () => {
    const broken = '<!-- fanotes-calendar-v1\n{ kaputt\n-->'
    const { actions, text } = setup({ [CALENDAR_NOTE_PATH]: broken })
    expect(await actions.saveEvent({ id: 'e', calendarId: 'personal', title: 'x', start: '2026-11-12', end: '2026-11-12', allDay: true, location: '', notes: '', notePath: '', recurrence: 'none', recurrenceUntil: null, exceptionDates: [] }, null)).toBe(false)
    expect(text(CALENDAR_NOTE_PATH)).toBe(broken)
  })
})

describe('task rules (HomeworkPlanner.kt)', () => {
  const task = (patch: Partial<ReturnType<typeof upsertTask>['tasks'][number]>) => ({ id: 'a', title: 'a', notes: '', subject: '', dueDate: null, dueTime: null, done: false, kind: 'homework' as const, priority: 'normal' as const, createdAt: '', updatedAt: '', ...patch })
  it('classifies and sorts: open first, important first, earliest due, then title', () => {
    expect(classifyTask(task({ dueDate: '2026-11-09' }), '2026-11-10')).toBe('overdue')
    expect(classifyTask(task({ dueDate: '2026-11-10' }), '2026-11-10')).toBe('today')
    expect(classifyTask(task({ dueDate: '2026-11-11' }), '2026-11-10')).toBe('upcoming')
    expect(classifyTask(task({}), '2026-11-10')).toBe('undated')
    expect(classifyTask(task({ done: true }), '2026-11-10')).toBe('done')
    const sorted = sortTasks([task({ id: 'done', done: true }), task({ id: 'late', dueDate: '2026-11-20' }), task({ id: 'none' }), task({ id: 'soon', dueDate: '2026-11-12', dueTime: '08:00' }), task({ id: 'soon2', dueDate: '2026-11-12' }), task({ id: 'high', dueDate: '2026-11-30', priority: 'high' })])
    expect(sorted.map((item) => item.id)).toEqual(['high', 'soon', 'soon2', 'late', 'none', 'done'])
  })
  it('prepares a draft the way the app does', () => {
    expect(prepareTask({ title: ' ' })).toBeNull()
    expect(prepareTask({ title: 'x', dueDate: '15.10.2026', dueTime: '9:30', kind: 'appointment' })).toMatchObject({ dueDate: null, dueTime: null, kind: 'appointment' })
    expect(prepareTask({ title: 'x'.repeat(300) })!.title).toHaveLength(240)
  })
  it('a copied assignment is skipped when title, subject and date match', () => {
    const doc = { tasks: [], publishedIds: [] }
    const once = appendSchoolAssignment(doc, { title: 'A', subject: 'B', dueDate: '2026-11-12', notes: '' }, 'schulnetz-1', 'now')!
    expect(appendSchoolAssignment(once, { title: 'A', subject: 'B', dueDate: '2026-11-12', notes: '' }, 'schulnetz-2', 'now')).toBeNull()
  })
})

describe('loading the own data from a vault', () => {
  it('reads every file of the first connection, and only the shared ones for a connection without a slot', async () => {
    const backend = new MemoryBackend({
      [GRADE_BOOK_PATH]: serializeGradeBook({ ...parseGradeBook(null), archivedCourseIds: ['de'] }),
      [HOMEWORK_NOTE_PATH]: serializeHomework({ tasks: [], publishedIds: [] }),
      [CALENDAR_NOTE_PATH]: '# Kalender\n<!-- fanotes-calendar-v1\n{"version":1,"calendars":[{"id":"x","name":"X","color":"#fff","visible":true}],"events":[]}\n-->',
    })
    expect((await loadOwn(backend, '')).book.archivedCourseIds).toEqual(['de'])
    expect((await loadOwn(backend, null)).book.archivedCourseIds).toEqual([])
    expect((await loadOwn(backend, null)).calendar.calendars.map((item) => item.id)).toEqual(['x'])
    expect((await loadOwn(new MemoryBackend(), '')).calendar).toEqual(emptyCalendar())
  })
})
