'use strict'

// One version order for the desktop updater and the download site.
// Same major.minor.patch ranks beta < stable < nightly. A later patch
// beats every nightly of the previous triple. Nightly is a commit that
// was not published as a Stable or Beta release.

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+|-nightly\.\d{14}\.[a-f0-9]{7,40})?$/u
const VERSION_CAPTURE = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+)|-nightly\.(\d{14})\.([a-f0-9]{7,40}))?$/u
const RELEASE_VERSION_SOURCE = String.raw`\d+\.\d+\.\d+(?:-beta\.\d+|-nightly\.\d{14}\.[a-f0-9]{7,40})?`
const LINUX_PACKAGE_PATTERN = new RegExp(`^FaNotes-(${RELEASE_VERSION_SOURCE})-x86_64\\.(AppImage|tar\\.gz)$`, 'u')
const WINDOWS_PACKAGE_PATTERN = new RegExp(`^FaNotes-(Setup|Portable)-(${RELEASE_VERSION_SOURCE})-x64\\.exe$`, 'u')
const DELTA_ROUTE_PATTERN = new RegExp(`^/download/delta/(linux|windows)-x64/(?:(beta|nightly)/)?(${RELEASE_VERSION_SOURCE})$`, 'u')
const DOWNLOAD_ROUTE_PATTERN = /^\/download\/(?:(beta|nightly)\/)?(appimage|portable|windows-installer|windows-portable|checksums|install-guide|windows-guide)$/u
const EMPTY_NIGHTLY_CHANGELOG = 'Dieser Nightly-Stand ist ein Commit von main und kein Stable- oder Beta-Release.'
const CHANNEL_RANK = Object.freeze({ beta: 0, stable: 1, nightly: 2 })
const UPDATE_CHANNELS = Object.freeze(['stable', 'beta', 'nightly'])

const parseReleaseVersion = (value) => {
  const match = VERSION_CAPTURE.exec(String(value))
  if (!match) throw new Error('Ungültige Versionsnummer.')
  const beta = match[4]
  const nightlyStamp = match[5]
  const sha = match[6]
  const channel = beta !== undefined ? 'beta' : nightlyStamp !== undefined ? 'nightly' : 'stable'
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    channel,
    pre: channel === 'beta' ? Number(beta) : channel === 'nightly' ? Number(nightlyStamp) : 0,
    sha: channel === 'nightly' ? sha : '',
  }
}

const compareSemanticVersions = (left, right) => {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.channel !== b.channel) return CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel]
  if (a.pre !== b.pre) return a.pre - b.pre
  if (a.sha === b.sha) return 0
  return a.sha < b.sha ? -1 : 1
}

const versionChannel = (version) => parseReleaseVersion(version).channel

const releaseVisibleOnChannel = (version, channel) => {
  const kind = versionChannel(version)
  if (channel === 'stable') return kind === 'stable'
  if (channel === 'beta') return kind === 'beta' || kind === 'stable'
  if (channel === 'nightly') return kind === 'nightly' || kind === 'stable'
  return false
}

const nightlyVersion = (base, committedAt, sha) => {
  const stripped = String(base).replace(/-(?:beta\.\d+|nightly\.\d{14}\.[a-f0-9]{7,40})$/u, '')
  const parsed = parseReleaseVersion(stripped)
  if (parsed.channel !== 'stable') throw new Error('Ungültige Versionsnummer.')
  const date = committedAt instanceof Date ? committedAt : new Date(committedAt)
  if (!Number.isFinite(date.getTime())) throw new Error('Ungültiges Commit-Datum.')
  const stamp = date.toISOString().replace(/\D/gu, '').slice(0, 14)
  const normalizedSha = String(sha).trim().toLowerCase()
  if (!/^\d{14}$/u.test(stamp)) throw new Error('Ungültiges Commit-Datum.')
  if (!/^[a-f0-9]{7,40}$/u.test(normalizedSha)) throw new Error('Ungültiger Commit.')
  const version = `${parsed.numbers.join('.')}-nightly.${stamp}.${normalizedSha}`
  if (!VERSION_PATTERN.test(version)) throw new Error('Ungültige Versionsnummer.')
  return version
}

const channelForPackagedVersion = (version) => {
  if (!VERSION_PATTERN.test(version || '')) return 'stable'
  return versionChannel(version)
}

const packagePathname = (channel, leaf) => (
  channel === 'stable' ? `/download/${leaf}` : `/download/${channel}/${leaf}`
)

const deltaPathname = (platform, version, channel = 'stable') => (
  channel === 'stable'
    ? `/download/delta/${platform}-x64/${version}`
    : `/download/delta/${platform}-x64/${channel}/${version}`
)

module.exports = {
  CHANNEL_RANK,
  DELTA_ROUTE_PATTERN,
  DOWNLOAD_ROUTE_PATTERN,
  EMPTY_NIGHTLY_CHANGELOG,
  LINUX_PACKAGE_PATTERN,
  UPDATE_CHANNELS,
  VERSION_PATTERN,
  WINDOWS_PACKAGE_PATTERN,
  channelForPackagedVersion,
  compareSemanticVersions,
  deltaPathname,
  nightlyVersion,
  packagePathname,
  parseReleaseVersion,
  releaseVisibleOnChannel,
  versionChannel,
}
