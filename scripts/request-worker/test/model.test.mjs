import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modelFor } from '../config.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-model-'))
const file = path.join(dir, 'models.json')
const config = { model: 'sonnet', modelOverridesPath: file }

test('falls back to the default without an override file', () => {
  assert.equal(modelFor(config, 'r0000000000000001'), 'sonnet')
})

test('uses the per-request override and ignores bad values', () => {
  fs.writeFileSync(file, JSON.stringify({ r0000000000000001: 'opus', r0000000000000002: 'bad model; rm', r0000000000000003: 7 }))
  assert.equal(modelFor(config, 'r0000000000000001'), 'opus')
  assert.equal(modelFor(config, 'r0000000000000002'), 'sonnet')
  assert.equal(modelFor(config, 'r0000000000000003'), 'sonnet')
  assert.equal(modelFor(config, 'r0000000000000004'), 'sonnet')
})

test('falls back on a malformed file', () => {
  fs.writeFileSync(file, '{oops')
  assert.equal(modelFor(config, 'r0000000000000001'), 'sonnet')
})
