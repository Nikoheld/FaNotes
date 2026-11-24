import { describe, expect, it } from 'vitest'
import { demoSnapshot } from '../src/lib/demo'
import { changedTrack, lastVersion, removedTracks } from '../src/lib/gradeHistory'
import { courseSummaries } from '../src/lib/grades'
import { STRINGS } from '../src/lib/i18n'

describe('grade history in the demo data', () => {
  const snapshot = demoSnapshot('2026-11-10')
  const history = snapshot.gradeHistory || []

  it('marks the corrected grade and no other', () => {
    const marked = snapshot.grades.filter((grade) => changedTrack(history, grade))
    expect(marked.map((grade) => grade.title)).toEqual(['Prüfung Geometrie'])
    expect(changedTrack(history, marked[0])?.versions.map((version) => version.mark)).toEqual([4, 4.5])
  })

  it('lists the removed grade under its subject and keeps it out of the averages', () => {
    const physics = courseSummaries(snapshot.grades).find((course) => course.label.includes('Physik'))
    expect(physics).toBeTruthy()
    const removed = removedTracks(history, physics?.key || '')
    expect(removed).toHaveLength(1)
    expect(lastVersion(removed[0]).title).toBe('Test Optik')
    // 3.75 and 4.5 only: the removed 3.0 is not counted.
    expect(physics?.marks.map((mark) => mark.mark)).toEqual(expect.not.arrayContaining([3]))
    expect(physics?.average).toBeCloseTo((3.75 + 4.5) / 2, 5)
    expect(removedTracks(history, 'other')).toEqual([])
  })

  it('has the history strings in German and English', () => {
    for (const language of ['de', 'en'] as const) {
      const t = STRINGS[language]
      expect(t.gradeHistory).toBeTruthy()
      expect(t.removedGrades).toBeTruthy()
      expect(t.removedOn).toBeTruthy()
      expect(t.seenOn).toBeTruthy()
      expect(t.gradeHistoryOf('X')).toContain('X')
    }
    expect(STRINGS.de.removedGrades).toBe('Entfernte Noten')
    expect(STRINGS.de.gradeHistory).toBe('Verlauf')
  })

  it('a hidden grade keeps no mark in any version', () => {
    const hidden = { ...history[0], hidden: true, versions: history[0].versions.map((version) => ({ ...version, mark: null })) }
    expect(hidden.versions.every((version) => version.mark === null)).toBe(true)
  })
})
