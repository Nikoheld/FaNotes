// Pieces of the Pendeln view and the Today card: line chips, delay badges, occupancy, trips with
// their leg timeline, and the board body with its status banners.
import { useState } from 'react'
import { chipColors, clockOf, delayClass, departureDelay, departurePlatform, durationLabel, hasOccupancy, lessonChange, occupancyLevel, rideLegs, tripCancelled } from '../lib/commute'
import type { Strings } from '../lib/i18n'
import type { CommuteRoute, CommuteTarget, Leg, Occupancy, RouteBoard, Stop, Trip, TripPoint } from '../types'
import { Banner, Icon, Tag, type IconName } from './ui'

export const stopIcon = (type: Stop['type'] | string): IconName => (type === 'train' ? 'train' : type === 'bus' ? 'bus' : type === 'tram' ? 'tram' : type === 'ship' ? 'ship' : type === 'cableway' ? 'cableway' : 'stop')

/** A line as the timetable prints it, in the operator's colours when it sends them. */
export const LineChip = ({ leg }: { leg: Pick<Leg, 'line' | 'category' | 'type' | 'bgColor' | 'fgColor' | 'kind'> }) => {
  if (leg.kind === 'walk') return <span className="line-chip line-chip-walk"><Icon name="walk" size={14} /></span>
  const colors = chipColors(leg)
  return (
    <span className={`line-chip${colors.background ? ' line-chip-colored' : ''}`} style={colors}>
      <Icon name={stopIcon(leg.type)} size={14} />
      <span>{leg.line || leg.category}</span>
    </span>
  )
}

export const delayText = (delay: number | null | undefined, cancelled: boolean, t: Strings): string => {
  const kind = delayClass(delay, cancelled)
  return kind === 'cancelled' ? t.tripCancelled : kind === 'ok' ? t.delayOnTime : t.delayMinutes(delay as number)
}

/** on time / +1-2 / +3-5 / >5 / cancelled, as colour and words (never colour alone). */
export const DelayBadge = ({ delay, cancelled = false, t, label }: { delay: number | null | undefined; cancelled?: boolean; t: Strings; label?: string }) => {
  const kind = delayClass(delay, cancelled)
  return <span className={`delay-badge delay-${kind}`}>{label || delayText(delay, cancelled, t)}</span>
}

export const Platform = ({ platform, changed, t }: { platform: string; changed: boolean; t: Strings }) => {
  if (!platform) return null
  return (
    <span className={`platform${changed ? ' platform-changed' : ''}`} title={changed ? t.platformChanged : undefined}>
      {changed ? <Icon name="warning" size={13} /> : null}
      <span>{t.platformShort} {platform}</span>
      {changed ? <span className="sr-only"> ({t.platformChanged})</span> : null}
    </span>
  )
}

/** Three people per class, filled by the forecast level. */
export const OccupancyMeter = ({ occupancy, t }: { occupancy: Occupancy; t: Strings }) => {
  if (!hasOccupancy(occupancy)) return null
  const row = (label: string, short: string, value: Occupancy['first']) => {
    const level = occupancyLevel(value)
    const text = level ? t.occupancyLevels[level] : t.occupancyUnknown
    return (
      <span className={`occupancy-class level-${level}`} title={`${label}: ${text}`} aria-label={`${label}: ${text}`}>
        <span className="occupancy-name" aria-hidden="true">{short}</span>
        <span className="occupancy-people" aria-hidden="true">{[1, 2, 3].map((n) => <span key={n} className={n <= level ? 'on' : ''}><Icon name="person" size={13} /></span>)}</span>
      </span>
    )
  }
  return <span className="occupancy">{row(t.occupancy1, '1.', occupancy.first)}{row(t.occupancy2, '2.', occupancy.second)}</span>
}

const Moment = ({ point, cancelled = false }: { point: TripPoint; cancelled?: boolean }) => {
  const late = (point.delay || 0) > 0
  return (
    <span className="moment tabular">
      {late && clockOf(point.planned) !== clockOf(point.time) ? <s>{clockOf(point.planned)}</s> : null}
      <strong className={`moment-real delay-text-${delayClass(point.delay, cancelled)}`}>{clockOf(point.time)}</strong>
    </span>
  )
}

const Timeline = ({ trip, t }: { trip: Trip; t: Strings }) => {
  const rides = rideLegs(trip).length
  let rideIndex = -1
  return (
    <ol className="legs">
      {trip.legs.map((leg, index) => {
        if (leg.kind === 'ride') rideIndex += 1
        const change = leg.kind === 'ride' && rideIndex < rides - 1 ? trip.changes[rideIndex] : undefined
        return (
          <li key={`${leg.from.stopId}-${index}`} className={`leg leg-${leg.kind}${leg.cancelled ? ' leg-cancelled' : ''}`}>
            <div className="leg-point">
              <Moment point={leg.from} cancelled={leg.cancelled} />
              <span className="leg-place">{leg.from.name}</span>
              <Platform platform={leg.from.platform} changed={leg.from.platformChanged} t={t} />
            </div>
            <div className="leg-body">
              <LineChip leg={leg} />
              <span className="leg-text">
                {leg.kind === 'walk' ? t.legWalk(leg.minutes) : [leg.direction ? t.legDirection(leg.direction) : '', leg.operator, durationLabel(leg.minutes)].filter(Boolean).join(' · ')}
              </span>
              {leg.cancelled ? <Tag tone="danger">{t.tripCancelled}</Tag> : null}
              {leg.kind === 'ride' ? <OccupancyMeter occupancy={leg.occupancy} t={t} /> : null}
              {leg.notes.map((note) => <p key={note} className="leg-note"><Icon name="info" size={14} />{note}</p>)}
            </div>
            <div className="leg-point">
              <Moment point={leg.to} cancelled={leg.cancelled} />
              <span className="leg-place">{leg.to.name}</span>
              <Platform platform={leg.to.platform} changed={leg.to.platformChanged} t={t} />
            </div>
            {change ? <TransferNote change={change} t={t} /> : null}
          </li>
        )
      })}
    </ol>
  )
}

export const TransferNote = ({ change, t }: { change: Trip['changes'][number]; t: Strings }) => (
  <p className={`transfer${change.broken ? ' transfer-broken' : change.tight ? ' transfer-tight' : ''}`}>
    <Icon name={change.broken ? 'warning' : 'swap'} size={14} />
    <span>{t.transferAt(change.at, change.minutes)}</span>
    {change.broken ? <Tag tone="danger">{t.transferBroken}</Tag> : change.tight ? <Tag tone="warning">{t.transferTight}</Tag> : null}
    {change.plannedMinutes !== change.minutes ? <small className="muted">({change.plannedMinutes} min)</small> : null}
  </p>
)

/** One connection: departure (planned struck when late), arrival, lines, platform, changes and forecast; opens into the legs. */
export const TripCard = ({ trip, t, open: startOpen = false, compact = false }: { trip: Trip; t: Strings; open?: boolean; compact?: boolean }) => {
  const [open, setOpen] = useState(startOpen)
  const cancelled = tripCancelled(trip)
  const delay = departureDelay(trip)
  const kind = delayClass(delay, cancelled)
  const { platform, changed } = departurePlatform(trip)
  const late = !cancelled && clockOf(trip.plannedDeparture) !== clockOf(trip.departure)
  const lateArrival = (trip.arrDelay || 0) > 0 && clockOf(trip.plannedArrival) !== clockOf(trip.arrival)
  const label = trip.status === 'broken' ? t.tripBroken : delayText(delay, cancelled, t)
  const detail = (
    <>
      {trip.issues.filter((issue) => issue.kind !== 'platformChange').map((issue) => <p key={issue.text} className="leg-note"><Icon name="info" size={14} />{issue.text}</p>)}
      <Timeline trip={trip} t={t} />
    </>
  )
  return (
    <article className={`trip trip-${kind}${cancelled ? ' trip-cancelled' : ''}${trip.quietest ? ' trip-quietest' : ''}`} data-trip={trip.id}>
      <button type="button" className="trip-head" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`${clockOf(trip.departure)} ${label}. ${open ? t.tripHideDetails : t.tripShowDetails}`}>
        <span className="trip-times tabular">
          <span className="trip-dep">
            {late ? <s className="trip-planned">{clockOf(trip.plannedDeparture)}</s> : null}
            <strong className={`trip-real delay-text-${kind}`}>{clockOf(trip.departure)}</strong>
          </span>
          <Icon name="forward" size={16} />
          <span className="trip-arr">
            {lateArrival ? <s className="trip-planned">{clockOf(trip.plannedArrival)}</s> : null}
            <span className={lateArrival ? `delay-text-${delayClass(trip.arrDelay)}` : ''}>{clockOf(trip.arrival)}</span>
          </span>
        </span>
        <span className="trip-chips">
          {rideLegs(trip).map((leg, index) => <LineChip key={`${leg.line}-${index}`} leg={leg} />)}
          {trip.legs.length && !rideLegs(trip).length ? <LineChip leg={trip.legs[0]} /> : null}
        </span>
        <span className="trip-status">
          <DelayBadge delay={delay} cancelled={cancelled} t={t} label={trip.status === 'broken' ? t.tripBroken : undefined} />
          {trip.quietest && !cancelled ? <Tag tone="success">{t.quietest}</Tag> : null}
        </span>
        <span className="trip-meta">
          <Platform platform={platform} changed={changed} t={t} />
          <span>{durationLabel(trip.minutes)}</span>
          <span>{trip.transfers ? t.transferCount(trip.transfers) : t.transferDirect}</span>
          {trip.changes.map((change, index) => (
            <span key={index} className={`xfer${change.broken ? ' xfer-broken' : change.tight ? ' xfer-tight' : ''}`} title={t.transferMinutes(change.minutes)}>
              {change.broken ? <Icon name="warning" size={13} /> : null}{change.minutes} min{change.broken ? ` · ${t.transferBroken}` : change.tight ? ` · ${t.transferTight}` : ''}
            </span>
          ))}
        </span>
        {compact ? null : <span className="trip-occupancy"><OccupancyMeter occupancy={trip.occupancy} t={t} /></span>}
        <span className="trip-toggle" aria-hidden="true"><Icon name={open ? 'up' : 'down'} size={18} /></span>
      </button>
      {open ? <div className="trip-detail">{detail}</div> : null}
    </article>
  )
}

export const targetLine = (target: CommuteTarget, t: Strings): string => {
  const at = clockOf(target.at)
  switch (target.kind) {
    case 'firstLesson': return target.lesson ? t.targetFirst(at, clockOf(target.lesson.start)) : t.targetArriveBy(at)
    case 'lastLesson': return target.lesson ? t.targetLast(at, clockOf(target.lesson.end)) : t.targetDepartAt(at)
    case 'time': return target.timeType === 'arrive' ? t.targetArriveBy(at) : t.targetDepartAt(at)
    default: return t.targetNow
  }
}

/** Banner for a school day that starts later or ends earlier than planned. */
export const LessonChangeBanner = ({ board, t }: { board: RouteBoard | undefined; t: Strings }) => {
  const change = lessonChange(board)
  if (!change) return null
  return (
    <Banner tone="accent" icon="info">
      {change.kind === 'lastCancelled'
        ? <strong>{t.lastCancelled(change.line, change.time, change.plannedTime)}</strong>
        : <><strong>{t.firstCancelled}</strong><span>{t.firstCancelledBody(change.line, change.time)}</span></>}
    </Banner>
  )
}

/** The cancelled or broken first trip: what happened and what to take instead. */
export const StatusBanner = ({ board, route, t }: { board: RouteBoard; route?: CommuteRoute; t: Strings }) => {
  const first = board.trips[0]
  if (!first || !tripCancelled(first)) return null
  return (
    <div className="status-block">
      <Banner tone="danger" icon="warning">
        <strong>{first.status === 'broken' ? t.bannerBroken : t.bannerCancelled}: {clockOf(first.plannedDeparture)}</strong>
        {first.issues[0]?.text ? <span>{first.issues[0].text}</span> : null}
        {board.alternatives.length && board.viaDropped ? <span>{route?.via ? `${t.viaDropped} (${route.via.name})` : t.viaDropped}</span> : null}
      </Banner>
      {board.alternatives.length ? (
        <div className="alternatives">
          <h3>{t.alternatives}</h3>
          {board.alternatives.map((trip) => <TripCard key={trip.id} trip={trip} t={t} compact />)}
        </div>
      ) : null}
    </div>
  )
}

/** Everything under the route header: banners, the trips, browsing buttons and the occupancy note. */
export const BoardBody = ({ route, board, trips, t, onEarlier, onLater, busy = '', browseError = false, noMore = false }: {
  route?: CommuteRoute
  board: RouteBoard
  trips: Trip[]
  t: Strings
  onEarlier?: () => void
  onLater?: () => void
  busy?: '' | 'earlier' | 'later'
  browseError?: boolean
  noMore?: boolean
}) => (
  <div className="board-body">
    <LessonChangeBanner board={board} t={t} />
    <StatusBanner board={board} route={route} t={t} />
    {board.stale ? <Banner tone="warning" icon="warning">{t.boardStale(clockOf(board.updatedAt))}</Banner> : null}
    {onEarlier ? <button type="button" className="button button-outline browse" onClick={onEarlier} disabled={busy !== ''}>{busy === 'earlier' ? <span className="spinner spinner-small" aria-hidden="true" /> : <Icon name="up" size={18} />}{t.boardEarlier}</button> : null}
    {trips.length ? <div className="trips">{trips.map((trip) => <TripCard key={trip.id} trip={trip} t={t} />)}</div> : <p className="muted board-empty">{t.boardNoTrips}</p>}
    {onLater ? <button type="button" className="button button-outline browse" onClick={onLater} disabled={busy !== ''}>{busy === 'later' ? <span className="spinner spinner-small" aria-hidden="true" /> : <Icon name="down" size={18} />}{t.boardLater}</button> : null}
    {browseError ? <p className="muted small" role="status">{t.boardMoreFailed}</p> : noMore ? <p className="muted small" role="status">{t.boardNoMore}</p> : null}
    <p className="muted small occupancy-note">{t.occupancyNote}</p>
  </div>
)
