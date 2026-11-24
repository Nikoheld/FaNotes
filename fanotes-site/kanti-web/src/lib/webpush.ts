// Web Push in the browser: the service worker (public/sw.js), the push subscription and the
// permission. Only the browser side; the server routes live in api.ts.

export const SERVICE_WORKER_URL = '/sw.js'

export const pushSupported = () => typeof window !== 'undefined'
  && 'serviceWorker' in navigator
  && 'PushManager' in window
  && 'Notification' in window

/** Registers the worker once the page has loaded. Failures are ignored: the page works without it. */
export const registerServiceWorker = () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  const register = () => { navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' }).catch(() => undefined) }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

export const keyBytes = (text: string) => {
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const raw = atob(padded)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

const registration = async () => (await navigator.serviceWorker.getRegistration('/')) || navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' }).then(() => navigator.serviceWorker.ready)

/** This browser's subscription, if it has one. */
export const currentSubscription = async (): Promise<PushSubscription | null> => {
  if (!pushSupported()) return null
  try {
    const found = await navigator.serviceWorker.getRegistration('/')
    return (await found?.pushManager.getSubscription()) || null
  } catch {
    return null
  }
}

/** The existing subscription, or a new one for the server's key. Needs a granted permission. */
export const subscribeBrowser = async (publicKey: string): Promise<PushSubscription> => {
  const active = await registration()
  const existing = await active.pushManager.getSubscription()
  if (existing) return existing
  return active.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource })
}

export const unsubscribeBrowser = async () => {
  try { await (await currentSubscription())?.unsubscribe() } catch { /* already gone */ }
}

/** A message from the worker when a notification is clicked while the page is open. */
export interface OpenMessage { type: 'kanti-open'; path: string; connection: string }
