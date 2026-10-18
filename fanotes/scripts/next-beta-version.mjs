// Print the next FaNotes beta for the current Europe/Zurich month.
// The rules match scripts/check-release-policy.mjs. Stdout is only the version.

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'FaNotes-release-policy/1.0',
}
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
if (token) headers.Authorization = `Bearer ${token}`

const zurichParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: 'numeric',
}).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))

const year = zurichParts.year
const month = zurichParts.month
const response = await fetch('https://api.github.com/repos/Nikoheld/FaNotes/releases?per_page=100', { headers })
if (!response.ok) throw new Error(`GitHub release policy check failed with HTTP ${response.status}.`)
const releases = await response.json()
if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list.')

const prefix = `v${year}.${month}.`
const monthly = releases.filter((release) => typeof release.tag_name === 'string' && release.tag_name.startsWith(prefix))
const stable = monthly.filter((release) => /^v\d{4}\.\d{1,2}\.[1-9]\d*$/u.test(release.tag_name))
const stableNumber = stable.length + 1
const matchingBetas = monthly
  .map((release) => new RegExp(`^v${year}\\.${month}\\.${stableNumber}-beta\\.(\\d+)$`, 'u').exec(release.tag_name))
  .filter(Boolean)
  .map((candidate) => Number(candidate[1]))
const betaNumber = matchingBetas.length ? Math.max(...matchingBetas) + 1 : 1
const version = `${year}.${month}.${stableNumber}-beta.${betaNumber}`
if (!/^(\d{4})\.(\d{1,2})\.([1-9]\d*)-beta\.([1-9]\d*)$/u.test(version)) {
  throw new Error(`Refusing to propose ${version}.`)
}
process.stdout.write(`${version}\n`)
