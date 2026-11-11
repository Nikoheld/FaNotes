// The commute data of the shown connection: routes, settings and the live boards. It lives in the
// provider so the Pendeln view, the Today card and the settings share one copy and one request.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, type Api } from './lib/api'
import { BOARD_MIN_MS, defaultSettings, normalizeRoute, sameLabels } from './lib/commute'
import { demoCommute } from './lib/demo-commute'
import type { CommuteProvider, CommuteRoute, CommuteSettings, RouteBoard, Stop, Trip } from './types'

export interface CommuteState {
  /** The routes have been read (or the demo is on). */
  loaded: boolean
  loading: boolean
  /** The server has no commute endpoint for this connection (404): the page hides the feature. */
  unavailable: boolean
  error: string
  routes: CommuteRoute[]
  settings: CommuteSettings
  provider: CommuteProvider | null
  boards: Record<string, RouteBoard>
  boardsAt: number
  boardLoading: boolean
  boardError: string
}

export interface CommuteActions {
  /** Reads the routes once per connection. */
  ensure: () => Promise<void>
  /** Loads the boards; skipped when the last load is younger than the server cache unless `force`. */
  refreshBoards: (force?: boolean) => Promise<void>
  save: (routes: CommuteRoute[], settings?: Partial<CommuteSettings>) => Promise<void>
  stops: (query: string) => Promise<Stop[]>
  trips: (routeId: string, at: string, timeType: 'depart' | 'arrive') => Promise<Trip[]>
}

export type Commute = CommuteState & CommuteActions

const EMPTY: CommuteState = {
  loaded: false, loading: false, unavailable: false, error: '', routes: [], settings: defaultSettings(), provider: null,
  boards: {}, boardsAt: 0, boardLoading: false, boardError: '',
}

const failure = (error: unknown): string => (error instanceof ApiError ? (error.status === 0 ? 'offline' : error.message) : error instanceof Error ? error.message : String(error))

export const useCommuteStore = ({ api, connectionId, demo, ready, hiddenLabels, onUnauthorized }: {
  api: Api
  connectionId: string
  demo: boolean
  ready: boolean
  /** null until the timetable is known: the stored labels then stay as they are. */
  hiddenLabels: string[] | null
  onUnauthorized: () => void
}): Commute => {
  const key = demo ? 'demo' : connectionId
  const [store, setStore] = useState<Record<string, CommuteState>>({})
  const storeRef = useRef(store)
  storeRef.current = store
  const demoState = useMemo<CommuteState>(() => {
    if (!demo) return EMPTY
    const seed = demoCommute(Date.now())
    return { ...EMPTY, loaded: true, routes: seed.routes, settings: seed.settings, provider: seed.provider, boards: seed.boards, boardsAt: Date.now() }
  }, [demo])
  const demoRef = useRef(demoState)
  demoRef.current = demoState
  const patch = useCallback((id: string, next: Partial<CommuteState>) => {
    setStore((current) => ({ ...current, [id]: { ...(current[id] || (id === 'demo' ? demoRef.current : EMPTY)), ...next } }))
  }, [])
  const state = demo ? (store.demo || demoState) : (store[key] || EMPTY)
  const stateRef = useRef(state)
  stateRef.current = state

  const handle = useCallback((error: unknown, id: string, target: 'error' | 'boardError') => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return }
    if (target === 'error' && error instanceof ApiError && error.status === 404) { patch(id, { unavailable: true, loading: false }); return }
    patch(id, target === 'error' ? { error: failure(error), loading: false } : { boardError: failure(error), boardLoading: false })
  }, [onUnauthorized, patch])

  const ensure = useCallback(async () => {
    if (demo || !ready || !connectionId) return
    const current = storeRef.current[connectionId]
    if (current?.loaded || current?.loading || current?.unavailable) return
    patch(connectionId, { loading: true, error: '' })
    try {
      const answer = await api.commute(connectionId)
      patch(connectionId, { loaded: true, loading: false, routes: answer.routes, settings: answer.settings, provider: answer.provider })
    } catch (error) {
      handle(error, connectionId, 'error')
    }
  }, [api, connectionId, demo, ready, patch, handle])

  const refreshBoards = useCallback(async (force = false) => {
    if (demo || !ready || !connectionId) return
    const current = storeRef.current[connectionId]
    if (!current?.loaded || !current.routes.length || current.boardLoading) return
    if (!force && current.boardsAt && Date.now() - current.boardsAt < BOARD_MIN_MS) return
    patch(connectionId, { boardLoading: true, boardError: '' })
    try {
      const answer = await api.commuteBoard(connectionId)
      const boards: Record<string, RouteBoard> = {}
      for (const board of answer.boards) boards[board.routeId] = board
      patch(connectionId, { boards, provider: answer.provider, boardsAt: Date.now(), boardLoading: false })
    } catch (error) {
      handle(error, connectionId, 'boardError')
    }
  }, [api, connectionId, demo, ready, patch, handle])

  const persist = useCallback(async (routes: CommuteRoute[], settings: CommuteSettings) => {
    const cleaned = routes.map(normalizeRoute)
    if (demo) {
      const boards = { ...stateRef.current.boards }
      const template = Object.values(boards)[0]
      for (const route of cleaned) if (!boards[route.id] && template) boards[route.id] = { ...template, routeId: route.id }
      patch('demo', { routes: cleaned, settings, boards, loaded: true })
      return
    }
    const answer = await api.saveCommute(connectionId, cleaned, settings)
    patch(connectionId, { routes: answer.routes, settings: answer.settings, provider: answer.provider, loaded: true })
    // A changed list needs fresh boards at once; the boards of removed routes go away.
    const kept = Object.fromEntries(Object.entries(storeRef.current[connectionId]?.boards || {}).filter(([id]) => answer.routes.some((route) => route.id === id)))
    patch(connectionId, { boards: kept, boardsAt: 0 })
  }, [api, connectionId, demo, patch])

  const save = useCallback(async (routes: CommuteRoute[], settings: Partial<CommuteSettings> = {}) => {
    const base = stateRef.current.settings
    await persist(routes, { delayThreshold: settings.delayThreshold ?? base.delayThreshold, hiddenLabels: settings.hiddenLabels ?? hiddenLabels ?? base.hiddenLabels })
    if (!demo) await refreshBoards(true)
  }, [persist, hiddenLabels, refreshBoards, demo])

  // Keep settings.hiddenLabels current while routes exist (half-class choices or the timetable changed).
  const syncing = useRef('')
  useEffect(() => {
    if (demo || !ready || !hiddenLabels || !state.loaded || !state.routes.length) return
    if (sameLabels(state.settings.hiddenLabels, hiddenLabels)) { syncing.current = ''; return }
    const signature = `${connectionId}:${hiddenLabels.join('|')}`
    if (syncing.current === signature) return
    syncing.current = signature
    void persist(state.routes, { delayThreshold: state.settings.delayThreshold, hiddenLabels }).catch(() => { /* the next change tries again */ })
  }, [demo, ready, state.loaded, state.routes, state.settings, hiddenLabels, connectionId, persist])

  const stops = useCallback(async (query: string): Promise<Stop[]> => {
    if (demo) {
      const needle = query.trim().toLowerCase()
      return demoCommute(Date.now()).stops.filter((stop) => stop.name.toLowerCase().includes(needle))
    }
    return (await api.commuteStops(connectionId, query)).stops
  }, [api, connectionId, demo])

  const trips = useCallback(async (routeId: string, at: string, timeType: 'depart' | 'arrive'): Promise<Trip[]> => {
    if (demo) return []
    return (await api.commuteTrips(connectionId, routeId, at, timeType)).trips
  }, [api, connectionId, demo])

  return { ...state, ensure, refreshBoards, save, stops, trips }
}
