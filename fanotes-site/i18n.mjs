import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('./public/i18n/en.json', import.meta.url)), 'utf8'))
const replacements = Object.entries(catalog)
  .filter(([source, translated]) => source !== translated && source.length >= 4)
  .sort(([left], [right]) => right.length - left.length)

export const languageForRequest = (request) => {
  const header = String(request.headers['accept-language'] || '')
  const first = header.split(',', 1)[0].trim()
  return /^de(?:-|$)/iu.test(first) ? 'de' : 'en'
}

export const localizeText = (value, language) => {
  if (language !== 'en' || typeof value !== 'string' || !value.trim()) return value
  const source = value.trim()
  if (catalog[source] !== undefined) return catalog[source]
  let translated = source
  for (const [german, english] of replacements) {
    if (translated.includes(german)) translated = translated.split(german).join(english)
  }
  return translated
}

export const localizeExactText = (value, language) => {
  if (language !== 'en' || typeof value !== 'string' || !value.trim()) return value
  const source = value.trim()
  return catalog[source] ?? source
}

const SCHULNETZ_EXACT = new Map([
  ['Neue Note', 'New grade'],
  ['Notenänderung', 'Grade change'],
  ['Neue Prüfung', 'New exam'],
  ['Prüfung entfällt', 'Exam removed'],
  ['Prüfung fällt aus', 'Exam cancelled'],
  ['Prüfung verschoben', 'Exam moved'],
  ['Prüfung geändert', 'Exam changed'],
  ['Neue Absenz', 'New absence'],
  ['Neue Mitteilung', 'New message'],
  ['Neuer Termin', 'New event'],
  ['Stundenplan geändert', 'Timetable changed'],
  ['Lektion entfernt', 'Lesson removed'],
  ['Lektion fällt aus', 'Lesson cancelled'],
  ['Vertretung', 'Substitution'],
  ['Raum geändert', 'Room changed'],
  ['Zeit geändert', 'Time changed'],
  ['Mitteilung', 'Message'],
  ['Termin', 'Event'],
  ['Tippen zum Aufdecken', 'Tap to reveal'],
  ['einem Fach', 'a subject'],
  ['Bei Schulnetz neu anmelden', 'Sign in to Schulnetz again'],
  ['Die Microsoft-Anmeldung ist abgelaufen. In Kanti+ neu anmelden.', 'The Microsoft sign-in has expired. Sign in again in Kanti+.'],
  ['Die Microsoft-Anmeldung ist abgelaufen.', 'The Microsoft sign-in has expired.'],
  ['Schulnetz hat die Anmeldung abgelehnt', 'Schulnetz rejected the sign-in'],
  ['Schulnetz hat kein Refresh-Token geliefert.', 'Schulnetz did not return a refresh token.'],
  ['Diese Schulnetz-Anmeldung ist nicht erlaubt.', 'This Schulnetz sign-in is not allowed.'],
  ['Diese Schulnetz-Anfrage ist nicht erlaubt.', 'This Schulnetz request is not allowed.'],
  ['Anfrage fehlgeschlagen', 'Request failed'],
  ['Ungültiges Konto.', 'Invalid account.'],
  ['Der Schulnetz-Schlüssel ist auf dem Server noch nicht eingerichtet.', 'The Schulnetz key is not set up on the server yet.'],
  ['Die Schulnetz-Adresse ist nicht erlaubt.', 'The Schulnetz address is not allowed.'],
  ['Die Gerätekennung fehlt.', 'The device id is missing.'],
  ['Das Schulnetz-Token ist ungültig.', 'The Schulnetz token is invalid.'],
  ['Die Microsoft-Cookies fehlen.', 'The Microsoft cookies are missing.'],
  ['Die Cookie-Daten sind zu gross.', 'The cookie data is too large.'],
  ['Schulnetz ist noch nicht verbunden.', 'Schulnetz is not connected yet.'],
  ['Der Schnappschuss ist ungültig.', 'The snapshot is invalid.'],
  ['Das Push-Token ist ungültig.', 'The push token is invalid.'],
  ['Dieses Gerät ist für Push nicht registriert.', 'This device is not registered for push.'],
  ['Firebase ist auf dem Server nicht eingerichtet.', 'Firebase is not set up on the server.'],
  ['Firebase hat die Testmeldung nicht angenommen.', 'Firebase did not accept the test notice.'],
  ['Dieses Gerät ist bei Firebase nicht mehr registriert.', 'This device is no longer registered with Firebase.'],
  ['Bitte erneut anmelden.', 'Please sign in again.'],
  ['Zu viele Anfragen. Bitte kurz warten.', 'Too many requests. Please wait a moment.'],
  ['Zu viele Anfragen. Bitte später erneut versuchen.', 'Too many requests. Please try again later.'],
  ['Diese Anfrage braucht ein FaNotes-Konto.', 'This request needs a FaNotes account.'],
  ['Diese Anfrage braucht ein Kanti+-Konto.', 'This request needs a Kanti+ account.'],
  ['Dieses Kanti+-Konto gibt es nicht.', 'This Kanti+ account does not exist.'],
  ['Die Anfrage ist zu gross.', 'The request is too large.'],
  ['Ungültiges JSON.', 'Invalid JSON.'],
  ['Diesen Schulnetz-Endpunkt gibt es nicht.', 'That Schulnetz endpoint does not exist.'],
  ['Der Schulnetz-Dienst ist vorübergehend nicht erreichbar.', 'The Schulnetz service is temporarily unavailable.'],
  ['Stundenplan: Seite geladen, aber nicht lesbar', 'Timetable: the page loaded, but it could not be read'],
  ['Noten: Seite geladen, aber nicht lesbar', 'Grades: the page loaded, but it could not be read'],
  ['Absenzen: Seite geladen, aber nicht lesbar', 'Absences: the page loaded, but it could not be read'],
  ['Prüfungen: Seite geladen, aber nicht lesbar', 'Exams: the page loaded, but it could not be read'],
  ['Termine: Seite geladen, aber nicht lesbar', 'Events: the page loaded, but it could not be read'],
  ['Schulnetz hat die IP-Adresse abgelehnt. Anmeldung wird erneuert.', 'Schulnetz rejected the IP address. Sign-in will be renewed.'],
  ['Schulnetz-Sitzung abgelaufen. Anmeldung wird erneuert.', 'The Schulnetz session expired. Sign-in will be renewed.'],
  ['Schulnetz braucht eine Anmeldung.', 'Schulnetz needs a sign-in.'],
  ['Die Zielnote liegt ausserhalb von 1 bis 6.', 'The target grade is outside 1 to 6.'],
  ['Das Gewicht der nächsten Prüfung muss grösser als 0 sein.', 'The weight of the next exam must be greater than 0.'],
  ['Die Wunschnote lässt sich daraus nicht rechnen.', 'The target grade cannot be calculated from this.'],
  ['Auch eine 6 reicht für diesen Schnitt nicht.', 'Even a 6 is not enough for this average.'],
  ['Der Schnitt ist schon gesichert. Eine 1 genügt.', 'The average is already safe. A 1 is enough.'],
  ['Nicht angemeldet.', 'Not signed in.'],
  ['Nicht angemeldet', 'Not signed in'],
  ['Das Passwort braucht mindestens 10 Zeichen.', 'The password needs at least 10 characters.'],
  ['Das Passwort ist zu lang.', 'The password is too long.'],
  ['Dieses Passwort ist zu leicht zu erraten.', 'This password is too easy to guess.'],
  ['Hidden · tap to reveal', 'Hidden · tap to reveal'],
  ['Hidden · hold to reveal', 'Hidden · hold to reveal'],
])

const SCHULNETZ_FRAGMENTS = [
  ['nicht entschuldigt', 'unexcused'],
  ['entschuldigt', 'excused'],
  ['fällt aus', 'cancelled'],
  ['Vertretung', 'Substitution'],
  ['Gewicht', 'Weight'],
  ['Raum ', 'Room '],
  ['Tippen zum Aufdecken', 'Tap to reveal'],
  ['Neue Noten', 'new grades'],
  ['Neue Note', 'New grade'],
]

export const schulnetzLanguage = (request) => {
  const first = String(request?.headers?.['accept-language'] || '').split(',')[0].trim()
  return /^en(?:-|$)/i.test(first) ? 'en' : 'de'
}

export const localizeSchulnetzText = (value, language) => {
  if (language !== 'en' || typeof value !== 'string' || !value) return value
  if (SCHULNETZ_EXACT.has(value)) return SCHULNETZ_EXACT.get(value)
  const counted = value.match(/^(\d+) neue Noten(?: – tippen zum Aufdecken)?$/u)
  if (counted) {
    const count = counted[1]
    const tail = value.includes('Aufdecken') ? ' – tap to reveal' : ''
    return `${count} new grade${count === '1' ? '' : 's'}${tail}`
  }
  let translated = value
  for (const [german, english] of SCHULNETZ_FRAGMENTS) {
    if (translated.includes(german)) translated = translated.split(german).join(english)
  }
  return translated
}

export const localizeSchulnetzPayload = (value, language) => {
  if (language !== 'en' || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = { ...value }
  for (const key of ['error', 'message', 'detail']) {
    if (typeof out[key] === 'string') out[key] = localizeSchulnetzText(out[key], language)
  }
  if (Array.isArray(out.changes)) {
    out.changes = out.changes.map((change) => {
      if (!change || typeof change !== 'object') return change
      const copy = { ...change }
      if (typeof copy.title === 'string') copy.title = localizeSchulnetzText(copy.title, language)
      if (typeof copy.body === 'string') copy.body = localizeSchulnetzText(copy.body, language)
      return copy
    })
  }
  return out
}

export const localizeResponse = (value, language, key = '') => {
  if (language !== 'en') return value
  if (typeof value === 'string') {
    if (['releaseNotes', 'changes'].includes(key)) return localizeExactText(value, language)
    return ['error', 'message', 'detail'].includes(key) ? localizeText(value, language) : value
  }
  if (Array.isArray(value)) return value.map((entry) => localizeResponse(entry, language, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, localizeResponse(child, language, childKey)]))
}
