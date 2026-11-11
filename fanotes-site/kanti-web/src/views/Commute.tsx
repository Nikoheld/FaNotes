// Pendeln: the live board per route, the trip details and the route management.
import { useEffect, useMemo, useState } from 'react'
import { browseRequest, clockOf, emptyRoute, MAX_ROUTES, mergeTrips, moveRoute, relevantRoute, routeLabel, THRESHOLDS, upsertRoute } from '../lib/commute'
import { useCommuteLive } from '../lib/useCommuteLive'
import { useKanti } from '../state'
import type { CommuteRoute, Trip } from '../types'
import { BoardBody, targetLine } from '../components/commute'
import { RouteEditor } from '../components/RouteEditor'
import { Banner, Button, Card, Dialog, Empty, Icon, IconButton, SectionLabel } from '../components/ui'
import { useClock } from './common'

const scheduleSummary = (route: CommuteRoute, t: ReturnType<typeof useKanti>['t']): string => {
  const { mode, times, days, bufferMinutes } = route.schedule
  if (mode === 'none') return t.scheduleModes.none
  const dayText = days.length === 7 ? '' : days.length === 5 && days.join() === '1,2,3,4,5' ? `${t.weekdays[0]}–${t.weekdays[4]}` : days.map((day) => t.weekdays[day - 1]).join(' ')
  const head = mode === 'times' ? times.join(' · ') : `${t.scheduleModes[mode]} (${bufferMinutes} ${t.minutesShort})`
  return [head, dayText].filter(Boolean).join(' · ')
}

export const Commute = () => {
  const kanti = useKanti()
  const { t, commute, route: location } = kanti
  const clock = useClock()
  useCommuteLive(commute)
  const [editing, setEditing] = useState<{ route: CommuteRoute; isNew: boolean } | null>(null)
  const [deleting, setDeleting] = useState<CommuteRoute | null>(null)
  const [error, setError] = useState('')
  const [extra, setExtra] = useState<Record<string, Trip[]>>({})
  const [busy, setBusy] = useState<'' | 'earlier' | 'later'>('')
  const [browse, setBrowse] = useState<{ failed: boolean; none: boolean }>({ failed: false, none: false })

  const { routes, boards } = commute
  const wanted = location.params.get('strecke') || ''
  const fallback = relevantRoute({ routes, boards, now: Date.now(), clockMinutes: clock.minutes })
  const selected = routes.find((route) => route.id === wanted) || fallback
  const board = selected ? boards[selected.id] : undefined
  const trips = useMemo(() => (board ? mergeTrips(board.trips, extra[board.routeId] || []) : []), [board, extra])

  const openNew = () => setEditing({ route: emptyRoute(), isNew: true })
  // "?neu=1" (from the Today card) opens the editor once the routes are known.
  const wantsNew = location.params.get('neu') === '1'
  useEffect(() => {
    if (!wantsNew || !commute.loaded) return
    if (routes.length < MAX_ROUTES) setEditing({ route: emptyRoute(), isNew: true })
    kanti.navigate('commute', {}, true)
  }, [wantsNew, commute.loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const persist = async (next: CommuteRoute[], settings?: { delayThreshold: number }) => {
    setError('')
    try { await commute.save(next, settings) } catch (failure) { setError(failure instanceof Error && failure.message ? `${t.commuteSaveFailed} (${failure.message})` : t.commuteSaveFailed); throw failure }
  }
  const choose = (id: string) => kanti.navigate('commute', { strecke: id }, true)

  const more = async (direction: 'earlier' | 'later') => {
    if (!board) return
    const request = browseRequest(trips, direction)
    if (!request) return
    setBusy(direction)
    setBrowse({ failed: false, none: false })
    try {
      const found = await commute.trips(board.routeId, request.at, request.timeType)
      const known = new Set(trips.map((trip) => trip.id))
      const fresh = found.filter((trip) => !known.has(trip.id))
      setExtra((current) => ({ ...current, [board.routeId]: mergeTrips(current[board.routeId] || [], fresh) }))
      setBrowse({ failed: false, none: fresh.length === 0 })
    } catch {
      setBrowse({ failed: true, none: false })
    }
    setBusy('')
  }

  if (commute.unavailable) return <div className="view view-commute"><Card><Empty icon="info">{t.commuteUnavailable}</Empty></Card></div>
  if (!commute.loaded) {
    return <div className="view view-commute">{commute.error ? <Banner tone="danger" icon="warning" action={<Button tone="outline" onClick={() => void commute.ensure()}>{t.tryAgain}</Button>}>{t.boardFailed}</Banner> : <div className="loading"><span className="spinner" /></div>}</div>
  }

  return (
    <div className="view view-commute">
      {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
      {!routes.length ? (
        <Card className="hero hero-clear commute-empty">
          <Icon name="train" size={30} />
          <h2>{t.commuteEmptyTitle}</h2>
          <p>{t.commuteEmptyBody}</p>
          <Button icon="plus" onClick={openNew}>{t.commuteAddRoute}</Button>
        </Card>
      ) : (
        <div className="columns">
          <div className="column column-main">
            {routes.length > 1 ? (
              <div className="route-tabs" role="tablist" aria-label={t.commuteRoutes}>
                {routes.map((route) => (
                  <button type="button" role="tab" key={route.id} aria-selected={route.id === selected?.id} className={route.id === selected?.id ? 'active' : ''} onClick={() => choose(route.id)}>{routeLabel(route)}</button>
                ))}
              </div>
            ) : null}
            {selected ? (
              <Card className="board">
                <header className="board-head">
                  <div className="board-title">
                    <h2>{routeLabel(selected)}</h2>
                    <p className="board-stops">{selected.from.name} <Icon name="forward" size={14} /> {selected.to.name}{selected.via ? <small className="muted"> · {selected.via.name}</small> : null}</p>
                  </div>
                  <IconButton icon="refresh" label={t.commuteRefresh} onClick={() => void commute.refreshBoards(true)} disabled={commute.boardLoading} />
                </header>
                {board ? <p className="board-target">{targetLine(board.target, t)}<small className="muted"> · {t.boardUpdated(clockOf(board.updatedAt))}</small></p> : null}
                {commute.boardError && !board ? <Banner tone="danger" icon="warning" action={<Button tone="outline" onClick={() => void commute.refreshBoards(true)}>{t.tryAgain}</Button>}>{t.boardFailed}</Banner> : null}
                {commute.boardError && board ? <Banner tone="warning" icon="warning">{t.boardFailed}</Banner> : null}
                {board ? (
                  <BoardBody
                    route={selected}
                    board={board}
                    trips={trips}
                    t={t}
                    busy={busy}
                    browseError={browse.failed}
                    noMore={browse.none}
                    onEarlier={() => void more('earlier')}
                    onLater={() => void more('later')}
                  />
                ) : !commute.boardError ? <div className="loading board-loading" role="status"><span className="spinner" /><span className="sr-only">{t.boardLoading}</span></div> : null}
                {commute.provider ? <p className="muted small board-provider">{t.commuteProvider(commute.provider.name)}</p> : null}
              </Card>
            ) : null}
          </div>

          <aside className="column column-side">
            <SectionLabel action={routes.length < MAX_ROUTES ? <Button tone="outline" icon="plus" onClick={openNew}>{t.commuteAddRoute}</Button> : null}>{t.commuteRoutes}</SectionLabel>
            <Card className="list">
              {routes.map((route, index) => (
                <div key={route.id} className={`route-row${route.id === selected?.id ? ' active' : ''}`}>
                  <button type="button" className="route-main" onClick={() => choose(route.id)}>
                    <strong>{routeLabel(route)}</strong>
                    <small>{route.from.name} → {route.to.name}{route.via ? ` · ${route.via.name}` : ''}</small>
                    <small className="muted">{scheduleSummary(route, t)}</small>
                  </button>
                  <div className="route-actions">
                    <IconButton icon="up" label={`${t.commuteMoveUp}: ${routeLabel(route)}`} disabled={index === 0} onClick={() => void persist(moveRoute(routes, index, -1)).catch(() => undefined)} />
                    <IconButton icon="down" label={`${t.commuteMoveDown}: ${routeLabel(route)}`} disabled={index === routes.length - 1} onClick={() => void persist(moveRoute(routes, index, 1)).catch(() => undefined)} />
                    <IconButton icon="edit" label={`${t.commuteEdit}: ${routeLabel(route)}`} onClick={() => setEditing({ route, isNew: false })} />
                    <IconButton icon="delete" label={`${t.commuteDelete}: ${routeLabel(route)}`} onClick={() => setDeleting(route)} />
                  </div>
                </div>
              ))}
            </Card>
            <Card className="form commute-global">
              <label className="field">
                <span className="field-label">{t.commuteGlobalThreshold}</span>
                <select value={commute.settings.delayThreshold} onChange={(event) => void persist(routes, { delayThreshold: Number(event.target.value) }).catch(() => undefined)}>
                  {[...new Set([...THRESHOLDS, commute.settings.delayThreshold])].sort((a, b) => a - b).map((minutes) => <option key={minutes} value={minutes}>{t.commuteThresholdMin(minutes)}</option>)}
                </select>
              </label>
              <p className="muted small">{t.commuteGlobalThresholdBody}</p>
            </Card>
          </aside>
        </div>
      )}

      {editing ? (
        <RouteEditor
          initial={editing.route}
          isNew={editing.isNew}
          globalThreshold={commute.settings.delayThreshold}
          search={commute.stops}
          t={t}
          onClose={() => setEditing(null)}
          onSave={async (route) => {
            await commute.save(upsertRoute(routes, route))
            setEditing(null)
            if (editing.isNew) choose(route.id)
          }}
        />
      ) : null}
      {deleting ? (
        <Dialog title={t.commuteDelete} onClose={() => setDeleting(null)}>
          <p>{t.commuteDeleteConfirm(routeLabel(deleting))}</p>
          <div className="dialog-actions">
            <Button tone="quiet" onClick={() => setDeleting(null)}>{t.cancel}</Button>
            <Button tone="danger" onClick={() => { const target = deleting; setDeleting(null); void persist(routes.filter((route) => route.id !== target.id)).catch(() => undefined) }}>{t.commuteDelete}</Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
