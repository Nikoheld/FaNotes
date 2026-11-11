// The snapshot the server keeps for a connection (the app's SchulnetzSnapshot, as JSON).

export interface AgendaEvent {
  id: string
  start: string
  end: string
  text: string
  comment: string
  room: string
  teachers: string[]
  courseId: string
  courseName: string
  status: string
  eventType: string
  color: string
  timetableText: string
  /** Lesson mark read from Schulnetz: '' | 'cancelled' | 'added' | 'moved' | 'changed'; absent on older stored lessons. */
  marker?: string
  /** Substitute teacher, or ''. */
  substitute?: string
}

export interface SchoolGrade {
  id: string
  course: string
  courseId: string
  subject: string
  title: string
  date: string
  mark: number | null
  weight: number
  confirmed?: boolean
  courseGrade?: number | null
  comment?: string
  /** Added by the server: the app's gradeTargetId. */
  targetId?: string
  /** Added by the server while hidden grades are on: the mark stays on the server. */
  hidden?: boolean
  withheld?: boolean
}

export interface SchoolAbsence {
  id: string
  dateFrom: string
  dateTo: string
  hourFrom: string
  hourTo: string
  subject: string
  reason: string
  excused: boolean
  acknowledged: boolean
  status: string
  excuseUntil?: string
  /** Booked Absenzpunkte from the statement. */
  points?: number | null
  /** An open absence report (no points yet; estimated). */
  pending?: boolean
}

export interface SchoolMessage { id: string; title: string; body: string; at: string }
export interface SchoolVacation { id: string; name: string; start: string; end: string }
export interface KontoLine { date: string; label: string; amount: string; balance: string }
export interface SchoolHomework { id: string; title: string; description: string; dueDate: string; courseId: string; courseName: string }

export interface Snapshot {
  revision: number
  fetchedAt: string
  profile?: { id: string; firstName: string; lastName: string; className: string; email: string } | null
  grades: SchoolGrade[]
  events: AgendaEvent[]
  exams: AgendaEvent[]
  absences: SchoolAbsence[]
  /** Kontingent and remaining quota as Schulnetz shows them. */
  absenceQuota?: number | null
  absenceRemaining?: number | null
  absenceParser?: number
  homework: SchoolHomework[]
  messages: SchoolMessage[]
  vacations: SchoolVacation[]
  konto: KontoLine[]
  /** Final Saldo row of the statement as Schulnetz prints it; absent or empty when missing. */
  kontoSaldo?: string
  startMessages: string[]
  readErrors?: string[]
  weekFetched?: Record<string, string>
  weekRead?: Record<string, string>
  examWeekFetched?: Record<string, string>
  weekSpanStart?: string
  weekSpanEnd?: string
}

export type Provider = 'schulnetz' | 'tam'

export interface Connection {
  id: string
  provider: Provider
  label: string
  source: 'pair' | 'fanotes' | 'demo'
  linked: boolean
  baseUrl: string
  needsReauth: boolean
  lastPollAt: string
  lastError: string
  mode: string
}

export interface Session {
  csrf: string
  browser: string
  createdAt: string
  expiresAt: string
  account: 'fanotes' | null
  connections: Connection[]
}

export interface AlertSettings {
  enabled: boolean
  grades: boolean
  gradeNew: boolean
  gradeChanged: boolean
  timetable: boolean
  lessonCancelled: boolean
  lessonChanged: boolean
  exams: boolean
  examNew: boolean
  examMoved: boolean
  examCancelled: boolean
  examRoom: boolean
  absences: boolean
  events: boolean
  appointmentNew: boolean
  messageNew: boolean
  deadlines: boolean
  guessGrades: boolean
}

export interface LinkStatus {
  linked: boolean
  provider: Provider
  baseUrl: string
  needsReauth: boolean
  lastPollAt: string
  lastError: string
  revision: number
  settings: Partial<AlertSettings>
  settingsUpdatedAt: string
  mode: string
}

export interface Reveals { guessGrades: boolean; hidden: string[] }

export interface Change {
  id: string
  revision: number
  category: string
  title: string
  body: string
  at: string
  target: string
  targetId: string
  courseId: string
}
