// Kanti+ im Browser: service worker. It only receives Web Push (the server's sealed notices, see
// fanotes-site/web-push-notice.mjs) and opens the right view when one is clicked. It caches nothing.
// Payload: { v: 1, c: connection id, l: label (several connections only), n: [{ i: id, t: title, b: body, p: path }], more }

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

const SAFE_PATH = /^\/(?:|stundenplan|noten|termine|absenzen|mitteilungen|mensa|pendeln|einstellungen)$/u

const readPayload = (event) => {
  try { return event.data ? event.data.json() : null } catch { return null }
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event)
  const notices = Array.isArray(payload?.n) ? payload.n.slice(0, 5) : []
  const connection = typeof payload?.c === 'string' ? payload.c : ''
  const label = typeof payload?.l === 'string' ? payload.l : ''
  // A push must always show something (the browser requires it); an unreadable one is a plain hint.
  const shown = notices.length ? notices : [{ i: 'kanti-update', t: 'Kanti+', b: '', p: '/' }]
  event.waitUntil(Promise.all(shown.map((notice) => {
    const title = String(notice.t || 'Kanti+')
    const path = SAFE_PATH.test(String(notice.p || '')) ? notice.p : '/'
    return self.registration.showNotification(label ? `${label} · ${title}` : title, {
      body: String(notice.b || ''),
      // The same tag the open page uses, so a page and a push never show the same news twice.
      tag: `kanti:${String(notice.i || title)}`,
      icon: '/kanti-icon-512.png',
      badge: '/kanti-icon-512.png',
      data: { path, connection },
    })
  })))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { path = '/', connection = '' } = event.notification.data || {}
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (open) {
      await open.focus()
      open.postMessage({ type: 'kanti-open', path, connection })
      return
    }
    await self.clients.openWindow(connection ? `${path}?connection=${encodeURIComponent(connection)}` : path)
  })())
})
