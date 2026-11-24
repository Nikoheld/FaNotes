// Everything the page shows of the student's own data, read from the vault files of one connection.
import type { VaultBackend } from './backend'
import {
  CALENDAR_NOTE_PATH, COLORS_PATH, DESK_PATH, GRADE_BOOK_PATH, HIDDEN_PATH, HOMEWORK_NOTE_PATH, HYPOTHETICAL_PATH, PLANNED_PATH,
  emptyCalendar, emptyGradeBook, loadCalendar, loadHomework, parseColors, parseDeskSettings, parseGradeBook, parseHiddenLessons, parseHypothetical,
  parsePlannedAbsences, slotVaultPath, textOf,
  type CalendarDocument, type DeskSettings, type GradeBook, type HiddenLesson, type HomeworkTask, type HypotheticalGrade, type PlannedAbsence,
} from './files'

export interface OwnData {
  book: GradeBook
  hypothetical: HypotheticalGrade[]
  hidden: HiddenLesson[]
  planned: PlannedAbsence[]
  colors: Record<string, string>
  desk: DeskSettings
  tasks: HomeworkTask[]
  /** False when Hausaufgaben.md has a marker that does not parse: the page shows it and never writes it. */
  tasksReadable: boolean
  calendar: CalendarDocument
  calendarReadable: boolean
}

export const emptyOwn = (): OwnData => ({
  book: emptyGradeBook(), hypothetical: [], hidden: [], planned: [], colors: {}, desk: parseDeskSettings(null),
  tasks: [], tasksReadable: true, calendar: emptyCalendar(), calendarReadable: true,
})

/** `slot` null: this connection has no vault files here (only the files every connection shares are read). */
export const loadOwn = async (backend: VaultBackend, slot: string | null): Promise<OwnData> => {
  await backend.sync?.()
  const read = async (path: string) => textOf((await backend.read(path)).bytes)
  const school = (path: string) => (slot === null ? Promise.resolve(null) : read(slotVaultPath(slot, path)))
  const [book, hypothetical, hidden, planned, colors, desk, homework, calendar] = await Promise.all([
    school(GRADE_BOOK_PATH), school(HYPOTHETICAL_PATH), school(HIDDEN_PATH), school(PLANNED_PATH), school(COLORS_PATH),
    read(DESK_PATH), read(HOMEWORK_NOTE_PATH), read(CALENDAR_NOTE_PATH),
  ])
  const tasks = loadHomework(homework)
  const events = loadCalendar(calendar)
  return {
    book: parseGradeBook(book),
    hypothetical: parseHypothetical(hypothetical),
    hidden: parseHiddenLessons(hidden),
    planned: parsePlannedAbsences(planned),
    colors: parseColors(colors),
    desk: parseDeskSettings(desk),
    tasks: tasks?.tasks ?? [],
    tasksReadable: tasks !== null,
    calendar: events ?? emptyCalendar(),
    calendarReadable: events !== null,
  }
}
