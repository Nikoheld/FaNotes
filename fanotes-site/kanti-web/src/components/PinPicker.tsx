// "Feste Verbindung" of the route editor: none / the same every day / per weekday, and the picker
// that lists real connections (GET /commute/connections) to choose one from.
import { useEffect, useRef, useState } from 'react'
import {
  assignPin, clockOf, connectionsQuery, dayLabel, defaultPickTime, durationLabel, isClock, mergeTrips, nextDateForWeekday, pickerPage, pinForDay, pinFromTrip, removePinDay, rideLegs,
  routeVias, travelDays, zurichAt, type ConnectionsQuery, type PinMode,
} from '../lib/commute'
import type { Strings } from '../lib/i18n'
import type { CommuteRoute, Pin, Stop, Trip } from '../types'
import { LineChip, OccupancyMeter } from './commute'
import { Banner, Button, Icon } from './ui'

export type ConnectionsFn = (query: ConnectionsQuery, stops: { from: Stop; to: Stop; vias: Stop[] }) => Promise<Trip[]>

const MODES: PinMode[] = ['none', 'daily', 'weekday']

/** "07:12 IR 16 ab Aarau · an 07:41 · 1 Umstieg". */
export const pinText = (pin: Pin, t: Strings): string => t.pinSummary(pin.departure, pin.line, pin.stop, pin.arrival, pin.transfers)

const daysText = (days: number[], t: Strings): string => (days.join() === '1,2,3,4,5' ? `${t.weekdays[0]}–${t.weekdays[4]}` : days.map((day) => t.weekdays[day - 1]).join(' '))

const PickTrip = ({ trip, t, onPick }: { trip: Trip; t: Strings; onPick: (trip: Trip) => void }) => {
  const late = (trip.depDelay || 0) > 0
  return (
    <li>
      <button type="button" className="pick-trip" disabled={!trip.pin} onClick={() => onPick(trip)} data-trip={trip.id}>
        <span className="pick-times tabular">
          <strong>{clockOf(trip.plannedDeparture || trip.departure)}</strong>
          <Icon name="forward" size={14} />
          <span>{clockOf(trip.plannedArrival || trip.arrival)}</span>
          {late ? <small className="muted">+{trip.depDelay}</small> : null}
        </span>
        <span className="pick-chips">{rideLegs(trip).map((leg, index) => <LineChip key={`${leg.line}-${index}`} leg={leg} />)}</span>
        <span className="pick-meta">
          <span>{trip.transfers ? t.transferCount(trip.transfers) : t.transferDirect}</span>
          <span>{durationLabel(trip.minutes)}</span>
          <OccupancyMeter occupancy={trip.occupancy} t={t} />
        </span>
      </button>
    </li>
  )
}

/** Lists connections of one weekday (the next date with it) from a start time; earlier/later paging. */
const ConnectionPicker = ({ route, days, day: startDay, connections, t, onPick, onClose }: {
  route: CommuteRoute
  /** Weekdays the user may switch between; one entry fixes the day. */
  days: number[]
  day: number
  connections: ConnectionsFn
  t: Strings
  onPick: (trip: Trip, day: number) => void
  onClose: () => void
}) => {
  const [day, setDay] = useState(startDay)
  const [time, setTime] = useState(defaultPickTime(route.schedule))
  const [trips, setTrips] = useState<Trip[]>([])
  const [busy, setBusy] = useState<'' | 'search' | 'earlier' | 'later'>('')
  const [failed, setFailed] = useState(false)
  const [searched, setSearched] = useState(false)
  const serial = useRef(0)
  const date = nextDateForWeekday(day, Date.now())

  const load = async (at: string, kind: 'search' | 'earlier' | 'later') => {
    const mine = ++serial.current
    setBusy(kind)
    setFailed(false)
    try {
      const found = await connections(connectionsQuery(route, at), { from: route.from, to: route.to, vias: routeVias(route) })
      if (mine !== serial.current) return
      setTrips((current) => (kind === 'search' ? mergeTrips(found, []) : mergeTrips(current, found)))
    } catch {
      if (mine === serial.current) setFailed(true)
    }
    if (mine === serial.current) { setBusy(''); setSearched(true) }
  }
  const search = () => { if (isClock(time)) void load(zurichAt(date, time), 'search') }
  useEffect(() => { search() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { serial.current += 1 }, [])
  const page = (direction: 'earlier' | 'later') => {
    const at = pickerPage(trips, direction)
    if (at) void load(at, direction)
  }

  const dayName = t.weekdaysLong[day - 1]
  return (
    <section className="pin-picker" aria-label={t.pinPickerTitle(`${dayName}, ${dayLabel(date)}`)}>
      <div className="pin-picker-head">
        <h4>{t.pinPickerTitle(`${dayName}, ${dayLabel(date)}`)}</h4>
        <button type="button" className="icon-button" aria-label={t.pinClosePicker} title={t.pinClosePicker} onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      <div className="pin-picker-controls">
        {days.length > 1 ? (
          <label className="field">
            <span className="field-label">{t.pinDay}</span>
            <select value={day} onChange={(event) => setDay(Number(event.target.value))}>
              {days.map((value) => <option key={value} value={value}>{t.weekdaysLong[value - 1]}, {dayLabel(nextDateForWeekday(value, Date.now()))}</option>)}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span className="field-label">{t.pinTime}</span>
          <input type="time" value={time} aria-invalid={!isClock(time) || undefined} onChange={(event) => setTime(event.target.value)} />
        </label>
        <Button tone="outline" icon="search" onClick={search} disabled={busy !== '' || !isClock(time)}>{t.pinSearch}</Button>
      </div>
      {failed ? <Banner tone="warning" icon="warning">{t.pinLoadFailed}</Banner> : null}
      {busy === 'search' ? <p className="muted small" role="status"><span className="spinner spinner-small" aria-hidden="true" /> {t.pinSearching}</p> : null}
      {trips.length ? (
        <>
          <button type="button" className="button button-outline browse" onClick={() => page('earlier')} disabled={busy !== ''}><Icon name="up" size={18} />{t.pinEarlier}</button>
          <ul className="pick-list">{trips.map((trip) => <PickTrip key={trip.id} trip={trip} t={t} onPick={(picked) => onPick(picked, day)} />)}</ul>
          <button type="button" className="button button-outline browse" onClick={() => page('later')} disabled={busy !== ''}><Icon name="down" size={18} />{t.pinLater}</button>
        </>
      ) : searched && busy === '' && !failed ? <p className="muted small" role="status">{t.pinNoTrips}</p> : null}
    </section>
  )
}

export const PinSection = ({ route, mode, onMode, onPins, connections, t, startDay }: {
  route: CommuteRoute
  mode: PinMode
  onMode: (mode: PinMode) => void
  onPins: (pins: Pin[]) => void
  connections: ConnectionsFn
  t: Strings
  /** Opens the picker for this weekday at once (re-picking a missing connection). */
  startDay?: number
}) => {
  const [picking, setPicking] = useState<number | null>(startDay ?? null)
  const ready = Boolean(route.from.id && route.to.id)
  const travel = travelDays(route.schedule)
  const rows = [...new Set([...travel, ...route.pins.flatMap((pin) => pin.days)])].sort((a, b) => a - b)
  const open = picking != null && ready && mode !== 'none'

  const pick = (trip: Trip, day: number) => {
    const pin = pinFromTrip(trip, mode === 'daily' ? travel : [day])
    if (!pin) return
    onPins(mode === 'daily' ? [pin] : assignPin(route.pins, pin))
    setPicking(null)
  }
  const changeMode = (next: PinMode) => { setPicking(null); onMode(next) }

  return (
    <fieldset className="field pin-field">
      <legend className="field-label">{t.pinSection}</legend>
      <div className="segments pin-modes" role="radiogroup" aria-label={t.pinSection}>
        {MODES.map((value) => {
          const label = value === 'none' ? t.pinNone : value === 'daily' ? t.pinDaily : t.pinWeekday
          return <button type="button" role="radio" aria-checked={mode === value} key={value} className={mode === value ? 'active' : ''} onClick={() => changeMode(value)}>{label}</button>
        })}
      </div>
      {mode !== 'none' ? <p className="muted small">{t.pinHint}</p> : null}
      {mode !== 'none' && !ready ? <p className="muted small" role="status">{t.pinNeedStops}</p> : null}

      {mode === 'daily' ? (
        <div className="pin-rows">
          <div className="pin-row">
            <div className="pin-row-text">
              {route.pins[0] ? <><strong className="pin-summary">{pinText(route.pins[0], t)}</strong><small className="muted">{t.pinDaysNote(daysText(route.pins[0].days, t))}</small></> : <span className="muted">{t.pinNoPin}</span>}
            </div>
            <div className="pin-row-actions">
              <Button tone="outline" icon="pin" disabled={!ready} onClick={() => setPicking(travel[0])}>{route.pins[0] ? t.pinChange : t.pinChoose}</Button>
              {route.pins[0] ? <Button tone="quiet" icon="delete" onClick={() => { setPicking(null); onPins([]) }}>{t.pinRemove}</Button> : null}
            </div>
          </div>
        </div>
      ) : null}

      {mode === 'weekday' ? (
        <div className="pin-rows">
          {rows.map((day) => {
            const pin = pinForDay(route.pins, day)
            const name = t.weekdaysLong[day - 1]
            return (
              <div className="pin-row" key={day}>
                <div className="pin-row-text">
                  <small className="pin-weekday">{name}</small>
                  {pin ? <strong className="pin-summary">{pinText(pin, t)}</strong> : <span className="muted">{t.pinNoPin}</span>}
                </div>
                <div className="pin-row-actions">
                  <Button tone="outline" icon="pin" disabled={!ready} aria-label={`${pin ? t.pinChange : t.pinChoose}: ${name}`} onClick={() => setPicking(day)}>{pin ? t.pinChange : t.pinChoose}</Button>
                  {pin ? <Button tone="quiet" icon="delete" aria-label={`${t.pinRemove}: ${name}`} onClick={() => { setPicking(null); onPins(removePinDay(route.pins, day)) }}>{t.pinRemove}</Button> : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {open ? (
        <ConnectionPicker
          key={`${mode}-${picking}`}
          route={route}
          days={mode === 'daily' ? travel : [picking as number]}
          day={picking as number}
          connections={connections}
          t={t}
          onPick={pick}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </fieldset>
  )
}
