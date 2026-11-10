// The app's courseSummaries (GradeMath.kt) on the server's grade rows, with the server's own grade
// math (weightedAverage, roundToHalf, promotionPoints, wunschnote from schulnetz-logic.mjs).
// Own and collective marks live only in the app, so the browser sums the school's marks.
import {
  cleanSchulnetzText, isSportCourse, isSummaryGrade, looksLikeCourseCode, promotionPoints, roundToHalf, weightedAverage, wunschnote,
} from '@shared/schulnetz-logic'
import type { SchoolGrade } from '../types'

export interface CourseMark {
  grade: SchoolGrade
  mark: number | null
  weight: number
  counted: boolean
  hidden: boolean
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

export const courseSummaries = (grades: SchoolGrade[]): CourseSummary[] => {
  const groups = new Map<string, CourseMark[]>()
  const labels = new Map<string, string>()
  for (const grade of grades || []) {
    if (isSummaryGrade(grade)) continue
    const key = courseKey(grade)
    if (!key) continue
    if (!labels.has(key)) labels.set(key, courseLabel(grade))
    const hidden = grade.hidden === true
    if (grade.mark == null && !hidden) {
      // A row still waiting for its mark is listed, never counted.
      groups.set(key, [...(groups.get(key) || []), { grade, mark: null, weight: grade.weight, counted: false, hidden: false }])
      continue
    }
    groups.set(key, [...(groups.get(key) || []), { grade, mark: grade.mark, weight: grade.weight, counted: !hidden && grade.mark != null, hidden }])
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
    }
  }).sort((left, right) => left.label.toLowerCase().localeCompare(right.label.toLowerCase()))
}

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
