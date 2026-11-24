// School assignments (snapshot.homework) for the agenda and Today. Read-only: the app's "copy into my
// tasks" needs the private vault, which the browser does not have.
import type { SchoolHomework } from '../types'

/** The due day as YYYY-MM-DD, from an ISO date or the Swiss d.m.yyyy form; '' when there is none. */
export const homeworkDay = (raw: string): string => {
  const text = (raw || '').trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(text)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const swiss = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u.exec(text)
  return swiss ? `${swiss[3]}-${swiss[2].padStart(2, '0')}-${swiss[1].padStart(2, '0')}` : ''
}

export interface HomeworkItem extends SchoolHomework { day: string }

const byDue = (left: HomeworkItem, right: HomeworkItem) => (left.day || '9999').localeCompare(right.day || '9999') || left.title.localeCompare(right.title)

/** Assignments due today or later (undated ones count as open), soonest first; with `past` those due before today, latest first. */
export const homeworkList = (homework: SchoolHomework[] | undefined, today: string, past = false): HomeworkItem[] => {
  const items = (homework || []).map((item) => ({ ...item, day: homeworkDay(item.dueDate) })).filter((item) => item.title.trim())
  const shown = items.filter((item) => (past ? item.day !== '' && item.day < today : item.day === '' || item.day >= today)).sort(byDue)
  return past ? shown.reverse() : shown
}

/** Dated assignments due from today until `horizon` (inclusive), for Today's "coming up" list. */
export const homeworkDue = (homework: SchoolHomework[] | undefined, today: string, horizon: string): HomeworkItem[] =>
  homeworkList(homework, today).filter((item) => item.day !== '' && item.day <= horizon)
