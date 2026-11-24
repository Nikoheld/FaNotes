// What a Web Push carries: the same notice text the app shows (the change feed already holds the
// German title and body), sealed by RFC 8291 on its way. Grades arrive here already redacted when
// hidden grades are on (prepareGradeNotifications), so no mark is added or restored in this file.

import { WEB_PUSH_PLAIN_LIMIT } from './web-push.mjs'

const MAX_NOTICES = 5
const clip = (value, max) => {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The view a notice opens. Paths match kanti-web/src/lib/route.ts. */
export const noticePath = (change) => {
  const category = String(change?.category || '')
  if (category === 'grade') return '/noten'
  if (category === 'timetable') return '/stundenplan'
  if (category === 'exam') return '/termine'
  if (category === 'absence' || category === 'deadline') return '/absenzen'
  if (category === 'settings') return '/einstellungen'
  if (category === 'event') return /termin/iu.test(String(change?.title || '')) ? '/termine' : '/mitteilungen'
  return '/'
}

// The app's reauth wording (Push.kt showReauth / showReauthSoon, values/ and values-de/ strings).
const REAUTH = {
  de: {
    reauth: ['Bei Schulnetz neu anmelden', 'Die Microsoft-Anmeldung ist abgelaufen. In Kanti+ neu anmelden.'],
    'reauth-soon': ['Schulnetz-Anmeldung läuft bald ab', 'In 2 Tagen prüft Kanti+ deine Noten nicht mehr im Hintergrund. Jetzt neu anmelden, damit die Meldungen pünktlich bleiben.'],
  },
  en: {
    reauth: ['Sign in to Schulnetz again', 'The Microsoft sign-in has expired. Sign in again in Kanti+.'],
    'reauth-soon': ['Schulnetz sign-in expires soon', 'In 2 days Kanti+ stops checking your grades in the background. Sign in again now to keep alerts on time.'],
  },
}

/** The notices of one push, newest grade first like the app's sealed payload. */
export const noticesFor = (event, changes, lang = 'de') => {
  if (event === 'reauth' || event === 'reauth-soon') {
    const [title, body] = (REAUTH[lang] || REAUTH.de)[event]
    return { notices: [{ id: 'schulnetz-login-required', title, body, path: '/einstellungen' }], more: false }
  }
  if (event !== 'sync') return { notices: [], more: false }
  const list = (Array.isArray(changes) ? changes : []).filter((change) => change && typeof change.category === 'string' && change.category)
  const ordered = [...list.filter((change) => change.category === 'grade'), ...list.filter((change) => change.category !== 'grade')]
  const notices = ordered.slice(0, MAX_NOTICES).map((change) => ({
    id: clip(change.id, 120),
    title: clip(change.title, 120),
    body: clip(change.body, 400),
    path: noticePath(change),
  }))
  return { notices, more: ordered.length > notices.length }
}

/**
 * The JSON the service worker shows: { v, c: connection id of this browser, l: label (only with
 * several connections), n: [{ i, t, b, p }], more }. Trimmed to fit one record.
 */
export const buildWebPushPayload = ({ event, changes, connectionId, label = '', lang = 'de' }) => {
  const { notices, more } = noticesFor(event, changes, lang)
  if (!notices.length) return ''
  for (let count = notices.length; count > 0; count -= 1) {
    const text = JSON.stringify({
      v: 1,
      c: connectionId,
      ...(label ? { l: clip(label, 60) } : {}),
      n: notices.slice(0, count).map((notice) => ({ i: notice.id, t: notice.title, b: notice.body, p: notice.path })),
      ...(more || count < notices.length ? { more: true } : {}),
    })
    if (Buffer.byteLength(text, 'utf8') <= WEB_PUSH_PLAIN_LIMIT) return text
  }
  return ''
}
