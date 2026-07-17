import assert from 'node:assert/strict'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument: ${key || ''}`)
  args.set(key.slice(2), value)
}

const version = args.get('version')
if (!version) throw new Error('Use --version <YYYY.M.N[-beta.B]>')

const match = /^(\d{4})\.(\d{1,2})\.([1-4])(?:-beta\.([1-9]\d*))?$/u.exec(version)
if (!match) throw new Error('Calendar versions must use YYYY.M.N or YYYY.M.N-beta.B; stable N is limited to 1–4.')

const year = Number(match[1])
const month = Number(match[2])
const stableNumber = Number(match[3])
const betaNumber = match[4] ? Number(match[4]) : null
if (month < 1 || month > 12) throw new Error('The release month must be between 1 and 12.')

const zurichParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: 'numeric',
}).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
if (year !== zurichParts.year || month !== zurichParts.month) {
  throw new Error(`Release ${version} is not in the current Europe/Zurich month ${zurichParts.year}.${zurichParts.month}.`)
}

const response = await fetch('https://api.github.com/repos/Nikoheld/FaNotes/releases?per_page=100', {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FaNotes-release-policy/1.0' },
})
if (!response.ok) throw new Error(`GitHub release policy check failed with HTTP ${response.status}.`)
const releases = await response.json()
assert.ok(Array.isArray(releases), 'GitHub returned an invalid release list.')

const prefix = `v${year}.${month}.`
const monthly = releases.filter((release) => typeof release.tag_name === 'string' && release.tag_name.startsWith(prefix))
if (monthly.some((release) => release.tag_name === `v${version}`)) throw new Error(`Release v${version} already exists.`)

const stable = monthly.filter((release) => /^v\d{4}\.\d{1,2}\.[1-4]$/u.test(release.tag_name))
if (betaNumber === null) {
  if (stable.length >= 4) throw new Error('Four stable releases already exist this month; publish a beta for the next month instead.')
  const expected = stable.length + 1
  if (stableNumber !== expected) throw new Error(`The next stable release this month must be number ${expected}.`)
} else {
  const matchingBetas = monthly
    .map((release) => new RegExp(`^v${year}\\.${month}\\.${stableNumber}-beta\\.(\\d+)$`, 'u').exec(release.tag_name))
    .filter(Boolean)
    .map((candidate) => Number(candidate[1]))
  const expected = matchingBetas.length ? Math.max(...matchingBetas) + 1 : 1
  if (betaNumber !== expected) throw new Error(`The next beta for ${year}.${month}.${stableNumber} must be beta.${expected}.`)
}

console.log(`${version} satisfies the FaNotes ${betaNumber === null ? 'Stable' : 'Beta'} calendar-version and monthly cadence gate.`)
