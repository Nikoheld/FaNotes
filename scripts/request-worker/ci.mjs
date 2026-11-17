// CI state via gh, summarised in the `gh pr checks` buckets: pass, fail, pending, skipping, cancel.
import { run } from './exec.mjs'

export function summarizeChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return { state: 'pending', failed: [] }
  const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name)
  if (failed.length) return { state: 'red', failed }
  if (checks.some((c) => c.bucket === 'pending')) return { state: 'pending', failed: [] }
  return { state: 'green', failed: [] }
}

// Maps `gh pr view --json statusCheckRollup` entries (CheckRun and StatusContext) to the
// `gh pr checks` buckets. `gh pr checks --json` needs gh >= 2.48; the build host has 2.46.
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
export function bucketOf(check) {
  if (check?.__typename === 'StatusContext' || (check && 'state' in check && !('status' in check))) {
    if (check.state === 'SUCCESS') return 'pass'
    if (check.state === 'PENDING' || check.state === 'EXPECTED') return 'pending'
    return 'fail'
  }
  if (check?.status !== 'COMPLETED') return 'pending'
  if (PASS.has(check.conclusion)) return check.conclusion === 'SUCCESS' ? 'pass' : 'skipping'
  if (check.conclusion === 'CANCELLED') return 'cancel'
  return 'fail'
}

export async function ciState(config, cwd, prNumber) {
  const r = await run(config.ghBin, ['pr', 'view', String(prNumber), '--json', 'statusCheckRollup,mergeable'], { cwd, timeoutMs: 60_000 })
  try {
    const { statusCheckRollup: rollup, mergeable } = JSON.parse(r.stdout)
    // GitHub runs no pull_request checks while the PR conflicts with its base, so a conflict
    // would otherwise look "pending" until the CI timeout.
    if (mergeable === 'CONFLICTING') return { state: 'conflict', failed: [] }
    return summarizeChecks((rollup || []).map((c) => ({ name: c.name || c.context || '', bucket: bucketOf(c) })))
  } catch { return { state: 'pending', failed: [], error: true } }
}

export async function findOpenPr(config, cwd, branch) {
  const r = await run(config.ghBin, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'], { cwd, timeoutMs: 60_000 })
  try {
    const list = JSON.parse(r.stdout)
    return Array.isArray(list) && list[0] ? { number: list[0].number, url: list[0].url } : null
  } catch { return null }
}
