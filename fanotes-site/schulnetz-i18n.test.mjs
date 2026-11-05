import assert from 'node:assert/strict'
import test from 'node:test'
import { localizeSchulnetzPayload, localizeSchulnetzText, schulnetzLanguage } from './i18n.mjs'

test('missing or German Accept-Language keeps Schulnetz copy in German', () => {
  assert.equal(schulnetzLanguage({ headers: {} }), 'de')
  assert.equal(schulnetzLanguage({ headers: { 'accept-language': 'de-CH,de;q=0.9' } }), 'de')
  assert.equal(localizeSchulnetzText('Neue Prüfung', 'de'), 'Neue Prüfung')
  const payload = localizeSchulnetzPayload({ error: 'Schulnetz ist noch nicht verbunden.', changes: [{ title: 'Neue Note', body: 'Mathe · Gewicht 1' }] }, 'de')
  assert.equal(payload.error, 'Schulnetz ist noch nicht verbunden.')
  assert.equal(payload.changes[0].title, 'Neue Note')
  assert.equal(payload.changes[0].body, 'Mathe · Gewicht 1')
})

test('English Accept-Language translates Schulnetz errors and change text', () => {
  assert.equal(schulnetzLanguage({ headers: { 'accept-language': 'en-US,en;q=0.8' } }), 'en')
  assert.equal(localizeSchulnetzText('Neue Prüfung', 'en'), 'New exam')
  assert.equal(localizeSchulnetzText('3 neue Noten – tippen zum Aufdecken', 'en'), '3 new grades – tap to reveal')
  const payload = localizeSchulnetzPayload({
    error: 'Schulnetz ist noch nicht verbunden.',
    grades: [{ title: 'Probe' }],
    changes: [{ title: 'Neue Absenz', body: 'Sport · nicht entschuldigt', course: 'Sport' }],
  }, 'en')
  assert.equal(payload.error, 'Schulnetz is not connected yet.')
  assert.equal(payload.grades[0].title, 'Probe')
  assert.equal(payload.changes[0].title, 'New absence')
  assert.equal(payload.changes[0].body, 'Sport · unexcused')
  assert.equal(payload.changes[0].course, 'Sport')
})
