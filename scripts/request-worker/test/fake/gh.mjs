#!/usr/bin/env node
// Fake gh: CI state from FAKE_GH_CI (pass | fail | pending, default pass); records merges.
import fs from 'node:fs'
const a = process.argv.slice(2)
// Like gh 2.46 on the build host: `pr view --json statusCheckRollup` (no `pr checks --json`).
if (a[0] === 'pr' && a[1] === 'view' && a.includes('statusCheckRollup')) {
  const b = process.env.FAKE_GH_CI || 'pass'
  const run = b === 'pending' ? { status: 'IN_PROGRESS', conclusion: '' } : { status: 'COMPLETED', conclusion: b === 'pass' ? 'SUCCESS' : 'FAILURE' }
  process.stdout.write(JSON.stringify({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', ...run }] }))
  process.exit(0)
}
if (a[0] === 'pr' && a[1] === 'list') { process.stdout.write('[]'); process.exit(0) }
if (a[0] === 'pr' && a[1] === 'merge') { fs.appendFileSync(process.env.FAKE_GH_LOG, a.join(' ') + '\n'); process.exit(0) }
process.exit(1)
