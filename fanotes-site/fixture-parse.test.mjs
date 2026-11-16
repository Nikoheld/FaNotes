import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseGradesHtml, parseKontoauszug, kontoStatementRead, parseSchedulerXml, readAbsenceStatement, terminlisteNextUrl } from './schulnetz-logic.mjs'

const stored = (name) => readFileSync(new URL(`../android/core/src/test/resources/schulnetz/${name}`, import.meta.url), 'utf8')
const local = (name) => readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8')

test('stored grade pages keep each exam and not the course average', () => {
  const grades = parseGradesHtml(stored('noten.html'))
  assert.equal(grades.length, 2)
  const chem = grades.find((grade) => grade.course.startsWith('Chemie'))
  const math = grades.find((grade) => grade.course.startsWith('MATH'))
  assert.equal(chem.mark, 5.5)
  assert.equal(chem.date, '2026-03-03')
  assert.equal(chem.title, 'Laborbericht')
  assert.equal(chem.courseGrade, 5)
  assert.equal(math.mark, 4.5)
  assert.equal(math.date, '2026-04-04')
  assert.equal(math.courseGrade, 4)
  assert.equal(grades.some((grade) => /durchschnitt/iu.test(grade.title)), false)

  const wide = parseGradesHtml(stored('noten-5141.html'))
  assert.equal(wide.length, 8)
  assert.equal(wide.find((grade) => grade.title === 'Algebra 1').mark, 5.5)
  assert.equal(parseGradesHtml(stored('noten-multi-course.html')).length, 18)
})

test('the stored Kontoauszug is a statement and keeps every booking', () => {
  const html = stored('kontoauszug.html')
  assert.equal(kontoStatementRead(html), true)
  const lines = parseKontoauszug(html)
  assert.equal(lines.length, 11)
  assert.equal(lines[0].date, '01.02.2026')
  assert.equal(lines[0].label, 'Klassenkasse Posten 1')
  assert.equal(lines[0].amount, '-12.50')
  assert.equal(lines[0].balance, '100.00')
  assert.equal(lines.at(-1).balance, '88.00')
})

test('stored absence pages keep booked points and do not treat an empty page as a read', () => {
  const empty = readAbsenceStatement(stored('absenzen.html'))
  assert.equal(empty.read, false)
  assert.equal(empty.absences.length, 0)

  const open = readAbsenceStatement(stored('absenzen-aksa-open.html'))
  assert.equal(open.read, true)
  assert.equal(open.quota, 30)
  assert.equal(open.remaining, 30)
  assert.equal(open.absences.length, 2)
  assert.equal(open.absences.every((row) => row.pending === true && row.status === 'offen'), true)

  const booked = readAbsenceStatement(stored('absenzen-aksa-booked.html'))
  assert.equal(booked.remaining, 27)
  const illness = booked.absences.find((row) => row.reason === 'Krankheit')
  assert.equal(illness.points, 3)
  assert.equal(illness.status, 'gebucht')
})

test('a stored scheduler week keeps a cancellation on the lesson and not on the exam', () => {
  const events = parseSchedulerXml(local('scheduler-week.xml'))
  assert.equal(events.length, 3)
  const lesson = events.find((event) => event.id === 'L1')
  const cancelled = events.find((event) => event.id === 'L2')
  const exam = events.find((event) => event.id === 'E1')
  assert.equal(lesson.text, 'Physik')
  assert.equal(lesson.room, 'A12')
  assert.equal(lesson.status, '')
  assert.equal(lesson.start, '2026-11-16T07:45:00')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.marker, 'cancelled')
  assert.equal(cancelled.text, 'Mathematik')
  assert.equal(exam.eventType, 'exam')
  assert.equal(exam.status, '')
  assert.equal(exam.comment, 'Stoichiometrie')
  assert.equal(exam.room, 'C11')
  assert.equal(lesson.comment, '')
  assert.equal(cancelled.comment, '')
  assert.equal(exam.start, '2026-11-18T10:15:00')
})

test('the stored Terminliste points at the next page of rows', () => {
  const next = terminlisteNextUrl(stored('terminliste.html'), 'https://www.schulnetz-ag.ch/aksa')
  assert.equal(next, 'https://www.schulnetz-ag.ch/aksa/index.php?pageid=22108&sRow=25')
})
