import type { Strings } from '../lib/i18n'
import { teacherAbsenceLine } from '../lib/teacher-absences'
import type { TeacherAbsenceDay } from '../types'
import { Card } from './ui'

/** One compact row: the teachers the school start page lists as absent or on an excursion today. */
export const TeacherAbsenceCard = ({ absences, t }: { absences: TeacherAbsenceDay; t: Strings }) => {
  const line = teacherAbsenceLine(absences, t.teacherOnExcursion)
  return (
    <Card className="teacher-absences" aria-label={t.teacherAbsences}>
      <p className="teacher-absences-label">{t.teacherAbsences}</p>
      <p className={line ? 'teacher-absences-line' : 'teacher-absences-line muted'}>{line || t.teacherAbsencesNone}</p>
    </Card>
  )
}
