// School statistics computed only from the snapshot the browser already holds: lesson cancellations,
// grading time, tests waiting for a grade, corrected grades, exam load and absences. Nothing is read
// from Schulnetz or sent anywhere, and no mark is part of the result. Kotlin twin: SchoolStats.kt; both run
// android/core/src/test/resources/schulnetz/school-stats-cases.json.
import {
  addDays, cleanSchulnetzText, courseIdentity, eventDate, isCancelled, isLesson, isSubstitution, isSummaryGrade, looksLikeCourseCode,
  schulnetzClock, weekMonday, zurichClock, zurichToday,
} from '@shared/schulnetz-logic'
import type { AgendaEvent, GradeTrack, SchoolGrade, Snapshot } from '../types'
import { courseLabel } from './grades'

export interface LessonCounts { total: number; cancelled: number; substituted: number; moved: number; changed: number; added: number; rate: number }
export interface CourseCancellations extends LessonCounts { key: string; title: string; teacher: string }
/** weekday: 1 = Monday .. 7 = Sunday. */
export interface WeekdayCount { weekday: number; total: number; cancelled: number }
export interface ClockCount { clock: string; total: number; cancelled: number }
export interface StatsCoverage { firstDay: string; lastDay: string; weeks: number }
export interface RecentCancellation { day: string; title: string; clock: string }
export interface CancellationStats {
  totals: LessonCounts
  courses: CourseCancellations[]
  weekdays: WeekdayCount[]
  clocks: ClockCount[]
  coverage: StatsCoverage
  recent: RecentCancellation[]
}
export interface CourseGrading { key: string; title: string; teacher: string; count: number; median: number; mean: number; fastest: number; slowest: number }
export interface RecentGrading { title: string; course: string; testDay: string; delay: number }
export interface GradingStats { count: number; median: number | null; mean: number | null; courses: CourseGrading[]; recent: RecentGrading[] }
export interface WaitingExam { title: string; course: string; examDay: string; daysWaiting: number }
export interface ChangedGrade { title: string; course: string; firstSeenDay: string; versions: number }
export interface GradeChangeStats { count: number; items: ChangedGrade[] }
export interface ExamWeek { monday: string; count: number }
export interface ExamLoad { weeks: ExamWeek[]; busiestMonday: string; busiestCount: number; next28: number }
/** subject is '' for an absence without a subject; the view names it. */
export interface AbsenceSubject { subject: string; count: number; excused: number }
export interface SchoolStats {
  cancellations: CancellationStats
  grading: GradingStats
  waiting: WaitingExam[]
  gradeChanges: GradeChangeStats
  examLoad: ExamLoad
  absences: AbsenceSubject[]
}

export const STATS_MAX_DELAY_DAYS = 180
export const STATS_WAITING_MAX_DAYS = 120
export const STATS_MATCH_DAYS = 3
export const STATS_RECENT = 10
export const STATS_EXAM_AHEAD_DAYS = 28

const DAY_MS = 86400000

/** UTF-16 code unit order, like Kotlin's String.compareTo (no locale). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A real calendar day (ISO) from an ISO or Swiss date, or ''. */
const statsDay = (raw: string | undefined): string => {
  const day = eventDate(String(raw || ''))
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day)
  if (!match) return ''
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === day ? day : ''
}

const epochDay = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)
const daysBetween = (from: string, to: string) => epochDay(to) - epochDay(from)
const weekdayOf = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1
const round1 = (value: number) => Math.floor(value * 10 + 0.5) / 10

const mostCommon = (values: string[]): string => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  let best = 0
  for (const count of counts.values()) best = Math.max(best, count)
  return [...counts.entries()].filter(([, count]) => count === best).map(([value]) => value).sort(cmp)[0] || ''
}

const median = (sorted: number[]) => {
  const n = sorted.length
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

const identityKey = (label: string): string | null => {
  const identity = courseIdentity(label)
  return identity ? `${identity.subject}|${identity.group}` : null
}

const eventLabelOf = (event: AgendaEvent) =>
  [event.courseName, event.text, event.timetableText].map((value) => cleanSchulnetzText(value)).find((value) => value) || 'Lektion'

/** The app's preferredSubjectTitle. */
const preferredSubjectTitle = (code: string, readable: string) => {
  const token = cleanSchulnetzText(code)
  const name = cleanSchulnetzText(readable)
  if (!name) return token
  if (!token || token.toLowerCase() === name.toLowerCase()) return name
  if (looksLikeCourseCode(token) && !looksLikeCourseCode(name)) {
    const words = name.split(/[\s,/]+/u).map((word) => word.replace(/^\(|\)$/gu, ''))
    if (words.some((word) => word.toLowerCase() === token.toLowerCase())) return name
    return `${name} (${token})`
  }
  return token
}

/** The app's preferredEventTitle. */
const preferredEventTitle = (event: AgendaEvent) => {
  const code = cleanSchulnetzText(event.courseName)
  const readable = [event.text, event.timetableText].map((value) => cleanSchulnetzText(value)).find((value) => value) || ''
  return preferredSubjectTitle(code, readable) || eventLabelOf(event)
}

const teachersOf = (event: AgendaEvent) => (event.teachers || []).map((value) => cleanSchulnetzText(value)).filter(Boolean).join(', ')
const cancelledEvent = (event: AgendaEvent) => event.marker === 'cancelled' || isCancelled(event)
const lessonKeyOf = (event: AgendaEvent) => identityKey(event.courseName) || identityKey(event.text) || cleanSchulnetzText(eventLabelOf(event))

interface Lesson { event: AgendaEvent; day: string; clock: string; cancelled: boolean; key: string }

/** Lessons of every loaded week, one per id and start (Schulnetz reuses a lesson id in every week). */
const dedupedLessons = (events: AgendaEvent[]): Lesson[] => {
  const byKey = new Map<string, AgendaEvent>()
  for (const event of events || []) if (isLesson(event)) byKey.set(`${event.id}|${event.start}`, event)
  const lessons: Lesson[] = []
  for (const event of byKey.values()) {
    const day = statsDay(event.start)
    if (day) lessons.push({ event, day, clock: schulnetzClock(event.start), cancelled: cancelledEvent(event), key: lessonKeyOf(event) })
  }
  return lessons
}

const endClock = (lesson: Lesson) => schulnetzClock(lesson.event.end) || lesson.clock || '23:59'

const courseTitles = (lessons: Lesson[]) => {
  const titles = new Map<string, string>()
  const latest = new Map<string, Lesson>()
  for (const lesson of lessons) {
    const current = latest.get(lesson.key)
    // The most recent lesson names the course; on a tie the later one in the list wins.
    if (!current || lesson.event.start >= current.event.start) latest.set(lesson.key, lesson)
  }
  for (const [key, lesson] of latest) titles.set(key, preferredEventTitle(lesson.event))
  return titles
}

const teacherLabels = (lessons: Lesson[], keyOf: (lesson: Lesson) => string = (lesson) => lesson.key) => {
  const byKey = new Map<string, string[]>()
  for (const lesson of lessons) {
    const key = keyOf(lesson)
    if (lesson.cancelled || !key) continue
    const label = teachersOf(lesson.event)
    if (label) byKey.set(key, [...(byKey.get(key) || []), label])
  }
  const labels = new Map<string, string>()
  for (const [key, values] of byKey) labels.set(key, mostCommon(values))
  return labels
}

const counts = (): LessonCounts => ({ total: 0, cancelled: 0, substituted: 0, moved: 0, changed: 0, added: 0, rate: 0 })
const countLesson = (target: LessonCounts, lesson: Lesson) => {
  const substituted = isSubstitution(lesson.event) && !lesson.cancelled
  target.total++
  if (lesson.cancelled) target.cancelled++
  if (substituted) target.substituted++
  if (lesson.event.marker === 'moved') target.moved++
  if (lesson.event.marker === 'changed') target.changed++
  if (lesson.event.marker === 'added') target.added++
  target.rate = target.cancelled / target.total
}

const cancellationStats = (lessons: Lesson[], now: Date): CancellationStats => {
  const nowStamp = `${zurichToday(now)}T${zurichClock(now)}`
  const past = lessons.filter((lesson) => `${lesson.day}T${endClock(lesson)}` < nowStamp)
  const totals = counts()
  const perCourse = new Map<string, LessonCounts>()
  const weekdayTotals = Array.from({ length: 8 }, () => 0)
  const weekdayCancelled = Array.from({ length: 8 }, () => 0)
  const clockCounts = new Map<string, [number, number]>()
  for (const lesson of past) {
    countLesson(totals, lesson)
    if (!perCourse.has(lesson.key)) perCourse.set(lesson.key, counts())
    countLesson(perCourse.get(lesson.key)!, lesson)
    const weekday = weekdayOf(lesson.day)
    weekdayTotals[weekday]++
    if (lesson.cancelled) weekdayCancelled[weekday]++
    if (lesson.clock) {
      const slot = clockCounts.get(lesson.clock) || [0, 0]
      slot[0]++
      if (lesson.cancelled) slot[1]++
      clockCounts.set(lesson.clock, slot)
    }
  }
  const titles = courseTitles(past)
  const teachers = teacherLabels(past)
  const courses: CourseCancellations[] = [...perCourse.entries()].map(([key, value]) => ({ key, title: titles.get(key) || '', teacher: teachers.get(key) || '', ...value }))
  courses.sort((a, b) => (b.cancelled * a.total - a.cancelled * b.total) || (b.cancelled - a.cancelled) || cmp(a.title, b.title) || cmp(a.key, b.key))
  const weekdays: WeekdayCount[] = []
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (weekday <= 5 || weekdayTotals[weekday] > 0) weekdays.push({ weekday, total: weekdayTotals[weekday], cancelled: weekdayCancelled[weekday] })
  }
  const clocks: ClockCount[] = [...clockCounts.entries()].sort((a, b) => cmp(a[0], b[0])).map(([clock, [total, cancelled]]) => ({ clock, total, cancelled }))
  const days = past.map((lesson) => lesson.day).sort(cmp)
  const coverage: StatsCoverage = days.length
    ? { firstDay: days[0], lastDay: days[days.length - 1], weeks: new Set(days.map((day) => weekMonday(day))).size }
    : { firstDay: '', lastDay: '', weeks: 0 }
  const recent = past.filter((lesson) => lesson.cancelled)
    .sort((a, b) => cmp(`${b.day}T${b.clock}`, `${a.day}T${a.clock}`) || cmp(b.event.id, a.event.id))
    .slice(0, STATS_RECENT)
    .map((lesson) => ({ day: lesson.day, title: preferredEventTitle(lesson.event), clock: lesson.clock }))
  return { totals, courses, weekdays, clocks, coverage, recent }
}

const gradeKey = (courseId: string, course: string, fallback: string) => identityKey(courseId) || identityKey(course) || fallback
const trackCourseKey = (track: GradeTrack) => track.courseId || track.course
const gradeCourseKey = (grade: SchoolGrade) => grade.courseId || grade.course || grade.subject || ''
const trackKey = (track: GradeTrack) => gradeKey(track.courseId, track.course, trackCourseKey(track))

const courseTitleOf = (track: GradeTrack, grades: SchoolGrade[], key: string) => {
  const grade = grades.find((item) => gradeKey(item.courseId, item.course, gradeCourseKey(item)) === key)
  return cleanSchulnetzText(grade ? courseLabel(grade) : track.course || track.courseId)
}

const instantOf = (raw: string): number | null => {
  const time = Date.parse(raw || '')
  return Number.isFinite(time) ? time : null
}

const zurichDay = (time: number) => zurichToday(new Date(time))

interface Graded { track: GradeTrack; key: string; testDay: string; delay: number; first: number }

const gradingStats = (snapshot: Snapshot, lessons: Lesson[]): GradingStats => {
  // A course the timetable names without a group part is found by its course id.
  const teachers = teacherLabels(lessons)
  const teachersById = teacherLabels(lessons, (lesson) => cleanSchulnetzText(lesson.event.courseId))
  const history = snapshot.gradeHistory || []
  const times = history.map((track) => instantOf(track.firstSeenAt))
  const known = times.filter((time): time is number => time !== null)
  const seed = known.length ? Math.min(...known) : null
  const grades = (snapshot.grades || []).filter((grade) => !isSummaryGrade(grade))
  const graded: Graded[] = []
  history.forEach((track, index) => {
    const first = times[index]
    if (track.removedAt || first === null || first === seed) return
    const testDay = statsDay(track.date)
    if (!testDay) return
    const delay = daysBetween(testDay, zurichDay(first))
    if (delay < 0 || delay > STATS_MAX_DELAY_DAYS) return
    graded.push({ track, key: trackKey(track), testDay, delay, first })
  })
  const byKey = new Map<string, Graded[]>()
  for (const item of graded) byKey.set(item.key, [...(byKey.get(item.key) || []), item])
  const courses: CourseGrading[] = [...byKey.entries()].map(([key, items]) => {
    const delays = items.map((item) => item.delay).sort((a, b) => a - b)
    return {
      key, title: courseTitleOf(items[0].track, grades, key), teacher: teachers.get(key) || teachersById.get(cleanSchulnetzText(items[0].track.courseId)) || '', count: delays.length,
      median: median(delays), mean: round1(delays.reduce((sum, value) => sum + value, 0) / delays.length),
      fastest: delays[0], slowest: delays[delays.length - 1],
    }
  })
  courses.sort((a, b) => (a.median - b.median) || cmp(a.title, b.title) || cmp(a.key, b.key))
  const all = graded.map((item) => item.delay).sort((a, b) => a - b)
  const titleOf = new Map(courses.map((course) => [course.key, course.title]))
  const recent = [...graded]
    .sort((a, b) => cmp(b.track.firstSeenAt, a.track.firstSeenAt) || cmp(b.track.id, a.track.id))
    .slice(0, STATS_RECENT)
    .map((item) => ({ title: cleanSchulnetzText(item.track.title), course: titleOf.get(item.key) || '', testDay: item.testDay, delay: item.delay }))
  return {
    count: all.length,
    median: all.length ? median(all) : null,
    mean: all.length ? round1(all.reduce((sum, value) => sum + value, 0) / all.length) : null,
    courses, recent,
  }
}

interface ExamDay { exam: AgendaEvent; day: string }

const examDays = (exams: AgendaEvent[]): ExamDay[] => {
  const byKey = new Map<string, AgendaEvent>()
  for (const exam of exams || []) if (!cancelledEvent(exam)) byKey.set(`${exam.id}|${exam.start}`, exam)
  const out: ExamDay[] = []
  for (const exam of byKey.values()) {
    const day = statsDay(exam.start)
    if (day) out.push({ exam, day })
  }
  return out
}

const examIdentity = (exam: AgendaEvent) => identityKey(exam.courseName) || identityKey(exam.text) || identityKey(exam.timetableText)

const waitingExams = (snapshot: Snapshot, titles: Map<string, string>, today: string): WaitingExam[] => {
  interface Dated { identity: string; names: Set<string>; day: string }
  const nameSet = (values: string[]) => new Set(values.map((value) => cleanSchulnetzText(value).toLowerCase()).filter(Boolean))
  const dated: Dated[] = []
  for (const grade of (snapshot.grades || []).filter((item) => !isSummaryGrade(item))) {
    const day = statsDay(grade.date)
    if (day) dated.push({ identity: gradeKey(grade.courseId, grade.course, ''), names: nameSet([grade.subject, grade.course, grade.courseId]), day })
  }
  for (const track of snapshot.gradeHistory || []) {
    if (track.removedAt) continue
    const day = statsDay(track.date)
    if (day) dated.push({ identity: gradeKey(track.courseId, track.course, ''), names: nameSet([track.course, track.courseId]), day })
  }
  const out: WaitingExam[] = []
  for (const { exam, day } of examDays(snapshot.exams)) {
    const waited = daysBetween(day, today)
    if (waited <= 0 || waited > STATS_WAITING_MAX_DAYS) continue
    const identity = examIdentity(exam)
    const name = cleanSchulnetzText(exam.courseName).toLowerCase()
    if (!identity && !name) continue
    const graded = dated.some((entry) => (identity ? entry.identity === identity : entry.names.has(name)) &&
      Math.abs(daysBetween(day, entry.day)) <= STATS_MATCH_DAYS)
    if (graded) continue
    const label = eventLabelOf(exam)
    const title = cleanSchulnetzText(exam.text) || cleanSchulnetzText(exam.timetableText) || label
    const course = (identity ? titles.get(identity) : '') || cleanSchulnetzText(exam.courseName) || label
    out.push({ title, course, examDay: day, daysWaiting: waited })
  }
  return out.sort((a, b) => (b.daysWaiting - a.daysWaiting) || cmp(a.title, b.title) || cmp(a.course, b.course))
}

const gradeChanges = (snapshot: Snapshot): GradeChangeStats => {
  const grades = (snapshot.grades || []).filter((grade) => !isSummaryGrade(grade))
  const changed = (snapshot.gradeHistory || []).filter((track) =>
    !track.removedAt && new Set(track.versions.map((version) => version.mark).filter((mark): mark is number => mark !== null && mark !== undefined)).size >= 2)
    .sort((a, b) => cmp(b.firstSeenAt, a.firstSeenAt) || cmp(b.id, a.id))
  const items = changed.map((track) => {
    const first = instantOf(track.firstSeenAt)
    return { title: cleanSchulnetzText(track.title), course: courseTitleOf(track, grades, trackKey(track)), firstSeenDay: first === null ? '' : zurichDay(first), versions: track.versions.length }
  })
  return { count: items.length, items }
}

const examLoad = (snapshot: Snapshot, today: string): ExamLoad => {
  const days = examDays(snapshot.exams).map((item) => item.day)
  const perWeek = new Map<string, number>()
  for (const day of days) perWeek.set(weekMonday(day), (perWeek.get(weekMonday(day)) || 0) + 1)
  const weeks = [...perWeek.entries()].sort((a, b) => cmp(a[0], b[0])).map(([monday, count]) => ({ monday, count }))
  // Weeks are in date order and only a larger count replaces the best, so the earliest week wins a tie.
  let busiest: ExamWeek = { monday: '', count: 0 }
  for (const week of weeks) if (week.count > busiest.count) busiest = week
  const limit = addDays(today, STATS_EXAM_AHEAD_DAYS)
  return { weeks, busiestMonday: busiest.monday, busiestCount: busiest.count, next28: days.filter((day) => day >= today && day < limit).length }
}

const absenceStats = (snapshot: Snapshot): AbsenceSubject[] => {
  const bySubject = new Map<string, { count: number; excused: number }>()
  for (const absence of snapshot.absences || []) {
    const subject = cleanSchulnetzText(absence.subject)
    const entry = bySubject.get(subject) || { count: 0, excused: 0 }
    entry.count++
    if (absence.excused) entry.excused++
    bySubject.set(subject, entry)
  }
  return [...bySubject.entries()].map(([subject, entry]) => ({ subject, ...entry })).sort((a, b) => (b.count - a.count) || cmp(a.subject, b.subject))
}

/** Every statistic the Statistik view shows, as of `now`. Pure: the same snapshot gives the same numbers. */
export const schoolStats = (snapshot: Snapshot, now: Date = new Date()): SchoolStats => {
  const today = zurichToday(now)
  const lessons = dedupedLessons(snapshot.events)
  return {
    cancellations: cancellationStats(lessons, now),
    grading: gradingStats(snapshot, lessons),
    waiting: waitingExams(snapshot, courseTitles(lessons), today),
    gradeChanges: gradeChanges(snapshot),
    examLoad: examLoad(snapshot, today),
    absences: absenceStats(snapshot),
  }
}
