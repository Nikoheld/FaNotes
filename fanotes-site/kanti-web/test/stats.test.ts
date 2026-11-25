import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { demoSnapshot } from '../src/lib/demo'
import { STRINGS } from '../src/lib/i18n'
import { parseRoute, routeHref } from '../src/lib/route'
import { schoolStats } from '../src/lib/stats'
import type { Snapshot } from '../src/types'

// The same cases run in android/core SchoolStatsTest, so the app and the browser show the same numbers.
const shared = JSON.parse(readFileSync(resolve(__dirname, '../../../android/core/src/test/resources/schulnetz/school-stats-cases.json'), 'utf8'))

describe('school statistics: shared cases', () => {
  it('has the cases the rules need', () => {
    expect(shared.cases.length).toBeGreaterThanOrEqual(8)
  })
  for (const item of shared.cases as { name: string; now: string; snapshot: Snapshot; expected: unknown }[]) {
    it(item.name, () => {
      expect(schoolStats(item.snapshot, new Date(item.now))).toEqual(item.expected)
    })
  }
  it('never puts a mark into the result', () => {
    for (const item of shared.cases as { now: string; snapshot: Snapshot }[]) {
      expect(JSON.stringify(schoolStats(item.snapshot, new Date(item.now)))).not.toContain('"mark"')
    }
  })
})

describe('school statistics: demo data', () => {
  const now = new Date('2026-11-25T10:00:00Z')
  const stats = schoolStats(demoSnapshot('2026-11-25'), now)

  it('shows cancellations, grading times, waiting tests and exam load', () => {
    expect(stats.cancellations.totals.total).toBeGreaterThan(20)
    expect(stats.cancellations.totals.cancelled).toBeGreaterThan(0)
    expect(stats.cancellations.courses.length).toBeGreaterThan(2)
    expect(stats.grading.count).toBeGreaterThan(2)
    expect(stats.grading.courses.length).toBeGreaterThan(1)
    expect(stats.waiting.length).toBeGreaterThan(0)
    expect(stats.examLoad.weeks.length).toBeGreaterThan(0)
    expect(stats.absences.length).toBeGreaterThan(0)
  })
})

describe('statistics page wiring', () => {
  it('has a route and strings in both languages', () => {
    expect(parseRoute('/statistik').view).toBe('stats')
    expect(routeHref('stats')).toBe('/statistik')
    for (const language of ['de', 'en'] as const) {
      const t = STRINGS[language]
      expect(t.stats).toBeTruthy()
      expect(t.statsMedian('3', false)).toContain('3')
      expect(t.statsCoverage(2, '1.11.', '24.11.')).toContain('2')
    }
    expect(STRINGS.de.stats).toBe('Statistik')
  })
})
