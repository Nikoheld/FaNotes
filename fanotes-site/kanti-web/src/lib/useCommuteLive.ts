// Keeps the commute boards fresh while a view that shows them is mounted: once when it opens, on
// window focus, and every 60 s only while the tab is visible and a trip leaves within 30 minutes.
// The server caches a board for 30 s, so nothing here ever asks faster than that.
import { useEffect, useRef } from 'react'
import type { Commute } from '../state-commute'
import { focusDue, POLL_EVERY_MS, pollDue } from './commute'

export const useCommuteLive = (commute: Commute) => {
  const ref = useRef(commute)
  ref.current = commute
  const { ensure, refreshBoards, loaded, unavailable } = commute
  const hasRoutes = commute.routes.length > 0

  useEffect(() => { void ensure() }, [ensure])

  // Open: load the boards as soon as the routes are known (and again when the list changes).
  useEffect(() => {
    if (loaded && hasRoutes && !unavailable) void refreshBoards()
  }, [loaded, hasRoutes, unavailable, refreshBoards, commute.routes])

  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    const timer = window.setInterval(() => {
      const c = ref.current
      if (pollDue({ visible: visible(), boards: c.boards, lastAt: c.boardsAt, now: Date.now(), loading: c.boardLoading })) void c.refreshBoards()
    }, POLL_EVERY_MS)
    const onFocus = () => {
      const c = ref.current
      if (visible() && c.loaded && c.routes.length && focusDue(c.boardsAt, Date.now(), c.boardLoading)) void c.refreshBoards()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [])
}
