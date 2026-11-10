import { describe, expect, it } from 'vitest'
import { pbkdf2Sync, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { allEntries, nextCommitment, weekRange, weekState, weekDays } from '../src/lib/agenda'
import { createApi } from '../src/lib/api'
import { deriveAuthKey, kdfSupported } from '../src/lib/auth'
import { demoSnapshot } from '../src/lib/demo'
import { courseLabel, courseSummaries, overallAverage, plusLabel, promotionTotals, wishFor } from '../src/lib/grades'
import { pickLanguage, STRINGS } from '../src/lib/i18n'
import { freshChanges } from '../src/lib/notify'
import { contrastRatio, hex, kantiPalette, mixColor, THEME_IDS } from '../src/lib/palette'
import { loadPrefs } from '../src/lib/prefs'
import { REFRESH_DEBOUNCE_MS, refreshDue } from '../src/lib/refresh'
import { parseRoute, routeHref } from '../src/lib/route'
import { search } from '../src/lib/search'
import { shortcutFor } from '../src/lib/shortcuts'
import { absenceTally } from '@shared/schulnetz-logic'
import { pointsLabel } from '../src/lib/i18n'
import type { Change, SchoolGrade } from '../src/types'

const grade = (fields: Partial<SchoolGrade>): SchoolGrade => ({ id: 'g', course: 'M-2a', courseId: 'M-2a', subject: 'Mathematik', title: 'Test', date: '2026-10-01', mark: 5, weight: 1, ...fields })

describe('palette (KantiPalette.kt)', () => {
  it('resolves the Snow theme with its fixed accent and the app contrast rules', () => {
    const snow = kantiPalette('snow', false, '#ff0000')
    expect(snow.fixedAccent).toBe(true)
    expect(hex(snow.background)).toBe('#f0f5fa')
    // The Snow accent ignores the user's accent and keeps 4.5:1 against every surface.
    expect(contrastRatio(snow.accent, snow.surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(snow.accent, snow.accentSoft)).toBeGreaterThanOrEqual(4.5)
  })
  it('keeps text 7:1 and muted 4.5:1 on every theme', () => {
    for (const id of THEME_IDS) {
      for (const dark of [false, true]) {
        const palette = kantiPalette(id, dark)
        for (const surface of [palette.background, palette.surface, palette.raised, palette.sunken]) {
          expect(contrastRatio(palette.text, surface)).toBeGreaterThanOrEqual(7)
          expect(contrastRatio(palette.muted, surface)).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrastRatio(palette.danger, palette.dangerSoft)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('follows the system for "system" and unknown ids, and truncates like Kotlin', () => {
    expect(kantiPalette('system', true).id).toBe('dark')
    expect(kantiPalette('nonsense', false).id).toBe('light')
    expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x7f7f7f)
  })
})

describe('grades (GradeMath.kt with the server grade math)', () => {
  it('averages per course, rounds to a half and counts Pluspunkte like the app', () => {
    const courses = courseSummaries([
      grade({ id: 'a', mark: 3.75, title: 'Mechanik', courseId: 'P', course: 'P', subject: 'Physik' }),
      grade({ id: 'b', mark: 4.5, title: 'Energie', courseId: 'P', course: 'P', subject: 'Physik' }),
      grade({ id: 'c', mark: 3, title: 'Lauf', courseId: 'S', course: 'Sport', subject: 'Sport' }),
      grade({ id: 'd', mark: 3.24, title: 'Test', courseId: 'F', course: 'F', subject: 'Französisch' }),
      grade({ id: 'e', mark: null, title: 'Offen', courseId: 'F', course: 'F', subject: 'Französisch' }),
      grade({ id: 'avg', mark: 4.5, title: 'Durchschnitt', courseId: 'P', course: 'P', subject: 'Physik', date: '' }),
    ])
    const physics = courses.find((course) => course.key === 'P')!
    expect(physics.average).toBeCloseTo(4.125)
    expect(physics.zeugnis).toBe(4)
    expect(physics.marks).toHaveLength(2)
    const sport = courses.find((course) => course.key === 'S')!
    expect(sport.promotion).toBe(false)
    const french = courses.find((course) => course.key === 'F')!
    expect(french.zeugnis).toBe(3)
    expect(french.pluspunkte).toBe(-2)
    expect(french.marks).toHaveLength(2)
    expect(promotionTotals(courses)).toEqual({ plus: 0, minus: -2, total: -2 })
    expect(plusLabel(-2)).toBe('−2')
    expect(plusLabel(1.5)).toBe('+1.5')
  })
  it('never counts a hidden grade, and the Wunschnote uses the shared formula', () => {
    const courses = courseSummaries([
      grade({ id: 'a', mark: 4, weight: 1 }),
      grade({ id: 'h', mark: null, hidden: true, title: 'Verdeckt' }),
    ])
    expect(courses[0].average).toBe(4)
    expect(courses[0].hidden).toBe(1)
    expect(overallAverage(courses)).toBe(4)
    const wish = wishFor(courses[0], 4.5, 1)
    expect(wish.needed).toBe(5)
    expect(wishFor(courses[0], 6, 0.25).achievable).toBe(false)
  })
  it('labels a course like the app', () => {
    expect(courseLabel(grade({ course: 'B-K26A', subject: 'Biologie' }))).toBe('Biologie (B-K26A)')
    expect(courseLabel(grade({ course: 'Mathematik', subject: 'Mathematik' }))).toBe('Mathematik')
  })
})

describe('agenda', () => {
  const today = '2026-11-10'
  const demo = demoSnapshot(today)
  const entries = allEntries(demo)
  it('builds the demo the way the app does', () => {
    expect(demo.grades).toHaveLength(12)
    expect(demo.exams).toHaveLength(5)
    expect(Object.keys(demo.weekRead || {})).toHaveLength(13)
    // One cancelled lesson and one substitution next week.
    expect(entries.filter((entry) => entry.cancelled)).toHaveLength(1)
    expect(entries.filter((entry) => entry.substitution)).toHaveLength(1)
    expect(entries.every((entry) => entry.event.id.startsWith('demo-'))).toBe(true)
  })
  it('finds what runs now or comes next, and skips cancelled lessons', () => {
    const running = nextCommitment(entries, { today, minutes: 8 * 60 })
    expect(running?.start).toBe('07:45')
    const later = nextCommitment(entries, { today, minutes: 15 * 60 })
    expect(later?.day).toBe('2026-11-11')
  })
  it('never shows an unread week as free', () => {
    const week = '2027-03-01'
    expect(weekState(demo, week, entries)).toBe('unread')
    expect(weekState({ ...demo, weekRead: { ...demo.weekRead, [week]: 'x' } }, week, entries)).toBe('empty')
    expect(weekState(demo, '2026-11-09', entries)).toBe('read')
    expect(weekDays('2026-11-09')).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'])
    const weeks = weekRange(demo, entries, today)
    expect(weeks[0]).toBe('2026-10-26')
    expect(weeks).toContain('2027-01-18')
  })
})

describe('sign-in', () => {
  it('derives the same auth key as the apps (PBKDF2-SHA256, second half of 512 bits, NFKC)', async () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64')
    const kdf = { algorithm: 'pbkdf2-sha256', iterations: 100_000, salt }
    const password = 'Ａbc ﬁ 123'
    const expected = pbkdf2Sync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), 100_000, 64, 'sha256').subarray(32, 64).toString('base64')
    expect(await deriveAuthKey(password, kdf, webcrypto.subtle as unknown as SubtleCrypto)).toBe(expected)
    expect(kdfSupported({ algorithm: 'pbkdf2-sha1', iterations: 600_000, salt })).toBe(false)
  })
  it('sends JSON with the CSRF token on every change and nothing extra on reads', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const api = createApi(async (url, init) => {
      seen.push({ url, init })
      if (url.endsWith('/session')) return new Response(JSON.stringify({ signedIn: true, csrf: 'token-1', connections: [] }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    await api.session()
    await api.saveSettings('abcdefabcdef', { grades: false })
    await api.snapshot('abcdefabcdef')
    const [read, write, snapshot] = seen
    expect((read.init.headers as Record<string, string>)['X-Kanti-CSRF']).toBeUndefined()
    expect((write.init.headers as Record<string, string>)['X-Kanti-CSRF']).toBe('token-1')
    expect((write.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(write.init.credentials).toBe('same-origin')
    expect(snapshot.url).toBe('/api/v1/kanti-web/connections/abcdefabcdef/snapshot')
  })
  it('treats a browser without a session as signed out and reports server messages', async () => {
    const signedOut = createApi(async () => new Response(JSON.stringify({ signedIn: false }), { status: 200 }))
    expect(await signedOut.session()).toBeNull()
    const api = createApi(async () => new Response(JSON.stringify({ error: 'Bitte erneut anmelden.' }), { status: 401 }))
    await expect(api.snapshot('abcdefabcdef')).rejects.toMatchObject({ status: 401, message: 'Bitte erneut anmelden.' })
  })
})

describe('keyboard, search, routes, notifications, prefs', () => {
  it('maps keys to actions and ignores them while typing', () => {
    expect(shortcutFor({ key: '2' })).toEqual({ type: 'view', view: 'timetable' })
    expect(shortcutFor({ key: 'ArrowRight' })).toEqual({ type: 'next' })
    expect(shortcutFor({ key: 'k', ctrlKey: true })).toEqual({ type: 'search' })
    expect(shortcutFor({ key: 'k', ctrlKey: true, typing: true })).toEqual({ type: 'search' })
    expect(shortcutFor({ key: '2', typing: true })).toBeNull()
    expect(shortcutFor({ key: 'g' })).toBe('g')
    expect(shortcutFor({ key: 'n' }, true)).toEqual({ type: 'view', view: 'grades' })
    expect(shortcutFor({ key: 'Escape', typing: true })).toEqual({ type: 'escape' })
  })
  it('finds courses, lessons by room or teacher, and views', () => {
    const demo = demoSnapshot('2026-11-10')
    const input = { entries: allEntries(demo), courses: courseSummaries(demo.grades), snapshot: demo, today: '2026-11-10', views: [{ id: 'grades', title: 'Noten' }] }
    expect(search('bio', input)[0]).toMatchObject({ type: 'course', title: 'Biologie (B-K26A)' })
    expect(search('N310', input).some((hit) => hit.type === 'entry' && hit.title === 'Physik')).toBe(true)
    expect(search('lehrperson z', input).some((hit) => hit.type === 'entry')).toBe(true)
    expect(search('noten', input)[0]).toMatchObject({ type: 'view', key: 'grades' })
    expect(search('zzzz', input)).toEqual([])
  })
  it('has stable paths for every view', () => {
    expect(parseRoute('/noten', '?fach=M').view).toBe('grades')
    expect(parseRoute('/noten/').params.get('fach')).toBeNull()
    expect(parseRoute('/unbekannt').view).toBe('today')
    expect(routeHref('timetable', { woche: '2026-11-16', eintrag: '' })).toBe('/stundenplan?woche=2026-11-16')
  })
  it('announces only changes newer than the stored position, never a backlog', () => {
    const change = (revision: number): Change => ({ id: `c${revision}`, revision, category: 'grade', title: 'Neue Note', body: '', at: '', target: '', targetId: '', courseId: '' })
    expect(freshChanges([change(3), change(4)], null)).toEqual({ show: [], cursor: 4 })
    expect(freshChanges([change(3), change(4), change(5)], 4).show.map((item) => item.revision)).toEqual([5])
    expect(freshChanges(Array.from({ length: 9 }, (_, index) => change(index + 10)), 9).show).toHaveLength(5)
  })
  it('starts from the defaults when storage is missing or broken', () => {
    expect(loadPrefs(null).theme).toBe('system')
    expect(loadPrefs({ getItem: () => '{broken' }).theme).toBe('system')
    expect(loadPrefs({ getItem: () => JSON.stringify({ theme: 'snow', snowfall: 'yes' }) })).toMatchObject({ theme: 'snow', snowfall: true })
    expect(pickLanguage('auto', ['en-GB', 'de-CH'])).toBe('en')
    expect(pickLanguage('auto', ['fr-CH'])).toBe('de')
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.de).sort())
  })
})

describe('page and assets', () => {
  it('needs no inline script or style, so the strict CSP holds', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u)
    expect(html).not.toMatch(/<style|\sstyle=/u)
  })
  it('uses the app brand mark as the favicon, byte for byte', () => {
    const icon = readFileSync(new URL('../public/kanti-icon.svg', import.meta.url))
    const master = readFileSync(new URL('../../../android/companion/docs/brand/kanti.svg', import.meta.url))
    expect(icon.equals(master)).toBe(true)
  })
})

describe('absence points (AbsencePoints.kt through the server logic)', () => {
  it('estimates the demo like the app: booked 5, open double lesson 3, 22 of 30 left', () => {
    const tally = absenceTally(demoSnapshot('2026-11-11'))
    expect(tally.booked).toBe(5)
    expect(tally.estimated).toBe(3)
    expect(tally.remaining).toBe(22)
    expect(Object.values(tally.estimates).map((estimate) => estimate.rule)).toEqual(['lessons', 'lessons'])
  })

  it('labels points like the app', () => {
    expect(pointsLabel(3, 'de')).toBe('3')
    expect(pointsLabel(2.5, 'de')).toBe('2,5')
    expect(pointsLabel(2.5, 'en')).toBe('2.5')
    expect(STRINGS.de.ruleLessons(2, 3)).toBe('2 Lektionen am Stück: 2 + 1 = 3 Punkte')
  })
})

describe('refresh on return to the tab', () => {
  it('refreshes at once, but not twice within 30 seconds and not while loading', () => {
    const now = 1_000_000_000
    expect(refreshDue(0, now, false)).toBe(true)
    expect(refreshDue(now - 10_000, now, false)).toBe(false)
    expect(refreshDue(now - REFRESH_DEBOUNCE_MS, now, false)).toBe(true)
    expect(refreshDue(now - 120_000, now, true)).toBe(false)
    // A clock that went back never blocks refreshing.
    expect(refreshDue(now + 60_000, now, false)).toBe(true)
  })
})
