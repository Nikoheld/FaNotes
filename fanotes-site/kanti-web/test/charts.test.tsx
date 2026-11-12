// Chart geometry (lib/charts.ts) and the redesigned Noten / Mitteilungen / Einstellungen views, on synthetic data.
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { KantiProvider } from '../src/state'
import { createApi } from '../src/lib/api'
import { nearestPoint, ringSegments, scalePercent, trendDomain, trendLayout, trendPoints } from '../src/lib/charts'
import { courseSummaries, type CourseMark } from '../src/lib/grades'
import { Grades } from '../src/views/Grades'
import { Updates } from '../src/views/Updates'
import { Settings } from '../src/views/Settings'
import { MarkTrend } from '../src/components/charts'
import { STRINGS } from '../src/lib/i18n'
import type { SchoolGrade } from '../src/types'

const noServer = createApi(async () => new Response('{"signedIn":false}', { status: 200 }))

const grade = (id: string, date: string, mark: number | null, weight = 1, extra: Partial<SchoolGrade> = {}): SchoolGrade => ({
  id, course: 'M-K26A', courseId: 'M-K26A', subject: 'Mathematik', title: `Test ${id}`, date, mark, weight, ...extra,
})
const marksOf = (grades: SchoolGrade[]): CourseMark[] => courseSummaries(grades)[0].marks

describe('scalePercent', () => {
  it('maps 1..6 to 0..100 with the pass mark at 60', () => {
    expect(scalePercent(1)).toBe(0)
    expect(scalePercent(4)).toBe(60)
    expect(scalePercent(6)).toBe(100)
    expect(scalePercent(7)).toBe(100)
    expect(scalePercent(null)).toBe(0)
  })
})

describe('trendPoints', () => {
  it('orders marks by date, keeps the weighted running average and ignores hidden or pending marks', () => {
    const points = trendPoints(marksOf([
      grade('b', '2026-10-02', 5, 2),
      grade('a', '2026-09-01', 3, 1),
      grade('h', '2026-09-15', 6, 1, { hidden: true }),
      grade('p', '2026-10-20', null, 1),
    ]))
    expect(points.map((point) => point.id)).toEqual(['a', 'b'])
    expect(points.map((point) => point.running)).toEqual([3, 13 / 3])
    expect(points.some((point) => point.mark === 6)).toBe(false)
  })

  it('lets a zero-weight mark show without moving the average', () => {
    const points = trendPoints(marksOf([grade('a', '2026-09-01', 4, 1), grade('b', '2026-09-02', 6, 0)]))
    expect(points.map((point) => point.running)).toEqual([4, 4])
  })
})

describe('trendLayout', () => {
  it('always contains the pass mark and stays within 1..6', () => {
    expect(trendDomain(trendPoints(marksOf([grade('a', '2026-09-01', 5.25)])))).toEqual({ low: 3, high: 6 })
    expect(trendDomain(trendPoints(marksOf([grade('a', '2026-09-01', 1.5), grade('b', '2026-09-02', 2)])))).toEqual({ low: 1, high: 5 })
    expect(trendDomain([])).toEqual({ low: 3, high: 5 })
  })

  it('puts a single mark in the middle and higher marks higher up', () => {
    const one = trendLayout(trendPoints(marksOf([grade('a', '2026-09-01', 5)])), 400, 200, { left: 20, right: 20, top: 10, bottom: 20 })
    expect(one.points).toHaveLength(1)
    expect(one.points[0].x).toBe(200)
    const two = trendLayout(trendPoints(marksOf([grade('a', '2026-09-01', 3), grade('b', '2026-10-01', 5.5)])), 400, 200)
    expect(two.points[1].y).toBeLessThan(two.points[0].y)
    expect(two.points[0].x).toBeLessThan(two.points[1].x)
    expect(two.passY).toBeGreaterThan(two.points[1].y)
    expect(two.markPath.startsWith('M')).toBe(true)
  })

  it('spaces marks by date', () => {
    const layout = trendLayout(trendPoints(marksOf([grade('a', '2026-09-01', 4), grade('b', '2026-09-03', 4), grade('c', '2026-09-30', 4)])), 600, 200)
    const [first, second, third] = layout.points
    expect(second.x - first.x).toBeLessThan((third.x - second.x) / 5)
  })

  it('finds the nearest point', () => {
    expect(nearestPoint([{ x: 10 }, { x: 50 }, { x: 90 }], 60)).toBe(1)
    expect(nearestPoint([], 5)).toBe(-1)
  })
})

describe('ringSegments', () => {
  it('lays the estimate after the booked points and clips to the quota', () => {
    const ring = ringSegments(5, 3, 30)
    expect(ring.booked).toBeCloseTo(ring.circumference / 6, 1)
    expect(ring.estimated).toBeCloseTo(ring.circumference / 10, 1)
    expect(ring.used).toBeCloseTo(8 / 30, 2)
    const over = ringSegments(25, 20, 30)
    expect(over.used).toBe(1)
    expect(ringSegments(5, 3, 0)).toMatchObject({ booked: 0, estimated: 0 })
  })
})

describe('views', () => {
  it('Noten (English by default in tests) shows the four figures, the scale bars and the chart for the first subject', () => {
    const html = renderToString(<KantiProvider api={noServer} demo><Grades /></KantiProvider>)
    expect(html).toContain(STRINGS.en.statBelowFour)
    expect(html).toContain(STRINGS.en.statBestSubject)
    expect(html).toContain('scale-bar')
    expect(html).toContain('scale-tick')
  })

  it('MarkTrend labels the chart for assistive technology and keeps hidden marks out of it', () => {
    const marks = marksOf([grade('a', '2026-09-01', 4.5), grade('h', '2026-09-10', 2, 1, { hidden: true })])
    for (const language of ['de', 'en'] as const) {
      const html = renderToString(<MarkTrend marks={marks} label="Mathematik" t={STRINGS[language]} language={language} />)
      expect(html).toContain('role="img"')
      expect(html).toContain(STRINGS[language].trendAria('Mathematik', 1, '4.5'))
      expect(html).toContain(STRINGS[language].hiddenCount(1))
      expect((html.match(/<circle class="trend-dot/gu) || []).length).toBe(1)
    }
    expect(renderToString(<MarkTrend marks={marksOf([grade('h', '2026-09-10', 2, 1, { hidden: true })])} label="M" t={STRINGS.de} language="de" />)).toBe('')
  })

  it('Mitteilungen ends the statement with the balance row', () => {
    const html = renderToString(<KantiProvider api={noServer} demo><Updates /></KantiProvider>)
    expect(html).toContain('konto-total')
    expect(html).toContain(STRINGS.en.accountBalance)
    expect(html).toContain('+50.00')
    expect(html).toContain('-12.50')
  })

  it('Einstellungen groups the settings and previews every theme', () => {
    const html = renderToString(<KantiProvider api={noServer} demo><Settings /></KantiProvider>)
    for (const title of [STRINGS.en.appearance, STRINGS.en.alerts, STRINGS.en.connections, STRINGS.en.account]) expect(html).toContain(title.replace('&', '&amp;'))
    expect((html.match(/role="radio"/gu) || []).length).toBe(8)
    expect(html).toContain('--m-accent')
  })
})
