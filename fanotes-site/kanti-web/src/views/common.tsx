// Small pieces several views share.
import { useEffect, useState } from 'react'
import { zurichNow, type Clock, type Entry } from '../lib/agenda'
import { dateLabel, markLabel, type Language, type Strings } from '../lib/i18n'
import { markTone } from '../lib/grades'
import { Icon, RoomPill, Tag } from '../components/ui'
import { daysBetween } from '../lib/agenda'

/** The Zurich clock, ticking once a minute. */
export const useClock = (): Clock => {
  const [clock, setClock] = useState(() => zurichNow())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(zurichNow()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return clock
}

export const relativeDay = (day: string, today: string, t: Strings, language: Language) => {
  const delta = daysBetween(today, day)
  if (delta === 0) return t.today
  if (delta === 1) return t.tomorrow
  if (delta > 1 && delta < 7) return dateLabel(day, language, { weekday: 'long' })
  if (delta < 0 && delta > -7) return t.daysAgo(-delta)
  return dateLabel(day, language)
}

export const ago = (iso: string, t: Strings) => {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return t.never
  return t.minutesAgo(Math.max(0, Math.round((Date.now() - at) / 60_000)))
}

export const kindLabel = (entry: Entry, t: Strings) => (entry.kind === 'exam' ? t.exam : entry.kind === 'appointment' ? t.appointment : t.lesson)

/** The tags a lesson carries beyond its title: cancelled wins, otherwise the mark and the substitution. */
export const EntryTags = ({ entry, t, detail = false }: { entry: Entry; t: Strings; detail?: boolean }) => {
  if (entry.cancelled) return <Tag tone="danger">{t.cancelled}</Tag>
  const mark = entry.marker === 'changed' ? t.markChanged : entry.marker === 'moved' ? t.markMoved : entry.marker === 'added' ? t.markAdded : ''
  return (
    <>
      {mark ? <Tag tone={entry.marker === 'added' ? 'accent' : 'warning'}>{mark}</Tag> : null}
      {entry.substitution ? <Tag tone="warning">{detail && entry.substitute ? t.substituteBy(entry.substitute) : t.substitution}</Tag> : null}
    </>
  )
}

export const EntryRow = ({ entry, t, language, today, showDay = false, onOpen, now = false }: { entry: Entry; t: Strings; language: Language; today: string; showDay?: boolean; onOpen?: () => void; now?: boolean }) => (
  <button type="button" className={`entry-row kind-${entry.kind}${entry.cancelled ? ' cancelled' : ''}${now ? ' running' : ''}`} onClick={onOpen}>
    <span className="entry-time tabular">
      {showDay ? <small>{relativeDay(entry.day, today, t, language)}</small> : null}
      <span>{entry.start || t.allDay}</span>
      {entry.end && entry.end !== entry.start ? <small>{entry.end}</small> : null}
    </span>
    <span className="entry-rail" aria-hidden="true" />
    <span className="entry-main">
      <span className="entry-title">{entry.title}</span>
      <span className="entry-meta">
        {[entry.teachers.join(', '), entry.kind !== 'lesson' ? kindLabel(entry, t) : ''].filter(Boolean).join(' · ')}
      </span>
    </span>
    <span className="entry-side">
      <EntryTags entry={entry} t={t} />
      {entry.room ? <RoomPill room={entry.room} label={t.room} /> : null}
    </span>
  </button>
)

export const MarkBadge = ({ mark, hidden, t, large = false }: { mark: number | null | undefined; hidden?: boolean; t: Strings; large?: boolean }) => {
  if (hidden) return <span className={`mark mark-hidden${large ? ' large' : ''}`} title={t.hiddenGrade}><Icon name="eyeOff" size={large ? 20 : 16} /></span>
  return <span className={`mark mark-${markTone(mark)}${large ? ' large' : ''} tabular`}>{mark == null ? '–' : markLabel(mark)}</span>
}

export const EntryDetails = ({ entry, t, language }: { entry: Entry; t: Strings; language: Language }) => (
  <div className="details">
    <p className="details-kind">{kindLabel(entry, t)}</p>
    <h3 className={entry.cancelled ? 'struck' : ''}>{entry.title}</h3>
    <dl>
      <dt>{t.date}</dt><dd>{dateLabel(entry.day, language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</dd>
      <dt>{t.time}</dt><dd className="tabular">{entry.start ? `${entry.start}${entry.end ? `–${entry.end}` : ''}` : t.allDay}</dd>
      {entry.room ? <><dt>{t.room}</dt><dd>{entry.room}</dd></> : null}
      {entry.teachers.length ? <><dt>{t.teachers}</dt><dd>{entry.teachers.join(', ')}</dd></> : null}
      {entry.comment ? <><dt>{t.note}</dt><dd>{entry.comment}</dd></> : null}
    </dl>
    <div className="details-tags">
      <EntryTags entry={entry} t={t} detail />
    </div>
  </div>
)
