// The grade version history the server sends (gradeHistory). Removed grades never reach the
// averages: they are not in the grade list, only in the history.
import type { GradeTrack, SchoolGrade } from '../types'
import type { Language } from './i18n'

/** The history of a grade that is still listed, when it has more than one version. */
export const changedTrack = (history: GradeTrack[] | undefined, grade: SchoolGrade): GradeTrack | null => {
  const track = (history || []).find((item) => !item.removedAt && item.gradeId === grade.id)
  return track && track.versions.length > 1 ? track : null
}

/** Grades of one subject that Schulnetz no longer lists, the most recently removed first. */
export const removedTracks = (history: GradeTrack[] | undefined, key: string): GradeTrack[] =>
  (history || [])
    .filter((track) => track.removedAt && (track.courseId || track.course) === key)
    .sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt)))

export const lastVersion = (track: GradeTrack) => track.versions[track.versions.length - 1]

/** Local date and time of a moment the server saw something (Zurich time). */
export const seenLabel = (iso: string, language: Language) => {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(language === 'de' ? 'de-CH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(time))
}
