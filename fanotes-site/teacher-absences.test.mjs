import assert from 'node:assert/strict'
import test from 'node:test'
import { diffSnapshots, newerTeacherAbsences, parseRawSnapshot, parseTeacherAbsences, teacherAbsenceField } from './schulnetz-logic.mjs'

// Synthetic names only.
const page = (card) => `<html><body><a href="index.php?pageid=1">Start</a>${card}</body></html>`
const card = (inner) => `<div class="mdl-card cls-card mdl-card--information " id="x1"><div class="mdl-card__title">t</div><div class="mdl-card__supporting-text">${inner}</div></div><div>Nach der Karte<p>Fremd</p></div>`

test('both sections from one card', () => {
  const html = page(card('<p>---Abwesende Lehrpersonen:</p><p>Muster</p><p><br>---Lehrpersonen auf Exkursion:<br>Beispiel Ann (7.30 - 12.45 Uhr)</p>'))
  assert.deepEqual(parseTeacherAbsences(html), { absent: ['Muster'], excursion: ['Beispiel Ann (7.30 - 12.45 Uhr)'] })
})

test('only one section', () => {
  assert.deepEqual(parseTeacherAbsences(page(card('<p>---Abwesende Lehrpersonen:</p><p>Muster</p>'))), { absent: ['Muster'], excursion: [] })
  assert.deepEqual(parseTeacherAbsences(page(card('<p>---Lehrpersonen auf Exkursion:<br>Beispiel</p>'))), { absent: [], excursion: ['Beispiel'] })
})

test('several names split on br and paragraphs, never on commas', () => {
  const html = page(card('<p>---Abwesende Lehrpersonen:<br>Muster, Hans<br>Probe</p><p>Beispiel</p><p>---Lehrpersonen auf Exkursion:</p><p>Eins</p><p>Zwei</p>'))
  assert.deepEqual(parseTeacherAbsences(html), { absent: ['Muster, Hans', 'Probe', 'Beispiel'], excursion: ['Eins', 'Zwei'] })
})

test('nbsp, entities, case and missing dashes', () => {
  const html = page(card('<p>ABWESENDE&nbsp;LEHRPERSONEN :</p><p>M&uuml;ller&nbsp;Test</p><p>Lehrpersonen&nbsp;auf Exkursion</p><p>&nbsp;</p><p>Beispiel &amp; Co</p>'))
  assert.deepEqual(parseTeacherAbsences(html), { absent: ['Müller Test'], excursion: ['Beispiel & Co'] })
})

test('no card gives empty lists, blank and login walls give null', () => {
  assert.deepEqual(parseTeacherAbsences(page('<p>Nichts</p>')), { absent: [], excursion: [] })
  assert.equal(parseTeacherAbsences(''), null)
  assert.equal(parseTeacherAbsences('   '), null)
  assert.equal(parseTeacherAbsences('<html><body><form><input type="password"></form></body></html>'), null)
  assert.equal(parseTeacherAbsences('<html>https://login.microsoftonline.com ConvergedSignIn pageid=1</html>'), null)
})

test('caps entries and length', () => {
  const names = Array.from({ length: 60 }, (_, index) => `<br>Name${index}`).join('')
  const parsed = parseTeacherAbsences(page(card(`<p>---Abwesende Lehrpersonen:${names}<br>${'x'.repeat(300)}</p>`)))
  assert.equal(parsed.absent.length, 40)
  const long = parseTeacherAbsences(page(card(`<p>---Abwesende Lehrpersonen:<br>${'x'.repeat(300)}</p>`)))
  assert.equal(long.absent[0].length, 120)
})

test('snapshot field carries the Zurich day of the read', () => {
  const html = page(card('<p>---Abwesende Lehrpersonen:</p><p>Muster</p>'))
  assert.deepEqual(teacherAbsenceField(html, '2026-11-09T23:30:00Z'), { day: '2026-11-10', absent: ['Muster'], excursion: [] })
  assert.equal(teacherAbsenceField('', '2026-11-09T10:00:00Z'), null)
  const snapshot = parseRawSnapshot({ startHtml: html }, '2026-11-09T10:00:00Z')
  assert.equal(snapshot.teacherAbsences.day, '2026-11-09')
  assert.equal('teacherAbsences' in parseRawSnapshot({ startHtml: '' }, '2026-11-09T10:00:00Z'), false)
})

test('the newer day wins, a malformed value loses', () => {
  const old = { day: '2026-11-08', absent: ['A'], excursion: [] }
  const fresh = { day: '2026-11-09', absent: ['B'], excursion: [] }
  assert.equal(newerTeacherAbsences(old, fresh).day, '2026-11-09')
  assert.equal(newerTeacherAbsences(fresh, old).day, '2026-11-09')
  assert.equal(newerTeacherAbsences(fresh, undefined).day, '2026-11-09')
  assert.equal(newerTeacherAbsences(fresh, { day: 'x', absent: 'no' }).day, '2026-11-09')
  assert.equal(newerTeacherAbsences(undefined, null), undefined)
})

test('a changed teacherAbsences produces no change notice', () => {
  const base = { revision: 1, grades: [], events: [], exams: [], absences: [], homework: [], messages: [], vacations: [], konto: [], kontoSaldo: '', startMessages: [] }
  const before = { ...base, teacherAbsences: { day: '2026-11-08', absent: ['A'], excursion: [] } }
  const after = { ...base, revision: 2, teacherAbsences: { day: '2026-11-09', absent: ['B', 'C'], excursion: ['D'] } }
  assert.deepEqual(diffSnapshots(before, after, {}, '2026-11-09'), [])
  assert.deepEqual(diffSnapshots(base, after, {}, '2026-11-09'), [])
})
