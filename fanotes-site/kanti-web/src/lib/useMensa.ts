import { useCallback, useEffect, useState } from 'react'
import { useKanti } from '../state'
import { demoMensa } from './demo'
import { toMensaFeed, type MensaFeed } from './mensa'
import { zurichToday } from '@shared/schulnetz-logic'

/** The menu is public and cached by the server; the page asks again every few hours at most. */
const REFRESH_MS = 3 * 3_600_000

export interface MensaState { feed: MensaFeed | null; loading: boolean; failed: boolean; reload: () => void }

/** The Mensa feed while `enabled`. Demo mode gets invented dishes; a failed load keeps the last feed. */
export const useMensa = (enabled: boolean): MensaState => {
  const kanti = useKanti()
  const [feed, setFeed] = useState<MensaFeed | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const demo = kanti.demo
  const api = kanti.api
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) return undefined
    if (demo) { setFeed(demoMensa(zurichToday())); return undefined }
    let alive = true
    const load = () => {
      setLoading(true)
      api.mensa().then(
        (body) => { if (alive) { setFeed(toMensaFeed(body)); setFailed(false) } },
        () => { if (alive) setFailed(true) },
      ).finally(() => { if (alive) setLoading(false) })
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [enabled, demo, api, tick])

  return { feed, loading, failed, reload }
}
