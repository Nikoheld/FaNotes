// Teacher absences, the Mensa week view and school assignments on the web.
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { TeacherAbsenceCard } from '../src/components/TeacherAbsenceCard'
import { MensaCard } from '../src/components/MensaCard'
import { demoMensa, demoSnapshot } from '../src/lib/demo'
import { homeworkDay, homeworkDue, homeworkList } from '../src/lib/homework'
import { STRINGS } from '../src/lib/i18n'
import { mensaPreselectedDate, mensaTargetDate, mensaWeekSlots, toMensaFeed } from '../src/lib/mensa'
import { DEFAULT_PREFS, loadPrefs } from '../src/lib/prefs'
import { PATHS, parseRoute, routeHref } from '../src/lib/route'
import { ALL_VIEWS, shortcutFor, VIEWS, visibleViews } from '../src/lib/shortcuts'
import { search } from '../src/lib/search'
import { teacherAbsenceLine, teacherAbsencesToday } from '../src/lib/teacher-absences'
import { HomeworkDetails, HomeworkRow } from '../src/views/common'

const TODAY = '2026-11-10' // a Tuesday
const snapshot = { ...demoSnapshot(TODAY), teacherAbsences: { day: TODAY, absent: ['Muster', 'Probe'], excursion: ['Beispiel (7.30 - 12.45 Uhr)'] } }

describe('teacher absences', () => {
  it('is off by default and survives a stored pref', () => {
    expect(DEFAULT_PREFS.showTeacherAbsences).toBe(false)
    const stored = { getItem: () => JSON.stringify({ showTeacherAbsences: true }) }
    expect(loadPrefs(stored).showTeacherAbsences).toBe(true)
  })
  it('shows only a read from today', () => {
    expect(teacherAbsencesToday(snapshot, TODAY)?.absent).toEqual(['Muster', 'Probe'])
    expect(teacherAbsencesToday(snapshot, '2026-11-11')).toBeNull()
    expect(teacherAbsencesToday({ ...snapshot, teacherAbsences: undefined }, TODAY)).toBeNull()
    expect(teacherAbsencesToday(null, TODAY)).toBeNull()
  })
  it('builds the one line like the app', () => {
    const t = STRINGS.de
    expect(teacherAbsenceLine({ day: TODAY, absent: ['A', 'B'], excursion: ['C'] }, t.teacherOnExcursion)).toBe('A, B  ·  auf Exkursion: C')
    expect(teacherAbsenceLine({ day: TODAY, absent: [], excursion: ['C'] }, STRINGS.en.teacherOnExcursion)).toBe('on excursion: C')
    expect(teacherAbsenceLine({ day: TODAY, absent: [], excursion: [] }, t.teacherOnExcursion)).toBe('')
  })
  it('renders the card in both languages, with the empty text when nobody is listed', () => {
    const html = renderToString(<TeacherAbsenceCard absences={snapshot.teacherAbsences} t={STRINGS.de} />)
    expect(html).toContain('Abwesende Lehrpersonen')
    expect(html).toContain('Muster, Probe')
    expect(html).toContain('auf Exkursion: Beispiel')
    expect(renderToString(<TeacherAbsenceCard absences={{ day: TODAY, absent: [], excursion: [] }} t={STRINGS.en} />)).toContain('No absences reported today')
  })
})

describe('Mensa week view', () => {
  const feed = demoMensa(TODAY)
  it('offers this week and next week when the feed knows it', () => {
    const slots = mensaWeekSlots(feed.days, TODAY)
    expect(slots).toHaveLength(10)
    expect(slots[0]).toMatchObject({ date: '2026-11-09', nextWeek: false })
    expect(slots[5]).toMatchObject({ date: '2026-11-16', nextWeek: true })
    expect(slots.every((slot) => slot.day !== null)).toBe(true)
  })
  it('leaves next week out when the feed has none of it, and keeps unknown days empty', () => {
    const slots = mensaWeekSlots(feed.days.filter((day) => day.date < '2026-11-14' && day.date !== '2026-11-11'), TODAY)
    expect(slots).toHaveLength(5)
    expect(slots[2].day).toBeNull()
  })
  it('on a weekend the current week is the one that just ended', () => {
    expect(mensaWeekSlots(feed.days, '2026-11-14')[0].date).toBe('2026-11-09')
  })
  it('preselects what the Today card shows, falling back to today or the closest earlier day', () => {
    const slots = mensaWeekSlots(feed.days, TODAY)
    expect(mensaTargetDate(new Date('2026-11-10T08:00:00Z'))).toBe('2026-11-10')
    expect(mensaPreselectedDate(slots, new Date('2026-11-10T08:00:00Z'))).toBe('2026-11-10')
    expect(mensaPreselectedDate(slots, new Date('2026-11-10T14:00:00Z'))).toBe('2026-11-11')
    expect(mensaPreselectedDate(slots.slice(0, 5), new Date('2026-11-13T14:00:00Z'))).toBe('2026-11-13')
    expect(mensaPreselectedDate([], new Date())).toBeNull()
  })
  it('reads the server body into the same week slots', () => {
    const parsed = toMensaFeed({ fetchedAt: '2026-11-10T07:00:00Z', stale: true, days: [{ date: '2026-11-10', closed: false, menus: [{ name: 'Risotto', studentPrice: 9 }] }] })
    expect(parsed.stale).toBe(true)
    expect(mensaWeekSlots(parsed.days, TODAY)[1].day?.menus[0].name).toBe('Risotto')
  })
  it('links the Today card to the week', () => {
    const html = renderToString(<MensaCard day={feed.days[1]} t={STRINGS.de} language="de" onWeek={() => undefined} />)
    expect(html).toContain('Woche')
    expect(renderToString(<MensaCard day={feed.days[1]} t={STRINGS.de} language="de" />)).not.toContain('Woche')
  })
})

describe('Mensa navigation', () => {
  it('is in the menu only while the Mensa pref is on, before Pendeln', () => {
    expect(VIEWS).not.toContain('mensa')
    expect(visibleViews(false)).toEqual(VIEWS)
    expect(visibleViews(true)).toEqual(ALL_VIEWS)
    expect(ALL_VIEWS.slice(-4)).toEqual(['mensa', 'commute', 'notes', 'settings'])
  })
  it('keeps the number keys of the default menu and shifts them with the Mensa on', () => {
    expect(shortcutFor({ key: '7' })).toEqual({ type: 'view', view: 'commute' })
    // Notizen was added after Pendeln: 7 and 8 keep their meaning, Einstellungen moves to 9 (and stays on the comma key).
    expect(shortcutFor({ key: '8' })).toEqual({ type: 'view', view: 'notes' })
    expect(shortcutFor({ key: '9' })).toEqual({ type: 'view', view: 'settings' })
    const views = visibleViews(true)
    expect(shortcutFor({ key: '7' }, false, views)).toEqual({ type: 'view', view: 'mensa' })
    expect(shortcutFor({ key: '9' }, false, views)).toEqual({ type: 'view', view: 'notes' })
    expect(shortcutFor({ key: ',' }, false, views)).toEqual({ type: 'view', view: 'settings' })
  })
  it('g l opens the Mensa only while it is on', () => {
    expect(shortcutFor({ key: 'l' }, true)).toBeNull()
    expect(shortcutFor({ key: 'l' }, true, visibleViews(true))).toEqual({ type: 'view', view: 'mensa' })
  })
  it('has its own path', () => {
    expect(PATHS.mensa).toBe('/mensa')
    expect(parseRoute('/mensa').view).toBe('mensa')
    expect(routeHref('mensa')).toBe('/mensa')
  })
  it('the command palette lists the views it is given', () => {
    const input = (views: string[]) => ({ entries: [], courses: [], snapshot: null, today: TODAY, views: views.map((id) => ({ id, title: STRINGS.de[id as 'mensa'] })) })
    expect(search('mensa', input(visibleViews(false))).some((hit) => hit.key === 'mensa')).toBe(false)
    expect(search('mensa', input(visibleViews(true))).some((hit) => hit.type === 'view' && hit.key === 'mensa')).toBe(true)
  })
})

describe('school assignments', () => {
  const homework = [
    { id: 'a', title: 'Später', description: '', dueDate: '2026-11-20', courseId: '', courseName: 'Deutsch' },
    { id: 'b', title: 'Morgen', description: 'Seite 5', dueDate: '2026-11-11', courseId: '', courseName: 'Mathematik' },
    { id: 'c', title: 'Gestern', description: '', dueDate: '09.11.2026', courseId: '', courseName: '' },
    { id: 'd', title: 'Ohne Datum', description: '', dueDate: '', courseId: '', courseName: '' },
    { id: 'e', title: '  ', description: '', dueDate: '2026-11-12', courseId: '', courseName: '' },
  ]
  it('reads ISO and Swiss dates', () => {
    expect(homeworkDay('2026-11-11T00:00:00')).toBe('2026-11-11')
    expect(homeworkDay('9.1.2026')).toBe('2026-01-09')
    expect(homeworkDay('bald')).toBe('')
  })
  it('lists open ones soonest first, undated last, and past ones latest first', () => {
    expect(homeworkList(homework, TODAY).map((item) => item.title)).toEqual(['Morgen', 'Später', 'Ohne Datum'])
    expect(homeworkList(homework, TODAY, true).map((item) => item.title)).toEqual(['Gestern'])
    expect(homeworkList(undefined, TODAY)).toEqual([])
  })
  it('picks the dated ones due within the horizon for Today', () => {
    expect(homeworkDue(homework, TODAY, '2026-11-14').map((item) => item.title)).toEqual(['Morgen'])
  })
  it('renders a row and its details', () => {
    const [item] = homeworkList(homework, TODAY)
    const row = renderToString(<HomeworkRow item={item} t={STRINGS.de} language="de" today={TODAY} onOpen={() => undefined} />)
    expect(row).toContain('Morgen')
    expect(row).toContain('Mathematik')
    expect(renderToString(<HomeworkDetails item={item} t={STRINGS.en} language="en" />)).toContain('Seite 5')
  })
  it('the demo has some and both languages name them', () => {
    expect(homeworkList(demoSnapshot(TODAY).homework, TODAY).length).toBeGreaterThan(0)
    expect(STRINGS.de.schoolAssignments).toBe('Schulaufträge')
    expect(STRINGS.en.noSchoolAssignments).toBe('No school assignments')
  })
})
