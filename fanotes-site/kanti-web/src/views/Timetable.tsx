import { useEffect, useMemo, useState } from 'react'
import { allEntries, clockMinutes, vacationOn, weekDays, weekMonday, weekRange, weekState, addDays, type Entry } from '../lib/agenda'
import { dateLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Banner, Button, Card, Empty, IconButton, Tag } from '../components/ui'
import { isAksaConnection, readSummary, type TimetableSummary } from '../lib/timetables'
import { EntryDetails, kindLabel, useClock } from './common'
import { OtherTimetables } from './OtherTimetables'

const DAY_START = 7 * 60
const DAY_END = 16 * 60

/** Mon–Fri as columns, the day as a measured axis, every week of the semester one keypress away. */
export const Timetable = () => {
  const kanti = useKanti()
  const { t, language, data, prefs, route, active, demo, api } = kanti
  const clock = useClock()
  const entries = useMemo(() => allEntries(data.snapshot, prefs.groupChoices), [data.snapshot, prefs.groupChoices])
  const weeks = useMemo(() => weekRange(data.snapshot, entries, clock.today), [data.snapshot, entries, clock.today])
  const requested = route.params.get('woche') || ''
  const monday = /^\d{4}-\d{2}-\d{2}$/u.test(requested) ? weekMonday(requested) : weekMonday(clock.today)
  const days = weekDays(monday, prefs.showWeekend)
  const inWeek = entries.filter((entry) => entry.day >= days[0] && entry.day <= days[days.length - 1])
  const timed = inWeek.filter((entry) => entry.start)
  const allDay = inWeek.filter((entry) => !entry.start)
  const state = weekState(data.snapshot, monday, entries)
  const [selectedKey, setSelectedKey] = useState(route.params.get('eintrag') || '')
  const selected = inWeek.find((entry) => entry.key === selectedKey) || null

  // Fit the axis to the week: never narrower than 07:00–18:00, wider when an entry is outside.
  const bounds = useMemo(() => {
    let low = DAY_START
    let high = DAY_END
    for (const entry of timed) {
      const start = clockMinutes(entry.start) ?? low
      const end = clockMinutes(entry.end) ?? start + 45
      low = Math.min(low, Math.floor(start / 60) * 60)
      high = Math.max(high, Math.ceil(end / 60) * 60)
    }
    return { low, high }
  }, [timed])

  const go = (target: string) => kanti.navigate('timetable', { woche: target === weekMonday(clock.today) ? '' : target }, true)

  useEffect(() => {
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (action === 'previous') go(addDays(monday, -7))
      if (action === 'next') go(addDays(monday, 7))
      if (action === 'today') go(weekMonday(clock.today))
    }
    window.addEventListener('kanti:action', onAction)
    return () => window.removeEventListener('kanti:action', onAction)
  })

  // The school's PDF of other classes and rooms: only asked for on the Alte Kanti, shown only when uploaded.
  const [others, setOthers] = useState<TimetableSummary>({ available: false })
  const activeId = active?.id || ''
  const aksa = !demo && isAksaConnection(active?.baseUrl)
  useEffect(() => {
    setOthers({ available: false })
    if (!aksa || !activeId) return undefined
    let live = true
    api.timetables(activeId).then((value) => { if (live) setOthers(readSummary(value)) }).catch(() => undefined)
    return () => { live = false }
  }, [api, aksa, activeId])

  const index = weeks.indexOf(monday)
  const span = bounds.high - bounds.low
  const hours = Array.from({ length: span / 60 + 1 }, (_, hour) => bounds.low + hour * 60)
  const top = (minutes: number) => `${((minutes - bounds.low) / span) * 100}%`

  // Entries that overlap in one day share the column side by side.
  const lanes = (list: Entry[]) => {
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start))
    const placed: { entry: Entry; lane: number; lanes: number }[] = []
    let group: { entry: Entry; lane: number; lanes: number }[] = []
    let groupEnd = -1
    for (const entry of sorted) {
      const start = clockMinutes(entry.start) ?? 0
      const end = clockMinutes(entry.end) ?? start + 45
      if (start >= groupEnd && group.length) { const count = Math.max(...group.map((item) => item.lane)) + 1; group.forEach((item) => { item.lanes = count }); group = [] }
      const used = new Set(group.filter((item) => (clockMinutes(item.entry.end) ?? 0) > start).map((item) => item.lane))
      let lane = 0
      while (used.has(lane)) lane += 1
      const item = { entry, lane, lanes: 1 }
      group.push(item)
      placed.push(item)
      groupEnd = Math.max(groupEnd, end)
    }
    if (group.length) { const count = Math.max(...group.map((item) => item.lane)) + 1; group.forEach((item) => { item.lanes = count }) }
    return placed
  }

  if (others.available && route.params.get('ansicht') === 'andere') return <OtherTimetables summary={others} />

  return (
    <div className="view view-timetable">
      <div className="toolbar">
        <div className="toolbar-group">
          <IconButton icon="left" label={`${t.previousWeek} (←)`} onClick={() => go(addDays(monday, -7))} />
          <IconButton icon="right" label={`${t.nextWeek} (→)`} onClick={() => go(addDays(monday, 7))} />
          <h2 className="week-title">{t.weekOf(dateLabel(monday, language, { day: 'numeric', month: 'long', year: 'numeric' }))}</h2>
          {monday !== weekMonday(clock.today) ? <Button tone="outline" onClick={() => go(weekMonday(clock.today))}>{t.thisWeek}</Button> : <Tag tone="accent">{t.thisWeek}</Tag>}
        </div>
        <div className="toolbar-group">
          {others.available ? <Button tone="quiet" icon="timetable" onClick={() => kanti.navigate('timetable', { ansicht: 'andere' })}>{t.otherTimetables}</Button> : null}
          <label className="select">
            <span className="sr-only">{t.week}</span>
            <select value={index >= 0 ? monday : ''} onChange={(event) => go(event.target.value)}>
              {index < 0 ? <option value="">{t.weekOf(dateLabel(monday, language))}</option> : null}
              {weeks.map((week) => <option key={week} value={week}>{t.weekOf(dateLabel(week, language, { day: 'numeric', month: 'short', year: 'numeric' }))}</option>)}
            </select>
          </label>
        </div>
      </div>
      {state === 'unread' ? <Banner tone="warning" icon="warning">{t.weekUnread}</Banner> : null}
      {state === 'holiday' ? <Banner icon="info">{vacationOn(data.snapshot, monday)?.name || t.holiday}</Banner> : null}
      <div className="columns columns-timetable">
        <Card className="week-grid-card">
          <div className="week-grid" style={{ ['--days' as string]: String(days.length) }}>
            <div className="week-head">
              <span />
              {days.map((day, dayIndex) => (
                <span key={day} className={`week-day${day === clock.today ? ' today' : ''}`}>
                  <strong>{t.weekdays[dayIndex]}</strong> <span className="tabular">{dateLabel(day, language, { day: 'numeric', month: 'numeric' })}</span>
                </span>
              ))}
            </div>
            {allDay.length ? (
              <div className="week-allday">
                <span className="axis-label">{t.allDay}</span>
                {days.map((day) => (
                  <span key={day} className="allday-cell">
                    {allDay.filter((entry) => entry.day === day).map((entry) => (
                      <button type="button" key={entry.key} className={`chip kind-${entry.kind}${entry.key === selectedKey ? ' selected' : ''}`} onClick={() => setSelectedKey(entry.key)}>{entry.title}</button>
                    ))}
                  </span>
                ))}
              </div>
            ) : null}
            <div className={`week-body${prefs.compactTimetable ? ' compact' : ''}`}>
              <div className="axis">
                {hours.map((minutes) => <span key={minutes} className="axis-hour tabular" style={{ top: top(minutes) }}>{`${String(minutes / 60).padStart(2, '0')}:00`}</span>)}
              </div>
              {days.map((day) => {
                const list = timed.filter((entry) => entry.day === day)
                const vacation = vacationOn(data.snapshot, day)
                return (
                  <div key={day} className={`day-column${day === clock.today ? ' today' : ''}${vacation ? ' vacation' : ''}`}>
                    {hours.map((minutes) => <span key={minutes} className="hour-line" style={{ top: top(minutes) }} />)}
                    {day === clock.today && clock.minutes >= bounds.low && clock.minutes <= bounds.high ? <span className="now-line" style={{ top: top(clock.minutes) }} /> : null}
                    {lanes(list).map(({ entry, lane, lanes: count }) => {
                      const start = clockMinutes(entry.start) ?? bounds.low
                      const end = clockMinutes(entry.end) ?? start + 45
                      return (
                        <button
                          type="button"
                          key={entry.key}
                          className={`block kind-${entry.kind}${entry.cancelled ? ' cancelled' : ''}${entry.substitution ? ' substitution' : ''}${entry.key === selectedKey ? ' selected' : ''}`}
                          style={{ top: top(start), height: `calc(${((end - start) / span) * 100}% - 2px)`, left: `calc(${(lane / count) * 100}% + 2px)`, width: `calc(${100 / count}% - 4px)` }}
                          onClick={() => setSelectedKey(entry.key)}
                          title={`${entry.start}–${entry.end} ${entry.title}${entry.room ? ` · ${entry.room}` : ''}`}
                        >
                          <span className="block-title">{entry.title}</span>
                          <span className="block-meta tabular">{entry.start}{entry.room ? ` · ${entry.room}` : ''}</span>
                          {entry.cancelled ? <span className="block-flag">{t.cancelled}</span> : entry.substitution ? <span className="block-flag">{t.substitution}</span> : entry.kind !== 'lesson' ? <span className="block-flag">{kindLabel(entry, t)}</span> : null}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
            {!timed.length && state !== 'unread' ? <div className="week-empty"><Empty icon="timetable">{state === 'holiday' ? t.holiday : t.weekFree}</Empty></div> : null}
          </div>
        </Card>
        <aside className="column column-side details-panel">
          <Card>{selected ? <EntryDetails entry={selected} t={t} language={language} /> : <Empty icon="info">{t.pickLesson}</Empty>}</Card>
        </aside>
      </div>
    </div>
  )
}
