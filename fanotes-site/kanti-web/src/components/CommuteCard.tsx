// The Today card for the commute route that matters now: next connection and its status.
import { boardFocus, clockOf, dayLabel, delayClass, departureDelay, departurePlatform, lessonChange, nextTrip, relevantRoute, rideLegs, routeLabel, tripCancelled } from '../lib/commute'
import { useCommuteLive } from '../lib/useCommuteLive'
import { useKanti } from '../state'
import { useClock } from '../views/common'
import { DelayBadge, LineChip, Platform, targetLine } from './commute'
import { Button, Card, Icon, SectionLabel } from './ui'

export const CommuteCard = () => {
  const kanti = useKanti()
  const { t, commute } = kanti
  const clock = useClock()
  useCommuteLive(commute)
  // The feature is simply absent where the server has none.
  if (commute.unavailable || (!commute.loaded && !commute.error)) return null
  if (!commute.loaded) return null

  if (!commute.routes.length) {
    return (
      <>
        <SectionLabel>{t.commute}</SectionLabel>
        <Card className="commute-card commute-card-empty">
          <div className="commute-card-head"><Icon name="train" size={22} /><strong>{t.commuteEmptyTitle}</strong></div>
          <p className="muted small">{t.commuteEmptyBody}</p>
          <Button tone="outline" icon="plus" onClick={() => kanti.navigate('commute', { neu: '1' })}>{t.commuteAddRoute}</Button>
        </Card>
      </>
    )
  }

  const route = relevantRoute({ routes: commute.routes, boards: commute.boards, now: Date.now(), clockMinutes: clock.minutes })
  if (!route) return null
  const board = commute.boards[route.id]
  const focus = boardFocus(board)
  const pinned = focus.mode === 'pinned' && focus.pin
  // A pinned route shows its fixed connection; when that fails, the first usable alternative; when it is missing, the nearest trip.
  const trip = pinned
    ? (focus.broken ? board?.alternatives.find((alt) => !tripCancelled(alt)) || null : focus.trip || focus.nearest)
    : nextTrip(board, Date.now())
  const first = pinned ? (focus.broken ? focus.trip : null) : board?.trips[0]
  const change = lessonChange(board)
  const open = () => kanti.navigate('commute', { strecke: route.id })
  // The card itself opens the connection it shows; the link above opens the whole board.
  const openTrip = () => (trip ? kanti.navigate('commute', { strecke: route.id, verbindung: trip.id, ab: trip.plannedDeparture }) : open())
  const delay = trip ? departureDelay(trip) : null
  const kind = trip ? delayClass(delay, false) : 'ok'
  const { platform, changed } = trip ? departurePlatform(trip) : { platform: '', changed: false }

  return (
    <>
      <SectionLabel action={<button type="button" className="link" onClick={open}>{t.commuteCardOpen} <Icon name="right" size={16} /></button>}>{t.commute}</SectionLabel>
      <Card className={`commute-card commute-card-${kind}`} role="button" tabIndex={0} onClick={openTrip} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) openTrip() }} aria-label={`${t.commute}: ${routeLabel(route)}`}>
        <div className="commute-card-head">
          <Icon name="train" size={20} />
          <strong>{routeLabel(route)}</strong>
          <small className="muted">{route.from.name} → {route.to.name}</small>
        </div>
        {pinned ? <p className="commute-card-pin"><Icon name="pin" size={14} />{t.pinnedBadge}</p> : null}
        {pinned && focus.status === 'moved' && focus.movedTo ? <p className="commute-card-alert commute-card-warn"><Icon name="warning" size={15} />{t.pinMoved(focus.movedTo)}</p> : null}
        {pinned && focus.status === 'missing' && focus.pin ? (
          <p className="commute-card-alert"><Icon name="warning" size={15} /><span>{t.pinMissing(focus.pin.departure, focus.pin.line, focus.pin.stop, dayLabel(focus.day))}{' '}
            <button type="button" className="link" onClick={(event) => { event.stopPropagation(); kanti.navigate('commute', { wahl: route.id }) }}>{t.pinRepick}</button></span></p>
        ) : null}
        {change ? <p className="commute-card-change"><Icon name="info" size={15} />{change.pinned ? (change.kind === 'lastCancelled' ? t.pinnedLastCancelled(change.line, change.time, change.arrival) : t.pinnedFirstCancelled(change.line, change.time, change.arrival)) : change.kind === 'lastCancelled' ? t.lastCancelled(change.line, change.time, change.plannedTime) : `${t.firstCancelled}: ${t.firstCancelledBody(change.line, change.time)}`}</p> : null}
        {first && tripCancelled(first) ? <p className="commute-card-alert"><Icon name="warning" size={15} />{t.bannerCancelled}: {clockOf(first.plannedDeparture)}</p> : null}
        {trip ? (
          <>
            <div className="commute-card-main">
              <span className="commute-card-time tabular">
                {clockOf(trip.plannedDeparture) !== clockOf(trip.departure) ? <s>{clockOf(trip.plannedDeparture)}</s> : null}
                <strong className={`delay-text-${kind}`}>{clockOf(trip.departure)}</strong>
              </span>
              <Icon name="forward" size={16} />
              <span className="commute-card-arrival tabular">{clockOf(trip.arrival)}</span>
              <DelayBadge delay={delay} t={t} />
            </div>
            <div className="commute-card-meta">
              {rideLegs(trip).map((leg, index) => <LineChip key={index} leg={leg} />)}
              <Platform platform={platform} changed={changed} t={t} />
              <small className="muted">{board ? targetLine(board.target, t) : ''}</small>
            </div>
          </>
        ) : board ? <p className="muted">{t.commuteCardNone}</p> : commute.boardError ? <p className="muted">{t.commuteCardUnreachable}</p> : <div className="loading board-loading"><span className="spinner" /></div>}
      </Card>
    </>
  )
}
