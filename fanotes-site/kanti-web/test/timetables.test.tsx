import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createAdminApi, createApi } from '../src/lib/api'
import { STRINGS } from '../src/lib/i18n'
import { ADMIN_TIMETABLE_PATH, parseRoute } from '../src/lib/route'
import { cellEntries, cellLabel, isAksaConnection, readSummary, roomDays, roomStarts, type RoomEntry } from '../src/lib/timetables'
import { KantiProvider } from '../src/state'
import { AdminTimetable } from '../src/views/AdminTimetable'

const entry = (fields: Partial<RoomEntry>): RoomEntry => ({ day: 1, start: '07:45', end: '08:35', class: 'G26A', subject: 'deu', teacher: 'ZimLu', ...fields })

describe('other classes and rooms (synthetic data)', () => {
  it('knows the Alte Kanti by its Schulnetz path', () => {
    expect(isAksaConnection('https://www.schulnetz-ag.ch/aksa')).toBe(true)
    expect(isAksaConnection('https://www.schulnetz-ag.ch/aksa/')).toBe(true)
    expect(isAksaConnection('https://www.schulnetz-ag.ch/kska')).toBe(false)
    expect(isAksaConnection('')).toBe(false)
    expect(isAksaConnection(undefined)).toBe(false)
  })

  it('reads the summary and drops anything that is not a class code or room name', () => {
    expect(readSummary(null)).toEqual({ available: false })
    expect(readSummary({ available: false })).toEqual({ available: false })
    expect(readSummary({ available: true, classes: [], rooms: [] }).available).toBe(false)
    const summary = readSummary({ available: true, uploadedAt: '2026-11-11T08:00:00Z', semester: 'SJ 2026-27', classes: [{ code: 'G26A', teacher: 'ZimLu' }, { code: '../x' }, 7], rooms: ['516', 'Wed_A', '<script>', 'a'.repeat(30)] })
    expect(summary.available).toBe(true)
    expect(summary.classes).toEqual([{ code: 'G26A', teacher: 'ZimLu' }])
    expect(summary.rooms).toEqual(['516', 'Wed_A'])
  })

  it('maps a room week to day columns, start rows and cells', () => {
    const entries = [
      entry({ day: 2, start: '08:35', class: 'G26B', subject: 'spf', teacher: 'BauAn' }),
      entry({ day: 2, start: '08:35', class: 'G26A', subject: 'spf', teacher: 'BauAn' }),
      entry({ day: 1 }),
      entry({ day: 2, start: '08:35', class: 'G26D', subject: 'phy', teacher: 'LanFr' }),
    ]
    const days = roomDays(entries)
    expect(days.map((day) => day.entries.length)).toEqual([1, 3, 0, 0, 0])
    expect(days[1].entries.map((item) => item.class)).toEqual(['G26A', 'G26B', 'G26D'])
    expect(roomStarts(entries)).toEqual(['07:45', '08:35'])
    const cell = cellEntries(entries, 2, '08:35')
    expect(cellLabel(cell)).toEqual([
      { text: 'spf · BauAn', classes: 'G26B, G26A' },
      { text: 'phy · LanFr', classes: 'G26D' },
    ])
    expect(cellEntries(entries, 5, '07:45')).toEqual([])
  })

  it('routes the admin page by URL only and keeps it out of the navigation', () => {
    expect(ADMIN_TIMETABLE_PATH).toBe('/admin/stundenplan')
    expect(parseRoute('/admin/stundenplan').admin).toBe('timetable')
    expect(parseRoute('/admin/stundenplan/').admin).toBe('timetable')
    expect(parseRoute('/stundenplan').admin).toBeUndefined()
  })

  it('has the strings in both languages', () => {
    for (const language of ['de', 'en'] as const) {
      const t = STRINGS[language]
      expect(t.otherTimetables.length).toBeGreaterThan(3)
      expect(t.adminDone(3, 9)).toContain('3')
    }
    expect(STRINGS.de.otherTimetables).toBe('Andere Klassen & Räume')
    expect(STRINGS.en.otherTimetables).toBe('Other classes & rooms')
  })

  it('builds the per-connection URLs and sends the admin token only as a bearer header', async () => {
    const api = createApi(async () => new Response('{}', { status: 200 }))
    expect(api.timetableClassImage('abc123abc123', 'G26D')).toBe('/api/v1/kanti-web/connections/abc123abc123/timetables/class/G26D.png')
    const seen: { url: string; init: RequestInit }[] = []
    const admin = createAdminApi(async (url, init) => { seen.push({ url, init }); return new Response('{"available":false}', { status: 200 }) })
    await admin.index(' secret ')
    await admin.upload('secret', new Blob(['%PDF-1.4'], { type: 'application/pdf' }))
    expect(seen[0].url).toBe('/api/v1/kanti-web/admin/timetable-pdf')
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret')
    expect(seen[0].init.credentials).toBe('omit')
    expect((seen[1].init.headers as Record<string, string>)['Content-Type']).toBe('application/pdf')
    expect(seen[1].init.method).toBe('POST')
  })

  it('renders the admin page without a session and without a stored token', () => {
    const noServer = createApi(async () => new Response('{"signedIn":false}', { status: 200 }))
    const html = renderToString(<KantiProvider api={noServer}><AdminTimetable /></KantiProvider>)
    expect(html).toMatch(/type="password"/u)
    expect(html).toMatch(/accept="application\/pdf"/u)
  })
})
