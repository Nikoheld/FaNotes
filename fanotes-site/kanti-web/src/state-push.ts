// Notifications with the tab closed (Web Push) for the connections of this browser session. Kept
// apart from state.tsx: the provider only reads `enabled` (to skip its own notification) and
// forwards the actions to the settings.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type Api } from './lib/api'
import { requestPermission } from './lib/notify'
import { currentSubscription, pushSupported, subscribeBrowser, unsubscribeBrowser } from './lib/webpush'
import type { Session } from './types'

export interface WebPush {
  /** The server has a key, the browser can do it and this is not the demo. */
  available: boolean
  /** Connection ids this browser is subscribed for. */
  enabled: ReadonlySet<string>
  busy: boolean
  /** 'denied' when the browser blocks notifications for this site. */
  blocked: boolean
  error: string
  enable: (connectionId: string) => Promise<void>
  disable: (connectionId: string) => Promise<void>
  /** After sign-out: forget the browser subscription too. */
  reset: () => Promise<void>
}

export const useWebPush = ({ api, session, demo, language, failure }: { api: Api; session: Session | null; demo: boolean; language: string; failure: string }): WebPush => {
  const available = Boolean(session?.webPush) && !demo && pushSupported()
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState('')
  const sessionId = session?.csrf || ''
  const failureRef = useRef(failure)
  failureRef.current = failure

  // What the server holds counts only while this browser still has the subscription and the permission.
  useEffect(() => {
    if (!available) { setEnabled(new Set()); return }
    let stopped = false
    setBlocked(Notification.permission === 'denied')
    void (async () => {
      try {
        const [status, subscription] = await Promise.all([api.pushStatus(), currentSubscription()])
        if (stopped) return
        setEnabled(new Set(subscription && status.subscribed && Notification.permission === 'granted' ? status.connections : []))
      } catch {
        if (!stopped) setEnabled(new Set())
      }
    })()
    return () => { stopped = true }
  }, [available, api, sessionId])

  const fail = (cause: unknown) => setError(cause instanceof ApiError || cause instanceof Error ? cause.message : failureRef.current)

  const enable = useCallback(async (connectionId: string) => {
    setBusy(true)
    setError('')
    try {
      const permission = await requestPermission()
      setBlocked(permission === 'denied')
      if (permission !== 'granted') return
      const { enabled: on, publicKey } = await api.pushKey()
      if (!on) throw new Error(failureRef.current)
      const subscription = await subscribeBrowser(publicKey)
      const status = await api.pushSubscribe(connectionId, subscription.toJSON(), language)
      setEnabled(new Set(status.connections))
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
    }
  }, [api, language])

  const disable = useCallback(async (connectionId: string) => {
    setBusy(true)
    setError('')
    try {
      const status = await api.pushUnsubscribe(connectionId)
      setEnabled(new Set(status.connections))
      if (!status.subscribed) await unsubscribeBrowser()
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
    }
  }, [api])

  const reset = useCallback(async () => {
    setEnabled(new Set())
    if (pushSupported()) await unsubscribeBrowser()
  }, [])

  return { available, enabled, busy, blocked, error, enable, disable, reset }
}
