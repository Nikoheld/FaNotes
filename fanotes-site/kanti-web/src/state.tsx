// Everything the page knows: the session, its connections, each connection's snapshot, status and
// hidden grades, the demo, and the change feed for browser notifications.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, createApi, type Api } from './lib/api'
import { demoSnapshot } from './lib/demo'
import { refreshDue } from './lib/refresh'
import { freshChanges, showNotification } from './lib/notify'
import { DEFAULT_PREFS, loadPrefs, readCursor, savePrefs, writeCursor, type Prefs } from './lib/prefs'
import { parseRoute, routeHref, type Route } from './lib/route'
import { pickLanguage, STRINGS, type Language, type Strings } from './lib/i18n'
import type { View } from './lib/shortcuts'
import { useCommuteStore, type Commute } from './state-commute'
import { detectGroupSets } from './lib/groups'
import { hiddenLabelsFor } from './lib/commute'
import { zurichToday } from '@shared/schulnetz-logic'
import type { AlertSettings, Change, Connection, LinkStatus, Reveals, Session, Snapshot } from './types'

export interface ConnectionData {
  snapshot: Snapshot | null
  status: LinkStatus | null
  reveals: Reveals | null
  loading: boolean
  error: string
  loadedAt: number
}

const EMPTY_DATA: ConnectionData = { snapshot: null, status: null, reveals: null, loading: false, error: '', loadedAt: 0 }
const DEMO_ID = 'demo'
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000
const CHANGES_VISIBLE_MS = 2 * 60 * 1000
const CHANGES_HIDDEN_MS = 5 * 60 * 1000

type Phase = 'loading' | 'signedOut' | 'ready'

export interface Kanti {
  api: Api
  phase: Phase
  demo: boolean
  session: Session | null
  connections: Connection[]
  active: Connection | null
  data: ConnectionData
  offline: boolean
  news: Change[]
  prefs: Prefs
  language: Language
  t: Strings
  commute: Commute
  route: Route
  navigate: (view: View, params?: Record<string, string>, replace?: boolean) => void
  setPrefs: (patch: Partial<Prefs>) => void
  start: () => Promise<void>
  startDemo: () => void
  endDemo: () => void
  select: (id: string) => void
  cycleConnection: () => void
  refresh: () => Promise<void>
  saveSettings: (patch: Partial<AlertSettings>) => Promise<void>
  reveal: (ids: string[]) => Promise<void>
  rename: (id: string, label: string) => Promise<void>
  remove: (id: string) => Promise<void>
  logout: () => Promise<void>
}

const KantiContext = createContext<Kanti | null>(null)

export const useKanti = () => {
  const value = useContext(KantiContext)
  if (!value) throw new Error('KantiProvider missing')
  return value
}

const demoConnection = (): Connection => ({ id: DEMO_ID, provider: 'schulnetz', label: 'Demo', source: 'demo', linked: true, baseUrl: '', needsReauth: false, lastPollAt: '', lastError: '', mode: 'demo' })

export const KantiProvider = ({ children, api: injected, demo: startInDemo = false }: { children: ReactNode; api?: Api; demo?: boolean }) => {
  const api = useMemo(() => injected || createApi(), [injected])
  const [phase, setPhase] = useState<Phase>('loading')
  const [session, setSession] = useState<Session | null>(null)
  // "?demo" opens the demo straight away (a link for reviewers); it never reaches the server.
  const [demo, setDemo] = useState(() => startInDemo || (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')))
  const [store, setStore] = useState<Record<string, ConnectionData>>({})
  const storeRef = useRef(store)
  storeRef.current = store
  const [offline, setOffline] = useState(false)
  const [news, setNews] = useState<Record<string, Change[]>>({})
  const [prefs, setPrefsState] = useState<Prefs>(() => (typeof window === 'undefined' ? { ...DEFAULT_PREFS } : loadPrefs()))
  const [route, setRoute] = useState<Route>(() => (typeof window === 'undefined' ? parseRoute('/') : parseRoute(window.location.pathname, window.location.search)))
  const language = pickLanguage(prefs.language, typeof navigator === 'undefined' ? [] : navigator.languages || [navigator.language])
  const t = STRINGS[language]
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const tRef = useRef(t)
  tRef.current = t

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname, window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((view: View, params: Record<string, string> = {}, replace = false) => {
    const href = routeHref(view, params)
    if (typeof window !== 'undefined') {
      if (replace) window.history.replaceState(null, '', href)
      else window.history.pushState(null, '', href)
    }
    setRoute(parseRoute(href.split('?')[0], href.includes('?') ? href.slice(href.indexOf('?')) : ''))
  }, [])

  const connections = useMemo<Connection[]>(() => (demo ? [demoConnection()] : session?.connections || []), [demo, session])
  const active = connections.find((connection) => connection.id === prefs.activeConnection) || connections[0] || null

  const patchData = useCallback((id: string, patch: Partial<ConnectionData>) => {
    setStore((current) => ({ ...current, [id]: { ...(current[id] || EMPTY_DATA), ...patch } }))
  }, [])

  const load = useCallback(async (id: string) => {
    if (id === DEMO_ID) return
    patchData(id, { loading: true, error: '' })
    // Each section on its own: one failing request must not hide the others, and the banner names the
    // section and the server's actual reason (not just "load failed").
    const parts = await Promise.allSettled([api.snapshot(id), api.status(id), api.reveals(id)])
    const failures = parts.map((part) => (part.status === 'rejected' ? part.reason : null))
    if (failures.some((error) => error instanceof ApiError && error.status === 401)) {
      setSession(null)
      setPhase('signedOut')
      return
    }
    const strings = tRef.current
    const sections = [strings.sectionSnapshot, strings.sectionStatus, strings.sectionReveals]
    const reasons = failures.map((error, index) => {
      if (!error) return ''
      if (error instanceof ApiError && error.status === 0) return `${sections[index]}: ${strings.reasonOffline}`
      if (error instanceof ApiError) return `${sections[index]}: ${strings.failureReason(error.message, error.status)}`
      return `${sections[index]}: ${error instanceof Error ? error.message : String(error)}`
    }).filter(Boolean)
    setOffline(failures.some((error) => error instanceof ApiError && error.status === 0))
    const value = <T,>(index: number, fallback: T): T => (parts[index].status === 'fulfilled' ? (parts[index] as PromiseFulfilledResult<T>).value : fallback)
    const previous = storeRef.current[id] || EMPTY_DATA
    patchData(id, {
      snapshot: value(0, previous.snapshot),
      status: value(1, previous.status),
      reveals: value(2, previous.reveals),
      loading: false,
      error: reasons.join(' · '),
      loadedAt: reasons.length ? previous.loadedAt : Date.now(),
    })
  }, [api, patchData])

  const start = useCallback(async () => {
    try {
      const next = await api.session()
      setSession(next)
      setPhase(next ? 'ready' : 'signedOut')
      setOffline(false)
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) setOffline(true)
      setSession(null)
      setPhase('signedOut')
    }
  }, [api])

  useEffect(() => { void start() }, [start])

  // Load the shown connection when it changes or has never loaded.
  useEffect(() => {
    if (!active || active.id === DEMO_ID || phase !== 'ready') return
    if (!store[active.id]?.loadedAt && !store[active.id]?.loading) void load(active.id)
  }, [active, phase, store, load])

  // Keep the shown snapshot fresh; the server reads the school on its own schedule.
  useEffect(() => {
    if (!active || active.id === DEMO_ID || phase !== 'ready') return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(active.id) }, SNAPSHOT_EVERY_MS)
    // Back to the tab (or the window): refresh at once, at most every 30 seconds, and ask for news too.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const entry = store[active.id]
      if (!refreshDue(entry?.loadedAt || 0, Date.now(), Boolean(entry?.loading))) return
      void load(active.id)
      pollNowRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) }
  }, [active, phase, load, store])

  // The change feed of every connection: news in the page, and browser notifications when allowed.
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections
  // Set by the change-feed loop below: ask for news now instead of at the next timer.
  const pollNowRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (phase !== 'ready' || demo) return
    let stopped = false
    let timer = 0
    const poll = async () => {
      for (const connection of connectionsRef.current) {
        try {
          const { changes } = await api.changes(connection.id, 0)
          if (stopped) return
          setNews((current) => ({ ...current, [connection.id]: changes.slice(-30).reverse() }))
          const { show, cursor } = freshChanges(changes, readCursor(connection.id))
          writeCursor(connection.id, cursor)
          if (show.length && prefsRef.current.browserAlerts) {
            for (const change of show) showNotification(change, connectionsRef.current.length > 1 ? connection.label : '', () => setPrefs({ activeConnection: connection.id }))
          }
          if (show.length) void load(connection.id)
        } catch {
          /* the next round tries again */
        }
      }
      if (!stopped) timer = window.setTimeout(poll, document.visibilityState === 'visible' ? CHANGES_VISIBLE_MS : CHANGES_HIDDEN_MS)
    }
    let running = false
    pollNowRef.current = () => {
      if (stopped || running) return
      window.clearTimeout(timer)
      running = true
      void poll().finally(() => { running = false })
    }
    void poll()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [phase, demo, api, load, setPrefs, session])

  const demoData = useMemo<ConnectionData>(() => {
    if (!demo) return EMPTY_DATA
    return {
      snapshot: demoSnapshot(zurichToday()),
      status: { linked: true, provider: 'schulnetz', baseUrl: '', needsReauth: false, lastPollAt: '', lastError: '', revision: 1, settings: {}, settingsUpdatedAt: '', mode: 'demo' },
      reveals: { guessGrades: false, hidden: [] },
      loading: false,
      error: '',
      loadedAt: Date.now(),
    }
  }, [demo])

  const data = demo ? demoData : (active ? store[active.id] || EMPTY_DATA : EMPTY_DATA)

  const hiddenLabels = useMemo(() => (data.snapshot ? hiddenLabelsFor(detectGroupSets(data.snapshot.events || []), prefs.groupChoices) : null), [data.snapshot, prefs.groupChoices])
  const onUnauthorized = useCallback(() => { setSession(null); setPhase('signedOut') }, [])
  const commute = useCommuteStore({ api, connectionId: active?.id || '', demo, ready: phase === 'ready', hiddenLabels, onUnauthorized })

  const value: Kanti = {
    commute,
    api,
    phase: demo ? 'ready' : phase,
    demo,
    session,
    connections,
    active,
    data,
    offline,
    news: active ? news[active.id] || [] : [],
    prefs,
    language,
    t,
    route,
    navigate,
    setPrefs,
    start,
    startDemo: () => { setDemo(true); navigate('today', {}, true) },
    endDemo: () => { setDemo(false); navigate('today', {}, true) },
    select: (id) => setPrefs({ activeConnection: id }),
    cycleConnection: () => {
      if (connections.length < 2 || !active) return
      const index = connections.findIndex((connection) => connection.id === active.id)
      setPrefs({ activeConnection: connections[(index + 1) % connections.length].id })
    },
    refresh: async () => {
      if (demo) return
      await start()
      if (active) await load(active.id)
    },
    saveSettings: async (patch) => {
      if (!active || demo) return
      const status = await api.saveSettings(active.id, patch)
      patchData(active.id, { status })
      if ('guessGrades' in patch) await load(active.id)
    },
    reveal: async (ids) => {
      if (!active || demo) return
      const reveals = await api.reveal(active.id, ids)
      patchData(active.id, { reveals })
      await load(active.id)
    },
    rename: async (id, label) => {
      await api.rename(id, label)
      await start()
    },
    remove: async (id) => {
      const result = await api.remove(id)
      if (result.signedOut) {
        setSession(null)
        setPhase('signedOut')
        return
      }
      await start()
    },
    logout: async () => {
      try { await api.logout() } catch { /* the cookie is cleared either way on the next 401 */ }
      setSession(null)
      setStore({})
      setNews({})
      setPhase('signedOut')
      navigate('today', {}, true)
    },
  }
  return <KantiContext.Provider value={value}>{children}</KantiContext.Provider>
}
