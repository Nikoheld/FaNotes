// dist/version.json: which commit this build is, shown by /api/v1/kanti-web/health.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

let commit = process.env.KANTI_WEB_COMMIT || ''
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { commit = '' }
}
writeFileSync(new URL('../dist/version.json', import.meta.url), `${JSON.stringify({ commit, builtAt: new Date().toISOString() })}\n`)
