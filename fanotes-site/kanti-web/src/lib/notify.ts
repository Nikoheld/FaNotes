// Browser notifications while Kanti+ is open: the connection's change feed (the same one the app's
// pushes come from), read every few minutes. The first read only sets the position, so opening the
// page never replays old news.
import type { Change } from '../types'

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window

export const permission = (): NotificationPermission | 'unsupported' => (notificationsSupported() ? Notification.permission : 'unsupported')

export const requestPermission = async (): Promise<NotificationPermission | 'unsupported'> => {
  if (!notificationsSupported()) return 'unsupported'
  try { return await Notification.requestPermission() } catch { return Notification.permission }
}

/** Which changes to announce: newer than the stored position, at most five, the newest last. */
export const freshChanges = (changes: Change[], cursor: number | null) => {
  const top = changes.reduce((max, change) => Math.max(max, change.revision), cursor ?? 0)
  if (cursor == null) return { show: [] as Change[], cursor: top }
  const show = changes.filter((change) => change.revision > cursor).slice(-5)
  return { show, cursor: top }
}

export const showNotification = (change: Change, label: string, onClick: () => void) => {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  try {
    const notice = new Notification(label ? `${label} · ${change.title}` : change.title, { body: change.body, tag: `kanti:${change.id}`, icon: '/kanti-icon.svg' })
    notice.onclick = () => { window.focus(); onClick(); notice.close() }
  } catch { /* some browsers only allow notifications from a service worker */ }
}
