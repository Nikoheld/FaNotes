// The share poll leaves the notes out when the client already holds the revision.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.FANOTES_SHARE_DIR = mkdtempSync(join(tmpdir(), 'fanotes-share-session-'))
const { sessionBodyFor } = await import('./share-api.mjs')

const record = { revision: 7, notes: [{ path: 'a.md', title: 'A', content: 'x', ink: { strokes: [{ points: [{ x: 1, y: 2 }] }] } }], editors: [], present: [] }

test('a poll at the current revision carries no notes', () => {
  const body = sessionBodyFor(record, 7)
  assert.equal(body.unchanged, true)
  assert.equal(body.revision, 7)
  assert.equal('notes' in body, false)
})

test('an older, missing or newer revision gets the whole session', () => {
  for (const since of [6, null, undefined, 8]) {
    const body = sessionBodyFor(record, since)
    assert.equal(body.unchanged, undefined)
    assert.equal(body.notes.length, 1)
  }
})
