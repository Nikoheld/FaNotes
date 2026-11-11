// The Today card for the commute route that matters now: next connection and its status.
import { clockOf, delayClass, departureDelay, departurePlatform, lessonChange, nextTrip, relevantRoute, rideLegs, routeLabel, tripCancelled } from '../lib/commute'
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
  const trip = nextTrip(board, Date.now())
  const first = board?.trips[0]
  const change = lessonChange(board)
  const open = () => kanti.navigate('commute', { strecke: route.id })
  const delay = trip ? departureDelay(trip) : null
  const kind = trip ? delayClass(delay, false) : 'ok'
  const { platform, changed } = trip ? departurePlatform(trip) : { platform: '', changed: false }

  return (
    <>
      <SectionLabel action={<button type="button" className="link" onClick={open}>{t.commuteCardOpen} <Icon name="right" size={16} /></button>}>{t.commute}</SectionLabel>
      <Card className={`commute-card commute-card-${kind}`} role="button" tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === 'Enter') open() }} aria-label={`${t.commute}: ${routeLabel(route)}`}>
        <div className="commute-card-head">
          <Icon name="train" size={20} />
          <strong>{routeLabel(route)}</strong>
          <small className="muted">{route.from.name} → {route.to.name}</small>
        </div>
        {change ? <p className="commute-card-change"><Icon name="info" size={15} />{change.kind === 'lastCancelled' ? t.lastCancelled(change.line, change.time, change.plannedTime) : `${t.firstCancelled}: ${t.firstCancelledBody(change.line, change.time)}`}</p> : null}
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
