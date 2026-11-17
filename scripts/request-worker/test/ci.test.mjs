import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketOf, summarizeChecks } from '../ci.mjs'

const run = (status, conclusion) => ({ __typename: 'CheckRun', name: 'x', status, conclusion })
const ctx = (state) => ({ __typename: 'StatusContext', context: 'x', state })

test('maps check runs and status contexts to buckets', () => {
  assert.equal(bucketOf(run('COMPLETED', 'SUCCESS')), 'pass')
  assert.equal(bucketOf(run('COMPLETED', 'SKIPPED')), 'skipping')
  assert.equal(bucketOf(run('IN_PROGRESS', '')), 'pending')
  assert.equal(bucketOf(run('QUEUED', null)), 'pending')
  assert.equal(bucketOf(run('COMPLETED', 'FAILURE')), 'fail')
  assert.equal(bucketOf(run('COMPLETED', 'TIMED_OUT')), 'fail')
  assert.equal(bucketOf(run('COMPLETED', 'CANCELLED')), 'cancel')
  assert.equal(bucketOf(ctx('SUCCESS')), 'pass')
  assert.equal(bucketOf(ctx('PENDING')), 'pending')
  assert.equal(bucketOf(ctx('ERROR')), 'fail')
})

test('a green rollup summarises to green', () => {
  const checks = [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED')].map((c) => ({ name: c.name, bucket: bucketOf(c) }))
  assert.equal(summarizeChecks(checks).state, 'green')
})
