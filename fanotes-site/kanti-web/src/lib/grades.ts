// The app's courseSummaries (GradeMath.kt) on the server's grade rows, with the server's own grade
// math (weightedAverage, roundToHalf, promotionPoints, wunschnote from schulnetz-logic.mjs).
// Own and collective marks live only in the app, so the browser sums the school's marks.
import {
  cleanSchulnetzText, gradeTargetId, isSportCourse, isSummaryGrade, looksLikeCourseCode, promotionPoints, roundToHalf, weightedAverage, wunschnote,
} from '@shared/schulnetz-logic'
import type { SchoolGrade } from '../types'
import { emptyGradeBook, normalizeGradeBook, type CollectivePart, type GradeBook, type HypotheticalGrade } from '../vault/files'

export interface CourseMark {
  grade: SchoolGrade
  mark: number | null
  weight: number
  counted: boolean
  hidden: boolean
  /** The student's own mark, collective grade or what-if mark (never a school mark). */
  own?: boolean
  collective?: boolean
  /** A what-if mark: only counted in the scenario of a subject page. */
  hypothetical?: boolean
  /** The student changed this school mark's value or weight (the school's stay in displayMark / displayWeight). */
  adjusted?: boolean
  excluded?: boolean
  displayMark?: number | null
  displayWeight?: number
  /** The id of the own mark in the vault files; `targetId` is the school mark's id for adjustments. */
  sourceId?: string
  targetId?: string
}

/** What the browser adds from the signed-in account's vault (see vault/files.ts). */
export interface OwnGrades {
  book?: GradeBook
  hypothetical?: HypotheticalGrade[]
}

export interface CourseSummary {
  key: string
  label: string
  average: number | null
  zeugnis: number | null
  pluspunkte: number
  promotion: boolean
  sport: boolean
  weight: number
  marks: CourseMark[]
  hidden: number
  latest: string
  /** Archived by the student: left out of the overall average and the promotion points. */
  archived: boolean
}

export const courseKey = (grade: SchoolGrade) => grade.courseId || grade.course || grade.subject || ''

/** The app's preferredSubjectTitle / displayCourseLabel. */
export const courseLabel = (grade: SchoolGrade) => {
  const token = cleanSchulnetzText(grade.course || grade.courseId)
  const name = cleanSchulnetzText(grade.subject)
  const fallback = grade.course || grade.subject || grade.courseId
  if (!name || name.toLowerCase() === token.toLowerCase()) return fallback
  if (!token) return name
  if (looksLikeCourseCode(token) && !looksLikeCourseCode(name)) {
    const words = name.split(/[\s,/]+/u).map((word) => word.replace(/^\(|\)$/gu, ''))
    if (words.some((word) => word.toLowerCase() === token.toLowerCase())) return name
    return `${name} (${token})`
  }
  return token || fallback
}

/** Weighted average of the partial tests (at least two). Core: collectiveValue. */
export const collectiveValue = (parts: CollectivePart[]): number | null =>
  parts.length < 2 ? null : weightedAverage(parts.map((part) => ({ mark: part.mark, weight: part.weight })))

const ownRow = (id: string, courseId: string, title: string, date: string): SchoolGrade => ({ id, course: courseId, courseId, subject: title, title, date, mark: null, weight: 1 })

/**
 * The app's courseSummaries (GradeMath.kt): the school's marks with the student's adjustments, plus the
 * student's own marks and collective grades; what-if marks only when `own.hypothetical` is given.
 */
export const courseSummaries = (grades: SchoolGrade[], own: OwnGrades = {}): CourseSummary[] => {
  const book = normalizeGradeBook(own.book || emptyGradeBook())
  const adjustments = new Map(book.adjustments.map((adjustment) => [adjustment.targetId, adjustment]))
  const archived = new Set(book.archivedCourseIds)
  const groups = new Map<string, CourseMark[]>()
  const labels = new Map<string, string>()
  const push = (key: string, mark: CourseMark) => groups.set(key, [...(groups.get(key) || []), mark])
  for (const grade of grades || []) {
    if (isSummaryGrade(grade)) continue
    const key = courseKey(grade)
    if (!key) continue
    if (!labels.has(key)) labels.set(key, courseLabel(grade))
    const hidden = grade.hidden === true
    if (grade.mark == null && !hidden) {
      // A row still waiting for its mark is listed, never counted.
      push(key, { grade, mark: null, weight: grade.weight, counted: false, hidden: false, targetId: grade.targetId || gradeTargetId(grade) })
      continue
    }
    const targetId = grade.targetId || gradeTargetId(grade)
    const adjustment = adjustments.get(targetId)
    const excluded = adjustment?.excluded === true
    const markOverride = adjustment?.mark ?? null
    const weightOverride = adjustment?.weight ?? null
    push(key, {
      grade,
      mark: hidden ? grade.mark : markOverride ?? grade.mark,
      weight: weightOverride ?? grade.weight,
      counted: !hidden && !excluded && grade.mark != null,
      hidden,
      targetId,
      displayMark: grade.mark,
      displayWeight: grade.weight,
      adjusted: !excluded && (markOverride != null || weightOverride != null),
      excluded,
    })
  }
  for (const extra of own.hypothetical || []) {
    if (!Number.isFinite(extra.mark) || !(extra.weight > 0) || !extra.courseId) continue
    if (!labels.has(extra.courseId)) labels.set(extra.courseId, extra.courseId)
    push(extra.courseId, { grade: { ...ownRow(extra.id, extra.courseId, extra.title || 'Eigene Note', ''), mark: extra.mark, weight: extra.weight }, mark: extra.mark, weight: extra.weight, counted: true, hidden: false, own: true, hypothetical: true, sourceId: extra.id })
  }
  for (const extra of book.own) {
    if (!labels.has(extra.courseId)) labels.set(extra.courseId, extra.courseId)
    push(extra.courseId, { grade: { ...ownRow(extra.id, extra.courseId, extra.title || 'Own mark', extra.date), mark: extra.mark, weight: extra.weight }, mark: extra.mark, weight: extra.weight, counted: true, hidden: false, own: true, sourceId: extra.id })
  }
  for (const extra of book.collective) {
    const value = collectiveValue(extra.parts)
    if (value == null) continue
    if (!labels.has(extra.courseId)) labels.set(extra.courseId, extra.courseId)
    push(extra.courseId, { grade: { ...ownRow(extra.id, extra.courseId, extra.title || 'Collective grade', extra.date), mark: value, weight: extra.weight }, mark: value, weight: extra.weight, counted: true, hidden: false, own: true, collective: true, sourceId: extra.id })
  }
  return [...groups.entries()].map(([key, marks]) => {
    const label = labels.get(key) || key
    const counted = marks.filter((mark) => mark.counted && mark.weight > 0 && mark.mark != null && Number.isFinite(mark.mark))
    const average = weightedAverage(counted.map((mark) => ({ mark: mark.mark as number, weight: mark.weight })))
    const sport = isSportCourse(label)
    const zeugnis = average == null ? null : roundToHalf(average)
    const promotion = zeugnis != null && !sport
    return {
      key,
      label,
      average,
      zeugnis,
      pluspunkte: promotion ? promotionPoints(zeugnis) ?? 0 : 0,
      promotion,
      sport,
      weight: counted.reduce((sum, mark) => sum + mark.weight, 0),
      marks: [...marks].sort((left, right) => (right.grade.date || '').localeCompare(left.grade.date || '')),
      hidden: marks.filter((mark) => mark.hidden).length,
      latest: marks.reduce((latest, mark) => ((mark.grade.date || '') > latest ? mark.grade.date || '' : latest), ''),
      archived: archived.has(key),
    }
  }).sort((left, right) => left.label.toLowerCase().localeCompare(right.label.toLowerCase()))
}

export const activeCourses = (courses: CourseSummary[]): CourseSummary[] => courses.filter((course) => !course.archived)

export const promotionTotals = (courses: CourseSummary[]) => {
  const counted = courses.filter((course) => course.promotion)
  const plus = counted.reduce((sum, course) => sum + Math.max(0, course.pluspunkte), 0)
  const minus = counted.reduce((sum, course) => sum + Math.min(0, course.pluspunkte), 0)
  return { plus, minus, total: plus + minus }
}

export const overallAverage = (courses: CourseSummary[]) =>
  weightedAverage(courses.flatMap((course) => course.marks.filter((mark) => mark.counted && mark.mark != null).map((mark) => ({ mark: mark.mark as number, weight: mark.weight }))))

export const wishFor = (course: CourseSummary, target: number, nextWeight: number) =>
  wunschnote(course.marks.filter((mark) => mark.counted && mark.mark != null).map((mark) => ({ mark: mark.mark as number, weight: mark.weight })), target, nextWeight)

export const latestGrades = (grades: SchoolGrade[], count = 5) =>
  (grades || []).filter((grade) => !isSummaryGrade(grade) && (grade.mark != null || grade.hidden)).sort((left, right) => (right.date || '').localeCompare(left.date || '')).slice(0, count)

export const plusLabel = (value: number) => {
  const rounded = Math.round(value * 100) / 100
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded).toString()}`
}

export const markTone = (mark: number | null | undefined): 'good' | 'pass' | 'fail' | 'none' => {
  if (mark == null || !Number.isFinite(mark)) return 'none'
  if (mark >= 5) return 'good'
  if (mark >= 4) return 'pass'
  return 'fail'
}
