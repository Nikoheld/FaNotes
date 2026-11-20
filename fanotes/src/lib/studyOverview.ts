import type { PageStats } from './pageStats'

export type StudyNoteInput = {
  path: string
  stats: Pick<PageStats, 'dwellMs' | 'focusMs' | 'dwellByWeekday' | 'typing' | 'ink'>
}

export type StudySubjectRow = {
  subject: string
  notes: number
  dwellMs: number
  typingMs: number
  inkMs: number
  inkMm: number
}

export type StudyOverview = {
  notes: number
  dwellMs: number
  typingMs: number
  inkMs: number
  inkMm: number
  /** Sunday-first, matching `PageStats.dwellByWeekday`. */
  dwellByWeekday: number[]
  subjects: StudySubjectRow[]
}

const subjectOf = (path: string) => {
  const slash = path.indexOf('/')
  return slash > 0 ? path.slice(0, slash) : 'Eingang'
}

const emptyWeek = () => [0, 0, 0, 0, 0, 0, 0]

/** Local study picture from quiet per-note statistics. Nothing is uploaded. */
export const aggregateStudy = (notes: StudyNoteInput[]): StudyOverview => {
  const dwellByWeekday = emptyWeek()
  const subjects = new Map<string, StudySubjectRow>()
  let dwellMs = 0
  let typingMs = 0
  let inkMs = 0
  let inkMm = 0
  for (const note of notes) {
    const dwell = Math.max(0, note.stats.dwellMs || 0)
    const typing = Math.max(0, note.stats.typing?.ms || 0)
    const ink = Math.max(0, note.stats.ink?.ms || 0)
    const length = Math.max(0, note.stats.ink?.lengthMm || 0)
    dwellMs += dwell
    typingMs += typing
    inkMs += ink
    inkMm += length
    const week = note.stats.dwellByWeekday ?? []
    for (let day = 0; day < 7; day += 1) dwellByWeekday[day] += Math.max(0, week[day] || 0)
    const name = subjectOf(note.path)
    const row = subjects.get(name) ?? { subject: name, notes: 0, dwellMs: 0, typingMs: 0, inkMs: 0, inkMm: 0 }
    row.notes += 1
    row.dwellMs += dwell
    row.typingMs += typing
    row.inkMs += ink
    row.inkMm += length
    subjects.set(name, row)
  }
  return {
    notes: notes.length,
    dwellMs,
    typingMs,
    inkMs,
    inkMm,
    dwellByWeekday,
    subjects: [...subjects.values()].sort((left, right) => right.dwellMs - left.dwellMs || left.subject.localeCompare(right.subject, 'de')),
  }
}

export const formatStudyDuration = (ms: number) => {
  const minutes = Math.round(Math.max(0, ms) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}
