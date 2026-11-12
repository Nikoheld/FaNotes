import { useEffect, useMemo, useState } from 'react'
import { allEntries, vacationOn, weekDays, weekMonday, weekRange, weekState, addDays } from '../lib/agenda'
import { dateLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Banner, Empty, IconButton, Tag } from '../components/ui'
import { DetailsPanel, WeekGrid } from '../components/WeekGrid'
import { isAksaConnection, readSummary, type TimetableSummary } from '../lib/timetables'
import { useClock } from './common'
import { OtherTimetables } from './OtherTimetables'

/** Mon–Fri as columns, the day as a measured axis, every week of the semester one keypress away. */
export const Timetable = () => {
  const kanti = useKanti()
  const { t, language, data, prefs, route, active, demo, api } = kanti
  const clock = useClock()
  const entries = useMemo(() => allEntries(data.snapshot), [data.snapshot])
  const weeks = useMemo(() => weekRange(data.snapshot, entries, clock.today), [data.snapshot, entries, clock.today])
  const requested = route.params.get('woche') || ''
  const monday = /^\d{4}-\d{2}-\d{2}$/u.test(requested) ? weekMonday(requested) : weekMonday(clock.today)
  const days = weekDays(monday, prefs.showWeekend)
  const inWeek = entries.filter((entry) => entry.day >= days[0] && entry.day <= days[days.length - 1])
  const state = weekState(data.snapshot, monday, entries)
  const [selectedKey, setSelectedKey] = useState(route.params.get('eintrag') || '')
  const selected = inWeek.find((entry) => entry.key === selectedKey) || null

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
  const isCurrent = monday === weekMonday(clock.today)

  if (others.available && route.params.get('ansicht') === 'andere') return <OtherTimetables summary={others} />

  return (
    <div className="view view-timetable">
      <div className="toolbar tt-toolbar">
        <div className="toolbar-group tt-heading">
          <div className="week-nav" role="group" aria-label={t.week}>
            <IconButton icon="left" label={`${t.previousWeek} (←)`} onClick={() => go(addDays(monday, -7))} />
            <button type="button" className={`nav-today${isCurrent ? ' current' : ''}`} onClick={() => go(weekMonday(clock.today))}>{t.today}</button>
            <IconButton icon="right" label={`${t.nextWeek} (→)`} onClick={() => go(addDays(monday, 7))} />
          </div>
          <h2 className="week-title">{t.weekOf(dateLabel(monday, language, { day: 'numeric', month: 'long', year: 'numeric' }))}</h2>
          {isCurrent ? <Tag tone="accent">{t.thisWeek}</Tag> : null}
        </div>
        <div className="toolbar-group">
          <label className="select">
            <span className="sr-only">{t.week}</span>
            <select value={index >= 0 ? monday : ''} onChange={(event) => go(event.target.value)}>
              {index < 0 ? <option value="">{t.weekOf(dateLabel(monday, language))}</option> : null}
              {weeks.map((week) => <option key={week} value={week}>{t.weekOf(dateLabel(week, language, { day: 'numeric', month: 'short', year: 'numeric' }))}</option>)}
            </select>
          </label>
          {others.available ? (
            <div className="segments" role="group" aria-label={t.timetable}>
              <button type="button" className="active" aria-pressed="true">{t.timetable}</button>
              <button type="button" aria-pressed="false" onClick={() => kanti.navigate('timetable', { ansicht: 'andere' })}>{t.otherTimetables}</button>
            </div>
          ) : null}
        </div>
      </div>
      {state === 'unread' ? <Banner tone="warning" icon="warning">{t.weekUnread}</Banner> : null}
      {state === 'holiday' ? <Banner icon="info">{vacationOn(data.snapshot, monday)?.name || t.holiday}</Banner> : null}
      <div className="columns columns-timetable">
        <WeekGrid
          days={days}
          today={clock.today}
          nowMinutes={clock.minutes}
          entries={inWeek}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          compact={prefs.compactTimetable}
          isVacation={(day) => Boolean(vacationOn(data.snapshot, day))}
          emptyLabel={state !== 'unread' ? <Empty icon="timetable">{state === 'holiday' ? t.holiday : t.weekFree}</Empty> : null}
        />
        <DetailsPanel entry={selected} />
      </div>
    </div>
  )
}
