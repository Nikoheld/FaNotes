import { useMemo, type ReactNode } from 'react'
import { clockMinutes, type Entry } from '../lib/agenda'
import { dateLabel, type Strings } from '../lib/i18n'
import { useKanti } from '../state'
import { Card, Icon } from './ui'
import { EntryDetails, kindLabel } from '../views/common'

/** What the grid draws of an entry; an agenda `Entry` fits, so do entries made from the school's PDF. */
export type GridEntry = Omit<Entry, 'event'>

/** The small label under a block: cancelled wins, then a change, a substitution or the kind of entry. */
const flag = (entry: GridEntry, t: Strings): ReactNode => {
  if (entry.cancelled) return <span className="block-flag flag-danger">{t.cancelled}</span>
  if (entry.marker === 'changed' || entry.marker === 'moved' || entry.marker === 'added') {
    return <span className={`block-flag ${entry.marker === 'added' ? 'flag-accent' : 'flag-warning'}`}>{entry.marker === 'changed' ? t.markChanged : entry.marker === 'moved' ? t.markMoved : t.markAdded}</span>
  }
  if (entry.substitution) return <span className="block-flag flag-warning">{t.substitution}</span>
  if (entry.kind !== 'lesson') return <span className={`block-flag ${entry.kind === 'exam' ? 'flag-warning' : 'flag-success'}`}>{kindLabel(entry, t)}</span>
  return null
}

const DAY_START = 7 * 60
const DAY_END = 15 * 60

interface Placed { entry: GridEntry; lane: number; lanes: number }

/** Entries that overlap in one day share the column side by side. */
const lanesOf = (list: GridEntry[]): Placed[] => {
  const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start))
  const placed: Placed[] = []
  let group: Placed[] = []
  let groupEnd = -1
  const close = () => { const count = Math.max(...group.map((item) => item.lane)) + 1; group.forEach((item) => { item.lanes = count }) }
  for (const entry of sorted) {
    const start = clockMinutes(entry.start) ?? 0
    const end = clockMinutes(entry.end) ?? start + 45
    if (start >= groupEnd && group.length) { close(); group = [] }
    const used = new Set(group.filter((item) => (clockMinutes(item.entry.end) ?? 0) > start).map((item) => item.lane))
    let lane = 0
    while (used.has(lane)) lane += 1
    const item = { entry, lane, lanes: 1 }
    group.push(item)
    placed.push(item)
    groupEnd = Math.max(groupEnd, end)
  }
  if (group.length) close()
  return placed
}

/**
 * The Mon–Fri week grid with the day as a measured axis. Presentational only: the own timetable and
 * the school's timetables of other classes and rooms both render through it, so they cannot drift.
 */
export const WeekGrid = ({ days, today, nowMinutes, entries, selectedKey, onSelect, compact = false, isVacation, emptyLabel }: {
  /** ISO dates of the columns. */
  days: string[]
  today: string
  /** Minutes since midnight of the running clock, for the "now" line. */
  nowMinutes?: number
  entries: GridEntry[]
  selectedKey: string
  onSelect: (key: string) => void
  compact?: boolean
  isVacation?: (day: string) => boolean
  /** Shown over an empty grid. */
  emptyLabel?: ReactNode
}) => {
  const { t, language } = useKanti()
  const timed = entries.filter((entry) => entry.start)
  const allDay = entries.filter((entry) => !entry.start)

  // Fit the axis to the week: never narrower than 07:00–15:00, wider when an entry is outside.
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

  const span = bounds.high - bounds.low
  const hours = Array.from({ length: span / 60 + 1 }, (_, hour) => bounds.low + hour * 60)
  const top = (minutes: number) => `${((minutes - bounds.low) / span) * 100}%`

  return (
    <Card className="week-grid-card">
      <div className="week-grid" style={{ ['--days' as string]: String(days.length) }}>
        <div className="week-head">
          <span />
          {days.map((day, dayIndex) => (
            <span key={day} className={`week-day${day === today ? ' today' : ''}`} aria-current={day === today ? 'date' : undefined}>
              <strong>{t.weekdays[dayIndex]}</strong>
              <span className="week-date tabular">{dateLabel(day, language, { day: 'numeric', month: 'numeric' })}</span>
            </span>
          ))}
        </div>
        {allDay.length ? (
          <div className="week-allday">
            <span className="axis-label">{t.allDay}</span>
            {days.map((day) => (
              <span key={day} className="allday-cell">
                {allDay.filter((entry) => entry.day === day).map((entry) => (
                  <button type="button" key={entry.key} className={`chip kind-${entry.kind}${entry.cancelled ? ' cancelled' : ''}${entry.key === selectedKey ? ' selected' : ''}`} onClick={() => onSelect(entry.key)}>{entry.title}</button>
                ))}
              </span>
            ))}
          </div>
        ) : null}
        <div className={`week-body${compact ? ' compact' : ''}`} style={{ ['--hours' as string]: String(span / 60) }}>
          <div className="axis">
            {hours.map((minutes) => <span key={minutes} className="axis-hour tabular" style={{ top: top(minutes) }}>{`${String(minutes / 60).padStart(2, '0')}:00`}</span>)}
          </div>
          {days.map((day) => {
            const list = timed.filter((entry) => entry.day === day)
            const vacation = isVacation?.(day) || false
            return (
              <div key={day} className={`day-column${day === today ? ' today' : ''}${vacation ? ' vacation' : ''}`}>
                {hours.map((minutes) => <span key={minutes} className="hour-line" style={{ top: top(minutes) }} />)}
                {day === today && nowMinutes !== undefined && nowMinutes >= bounds.low && nowMinutes <= bounds.high ? <span className="now-line" style={{ top: top(nowMinutes) }} /> : null}
                {lanesOf(list).map(({ entry, lane, lanes: count }) => {
                  const start = clockMinutes(entry.start) ?? bounds.low
                  const end = clockMinutes(entry.end) ?? start + 45
                  return (
                    <button
                      type="button"
                      key={entry.key}
                      className={`block kind-${entry.kind}${entry.cancelled ? ' cancelled' : ''}${entry.substitution ? ' substitution' : ''}${entry.key === selectedKey ? ' selected' : ''}`}
                      style={{ top: top(start), height: `calc(${((end - start) / span) * 100}% - 2px)`, left: `calc(${(lane / count) * 100}% + 2px)`, width: `calc(${100 / count}% - 4px)` }}
                      onClick={() => onSelect(entry.key)}
                      title={`${entry.start}–${entry.end} ${entry.title}${entry.room ? ` · ${entry.room}` : ''}`}
                    >
                      <span className="block-title">{entry.title}</span>
                      <span className="block-meta tabular">{entry.start}{entry.room ? ` · ${entry.room}` : ''}</span>
                      {flag(entry, t)}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
        {!timed.length && emptyLabel ? <div className="week-empty">{emptyLabel}</div> : null}
      </div>
    </Card>
  )
}

/** The sticky card beside the grid: the picked entry in full, or a friendly hint. */
export const DetailsPanel = ({ entry }: { entry: GridEntry | null }) => {
  const { t, language } = useKanti()
  return (
    <aside className="column column-side details-panel">
      <Card className={`detail-card${entry ? ` kind-${entry.kind}${entry.cancelled ? ' cancelled' : ''}` : ''}`}>
        {entry ? <EntryDetails entry={entry} t={t} language={language} /> : (
          <div className="detail-empty">
            <span className="detail-empty-icon"><Icon name="timetable" size={22} /></span>
            <strong>{t.details}</strong>
            <p>{t.pickLesson}</p>
          </div>
        )}
      </Card>
    </aside>
  )
}
