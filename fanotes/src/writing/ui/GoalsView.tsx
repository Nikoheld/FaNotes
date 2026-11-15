// Goals, streak and the writing calendar.
import { Flame, Target, Trophy } from 'lucide-react'
import { calendarWeeks, goalStatus, localDate, streaks } from '../model/progress'
import type { StoryGoals } from '../model/types'
import { L, formatNumber } from './i18n'

const Bar = ({ value, max }: { value: number; max: number }) => (
  <span className="wm-goal-bar is-large"><span style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} /></span>
)

export function GoalsView({ goals, total, today, session, days, onGoals }: {
  goals: StoryGoals
  total: number
  today: number
  session: number
  days: Map<string, number>
  onGoals: (goals: StoryGoals) => void
}) {
  const status = goalStatus(total, goals)
  const streak = streaks(days, goals.daily)
  const weeks = calendarWeeks(16)
  const dailyGoal = goals.daily ?? 0
  const level = (words: number) => (words <= 0 ? 0 : dailyGoal ? (words >= dailyGoal ? 4 : words >= dailyGoal / 2 ? 3 : 2) : words >= 1000 ? 4 : words >= 500 ? 3 : words >= 100 ? 2 : 1)
  const number = (value: number | undefined, update: (value: number | undefined) => void, label: string, step = 100) => (
    <label>{label}
      <input type="number" min={0} step={step} value={value ?? ''} placeholder="–" onChange={(event) => update(Number(event.target.value) > 0 ? Math.round(Number(event.target.value)) : undefined)} />
    </label>
  )
  const now = localDate()
  return (
    <div className="wm-goals">
      <section className="wm-goal-cards">
        <article>
          <h4><Target size={14} /> {L('Projekt', 'Project')}</h4>
          <strong>{formatNumber(total)}{goals.project ? ` / ${formatNumber(goals.project)}` : ''}</strong>
          {goals.project ? <Bar value={total} max={goals.project} /> : <small>{L('Wörter im Manuskript', 'words in the manuscript')}</small>}
          {status.perDay !== null && <small>{L(`Noch ${formatNumber(status.left)} Wörter in ${formatNumber(status.daysLeft ?? 0)} Tagen: ${formatNumber(status.perDay)} pro Tag`, `${formatNumber(status.left)} words left in ${formatNumber(status.daysLeft ?? 0)} days: ${formatNumber(status.perDay)} a day`)}</small>}
          {status.daysLeft !== null && status.daysLeft <= 0 && status.left > 0 && <small className="wm-warn">{L('Der Termin ist vorbei.', 'The deadline has passed.')}</small>}
        </article>
        <article>
          <h4>{L('Heute', 'Today')}</h4>
          <strong>{formatNumber(today)}{dailyGoal ? ` / ${formatNumber(dailyGoal)}` : ''}</strong>
          {dailyGoal ? <Bar value={today} max={dailyGoal} /> : <small>{L('Wörter auf allen Geräten', 'words on all devices')}</small>}
        </article>
        <article>
          <h4>{L('Diese Sitzung', 'This session')}</h4>
          <strong>{formatNumber(Math.max(0, session))}{goals.session ? ` / ${formatNumber(goals.session)}` : ''}</strong>
          {goals.session ? <Bar value={Math.max(0, session)} max={goals.session} /> : <small>{L('seit dem Öffnen', 'since opening')}</small>}
        </article>
        <article>
          <h4><Flame size={14} /> {L('Serie', 'Streak')}</h4>
          <strong>{L(`${formatNumber(streak.current)} Tage`, `${formatNumber(streak.current)} days`)}</strong>
          <small><Trophy size={11} /> {L(`Längste: ${formatNumber(streak.longest)} Tage`, `Longest: ${formatNumber(streak.longest)} days`)}{streak.todayMet ? '' : L(' · heute noch offen', ' · today still open')}</small>
        </article>
      </section>
      <section className="wm-goal-settings">
        <h4>{L('Ziele', 'Goals')}</h4>
        <div>
          {number(goals.project, (project) => onGoals({ ...goals, project }), L('Wörter im ganzen Projekt', 'Words for the whole project'), 1000)}
          <label>{L('Termin', 'Deadline')}
            <input type="date" value={goals.deadline ?? ''} onChange={(event) => onGoals({ ...goals, deadline: event.target.value || undefined })} />
          </label>
          {number(goals.daily, (daily) => onGoals({ ...goals, daily }), L('Wörter pro Tag (für die Serie)', 'Words per day (for the streak)'))}
          {number(goals.session, (session_) => onGoals({ ...goals, session: session_ }), L('Wörter pro Sitzung', 'Words per session'))}
        </div>
      </section>
      <section>
        <h4>{L('Schreibkalender', 'Writing calendar')}</h4>
        <div className="wm-calendar" role="grid" aria-label={L('Wörter pro Tag, letzte 16 Wochen', 'Words per day, last 16 weeks')}>
          {weeks.map((week, index) => (
            <div key={index} role="row">
              {week.map((date) => {
                const words = days.get(date) ?? 0
                return <span key={date} role="gridcell" className={`level-${date > now ? 'future' : level(words)}${date === now ? ' is-today' : ''}`} title={`${date}: ${formatNumber(words)} ${L('Wörter', 'words')}`} />
              })}
            </div>
          ))}
        </div>
        <p className="wm-hint">{L('Gezählt wird, was das Manuskript an einem Tag gewachsen ist, auf allen Geräten zusammen.', 'Counted is how much the manuscript grew on a day, on all devices together.')}</p>
      </section>
    </div>
  )
}
