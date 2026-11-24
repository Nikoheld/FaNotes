// The changes the forms make to the student's own data. Each one reads the file's current content,
// applies the change to it and writes it back with the conflict rule of the vault client (re-read and
// re-apply on a stale rejection, never overwrite a newer remote version). The returned promise resolves to
// whether the change was saved; a failure is reported through `onFailure` and the page keeps its old data.
import type { VaultBackend } from './backend'
import { VaultError } from './client'
import {
  CALENDAR_NOTE_PATH, GRADE_BOOK_PATH, HIDDEN_PATH, HOMEWORK_NOTE_PATH, HYPOTHETICAL_PATH, PLANNED_PATH,
  bytesOf, cleanAdjustment, loadCalendar, loadHomework, newId, parseGradeBook, parseHiddenLessons, parseHypothetical, parsePlannedAbsences,
  serializeCalendar, serializeGradeBook, serializeHiddenLessons, serializeHomework, serializeHypothetical, serializePlannedAbsences, slotVaultPath, textOf,
  type CalendarDocument, type CalendarEvent, type CollectiveGrade, type GradeAdjustment, type GradeBook, type HomeworkDocument, type OwnGrade,
} from './files'
import { addExam, deleteEvent, saveOccurrence, skipOccurrence } from './calendar'
import type { OwnData } from './own'
import { hideOnce, hideSeries, planAbsence } from './school'
import { appendSchoolAssignment, deleteTask, prepareTask, setTaskDone, upsertTask, type TaskInput } from './tasks'
import type { AgendaEvent } from '../types'

export interface ActionContext { slot: string | null; onFailure?: (problem: unknown) => void }

export interface OwnActions {
  /** Changes can be written (the vault is open). */
  writable: boolean
  /** The school files of the shown connection can be written (it has a slot). */
  schoolWritable: boolean
  saveOwnGrade: (grade: OwnGrade) => Promise<boolean>
  deleteOwnGrade: (id: string) => Promise<boolean>
  saveCollective: (grade: CollectiveGrade) => Promise<boolean>
  deleteCollective: (id: string) => Promise<boolean>
  saveAdjustment: (adjustment: GradeAdjustment) => Promise<boolean>
  restoreAdjustment: (targetId: string) => Promise<boolean>
  archiveCourse: (courseId: string) => Promise<boolean>
  restoreCourse: (courseId: string) => Promise<boolean>
  addHypothetical: (courseId: string, title: string, mark: number, weight: number) => Promise<boolean>
  removeHypothetical: (id: string) => Promise<boolean>
  hideLesson: (event: AgendaEvent, mode: 'once' | 'series') => Promise<boolean>
  showLesson: (ruleId: string) => Promise<boolean>
  planAbsence: (event: AgendaEvent) => Promise<boolean>
  unplanAbsence: (id: string) => Promise<boolean>
  saveTask: (input: Parameters<typeof prepareTask>[0], id?: string | null) => Promise<boolean>
  deleteTask: (id: string) => Promise<boolean>
  setTaskDone: (id: string, done: boolean) => Promise<boolean>
  /** Copies a school assignment into the own tasks. Resolves to 'added', 'exists' or 'failed'. */
  addSchoolHomework: (homework: { title: string; courseName: string; dueDate: string; description: string }) => Promise<'added' | 'exists' | 'failed'>
  saveEvent: (event: CalendarEvent, occurrenceKey: string | null) => Promise<boolean>
  deleteEvent: (id: string) => Promise<boolean>
  skipOccurrence: (id: string, day: string) => Promise<boolean>
  /** Copies a school exam into the "Schule" calendar. Resolves to 'added', 'exists' or 'failed'. */
  addExam: (exam: { id: string; title: string; start: string; end: string; room: string; comment: string }) => Promise<'added' | 'exists' | 'failed'>
}

const UNREADABLE = 'unreadable'

export const createOwnActions = (getBackend: () => VaultBackend | null, setOwn: (own: OwnData) => void, getOwn: () => OwnData, context: ActionContext = { slot: null }): OwnActions => {
  const fail = (problem: unknown) => { context.onFailure?.(problem) }
  const need = (): VaultBackend => {
    const backend = getBackend()
    if (!backend) throw new VaultError('unavailable', 'The vault is not open.')
    return backend
  }
  const schoolPath = (path: string): string => {
    if (context.slot === null) throw new VaultError('failed', 'This connection has no own data here.')
    return slotVaultPath(context.slot, path)
  }
  const run = async (task: () => Promise<void>): Promise<boolean> => {
    try { await task(); return true } catch (problem) { fail(problem); return false }
  }

  /** Reads `path`, applies `op` to the parsed fresh content, writes it, and shows what was written. */
  const edit = async <T>(path: string, read: (text: string | null) => T, write: (value: T) => string, op: (value: T) => T, show: (own: OwnData, value: T) => OwnData) => {
    const result = await need().update(path, (current) => bytesOf(write(op(read(textOf(current))))))
    if (result) setOwn(show(getOwn(), read(textOf(result.bytes))))
  }
  const editBook = (op: (book: GradeBook) => GradeBook) => edit(schoolPath(GRADE_BOOK_PATH), parseGradeBook, serializeGradeBook, op, (own, book) => ({ ...own, book }))
  const editHomework = (op: (document: HomeworkDocument) => HomeworkDocument | null) => {
    let skipped = false
    return edit(
      HOMEWORK_NOTE_PATH,
      (text) => { const loaded = loadHomework(text); if (!loaded) throw new VaultError('corrupt', UNREADABLE); return loaded },
      serializeHomework,
      (document) => { const next = op(document); if (!next) { skipped = true; return document } return next },
      (own, document) => ({ ...own, tasks: document.tasks, tasksReadable: true }),
    ).then(() => skipped)
  }
  const editCalendar = (op: (document: CalendarDocument) => CalendarDocument) => edit(
    CALENDAR_NOTE_PATH,
    (text) => { const loaded = loadCalendar(text); if (!loaded) throw new VaultError('corrupt', UNREADABLE); return loaded },
    serializeCalendar,
    op,
    (own, calendar) => ({ ...own, calendar, calendarReadable: true }),
  )
  const now = () => new Date().toISOString()

  return {
    writable: getBackend() !== null,
    schoolWritable: getBackend() !== null && context.slot !== null,
    saveOwnGrade: (grade) => run(() => editBook((book) => ({ ...book, own: book.own.some((item) => item.id === grade.id) ? book.own.map((item) => (item.id === grade.id ? grade : item)) : [...book.own, grade] }))),
    deleteOwnGrade: (id) => run(() => editBook((book) => ({ ...book, own: book.own.filter((item) => item.id !== id) }))),
    saveCollective: (grade) => run(() => editBook((book) => ({ ...book, collective: book.collective.some((item) => item.id === grade.id) ? book.collective.map((item) => (item.id === grade.id ? grade : item)) : [...book.collective, grade] }))),
    deleteCollective: (id) => run(() => editBook((book) => ({ ...book, collective: book.collective.filter((item) => item.id !== id) }))),
    saveAdjustment: (adjustment) => run(() => editBook((book) => {
      const cleaned = cleanAdjustment(adjustment)
      const others = book.adjustments.filter((item) => item.targetId !== adjustment.targetId)
      return { ...book, adjustments: cleaned ? [...others, cleaned] : others }
    })),
    restoreAdjustment: (targetId) => run(() => editBook((book) => ({ ...book, adjustments: book.adjustments.filter((item) => item.targetId !== targetId) }))),
    archiveCourse: (courseId) => run(() => editBook((book) => ({ ...book, archivedCourseIds: [...new Set([...book.archivedCourseIds, courseId])] }))),
    restoreCourse: (courseId) => run(() => editBook((book) => ({ ...book, archivedCourseIds: book.archivedCourseIds.filter((id) => id !== courseId) }))),
    addHypothetical: (courseId, title, mark, weight) => run(() => edit(schoolPath(HYPOTHETICAL_PATH), parseHypothetical, serializeHypothetical,
      (grades) => [...grades, { id: newId(), courseId, title: title.trim(), mark, weight }], (own, hypothetical) => ({ ...own, hypothetical }))),
    removeHypothetical: (id) => run(() => edit(schoolPath(HYPOTHETICAL_PATH), parseHypothetical, serializeHypothetical,
      (grades) => grades.filter((grade) => grade.id !== id), (own, hypothetical) => ({ ...own, hypothetical }))),
    hideLesson: (event, mode) => run(() => edit(schoolPath(HIDDEN_PATH), parseHiddenLessons, serializeHiddenLessons,
      (rules) => (mode === 'once' ? hideOnce(event, rules) : hideSeries(event, rules)), (own, hidden) => ({ ...own, hidden }))),
    showLesson: (ruleId) => run(() => edit(schoolPath(HIDDEN_PATH), parseHiddenLessons, serializeHiddenLessons,
      (rules) => rules.filter((rule) => rule.id !== ruleId), (own, hidden) => ({ ...own, hidden }))),
    planAbsence: (event) => run(() => edit(schoolPath(PLANNED_PATH), parsePlannedAbsences, serializePlannedAbsences,
      (items) => planAbsence(event, items), (own, planned) => ({ ...own, planned }))),
    unplanAbsence: (id) => run(() => edit(schoolPath(PLANNED_PATH), parsePlannedAbsences, serializePlannedAbsences,
      (items) => items.filter((item) => item.id !== id), (own, planned) => ({ ...own, planned }))),
    saveTask: (input, id = null) => {
      const prepared = prepareTask(input)
      if (!prepared) return Promise.resolve(false)
      return run(async () => { await editHomework((document) => upsertTask(document, prepared as TaskInput, id, now())) })
    },
    deleteTask: (id) => run(async () => { await editHomework((document) => deleteTask(document, id)) }),
    setTaskDone: (id, done) => run(async () => { await editHomework((document) => setTaskDone(document, id, done, now())) }),
    addSchoolHomework: async (homework) => {
      let result: 'added' | 'exists' | 'failed' = 'failed'
      const ok = await run(async () => {
        const skipped = await editHomework((document) => appendSchoolAssignment(document, {
          title: homework.title, subject: homework.courseName, dueDate: /^\d{4}-\d{2}-\d{2}$/u.test(homework.dueDate) ? homework.dueDate : swissToIso(homework.dueDate), notes: homework.description,
        }, `schulnetz-${newId()}`, now()))
        result = skipped ? 'exists' : 'added'
      })
      return ok ? result : 'failed'
    },
    saveEvent: (event, occurrenceKey) => run(() => editCalendar((document) => saveOccurrence(document, occurrenceKey, event))),
    deleteEvent: (id) => run(() => editCalendar((document) => deleteEvent(document, id))),
    skipOccurrence: (id, day) => run(() => editCalendar((document) => skipOccurrence(document, id, day))),
    addExam: async (exam) => {
      let existed = false
      const ok = await run(() => editCalendar((document) => {
        const next = addExam(document, exam)
        existed = next === document
        return next
      }))
      return ok ? (existed ? 'exists' : 'added') : 'failed'
    },
  }
}

const swissToIso = (raw: string): string | null => {
  const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u.exec(raw)
  return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : null
}

