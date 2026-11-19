// Pure calendar-version rules shared by check-release-policy.mjs, the shared
// updater fixtures and the Rust port (crates/fanotes-updater/src/release_policy.rs).
// No network and no clock in here: the caller passes the Europe/Zurich month
// and the existing release tags.

export const parseCalendarVersion = (version) => {
  const match = /^(\d{4})\.(\d{1,2})\.([1-9]\d*)(?:-beta\.([1-9]\d*))?$/u.exec(version)
  if (!match) throw new Error('Calendar versions must use YYYY.M.N or YYYY.M.N-beta.B.')
  const year = Number(match[1])
  const month = Number(match[2])
  const stableNumber = Number(match[3])
  const betaNumber = match[4] ? Number(match[4]) : null
  if (month < 1 || month > 12) throw new Error('The release month must be between 1 and 12.')
  return { version, year, month, stableNumber, betaNumber }
}

export const assertCurrentMonth = ({ version, year, month }, zurich) => {
  if (year !== zurich.year || month !== zurich.month) {
    throw new Error(`Release ${version} is not in the current Europe/Zurich month ${zurich.year}.${zurich.month}.`)
  }
}

// `tags` are release tag names such as "v2026.11.2". Returns 'stable' or 'beta'.
export const checkAgainstTags = ({ version, year, month, stableNumber, betaNumber }, tags) => {
  const prefix = `v${year}.${month}.`
  const monthly = tags.filter((tag) => typeof tag === 'string' && tag.startsWith(prefix))
  if (monthly.some((tag) => tag === `v${version}`)) throw new Error(`Release v${version} already exists.`)

  const stable = monthly.filter((tag) => /^v\d{4}\.\d{1,2}\.[1-9]\d*$/u.test(tag))
  if (betaNumber === null) {
    const expected = stable.length + 1
    if (stableNumber !== expected) throw new Error(`The next stable release this month must be number ${expected}.`)
    return 'stable'
  }
  const targetedStableNumber = stable.length + 1
  if (stableNumber !== targetedStableNumber) {
    throw new Error(
      `The next beta must target Stable ${year}.${month}.${targetedStableNumber}; ` +
      `a prerelease for ${year}.${month}.${stableNumber} would not be newer than the installed Stable channel.`,
    )
  }
  const matchingBetas = monthly
    .map((tag) => new RegExp(`^v${year}\\.${month}\\.${stableNumber}-beta\\.(\\d+)$`, 'u').exec(tag))
    .filter(Boolean)
    .map((candidate) => Number(candidate[1]))
  const expected = matchingBetas.length ? Math.max(...matchingBetas) + 1 : 1
  if (betaNumber !== expected) throw new Error(`The next beta for ${year}.${month}.${stableNumber} must be beta.${expected}.`)
  return 'beta'
}

export const checkReleasePolicy = (version, zurich, tags) => {
  const parsed = parseCalendarVersion(version)
  assertCurrentMonth(parsed, zurich)
  return checkAgainstTags(parsed, tags)
}
