import { useMemo, useState } from 'react'
import { byDay, daysBetween, isRunning, nextCommitment, clockMinutes, type Entry } from '../lib/agenda'
import { activeCourses, courseSummaries, latestGrades, overallAverage, plusLabel, promotionTotals } from '../lib/grades'
import { useEntries } from '../vault/entries'
import { useProvisional } from '../vault/planned'
import { useVault } from '../vault/store'
import { TasksCard } from '../vault/ui'
import { dateLabel, markLabel, pointsLabel } from '../lib/i18n'
import { pickMensaDay } from '../lib/mensa'
import { useMensa } from '../lib/useMensa'
import { homeworkDue, type HomeworkItem } from '../lib/homework'
import { teacherAbsencesToday } from '../lib/teacher-absences'
import { TeacherAbsenceCard } from '../components/TeacherAbsenceCard'
import { MensaCard } from '../components/MensaCard'
import { CommuteCard } from '../components/CommuteCard'
import { useKanti } from '../state'
import { Banner, Card, DayBand, Dialog, Empty, Icon, RoomPill, SectionLabel, Snowfall } from '../components/ui'
import { EntryDetails, EntryRow, EntryTags, HomeworkDetails, HomeworkRow, MarkBadge, relativeDay, useClock } from './common'
import { addDays, eventDate } from '@shared/schulnetz-logic'

export const Today = () => {
  const kanti = useKanti()
  const { t, language, data, prefs } = kanti
  const clock = useClock()
  const snapshot = data.snapshot
  const entries = useEntries()
  const { own } = useVault()
  const days = useMemo(() => byDay(entries), [entries])
  const next = nextCommitment(entries, clock)
  const [selected, setSelected] = useState<Entry | null>(null)
  const [homeworkOpen, setHomeworkOpen] = useState<HomeworkItem | null>(null)
  const mensa = useMensa(prefs.showMensa)
  const mensaDay = prefs.showMensa && mensa.feed ? pickMensaDay(mensa.feed.days, new Date()) : null
  const teachers = prefs.showTeacherAbsences ? teacherAbsencesToday(snapshot, clock.today) : null
  const homework = useMemo(() => homeworkDue(snapshot?.homework, clock.today, addDays(clock.today, 14)).slice(0, 4), [snapshot, clock.today])
  const todays = days.get(clock.today) || []
  const courses = useMemo(() => activeCourses(courseSummaries(snapshot?.grades || [], { book: own.book })), [snapshot, own.book])
  const totals = promotionTotals(courses)
  const recent = latestGrades(snapshot?.grades || [], 5)
  const exams = entries.filter((entry) => entry.kind === 'exam' && !entry.cancelled && entry.key !== next?.key && (entry.day > clock.today || (entry.day === clock.today && (clockMinutes(entry.end) ?? 1440) > clock.minutes))).slice(0, 4)
  const appointments = entries.filter((entry) => entry.kind === 'appointment' && entry.day >= clock.today && entry.day <= addDays(clock.today, 21)).slice(0, 3)
  const excuses = (snapshot?.absences || []).filter((absence) => !absence.excused && absence.excuseUntil && (eventDate(absence.excuseUntil) || absence.excuseUntil) >= clock.today)
  const absencePoints = useProvisional(clock.today).tally
  const snow = prefs.theme === 'snow' && prefs.snowfall
  const running = next ? isRunning(next, clock) : false
  const dayLessons = next ? (days.get(next.day) || []).filter((entry) => entry.kind === 'lesson' && entry.start) : []

  const heroLabel = !next ? '' : running ? t.now : next.day === clock.today ? t.upNext : relativeDay(next.day, clock.today, t, language)
  const start = next ? clockMinutes(next.start) : null
  const end = next ? clockMinutes(next.end) : null
  // What follows the hero lesson on the same day, and the next exam for the figures beside it.
  const after = next ? dayLessons.filter((entry) => !entry.cancelled && entry.start > (next.start || '')).slice(0, 3) : []
  const nextExam = entries.find((entry) => entry.kind === 'exam' && !entry.cancelled && (entry.day > clock.today || (entry.day === clock.today && (clockMinutes(entry.end) ?? 1440) > clock.minutes))) || null
  const examDays = nextExam ? daysBetween(clock.today, nextExam.day) : 0
  const average = overallAverage(courses)
  const pointsShare = absencePoints.quota ? Math.max(0, Math.min(1, (absencePoints.booked + absencePoints.estimated) / absencePoints.quota)) : 0
  const countdown = !next ? '' : running && end != null ? t.endsIn(end - clock.minutes) : next.day === clock.today && start != null && start > clock.minutes ? t.startsIn(start - clock.minutes) : ''

  return (
    <div className="view view-today">
      <div className="dash">
        {next ? (
          <Card className={`hero dash-hero${snow ? ' hero-snow' : ''}`} onClick={() => setSelected(next)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(next) }}>
            {snow ? <Snowfall /> : null}
            <div className="hero-head">
              {running ? <span className="pulse" aria-hidden="true" /> : null}
              <span className="hero-label">{heroLabel}</span>
              <span className="hero-countdown">{countdown}</span>
            </div>
            <div className="hero-time-row">
              <span className="hero-time tabular">{next.start || t.allDay}</span>
              <div className="hero-what">
                <h2 className={`hero-title${next.cancelled ? ' struck' : ''}`}>{next.title}</h2>
                <p className="hero-meta">{[next.end && next.end !== next.start ? t.until(next.end) : '', next.teachers.join(', '), next.kind === 'exam' ? t.exam : next.kind === 'appointment' ? t.appointment : ''].filter(Boolean).join('  ·  ')}</p>
              </div>
              {next.room ? <RoomPill room={next.room} label={t.room} /> : null}
            </div>
            <div className="details-tags"><EntryTags entry={next} t={t} detail /></div>
            <DayBand lessons={dayLessons} clock={next.day === clock.today ? clock.minutes : -1} focusKey={next.key} />
            {after.length ? (
              <p className="hero-after">
                <span className="hero-after-label">{t.thenLabel}</span>
                {after.map((entry) => <span key={entry.key} className="hero-after-item"><span className="tabular">{entry.start}</span> {entry.title}</span>)}
              </p>
            ) : null}
          </Card>
        ) : (
          <Card className="hero hero-clear dash-hero">
            <Icon name="today" size={28} />
            <h2>{t.roomToBreathe}</h2>
            <p>{t.nothingAhead}</p>
          </Card>
        )}

        <div className="dash-kpis">
          <button type="button" className="card kpi-tile" onClick={() => kanti.navigate('grades')}>
            <span className="kpi-label">{t.overall}</span>
            <span className="kpi-figure tabular">{average == null ? '–' : markLabel(Math.round(average * 100) / 100)}</span>
            <span className="kpi-sub">{t.subjects(courses.length)}</span>
          </button>
          <button type="button" className="card kpi-tile" onClick={() => kanti.navigate('grades')}>
            <span className="kpi-label">{t.pluspunkte}</span>
            <span className={`kpi-figure tabular ${totals.total >= 0 ? 'positive' : 'negative'}`}>{courses.length ? plusLabel(totals.total) : '–'}</span>
            <span className="kpi-sub tabular">{courses.length ? `${plusLabel(totals.plus)} / ${totals.minus === 0 ? '−0' : plusLabel(totals.minus)}` : ''}</span>
          </button>
          <button type="button" className={`card kpi-tile${absencePoints.estimated > 0 ? ' kpi-tile-open' : ''}`} title={t.absenceExplain} aria-label={absencePoints.quota != null && absencePoints.remaining != null ? `${t.absencePoints}: ${t.pointsLeft(pointsLabel(absencePoints.remaining, language), pointsLabel(absencePoints.quota, language))}` : undefined} onClick={() => kanti.navigate('absences')}>
            <span className="kpi-label">{t.absencePoints}</span>
            {absencePoints.quota != null && absencePoints.remaining != null ? (
              <>
                <span className={`kpi-figure tabular${absencePoints.remaining < 0 ? ' negative' : ''}`}>{pointsLabel(absencePoints.remaining, language)}<small>/ {pointsLabel(absencePoints.quota, language)}</small></span>
                <span className={`meter${absencePoints.remaining < 0 ? ' tone-danger' : absencePoints.estimated > 0 ? ' tone-warning' : ''}`} aria-hidden="true"><span style={{ width: `${Math.round(pointsShare * 100)}%` }} /></span>
                <span className="kpi-sub">{absencePoints.openReports ? t.openReports(absencePoints.openReports) : t.pointsSummary(pointsLabel(absencePoints.booked, language), '0')}</span>
              </>
            ) : (
              <>
                <span className="kpi-figure tabular">{pointsLabel(absencePoints.booked, language)}</span>
                <span className="kpi-sub">{t.pointsSummary(pointsLabel(absencePoints.booked, language), absencePoints.estimated > 0 ? `≈ ${absencePoints.estimated}` : '0')}</span>
              </>
            )}
          </button>
          <button type="button" className="card kpi-tile" onClick={() => (nextExam ? setSelected(nextExam) : kanti.navigate('agenda'))}>
            <span className="kpi-label">{t.nextExam}</span>
            <span className={`kpi-figure${nextExam && examDays <= 2 ? ' warning-text' : ''}`}>{nextExam ? relativeDay(nextExam.day, clock.today, t, language) : '–'}</span>
            <span className="kpi-sub kpi-sub-wrap">{nextExam ? nextExam.title : t.noExams}</span>
          </button>
        </div>

        {excuses.length ? (
          <div className="dash-wide">
            <Banner tone="warning" icon="warning" action={<button type="button" className="link" onClick={() => kanti.navigate('absences')}>{t.absences} <Icon name="right" size={16} /></button>}>
              <strong>{t.openExcuses}</strong>
              {excuses.map((absence) => <span key={absence.id}>{absence.subject} · {t.excuseUntil(dateLabel(eventDate(absence.excuseUntil || '') || absence.excuseUntil || '', language))}</span>)}
            </Banner>
          </div>
        ) : null}

        <div className="dash-col">
          <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('timetable')}>{t.timetable} <Icon name="right" size={16} /></button>}>
            {t.todayLessons}
          </SectionLabel>
          <Card className="list">
            {todays.length ? todays.map((entry) => (
              <EntryRow key={entry.key} entry={entry} t={t} language={language} today={clock.today} now={isRunning(entry, clock)} onOpen={() => setSelected(entry)} />
            )) : <Empty icon="today">{t.noLessonsToday}</Empty>}
          </Card>
          {teachers ? <TeacherAbsenceCard absences={teachers} t={t} /> : null}
          {mensaDay ? <MensaCard day={mensaDay} t={t} language={language} onWeek={() => kanti.navigate('mensa')} /> : null}
        </div>

        <div className="dash-col">
          <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('agenda')}>{t.agenda} <Icon name="right" size={16} /></button>}>{t.comingUp}</SectionLabel>
          <Card className="list">
            {exams.length || appointments.length || homework.length ? [
              ...[...exams, ...appointments].map((entry) => ({ day: entry.day, node: <EntryRow key={entry.key} entry={entry} t={t} language={language} today={clock.today} showDay onOpen={() => setSelected(entry)} /> })),
              ...homework.map((item) => ({ day: item.day, node: <HomeworkRow key={`hw:${item.id}`} item={item} t={t} language={language} today={clock.today} onOpen={() => setHomeworkOpen(item)} /> })),
            ].sort((a, b) => a.day.localeCompare(b.day)).map((row) => row.node) : <Empty icon="agenda">{t.noExams}</Empty>}
          </Card>

          {(snapshot?.messages?.length || snapshot?.startMessages?.length) ? (
            <>
              <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('updates')}>{t.updates} <Icon name="right" size={16} /></button>}>{t.fromSchool}</SectionLabel>
              <Card className="list">
                {(snapshot?.messages || []).slice(0, 3).map((message) => (
                  <button type="button" key={message.id} className="message-row" onClick={() => kanti.navigate('updates')}>
                    <span className="grade-title">{message.title}</span>
                    <small>{message.body.slice(0, 160)}</small>
                  </button>
                ))}
              </Card>
            </>
          ) : null}
          <TasksCard />
          {/* Closes the "Von der Schule" block; without it, the card follows "Demnächst". */}
          <CommuteCard />
        </div>

        <div className="dash-col">
          <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('grades')}>{t.grades} <Icon name="right" size={16} /></button>}>{t.latestGrades}</SectionLabel>
          <Card className="list">
            {recent.length ? recent.map((grade) => (
              <button type="button" key={grade.id} className="grade-row" onClick={() => kanti.navigate('grades', { fach: grade.courseId || grade.course })}>
                <span className="grade-main"><span className="grade-title">{grade.title || grade.subject}</span><small>{grade.subject || grade.course} · {dateLabel(grade.date, language)}</small></span>
                <MarkBadge mark={grade.mark} hidden={grade.hidden} t={t} />
              </button>
            )) : <Empty icon="grades">{t.noGrades}</Empty>}
          </Card>
        </div>
      </div>
      {homeworkOpen ? <Dialog title={homeworkOpen.title} onClose={() => setHomeworkOpen(null)}><HomeworkDetails item={homeworkOpen} t={t} language={language} /></Dialog> : null}
      {selected ? <Dialog title={selected.title} onClose={() => setSelected(null)}><EntryDetails entry={selected} t={t} language={language} onDone={() => setSelected(null)} /></Dialog> : null}
    </div>
  )
}
