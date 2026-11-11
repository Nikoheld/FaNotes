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
  /** Pendelstrecken alerts: the parent switch and its three fine switches (default on). */
  commute: boolean
  commuteDelay: boolean
  commuteCancelled: boolean
  commuteLessonEnd: boolean
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

// Pendelstrecken (commute routes): the contract in fanotes-site/commute-api.md. All times are ISO 8601
// with the Zurich offset; minutes are integers.

export type StopType = 'train' | 'bus' | 'tram' | 'ship' | 'cableway' | 'other'
export interface Stop { id: string; name: string; type: StopType }

export type ScheduleMode = 'none' | 'times' | 'firstLesson' | 'lastLesson'
export interface Schedule {
  mode: ScheduleMode
  /** 'HH:MM' departure times (mode 'times' only, at most 6). */
  times: string[]
  /** 1 = Monday ... 7 = Sunday. */
  days: number[]
  /** firstLesson: arrive this early; lastLesson: leave this long after the end (0-60). */
  bufferMinutes: number
}

export interface CommuteRoute {
  id: string
  name: string
  from: Stop
  to: Stop
  via: Stop | null
  schedule: Schedule
  /** Minutes; null follows the global threshold. */
  delayThreshold: number | null
  notify: boolean
}

export interface CommuteSettings { delayThreshold: number; hiddenLabels: string[] }

/** 1 low, 2 medium, 3 high, null unknown. */
export type OccupancyLevel = 1 | 2 | 3 | null
export interface Occupancy { first: OccupancyLevel; second: OccupancyLevel }

export interface TripPoint { name: string; stopId: string; time: string; planned: string; delay: number | null; platform: string; platformChanged: boolean }

export interface Leg {
  kind: 'ride' | 'walk'
  line: string
  category: string
  type: StopType
  operator: string
  direction: string
  /** Hex without '#', may be empty. */
  fgColor: string
  bgColor: string
  from: TripPoint
  to: TripPoint
  occupancy: Occupancy
  cancelled: boolean
  notes: string[]
  minutes: number
}

export interface Transfer { at: string; minutes: number; plannedMinutes: number; broken: boolean; tight: boolean }

export type TripStatus = 'ok' | 'delayed' | 'cancelled' | 'broken'
export interface TripIssue { kind: 'cancelled' | 'missedTransfer' | 'platformChange' | 'delay' | 'disruption'; text: string }

export interface Trip {
  id: string
  departure: string
  arrival: string
  plannedDeparture: string
  plannedArrival: string
  depDelay: number | null
  arrDelay: number | null
  minutes: number
  transfers: number
  status: TripStatus
  legs: Leg[]
  changes: Transfer[]
  occupancy: Occupancy
  issues: TripIssue[]
  quietest: boolean
}

export interface CommuteTarget {
  kind: 'now' | 'time' | 'firstLesson' | 'lastLesson'
  at: string
  timeType: 'depart' | 'arrive'
  lesson: { start: string; end: string; label: string } | null
  lessonChange: 'none' | 'lastCancelled' | 'firstCancelled'
  plannedAt: string | null
}

export interface RouteBoard {
  routeId: string
  target: CommuteTarget
  trips: Trip[]
  alternatives: Trip[]
  viaDropped: boolean
  updatedAt: string
  stale: boolean
}

export interface CommuteProvider { name: 'search.ch' | 'transport.opendata.ch'; occupancy: 'train-class'; formation: false }

export interface CommuteConfig { routes: CommuteRoute[]; settings: CommuteSettings; provider: CommuteProvider }
export interface CommuteBoards { boards: RouteBoard[]; provider: CommuteProvider }
