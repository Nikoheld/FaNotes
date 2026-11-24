import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GRADE_PARSER_VERSION, gradeDiffBase, keepLoadedGrades, trustedGradeRead, updateGradeHistory, GRADE_HISTORY_MAX_TRACKS } from './schulnetz-logic.mjs'

// The same cases run in android/core ... GradeHistoryTest.kt, so server and app keep one history alike.
const here = dirname(fileURLToPath(import.meta.url))
const shared = JSON.parse(readFileSync(resolve(here, '../android/core/src/test/resources/schulnetz/grade-history-cases.json'), 'utf8'))

const generated = (spec) => Array.from({ length: spec.removed }, (_, index) => {
  const n = index + 1
  const seen = '2020-01-01T00:00:00.000Z'
  return {
    id: `g${n}`, gradeId: `old-${n}`, courseId: 'c', course: 'C', title: `t ${n}`, date: '2020-01-01', firstSeenAt: seen,
    versions: [{ mark: 4, weight: 1, title: `t ${n}`, date: '2020-01-01', seenAt: seen }],
    removedAt: `2021-01-01T00:00:00.${String(n).padStart(5, '0')}Z`,
  }
})

for (const item of shared.cases) {
  test(`grade history: ${item.name}`, () => {
    let history = item.generate ? generated(item.generate) : item.history
    for (const step of item.steps) {
      history = updateGradeHistory(history, step.previous, step.next, { at: step.at, trusted: step.trusted })
    }
    if (item.expect) assert.deepEqual(history, item.expect)
    if (item.expectVersions) {
      for (const [id, want] of Object.entries(item.expectVersions)) {
        const versions = history.find((track) => track.id === id).versions
        assert.equal(versions.length, want.count)
        assert.equal(versions[0].mark, want.first)
        assert.equal(versions[1].mark, want.second)
        assert.equal(versions.at(-1).mark, want.last)
      }
    }
    if (item.expectTracks) {
      assert.equal(history.length, item.expectTracks.count)
      for (const id of item.expectTracks.absent) assert.ok(!history.some((track) => track.id === id), id)
      for (const id of item.expectTracks.present) assert.ok(history.some((track) => track.id === id), id)
    }
  })
}

test('grade history: the track limit constant matches the fixture', () => {
  assert.equal(GRADE_HISTORY_MAX_TRACKS, 3000)
})

test('grade history: an old grade parser base makes no versions and no removals', () => {
  const row = (id, title, mark) => ({ id, course: 'Mathematik', courseId: 'MAT', subject: 'Mathematik', title, date: '2026-01-05', mark, weight: 1 })
  const seeded = updateGradeHistory([], [], [row('a', 'Test', 5)], { at: '2026-01-10T08:00:00.000Z' })
  const previous = { gradeParser: GRADE_PARSER_VERSION - 1, grades: [row('a', 'Test', 5)] }
  const next = { grades: [row('a', 'Test: Funktionen', 5), row('b', 'Info', 4)] }
  const base = gradeDiffBase(previous, next)
  const after = updateGradeHistory(seeded, base.grades, next.grades, { at: '2026-01-11T08:00:00.000Z', trusted: true })
  assert.equal(after.length, 2)
  assert.equal(after[0].versions.length, 1)
  assert.equal(after[0].removedAt, undefined)
})

test('grade history: a partial read is not trusted, a complete one that was taken over is', () => {
  const kept = [{ id: 'a', course: 'Mathematik', title: 'Test', mark: 5, weight: 1 }]
  const partial = { gradesReadComplete: false, grades: [] }
  assert.equal(trustedGradeRead(partial), false)
  assert.equal(keepLoadedGrades(kept, partial.grades, trustedGradeRead(partial)), kept)
})
