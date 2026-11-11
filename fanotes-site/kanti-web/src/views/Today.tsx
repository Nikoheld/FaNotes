import { useEffect, useMemo, useState } from 'react'
import { allEntries, byDay, isRunning, nextCommitment, clockMinutes, type Entry } from '../lib/agenda'
import { courseSummaries, latestGrades, plusLabel, promotionTotals } from '../lib/grades'
import { dateLabel, pointsLabel } from '../lib/i18n'
import { toMensaFeed, pickMensaDay, type MensaFeed } from '../lib/mensa'
import { MensaCard } from '../components/MensaCard'
import { CommuteCard } from '../components/CommuteCard'
import { useKanti } from '../state'
import { Banner, Card, DayBand, Dialog, Empty, Icon, RoomPill, SectionLabel, Snowfall } from '../components/ui'
import { EntryDetails, EntryRow, EntryTags, MarkBadge, relativeDay, useClock } from './common'
import { absenceTally, addDays, eventDate } from '@shared/schulnetz-logic'

export const Today = () => {
  const kanti = useKanti()
  const { t, language, data, prefs } = kanti
  const clock = useClock()
  const snapshot = data.snapshot
  const entries = useMemo(() => allEntries(snapshot), [snapshot])
  const days = useMemo(() => byDay(entries), [entries])
  const next = nextCommitment(entries, clock)
  const [selected, setSelected] = useState<Entry | null>(null)
  const [mensa, setMensa] = useState<MensaFeed | null>(null)
  // The menu is public and cached by the server; the page asks again every few hours at most.
  useEffect(() => {
    if (!prefs.showMensa || kanti.demo) return undefined
    let alive = true
    const load = () => { kanti.api.mensa().then((body) => { if (alive) setMensa(toMensaFeed(body)) }, () => { /* unavailable: no card */ }) }
    load()
    const timer = window.setInterval(load, 3 * 3_600_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [prefs.showMensa, kanti.demo, kanti.api])
  const mensaDay = prefs.showMensa && mensa ? pickMensaDay(mensa.days, new Date()) : null
  const todays = days.get(clock.today) || []
  const courses = useMemo(() => courseSummaries(snapshot?.grades || []), [snapshot])
  const totals = promotionTotals(courses)
  const recent = latestGrades(snapshot?.grades || [], 5)
  const exams = entries.filter((entry) => entry.kind === 'exam' && !entry.cancelled && entry.key !== next?.key && (entry.day > clock.today || (entry.day === clock.today && (clockMinutes(entry.end) ?? 1440) > clock.minutes))).slice(0, 4)
  const appointments = entries.filter((entry) => entry.kind === 'appointment' && entry.day >= clock.today && entry.day <= addDays(clock.today, 21)).slice(0, 3)
  const excuses = (snapshot?.absences || []).filter((absence) => !absence.excused && absence.excuseUntil && (eventDate(absence.excuseUntil) || absence.excuseUntil) >= clock.today)
  const absencePoints = useMemo(() => absenceTally(snapshot), [snapshot])
  const snow = prefs.theme === 'snow' && prefs.snowfall
  const running = next ? isRunning(next, clock) : false
  const dayLessons = next ? (days.get(next.day) || []).filter((entry) => entry.kind === 'lesson' && entry.start) : []

  const heroLabel = !next ? '' : running ? t.now : next.day === clock.today ? t.upNext : relativeDay(next.day, clock.today, t, language)
  const start = next ? clockMinutes(next.start) : null
  const end = next ? clockMinutes(next.end) : null
  const countdown = !next ? '' : running && end != null ? t.endsIn(end - clock.minutes) : next.day === clock.today && start != null && start > clock.minutes ? t.startsIn(start - clock.minutes) : ''

  return (
    <div className="view view-today">
      <div className="columns">
        <div className="column column-main">
          {next ? (
            <Card className={`hero${snow ? ' hero-snow' : ''}`} onClick={() => setSelected(next)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(next) }}>
              {snow ? <Snowfall /> : null}
              <div className="hero-head">
                {running ? <span className="pulse" aria-hidden="true" /> : null}
                <span className="hero-label">{heroLabel}</span>
                <span className="hero-countdown">{countdown}</span>
              </div>
              <div className="hero-time-row">
                <span className="hero-time tabular">{next.start || t.allDay}</span>
                {next.room ? <RoomPill room={next.room} label={t.room} /> : null}
              </div>
              <h2 className={`hero-title${next.cancelled ? ' struck' : ''}`}>{next.title}</h2>
              <p className="hero-meta">{[next.end && next.end !== next.start ? t.until(next.end) : '', next.teachers.join(', '), next.kind === 'exam' ? t.exam : next.kind === 'appointment' ? t.appointment : ''].filter(Boolean).join('  ·  ')}</p>
              <div className="details-tags"><EntryTags entry={next} t={t} detail /></div>
              <DayBand lessons={dayLessons} clock={next.day === clock.today ? clock.minutes : -1} focusKey={next.key} />
            </Card>
          ) : (
            <Card className="hero hero-clear">
              <Icon name="today" size={28} />
              <h2>{t.roomToBreathe}</h2>
              <p>{t.nothingAhead}</p>
            </Card>
          )}

          <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('timetable')}>{t.timetable} <Icon name="right" size={16} /></button>}>
            {t.todayLessons} <small>{dateLabel(clock.today, language, { weekday: 'long', day: 'numeric', month: 'long' })}</small>
          </SectionLabel>
          <Card className="list">
            {todays.length ? todays.map((entry) => (
              <EntryRow key={entry.key} entry={entry} t={t} language={language} today={clock.today} now={isRunning(entry, clock)} onOpen={() => setSelected(entry)} />
            )) : <Empty icon="today">{t.noLessonsToday}</Empty>}
          </Card>
        </div>

        <aside className="column column-side">
          {excuses.length ? (
            <Banner tone="warning" icon="warning" action={<button type="button" className="link" onClick={() => kanti.navigate('absences')}>{t.absences}</button>}>
              <strong>{t.openExcuses}</strong>
              {excuses.map((absence) => <span key={absence.id}>{absence.subject} · {t.excuseUntil(dateLabel(eventDate(absence.excuseUntil || '') || absence.excuseUntil || '', language))}</span>)}
            </Banner>
          ) : null}

          {absencePoints.quota != null && absencePoints.remaining != null ? (
            <button type="button" className={`card points-card${absencePoints.estimated > 0 ? ' points-card-open' : ''}`} title={t.absenceExplain} onClick={() => kanti.navigate('absences')}>
              <span className="stat-label">{t.absencePoints}</span>
              <span className={`points-left tabular${absencePoints.remaining < 0 ? ' negative' : ''}`}>{t.pointsLeft(pointsLabel(absencePoints.remaining, language), pointsLabel(absencePoints.quota, language))}</span>
              <small className="muted">{t.pointsSummary(pointsLabel(absencePoints.booked, language), absencePoints.estimated > 0 ? `≈ ${absencePoints.estimated}` : '0')}{absencePoints.openReports ? ` · ${t.openReports(absencePoints.openReports)}` : ''}</small>
            </button>
          ) : null}

          <CommuteCard />

          {mensaDay ? <MensaCard day={mensaDay} t={t} language={language} /> : null}

          <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('agenda')}>{t.agenda} <Icon name="right" size={16} /></button>}>{t.comingUp}</SectionLabel>
          <Card className="list">
            {exams.length || appointments.length ? [...exams, ...appointments].sort((a, b) => a.day.localeCompare(b.day)).map((entry) => (
              <EntryRow key={entry.key} entry={entry} t={t} language={language} today={clock.today} showDay onOpen={() => setSelected(entry)} />
            )) : <Empty icon="agenda">{t.noExams}</Empty>}
          </Card>

          <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('grades')}>{t.grades} <Icon name="right" size={16} /></button>}>{t.latestGrades}</SectionLabel>
          <Card className="list">
            {recent.length ? recent.map((grade) => (
              <button type="button" key={grade.id} className="grade-row" onClick={() => kanti.navigate('grades', { fach: grade.courseId || grade.course })}>
                <span className="grade-main"><span className="grade-title">{grade.title || grade.subject}</span><small>{grade.subject || grade.course} · {dateLabel(grade.date, language)}</small></span>
                <MarkBadge mark={grade.mark} hidden={grade.hidden} t={t} />
              </button>
            )) : <Empty icon="grades">{t.noGrades}</Empty>}
            {courses.length ? (
              <div className="grade-total"><span>{t.pluspunkte}</span><span className={`tabular ${totals.total >= 0 ? 'positive' : 'negative'}`}>{plusLabel(totals.total)}</span></div>
            ) : null}
          </Card>

          {(snapshot?.messages?.length || snapshot?.startMessages?.length) ? (
            <>
              <SectionLabel action={<button type="button" className="link" onClick={() => kanti.navigate('updates')}>{t.updates} <Icon name="right" size={16} /></button>}>{t.fromSchool}</SectionLabel>
              <Card className="list">
                {(snapshot?.messages || []).slice(0, 3).map((message) => (
                  <button type="button" key={message.id} className="message-row" onClick={() => kanti.navigate('updates')}>
                    <span className="grade-title">{message.title}</span>
                    <small>{message.body.slice(0, 120)}</small>
                  </button>
                ))}
              </Card>
            </>
          ) : null}
        </aside>
      </div>
      {selected ? <Dialog title={selected.title} onClose={() => setSelected(null)}><EntryDetails entry={selected} t={t} language={language} /></Dialog> : null}
    </div>
  )
}
