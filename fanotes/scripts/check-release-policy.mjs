import assert from 'node:assert/strict'
import { assertCurrentMonth, checkAgainstTags, parseCalendarVersion } from './release-policy-core.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument: ${key || ''}`)
  args.set(key.slice(2), value)
}

const version = args.get('version')
if (!version) throw new Error('Use --version <YYYY.M.N[-beta.B]>')

const parsed = parseCalendarVersion(version)

const zurichParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: 'numeric',
}).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
assertCurrentMonth(parsed, zurichParts)

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'FaNotes-release-policy/1.0' }
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
if (token) headers.Authorization = `Bearer ${token}`
const response = await fetch('https://api.github.com/repos/Nikoheld/FaNotes/releases?per_page=100', { headers })
if (!response.ok) throw new Error(`GitHub release policy check failed with HTTP ${response.status}.`)
const releases = await response.json()
assert.ok(Array.isArray(releases), 'GitHub returned an invalid release list.')

const kind = checkAgainstTags(parsed, releases.map((release) => release.tag_name))

console.log(`${version} satisfies the FaNotes ${kind === 'stable' ? 'Stable' : 'Beta'} calendar-version check.`)
