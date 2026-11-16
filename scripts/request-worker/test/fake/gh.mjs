#!/usr/bin/env node
// Fake gh: CI JSON from FAKE_GH_CI (default green); records merges.
import fs from 'node:fs'
const a = process.argv.slice(2)
if (a[0] === 'pr' && a[1] === 'checks') {
  const b = process.env.FAKE_GH_CI || 'pass'
  process.stdout.write(JSON.stringify([{ name: 'build', bucket: b }]))
  process.exit(b === 'pass' ? 0 : 1)
}
if (a[0] === 'pr' && a[1] === 'list') { process.stdout.write('[]'); process.exit(0) }
if (a[0] === 'pr' && a[1] === 'merge') { fs.appendFileSync(process.env.FAKE_GH_LOG, a.join(' ') + '\n'); process.exit(0) }
process.exit(1)
