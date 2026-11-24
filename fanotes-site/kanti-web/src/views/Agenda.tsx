import { useMemo, useState } from 'react'
import { daysBetween, weekMonday, type Entry } from '../lib/agenda'
import { useEntries } from '../vault/entries'
import { EventDialog } from '../vault/forms'
import { useVault } from '../vault/store'
import { dateLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Button, Card, Dialog, Empty, RoomPill, Toggle } from '../components/ui'
import { homeworkList, type HomeworkItem } from '../lib/homework'
import { EntryDetails, EntryTags, HomeworkDetails, HomeworkRow, kindLabel, relativeDay, useClock } from './common'

type Filter = 'all' | 'exam' | 'appointment' | 'homework'

const groupByWeek = (entries: Entry[]) => {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    const monday = weekMonday(entry.day)
    groups.set(monday, [...(groups.get(monday) || []), entry])
  }
  return [...groups.entries()]
}

/** Exams and school events as one timeline grouped by week, filterable by kind. */
export const Agenda = () => {
  const { t, language, data } = useKanti()
  const clock = useClock()
  const [past, setPast] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Entry | null>(null)
  const [homeworkOpen, setHomeworkOpen] = useState<HomeworkItem | null>(null)
  const vault = useVault()
  const [creating, setCreating] = useState(false)
  const entries = useEntries()
  const pool = (kind: Entry['kind']) => entries.filter((entry) => entry.kind === kind && (past ? entry.day < clock.today : entry.day >= clock.today))
  const exams = pool('exam')
  const appointments = pool('appointment')
  const homework = useMemo(() => homeworkList(data.snapshot?.homework, clock.today, past), [data.snapshot, clock.today, past])
  const list = useMemo(() => {
    if (filter === 'homework') return []
    const merged = filter === 'exam' ? [...exams] : filter === 'appointment' ? [...appointments] : [...exams, ...appointments]
    merged.sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start))
    return past ? merged.reverse() : merged
  }, [exams, appointments, filter, past])
  const nextExam = past ? undefined : exams[0]

  const relative = (entry: Entry) => {
    const delta = daysBetween(clock.today, entry.day)
    if (delta < 0) return relativeDay(entry.day, clock.today, t, language)
    return delta === 0 ? t.today : delta === 1 ? t.tomorrow : t.inDays(delta)
  }
  const options: [Filter, string, number][] = [['all', t.filterAll, exams.length + appointments.length], ['exam', t.exams, exams.length], ['appointment', t.appointments, appointments.length], ...(data.snapshot?.homework?.length ? [['homework', t.schoolAssignments, homework.length] as [Filter, string, number]] : [])]
  const emptyText = filter === 'homework' ? t.noSchoolAssignments : filter === 'exam' ? t.noExams : filter === 'appointment' ? t.noAppointments : `${t.noExams} ${t.noAppointments}`

  return (
    <div className="view view-agenda">
      <div className="toolbar">
        <div className="segments" role="group" aria-label={t.agenda}>
          {options.map(([value, label, count]) => (
            <button type="button" key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
              {label} <span className="seg-count tabular">{count}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-group">
          {vault.mode === 'ready' && vault.actions.writable && vault.own.calendarReadable ? <Button tone="outline" icon="plus" onClick={() => setCreating(true)}>{t.newEvent}</Button> : null}
          <Toggle checked={past} onChange={setPast} label={t.showPast} />
        </div>
      </div>
      <div className="agenda-layout">
        <div className="agenda-timeline">
          {list.length ? groupByWeek(list).map(([monday, items]) => (
            <section className="tl-week" key={monday} aria-label={t.weekOf(dateLabel(monday, language, { day: 'numeric', month: 'long' }))}>
              <h3 className="tl-week-head">{t.weekOf(dateLabel(monday, language, { day: 'numeric', month: 'long' }))}</h3>
              <Card className="list tl-list">
                {items.map((entry) => {
                  const delta = daysBetween(clock.today, entry.day)
                  const soon = delta >= 0 && delta <= 3
                  return (
                    <button type="button" key={entry.key} className={`tl-item kind-${entry.kind}${entry.cancelled ? ' cancelled' : ''}`} onClick={() => setSelected(entry)}>
                      <span className="tl-tile" aria-hidden="true">
                        <span className="tl-wd">{dateLabel(entry.day, language, { weekday: 'short' }).replace('.', '')}</span>
                        <span className="tl-day tabular">{dateLabel(entry.day, language, { day: 'numeric' })}</span>
                        <span className="tl-month">{dateLabel(entry.day, language, { month: 'short' }).replace('.', '')}</span>
                      </span>
                      <span className="tl-main">
                        <span className="tl-title">{entry.title}</span>
                        <span className="tl-meta">
                          <span className="tabular">{entry.start ? `${entry.start}${entry.end ? `–${entry.end}` : ''}` : t.allDay}</span>
                          {[entry.teachers.join(', '), kindLabel(entry, t)].filter(Boolean).map((part) => <span key={part}>{part}</span>)}
                        </span>
                      </span>
                      <span className="tl-side">
                        <EntryTags entry={entry} t={t} />
                        {entry.room ? <RoomPill room={entry.room} label={t.room} /> : null}
                        <span className={`tag ${soon && entry.kind === 'exam' ? 'tag-warning' : delta === 0 ? 'tag-accent' : ''}`}>{relative(entry)}</span>
                      </span>
                    </button>
                  )
                })}
              </Card>
            </section>
          )) : filter === 'homework' && homework.length ? null : <Card><Empty icon="agenda">{emptyText}</Empty></Card>}
          {homework.length && (filter === 'all' || filter === 'homework') ? (
            <section className="tl-week hw-section" aria-label={t.schoolAssignments}>
              <h3 className="tl-week-head">{t.schoolAssignments}</h3>
              <Card className="list tl-list">
                {homework.map((item) => <HomeworkRow key={item.id} item={item} t={t} language={language} today={clock.today} onOpen={() => setHomeworkOpen(item)} />)}
              </Card>
            </section>
          ) : null}
        </div>
        <aside className="agenda-side">
          <Card className="agenda-glance">
            <p className="glance-label">{t.nextExam}</p>
            {nextExam ? (
              <>
                <p className="glance-figure">{relative(nextExam)}</p>
                <p className="glance-title">{nextExam.title}</p>
                <p className="glance-meta">{dateLabel(nextExam.day, language, { weekday: 'long', day: 'numeric', month: 'long' })}{nextExam.start ? ` · ${nextExam.start}` : ''}</p>
              </>
            ) : <p className="glance-meta">{t.noExams}</p>}
            <div className="glance-counts">
              <span><span className="dot dot-exam" aria-hidden="true" /><strong className="tabular">{exams.length}</strong> {t.exams}</span>
              <span><span className="dot dot-appointment" aria-hidden="true" /><strong className="tabular">{appointments.length}</strong> {t.appointments}</span>
            </div>
          </Card>
        </aside>
      </div>
      {homeworkOpen ? <Dialog title={homeworkOpen.title} onClose={() => setHomeworkOpen(null)}><HomeworkDetails item={homeworkOpen} t={t} language={language} /></Dialog> : null}
      {creating ? <EventDialog onClose={() => setCreating(false)} /> : null}
      {selected ? <Dialog title={selected.title} onClose={() => setSelected(null)}><EntryDetails entry={selected} t={t} language={language} onDone={() => setSelected(null)} /></Dialog> : null}
    </div>
  )
}
