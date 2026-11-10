// When the server reads Schulnetz: phases, waits, jitter, backoff and the due-time scheduler.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POLL_MAX_BACKOFF_MS, POLL_QUIET_MS, POLL_SCHOOL_MAX_MS, POLL_SCHOOL_MIN_MS, POLL_WEEKEND_MS, createPollScheduler, pollDelayMs, pollPhase,
} from './schulnetz-logic.mjs'

// November is CET (UTC+1): 08:00Z is 09:00 in Zurich.
const at = (iso) => new Date(iso)
const lesson = (day) => ({ id: '1', start: `${day}T08:00:00`, end: `${day}T08:45:00`, eventType: '0_stp', text: 'Mathematik' })
const schoolWeek = { events: ['2026-11-09', '2026-11-10', '2026-11-11'].map(lesson), weekRead: { '2026-11-09': '2026-11-09T06:00:00Z' } }
const middle = () => 0.5

test('phases follow the Zurich school day, weekends, nights and holidays', () => {
  assert.equal(pollPhase(at('2026-11-10T08:00:00Z'), schoolWeek), 'school')
  assert.equal(pollPhase(at('2026-11-10T05:00:00Z'), schoolWeek), 'school') // 06:00 Zurich
  assert.equal(pollPhase(at('2026-11-10T04:59:00Z'), schoolWeek), 'night') // 05:59 Zurich
  assert.equal(pollPhase(at('2026-11-10T21:30:00Z'), schoolWeek), 'night') // 22:30 Zurich
  assert.equal(pollPhase(at('2026-11-14T09:00:00Z'), schoolWeek), 'weekend')
  assert.equal(pollPhase(at('2026-11-10T08:00:00Z'), { ...schoolWeek, vacations: [{ start: '2026-11-09', end: '2026-11-13' }] }), 'holiday')
  // A week the timetable was read for and that has no lessons is a school-free week.
  assert.equal(pollPhase(at('2026-11-17T08:00:00Z'), { events: [], weekRead: { '2026-11-16': '2026-11-16T06:00:00Z' } }), 'holiday')
  // Without any snapshot, a weekday is a school day.
  assert.equal(pollPhase(at('2026-11-10T08:00:00Z'), null), 'school')
})

test('waits: 2–5 minutes on school days, slower otherwise, jitter both ways, backoff on failures', () => {
  const tuesday = at('2026-11-10T08:00:00Z')
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 180_000, random: middle }), 180_000)
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 60_000, random: middle }), POLL_SCHOOL_MIN_MS)
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 900_000, random: middle }), POLL_SCHOOL_MAX_MS)
  assert.equal(pollDelayMs({ now: at('2026-11-14T09:00:00Z'), snapshot: schoolWeek, random: middle }), POLL_WEEKEND_MS)
  assert.equal(pollDelayMs({ now: at('2026-11-10T22:30:00Z'), snapshot: schoolWeek, random: middle }), POLL_QUIET_MS)
  assert.equal(pollDelayMs({ now: tuesday, snapshot: { ...schoolWeek, vacations: [{ start: '2026-11-10', end: '2026-11-10' }] }, random: middle }), POLL_QUIET_MS)
  // Jitter stays within 20 % either way.
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 150_000, random: () => 0 }), 120_000)
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 150_000, random: () => 1 }), 180_000)
  // Each failure doubles the wait, up to an hour.
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 150_000, failures: 1, random: middle }), 300_000)
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 150_000, failures: 3, random: middle }), 1_200_000)
  assert.equal(pollDelayMs({ now: tuesday, snapshot: schoolWeek, baseMs: 150_000, failures: 12, random: middle }), POLL_MAX_BACKOFF_MS)
  // 05:50 on a school day: the next read is at 06:00 (plus at most a minute), not half an hour later.
  const early = pollDelayMs({ now: at('2026-11-10T04:50:00Z'), snapshot: schoolWeek, random: () => 0 })
  assert.ok(early <= 10 * 60_000 && early >= 30_000, String(early))
})

test('a school day has a read every few minutes; a night, a weekend and a holiday far fewer', () => {
  const count = (fromIso, hours, snapshot) => {
    let t = Date.parse(fromIso)
    const end = t + hours * 3600_000
    let reads = 0
    let seed = 7
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    while (t < end) { reads += 1; t += pollDelayMs({ now: new Date(t), snapshot, baseMs: 150_000, random }) }
    return reads
  }
  const schoolDay = count('2026-11-10T05:00:00Z', 16, schoolWeek) // 06:00–22:00 Zurich
  const night = count('2026-11-10T21:00:00Z', 8, schoolWeek) // 22:00–06:00
  const weekendDay = count('2026-11-14T05:00:00Z', 16, schoolWeek)
  assert.ok(schoolDay >= 16 * 60 / 3 && schoolDay <= 16 * 60 / 2, `school day ${schoolDay}`)
  assert.ok(night <= 18, `night ${night}`)
  assert.ok(weekendDay <= 16 * 4 + 6, `weekend ${weekendDay}`)
})

test('the scheduler reads due accounts one at a time, staggers new ones, backs off and forgets removed ones', async () => {
  let clock = Date.parse('2026-11-10T08:00:00Z')
  const accounts = ['a'.repeat(32), 'b'.repeat(32)]
  const polled = []
  const slept = []
  let failA = false
  const scheduler = createPollScheduler({
    listAccounts: async () => [...accounts],
    pollAccount: async (id) => { polled.push(id[0]); if (id[0] === 'a' && failA) throw new Error('down'); return { revision: 1 } },
    readSnapshot: async () => schoolWeek,
    now: () => new Date(clock),
    baseMs: 150_000,
    random: middle,
    sleep: async (ms) => { slept.push(ms); clock += ms },
  })
  // A restart does not read every account at once: the second starts 10 s later.
  assert.equal(await scheduler.tick(), 1)
  assert.deepEqual(polled, ['a'])
  clock += 10_000
  assert.equal(await scheduler.tick(), 1)
  assert.deepEqual(polled, ['a', 'b'])
  // Nothing is due until the wait has passed.
  clock += 60_000
  assert.equal(await scheduler.tick(), 0)
  clock += 150_000
  assert.equal(await scheduler.tick(), 2)
  // Two accounts in one round are spaced apart.
  assert.deepEqual(slept, [5_000])
  // A failing account waits longer (twice, then four times the base).
  failA = true
  clock += 150_000
  await scheduler.tick()
  assert.equal(scheduler.failures.get(accounts[0]), 1)
  // Planned when its read ended; the 5 s spacing before the next account came after that.
  assert.ok(Math.abs(scheduler.due.get(accounts[0]) - clock - 300_000) <= 5_000, String(scheduler.due.get(accounts[0]) - clock))
  // A removed account is forgotten.
  accounts.pop()
  await scheduler.tick()
  assert.equal(scheduler.due.has('b'.repeat(32)), false)
})

test('a failed school read reported by the poll counts like an error', async () => {
  let clock = Date.parse('2026-11-10T08:00:00Z')
  const scheduler = createPollScheduler({
    listAccounts: async () => ['c'.repeat(32)],
    pollAccount: async () => ({ revision: 2, failed: true }),
    readSnapshot: async () => schoolWeek,
    now: () => new Date(clock),
    baseMs: 150_000,
    random: middle,
    sleep: async () => {},
  })
  await scheduler.tick()
  assert.equal(scheduler.failures.get('c'.repeat(32)), 1)
  assert.equal(scheduler.due.get('c'.repeat(32)) - clock, 300_000)
})
