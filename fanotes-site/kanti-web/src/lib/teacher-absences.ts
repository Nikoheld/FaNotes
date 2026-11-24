// The "Abwesende Lehrpersonen" card on Today (the app's TeacherAbsenceCard).
import type { Snapshot, TeacherAbsenceDay } from '../types'

/** The stored read when it is from today and in its known shape; null hides the card. */
export const teacherAbsencesToday = (snapshot: Snapshot | null, today: string): TeacherAbsenceDay | null => {
  const read = snapshot?.teacherAbsences
  if (!read || read.day !== today) return null
  return { day: read.day, absent: Array.isArray(read.absent) ? read.absent : [], excursion: Array.isArray(read.excursion) ? read.excursion : [] }
}

/** The one line the card shows: absent names, then the excursion names after a separator. Empty when nobody is listed. */
export const teacherAbsenceLine = (absences: TeacherAbsenceDay, excursionLabel: (names: string) => string): string =>
  [absences.absent.length ? absences.absent.join(', ') : '', absences.excursion.length ? excursionLabel(absences.excursion.join(', ')) : ''].filter(Boolean).join('  ·  ')
