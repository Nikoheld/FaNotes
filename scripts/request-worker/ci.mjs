// CI state via gh. `gh pr checks --json` buckets: pass, fail, pending, skipping, cancel.
import { run } from './exec.mjs'

export function summarizeChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return { state: 'pending', failed: [] }
  const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name)
  if (failed.length) return { state: 'red', failed }
  if (checks.some((c) => c.bucket === 'pending')) return { state: 'pending', failed: [] }
  return { state: 'green', failed: [] }
}

export async function ciState(config, cwd, prNumber) {
  const r = await run(config.ghBin, ['pr', 'checks', String(prNumber), '--json', 'name,bucket'], { cwd, timeoutMs: 60_000 })
  // gh exits 8 while checks are pending and 1 on failures but still prints JSON.
  try { return summarizeChecks(JSON.parse(r.stdout)) } catch { return { state: 'pending', failed: [], error: true } }
}

export async function findOpenPr(config, cwd, branch) {
  const r = await run(config.ghBin, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'], { cwd, timeoutMs: 60_000 })
  try {
    const list = JSON.parse(r.stdout)
    return Array.isArray(list) && list[0] ? { number: list[0].number, url: list[0].url } : null
  } catch { return null }
}
