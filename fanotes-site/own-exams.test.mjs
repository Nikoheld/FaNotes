import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { carryTimetableExams, courseIdentity, diffSnapshots, ownExams, parseSchedulerXml } from './schulnetz-logic.mjs'
import { scrapeWithSession } from './schulnetz-web.mjs'

// Synthetic data only. Shapes follow the live structure: lessons carry a numeric course id and a
// code such as Sub_G24a_Teach, Subj_G24a or "Subj 2.3"; overview exams have no course id and start
// their course name with the course code.
const lesson = (id, courseName, day = '2026-11-02') => ({ id, start: `${day}T07:45:00`, end: `${day}T08:30:00`, text: courseName, courseName, courseId: '9001', teachers: [], room: '', status: '', eventType: '0_stp', timetableText: courseName })
const exam = (id, courseName, day = '2099-02-10') => ({ id, start: `${day}T10:15:00`, end: `${day}T11:00:00`, text: courseName, courseName, courseId: '', teachers: [], room: 'B04', status: '', eventType: 'exam', timetableText: courseName })
const timetable = [lesson('l1', 'Mat_G24a_Holm'), lesson('l2', 'Eng_G24a'), lesson('l3', 'Phy 2.3'), lesson('l4', 'Bio_G24a_Nord', '2026-11-03')]
const ids = (list) => list.map((event) => event.id)

test('course identity accepts underscore and space separators and needs a group part', () => {
  assert.deepEqual(courseIdentity('Mat_G24a_Holm'), { subject: 'mat', group: 'g24a', teacher: 'holm' })
  assert.deepEqual(courseIdentity('Phy 2.3'), { subject: 'phy', group: '2.3', teacher: '' })
  assert.deepEqual(courseIdentity('Phy 2.3 Test Kapitel 4'), { subject: 'phy', group: '2.3', teacher: '' })
  assert.equal(courseIdentity('Bio Test Zellen'), null)
  assert.equal(courseIdentity('Notenkonferenz'), null)
  assert.equal(courseIdentity(''), null)
})

test('the overview exam of a course the student does not take is dropped, their own is kept', () => {
  const own = exam('e1', 'Mat_G24a_Holm Test 1')
  const foreign = exam('e2', 'Chx_2.3_Salt Test 2')
  assert.deepEqual(ids(ownExams([own, foreign], timetable).exams), ['e1'])
})

test('the other group of the same subject is excluded, the student\'s group kept', () => {
  const mine = exam('e1', 'Phy_2.3_Kern Test')
  const other = exam('e2', 'Phy_2.4_Kern Test')
  const otherClass = exam('e3', 'Eng_G24b Test')
  const spaced = exam('e4', 'Phy 2.3 Test')
  assert.deepEqual(ids(ownExams([mine, other, otherClass, spaced], timetable).exams), ['e1', 'e4'])
})

test('a missing teacher on one side still matches, a different teacher does not', () => {
  assert.deepEqual(ids(ownExams([exam('a', 'Eng_G24a_Berg Test'), exam('b', 'Mat_G24a Test'), exam('c', 'Mat_G24a_Glas Test')], timetable).exams), ['a', 'b'])
})

test('entries without a course code are kept, with one or several own courses of the subject', () => {
  const bio = exam('bio', 'Bio Test Zellen')
  const termin = { ...exam('trm', 'Klassenabend'), eventType: '5_trm' }
  assert.deepEqual(ids(ownExams([bio, termin], timetable).exams), ['bio', 'trm'])
  assert.deepEqual(ids(ownExams([bio], [...timetable, lesson('l9', 'Bio 2.1')]).exams), ['bio'])
})

test('the course set covers every loaded week, not only the exam week', () => {
  const later = [lesson('x1', 'Chx_2.3_Salt', '2026-09-14')]
  assert.deepEqual(ids(ownExams([exam('e2', 'Chx_2.3_Salt Test', '2026-12-01')], later).exams), ['e2'])
})

test('without a loaded timetable nothing is filtered and the state is marked', () => {
  const foreign = exam('e2', 'Chx_2.3_Salt Test')
  const none = ownExams([foreign], [])
  assert.deepEqual(ids(none.exams), ['e2'])
  assert.equal(none.unfiltered, true)
  assert.equal(ownExams([foreign], [{ ...exam('t', 'Event'), eventType: 'event' }]).unfiltered, true)
  assert.equal(ownExams([foreign], timetable).unfiltered, false)
  assert.equal(ownExams([], []).unfiltered, false)
})

test('an exam in the personal timetable and in the overview is one exam', () => {
  const inTimetable = { ...exam('tt-1', 'Mat_G24a_Holm Test 1'), eventType: '1_pru' }
  const inOverview = exam('ov-1', 'Mat_G24a_Holm Test 1')
  assert.equal(carryTimetableExams([inTimetable], [inOverview]).length, 1)
  assert.deepEqual(ids(ownExams(carryTimetableExams([inTimetable], []), timetable).exams), ['tt-1'])
})

test('a scrape keeps the own overview exams and drops the whole department\'s other courses', async () => {
  const shell = (name) => readFileSync(new URL(`../android/core/src/test/resources/schulnetz/${name}`, import.meta.url), 'utf8')
  const field = (name, value) => `<${name}>${value}</${name}>`
  const lessonEvent = (id, code, day) => `<event id="${id}">${field('start_date', `${day} 07:45`)}${field('end_date', `${day} 08:30`)}${field('text', code)}${field('kurskuerzel', code)}${field('kursid', '9001')}${field('event_type', '0_stp')}</event>`
  const examEvent = (id, title, day) => `<event id="${id}">${field('start_date', `${day} 10:15`)}${field('end_date', `${day} 11:00`)}${field('text', title)}${field('kurskuerzel', title)}${field('event_type', '1_pru')}</event>`
  const fetchImpl = async (url) => {
    const target = String(url)
    const q = Object.fromEntries(new URL(target).searchParams)
    let body = '<html><body></body></html>'
    if (target.includes('scheduler_processor')) {
      body = "<?xml version='1.0' encoding='utf-8' ?><data></data>"
      if (q.pageid === '22202' && q.min_date === '2026-11-02') body = `<data>${lessonEvent('a', 'Mat_G24a_Holm', '2026-11-02')}</data>`
      if (q.pageid === '21312' && q.min_date === '2026-11-09') body = `<data>${examEvent('x1', 'Mat_G24a_Holm Test 1', '2026-11-10')}${examEvent('x2', 'Chx_2.3_Salt Test 2', '2026-11-11')}</data>`
    } else if (q.pageid === '22202') body = shell('stundenplan-5141.html')
    else if (q.pageid === '21312') body = shell('pruefungsplan-5141.html')
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const read = await scrapeWithSession('https://www.schulnetz-ag.ch/aksa', { php: 'php', id: 'f1a2b3c4d5e6f708', transid: 'a1b2c3', userAgent: 'test' }, fetchImpl, { today: '2026-11-06', now: '2026-11-06T17:00:00Z' })
  assert.deepEqual(ids(read.exams), ['x1'])
  assert.equal(read.examsUnfiltered, false)
  const without = await scrapeWithSession('https://www.schulnetz-ag.ch/aksa', { php: 'php', id: 'f1a2b3c4d5e6f708', transid: 'a1b2c3', userAgent: 'test' }, async (url) => {
    const response = await fetchImpl(url)
    const q = Object.fromEntries(new URL(String(url)).searchParams)
    return q.pageid === '22202' && String(url).includes('scheduler_processor') ? { ...response, text: async () => '<data></data>' } : response
  }, { today: '2026-11-06', now: '2026-11-06T17:00:00Z' })
  assert.deepEqual(ids(without.exams), ['x1', 'x2'])
  assert.equal(without.examsUnfiltered, true)
  assert.equal(parseSchedulerXml(`<data>${examEvent('x1', 'Mat_G24a_Holm Test 1', '2026-11-10')}</data>`)[0].eventType, 'exam')
})

const base = { grades: [], events: timetable, exams: [], absences: [], messages: [] }
const titles = (previous, next) => diffSnapshots(previous, next, {}).map((change) => change.title)

test('no notification for a foreign exam, one for an own exam', () => {
  assert.deepEqual(titles(base, { ...base, exams: [exam('e2', 'Chx_2.3_Salt Test 2')] }), [])
  assert.deepEqual(titles(base, { ...base, exams: [exam('e1', 'Mat_G24a_Holm Test 1')] }), ['Neue Prüfung'])
})

test('a foreign exam leaving the stored list on migration is silent', () => {
  const stored = { ...base, exams: [exam('e1', 'Mat_G24a_Holm Test 1'), exam('e2', 'Chx_2.3_Salt Test 2')] }
  assert.deepEqual(titles(stored, { ...base, exams: [exam('e1', 'Mat_G24a_Holm Test 1')] }), [])
})

test('an unloaded timetable keeps the old diff behaviour', () => {
  const none = { ...base, events: [] }
  assert.deepEqual(titles(none, { ...none, exams: [exam('e2', 'Chx_2.3_Salt Test 2')] }), ['Neue Prüfung'])
})

test('an all-day exam listed twice under different ids is one exam; different courses or days stay apart', () => {
  const allDay = (id, courseName, day = '2099-02-10') => ({ ...exam(id, courseName, day), start: `${day}T00:00:00`, end: `${day}T00:00:00` })
  const first = allDay('7', 'Phy 2.3 Test Kapitel 4')
  const twin = allDay('12', 'Phy 2.3 Test Kapitel 4')
  assert.deepEqual(ids(carryTimetableExams([], [first, twin])), ['7'])
  assert.equal(carryTimetableExams([], [first, allDay('13', 'Mat_G24a_Holm Test 1')]).length, 2, 'another course on the same day')
  assert.equal(carryTimetableExams([], [first, allDay('14', 'Phy 2.3 Test Kapitel 4', '2099-02-11')]).length, 2, 'the same course on another day')
  // The stored list still has both copies; collapsing them is not news.
  const previous = { events: timetable, exams: [first, twin], examWeekFetched: {} }
  assert.equal(diffSnapshots(previous, { ...previous, exams: carryTimetableExams([], [first, twin]) }).filter((change) => change.category === 'exam').length, 0)
})
