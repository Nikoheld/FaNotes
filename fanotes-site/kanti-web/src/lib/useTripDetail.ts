// Loads the connection detail of one trip and keeps it fresh while it is open: every 30 s, but only
// while the tab is visible (a hidden tab pauses and catches up when it comes back), plus a manual refresh.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Commute } from '../state-commute'
import type { TripDetail } from '../types'
import { DETAIL_REFRESH_MS } from './commute'

export interface TripDetailState {
  detail: TripDetail | null
  /** First load (no detail yet). */
  loading: boolean
  /** A reload is running (shown on the refresh button). */
  refreshing: boolean
  /** The last request failed; `detail` may still hold the previous answer. */
  failed: boolean
  reload: () => void
}

export const useTripDetail = (commute: Pick<Commute, 'tripDetail'>, routeId: string, tripId: string, at: string): TripDetailState => {
  const fetchRef = useRef(commute.tripDetail)
  fetchRef.current = commute.tripDetail
  const [state, setState] = useState<{ key: string; detail: TripDetail | null; loading: boolean; refreshing: boolean; failed: boolean }>({ key: '', detail: null, loading: true, refreshing: false, failed: false })
  const key = `${routeId}|${tripId}|${at}`
  const keyRef = useRef(key)
  keyRef.current = key
  const lastAt = useRef(0)
  const running = useRef(false)

  const load = useCallback(async () => {
    if (running.current) return
    running.current = true
    const mine = keyRef.current
    setState((current) => (current.key === mine ? { ...current, refreshing: true } : { key: mine, detail: null, loading: true, refreshing: true, failed: false }))
    try {
      const detail = await fetchRef.current(routeId, tripId, at)
      lastAt.current = Date.now()
      if (keyRef.current === mine) setState({ key: mine, detail, loading: false, refreshing: false, failed: false })
    } catch {
      if (keyRef.current === mine) setState((current) => ({ ...current, key: mine, loading: false, refreshing: false, failed: true }))
    } finally {
      running.current = false
    }
  }, [routeId, tripId, at])

  useEffect(() => {
    lastAt.current = 0
    running.current = false
    void load()
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    const due = () => visible() && Date.now() - lastAt.current >= DETAIL_REFRESH_MS - 500
    const timer = window.setInterval(() => { if (due()) void load() }, DETAIL_REFRESH_MS)
    const onVisible = () => { if (due()) void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  const current = state.key === key ? state : { key, detail: null, loading: true, refreshing: false, failed: false }
  return { detail: current.detail, loading: current.loading, refreshing: current.refreshing, failed: current.failed, reload: () => { void load() } }
}
