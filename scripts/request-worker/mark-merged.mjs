#!/usr/bin/env node
// Marks requests whose PR was merged by hand as merged in the owner's panel.
//   node scripts/request-worker/mark-merged.mjs <requestId>:<prNumber> [...]
// Needs FANOTES_SERVER_ORIGIN and FANOTES_AGENT_TOKEN like the worker. Checks with gh first
// that each PR really is merged.
import { createApi } from './api.mjs'
import { loadConfig } from './config.mjs'
import { run } from './exec.mjs'

const config = loadConfig()
const api = createApi({ origin: config.origin, token: config.token })
let failed = 0
for (const arg of process.argv.slice(2)) {
  const m = /^(r[0-9a-f]{16}):([0-9]+)$/u.exec(arg)
  if (!m) { console.error(`skip ${arg}: expected <requestId>:<prNumber>`); failed++; continue }
  const [, id, number] = m
  const r = await run(config.ghBin, ['pr', 'view', number, '--json', 'state,url'], { cwd: config.repoPath, timeoutMs: 60_000 })
  let pr = null
  try { pr = JSON.parse(r.stdout) } catch { /* below */ }
  if (pr?.state !== 'MERGED') { console.error(`${id}: PR #${number} is not merged (${pr?.state ?? 'unknown'})`); failed++; continue }
  try {
    const out = await api.markMerged(id, { prNumber: Number(number), prUrl: pr.url })
    console.log(`${id}: ${out?.request?.status ?? 'ok'} (#${number})`)
  } catch (e) { console.error(`${id}: ${e.message}`); failed++ }
}
process.exit(failed ? 1 : 0)
