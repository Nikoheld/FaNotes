// The connection detail ("Verbindungsdetail"): one trip with its legs, every stop on a vertical rail,
// real times, platforms, the transfers and where the vehicle is now. It opens as a side panel on
// desktop and fills the screen on a phone; the data comes from the commute store (server or demo).
import { useState, type CSSProperties } from 'react'
import { changeAfter, clockOf, delayClass, departureDelay, durationLabel, dwellMinutes, delayBadgeRows, legRows, pinnedPoints, positionInfo, railItems, rowProgress, rowShowsPlanned, rowTime, transferWarning, tripCancelled, type RailRow } from '../lib/commute'
import type { Strings } from '../lib/i18n'
import { useTripDetail } from '../lib/useTripDetail'
import type { Commute } from '../state-commute'
import type { Leg, Position, Trip, TripDetail } from '../types'
import { DelayBadge, LineChip, OccupancyMeter, Platform, stopIcon } from './commute'
import { Banner, Button, Dialog, Icon, IconButton, Tag } from './ui'

/** CSS custom property in a React style object (the progress of the vehicle between two stops). */
const progressStyle = (progress: number): CSSProperties => ({ ['--p' as string]: String(Math.round(progress * 1000) / 1000) })

const Vehicle = ({ leg, position, t }: { leg: Leg; position: Position; t: Strings }) => (
  <span className={`rail-vehicle${position.estimated ? ' is-estimated' : ''}`} style={position.state === 'between' ? progressStyle(position.progress) : progressStyle(0)}>
    <Icon name={stopIcon(leg.type)} size={13} />
    <span className="sr-only">{t.vehicleHere}{position.estimated ? ` (${t.estimatedShort})` : ''}</span>
  </span>
)

const RailRowView = ({ row, leg, legIndex, position, badge, t }: { row: RailRow; leg: Leg; legIndex: number; position: Position | undefined; badge: boolean; t: Strings }) => {
  const progress = rowProgress(position, legIndex, row.index)
  const time = rowTime(row)
  const hasVehicle = Boolean(position && position.legIndex === legIndex && position.state !== 'notStarted' && position.point === row.index)
  const delay = row.realtime && !row.cancelled ? time?.delay ?? null : null
  const dwell = dwellMinutes(row)
  return (
    <li className={`rail-row rail-${row.kind} is-${progress}${row.cancelled ? ' is-cancelled' : ''}${hasVehicle ? ' has-vehicle' : ''}${position?.state === 'between' && hasVehicle ? ' is-between' : ''}`} style={hasVehicle && position ? progressStyle(position.state === 'between' ? position.progress : 0) : undefined}>
      <div className="rail-time tabular">
        <span className="sr-only">{row.kind === 'board' ? t.tripDeparture : t.tripArrival}</span>
        {time ? <>
          {rowShowsPlanned(row) ? <s>{clockOf(time.planned)}</s> : null}
          <strong className={`delay-text-${delayClass(delay, row.cancelled)}`}>{clockOf(row.realtime && !row.cancelled ? time.time : time.planned)}</strong>
        </> : null}
      </div>
      <div className="rail-track" aria-hidden="true">
        <span className="rail-dot" />
        {hasVehicle && position ? <Vehicle leg={leg} position={position} t={t} /> : null}
      </div>
      <div className="rail-body">
        <span className="rail-name">{row.name}</span>
        <span className="rail-chips">
          {row.cancelled ? <Tag tone="danger">{t.stopCancelled}</Tag> : null}
          {badge && delay != null && delay > 0 ? <DelayBadge delay={delay} t={t} /> : null}
          {!row.cancelled ? <Platform platform={row.platform} changed={row.platformChanged} t={t} /> : null}
          {!row.realtime && !row.cancelled ? <span className="rail-note">{t.noRealtime}</span> : null}
          {dwell > 0 && !row.cancelled ? <span className="rail-note">{t.dwell(dwell)}</span> : null}
        </span>
      </div>
    </li>
  )
}

const LegBlock = ({ leg, legIndex, position, t }: { leg: Leg; legIndex: number; position: Position | undefined; t: Strings }) => {
  const [expanded, setExpanded] = useState(false)
  const rows = legRows(leg)
  const hidden = rows.filter((row) => row.kind === 'stop').length
  const keep = pinnedPoints(leg, legIndex, position)
  const items = railItems(rows, expanded, keep)
  const badges = delayBadgeRows(rows)
  const label = leg.line || leg.category
  return (
    <section className={`dt-leg${leg.cancelled ? ' is-cancelled' : ''}`}>
      <header className="dt-leg-head">
        <LineChip leg={leg} />
        {leg.direction ? <span className="dt-direction"><Icon name="forward" size={14} />{leg.direction}</span> : null}
        {leg.cancelled ? <Tag tone="danger">{t.tripCancelled}</Tag> : null}
        {leg.operator ? <small className="dt-operator muted">{leg.operator}</small> : null}
        <OccupancyMeter occupancy={leg.occupancy} t={t} />
      </header>
      {leg.notes.map((note) => <p key={note} className="leg-note"><Icon name="info" size={14} />{note}</p>)}
      <ol className="rail" aria-label={t.detailStopList(label)}>
        {items.map((item) => {
          if (item.type === 'row') return <RailRowView key={item.row.index} row={item.row} leg={leg} legIndex={legIndex} position={position} badge={badges.has(item.row.index)} t={t} />
          const progress = rowProgress(position, legIndex, item.from)
          return (
            <li key={`gap-${item.from}`} className={`rail-row rail-gap is-${progress}`}>
              <div className="rail-time" />
              <div className="rail-track" aria-hidden="true" />
              <div className="rail-body">
                <button type="button" className="rail-toggle" aria-expanded="false" onClick={() => setExpanded(true)}>
                  <Icon name="down" size={16} />{t.detailStops(item.count)}
                </button>
              </div>
            </li>
          )
        })}
      </ol>
      {expanded && hidden > 0 ? (
        <button type="button" className="rail-toggle rail-toggle-hide" aria-expanded="true" onClick={() => setExpanded(false)}><Icon name="up" size={16} />{t.detailStopsHide}</button>
      ) : null}
    </section>
  )
}

const TransferRow = ({ change, t }: { change: Trip['changes'][number]; t: Strings }) => {
  const warning = transferWarning(change)
  return (
    <li className={`dt-transfer${warning ? ` dt-transfer-${warning}` : ''}`}>
      <Icon name={warning === 'broken' ? 'warning' : 'swap'} size={16} />
      <span>{t.transferAt(change.at, change.minutes)}</span>
      {warning === 'broken' ? <Tag tone="danger">{t.transferBroken}</Tag> : warning === 'tight' ? <Tag tone="warning">{t.transferAtRisk}</Tag> : null}
    </li>
  )
}

const WalkRow = ({ leg, t }: { leg: Leg; t: Strings }) => (
  <li className="dt-walk">
    <div />
    <div className="rail-track" aria-hidden="true" />
    <span className="dt-walk-text"><Icon name="walk" size={16} />{t.legWalk(leg.minutes)}</span>
  </li>
)

/** "Hält in X", "Zwischen X und Y", ...: where the vehicle is, in words. */
export const PositionLine = ({ trip, position, t }: { trip: Trip; position: Position | undefined; t: Strings }) => {
  const info = positionInfo(trip, position)
  if (!info) return null
  const text = info.state === 'notStarted' ? t.posNotStarted : info.state === 'atStop' ? t.posAt(info.at) : info.state === 'between' ? t.posBetween(info.at, info.next) : info.state === 'transfer' ? t.posTransfer(info.at) : t.posArrived
  return (
    <p className={`dt-position dt-pos-${info.state}`} role="status">
      <span className="dt-pos-dot" aria-hidden="true" />
      <span>{text}</span>
      {info.estimated && info.state !== 'notStarted' ? <Tag>{t.estimatedShort}</Tag> : null}
    </p>
  )
}

const Skeleton = ({ t }: { t: Strings }) => (
  <div className="dt-skeleton" role="status" aria-busy="true">
    <span className="sr-only">{t.detailLoading}</span>
    <div className="skel skel-title" />
    <div className="skel skel-line" />
    <div className="skel skel-card" />
    <div className="skel skel-card" />
  </div>
)

export const DetailContent = ({ trip, detail, routeName, t }: { trip: Trip; detail: TripDetail; routeName: string; t: Strings }) => {
  const cancelled = tripCancelled(trip)
  const delay = departureDelay(trip)
  const late = !cancelled && clockOf(trip.plannedDeparture) !== clockOf(trip.departure)
  const lateArrival = !cancelled && (trip.arrDelay || 0) > 0 && clockOf(trip.plannedArrival) !== clockOf(trip.arrival)
  const position = cancelled ? undefined : detail.position
  const sources = detail.sources
  return (
    <>
      <header className="dt-summary">
        {routeName ? <p className="dt-route">{routeName}</p> : null}
        <div className={`dt-times tabular${cancelled ? ' is-cancelled' : ''}`}>
          <span className="dt-dep">
            {late ? <s>{clockOf(trip.plannedDeparture)}</s> : null}
            <strong className={`delay-text-${delayClass(delay, cancelled)}`}>{clockOf(trip.departure)}</strong>
          </span>
          <Icon name="forward" size={20} />
          <span className="dt-arr">
            {lateArrival ? <s>{clockOf(trip.plannedArrival)}</s> : null}
            <strong className={lateArrival ? `delay-text-${delayClass(trip.arrDelay)}` : ''}>{clockOf(trip.arrival)}</strong>
          </span>
        </div>
        <div className="dt-facts">
          <DelayBadge delay={delay} cancelled={cancelled} t={t} label={trip.status === 'broken' ? t.tripBroken : undefined} />
          <span>{durationLabel(trip.minutes)}</span>
          <span>{trip.transfers ? t.transferCount(trip.transfers) : t.transferDirect}</span>
        </div>
        <PositionLine trip={trip} position={position} t={t} />
      </header>
      {trip.issues.filter((issue) => issue.kind !== 'platformChange').map((issue) => <p key={issue.text} className="leg-note"><Icon name="info" size={14} />{issue.text}</p>)}
      {detail.stale ? <Banner tone="warning" icon="warning">{t.boardStale(clockOf(detail.updatedAt || ''))}</Banner> : null}
      <ol className="dt-legs">
        {trip.legs.map((leg, index) => {
          const change = leg.kind === 'ride' ? changeAfter(trip, index) : undefined
          return (
            <li key={`${leg.from.stopId}-${index}`} className="dt-item">
              {leg.kind === 'ride' ? <LegBlock leg={leg} legIndex={index} position={position} t={t} /> : <ol className="dt-walks"><WalkRow leg={leg} t={t} /></ol>}
              {change ? <ol className="dt-transfers"><TransferRow change={change} t={t} /></ol> : null}
            </li>
          )
        })}
      </ol>
      <footer className="dt-foot">
        {sources ? <p>{t.detailSources(sources.realtime, sources.platforms)}</p> : null}
        <p>{t.detailNoFormation}</p>
        <p>{t.occupancyNote}</p>
      </footer>
    </>
  )
}

/** The side panel. `routeName` is shown above the times; the trip itself comes from the server (or demo). */
export const ConnectionDetail = ({ commute, routeId, routeName, tripId, at, t, onClose }: {
  commute: Pick<Commute, 'tripDetail'>
  routeId: string
  routeName: string
  tripId: string
  at: string
  t: Strings
  onClose: () => void
}) => {
  const { detail, loading, refreshing, failed, reload } = useTripDetail(commute, routeId, tripId, at)
  const trip = detail?.trip || null
  const unreachable = !loading && !trip && !detail?.gone
  const updated = clockOf(detail?.updatedAt || '')
  return (
    <Dialog title={t.detailTitle} onClose={onClose} side>
      <div className="dt" aria-busy={loading || refreshing}>
        <div className="dt-bar">
          <span className="dt-stand muted tabular">{updated ? t.boardUpdated(updated) : ''}</span>
          <IconButton icon="refresh" label={t.detailRefresh} onClick={reload} disabled={loading || refreshing} />
        </div>
        {loading ? <Skeleton t={t} /> : null}
        {!loading && detail?.gone ? <Banner tone="warning" icon="info">{t.detailGone}</Banner> : null}
        {unreachable ? <Banner tone="danger" icon="warning" action={<Button tone="outline" onClick={reload}>{t.tryAgain}</Button>}>{t.detailFailed}</Banner> : null}
        {failed && trip ? <Banner tone="warning" icon="warning">{t.detailRefreshFailed(updated)}</Banner> : null}
        {trip && detail ? <DetailContent trip={trip} detail={detail} routeName={routeName} t={t} /> : null}
      </div>
    </Dialog>
  )
}

