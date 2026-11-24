import { useEffect, useMemo, useState } from 'react'
import { MensaDish } from '../components/MensaCard'
import { Banner, Button, Card, Empty, Icon } from '../components/ui'
import { dateLabel } from '../lib/i18n'
import { mensaPreselectedDate, mensaWeekSlots } from '../lib/mensa'
import { useMensa } from '../lib/useMensa'
import { useKanti } from '../state'
import { useClock } from './common'
import { zurichToday } from '@shared/schulnetz-logic'

/** The Mensa menu by week: day chips (this week, then next week when known) and the chosen day's dishes. */
export const Mensa = () => {
  const kanti = useKanti()
  const { t, language, offline } = kanti
  const clock = useClock()
  const { feed, loading, failed, reload } = useMensa(true)
  const [chosen, setChosen] = useState('')
  const today = zurichToday()
  const slots = useMemo(() => (feed ? mensaWeekSlots(feed.days, today) : []), [feed, today])
  const preselected = mensaPreselectedDate(slots, new Date())
  const selected = slots.find((slot) => slot.date === chosen)?.date || preselected
  const index = slots.findIndex((slot) => slot.date === selected)
  const slot = slots[index] || null
  const empty = !feed || slots.every((entry) => entry.day === null)
  const offlineNow = offline || failed
  const stamp = feed?.fetchedAt ? `${dateLabel(feed.fetchedAt.slice(0, 10), language, { day: 'numeric', month: 'short' })} ${new Date(feed.fetchedAt).toLocaleTimeString(language === 'de' ? 'de-CH' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' })}` : ''

  // The arrow keys and "r" are shared shortcuts: previous/next move the day, refresh reloads the menu.
  useEffect(() => {
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      const step = action === 'previous' ? -1 : action === 'next' ? 1 : 0
      if (step && slots[index + step]) setChosen(slots[index + step].date)
      if (action === 'refresh') reload()
    }
    window.addEventListener('kanti:action', onAction)
    return () => window.removeEventListener('kanti:action', onAction)
  })

  const groups = [false, true].map((next) => slots.filter((entry) => entry.nextWeek === next)).filter((list) => list.length)
  return (
    <div className="view view-mensa">
      <div className="toolbar">
        <div className="mensa-status">
          {feed && stamp ? <span className="muted small">{offlineNow ? t.offlineUpdated(stamp) : t.mensaUpdated(stamp)}</span> : null}
        </div>
        <div className="toolbar-group"><Button tone="outline" icon="refresh" onClick={reload} disabled={loading}>{t.refresh}</Button></div>
      </div>
      {feed?.stale ? <Banner tone="warning" icon="warning">{t.mensaStale}</Banner> : null}
      {empty ? (
        <Card><Empty icon="info"><strong>{t.mensaEmptyTitle}</strong><br />{offlineNow ? t.mensaOfflineBody : t.mensaEmptyBody}</Empty></Card>
      ) : (
        <>
          <div className="mensa-weeks">
            {groups.map((list) => (
              <div className="mensa-week" key={String(list[0].nextWeek)} role="group" aria-label={list[0].nextWeek ? t.mensaNextWeek : t.mensaThisWeek}>
                <h3 className="mensa-week-label">{list[0].nextWeek ? t.mensaNextWeek : t.mensaThisWeek}</h3>
                <div className="mensa-chips">
                  {list.map((entry) => (
                    <button type="button" key={entry.date} className={`mensa-chip${entry.date === selected ? ' active' : ''}${entry.date < clock.today ? ' past' : ''}`} aria-pressed={entry.date === selected} aria-label={dateLabel(entry.date, language, { weekday: 'long', day: 'numeric', month: 'long' })} onClick={() => setChosen(entry.date)}>
                      <span>{dateLabel(entry.date, language, { weekday: 'short' }).replace('.', '')}</span>
                      <strong className="tabular">{dateLabel(entry.date, language, { day: 'numeric' })}</strong>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {slot ? (
            <section className="mensa-dayview" aria-label={dateLabel(slot.date, language, { weekday: 'long', day: 'numeric', month: 'long' })}>
              <h2 className="mensa-heading"><Icon name="today" size={18} />{dateLabel(slot.date, language, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
              <Card className="mensa-card">
                {!slot.day ? <p className="muted">{t.mensaNoMenuDay}</p> : slot.day.closed ? <p>{slot.day.note || t.mensaClosed}</p> : slot.day.menus.map((menu, position) => <MensaDish key={`${menu.name}:${position}`} menu={menu} t={t} />)}
              </Card>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
