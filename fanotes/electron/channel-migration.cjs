'use strict'

const { VERSION_PATTERN, channelForPackagedVersion, compareSemanticVersions } = require('./releaseVersion.cjs')

/**
 * The owner moves every Beta device to Stable again from this stable on: a
 * marker older than this version counts as not done, so the migration runs
 * once more on the first stable at or above it (2026.11.4 or a later one).
 * Raise it only when the owner asks for another round.
 */
const AUTO_STABLE_ROUND = '2026.11.4'

/**
 * Migration once per round: a device on the Beta channel that first runs a
 * Stable version is moved to the Stable channel, silently. The marker
 * `channelAutoStableDoneAt` (the version that ran the migration) is stored in
 * the settings so the migration does not repeat within the round; a later
 * manual switch back to Beta therefore sticks, also across later stables.
 *
 * Only "beta" is migrated. Nightly is not beta-like: it already prefers
 * stable builds that are newer than the installed one and is an explicit
 * opt-in to unfinished builds, so nightly users stay unchanged.
 * Switching the channel never installs an older build: the updater only
 * offers releases newer than the installed version.
 */
/** A marker from an earlier round, while the running stable is in this round. */
const markerBeforeRound = (marker, version) => {
  if (!VERSION_PATTERN.test(marker) || compareSemanticVersions(version, AUTO_STABLE_ROUND) < 0) return false
  return compareSemanticVersions(marker, AUTO_STABLE_ROUND) < 0
}

const migrateBetaToStable = (settings, version) => {
  if (!settings || typeof settings.channelAutoStableDoneAt !== 'string') return settings
  if (!VERSION_PATTERN.test(version || '') || channelForPackagedVersion(version) !== 'stable') return settings
  if (settings.channelAutoStableDoneAt && !markerBeforeRound(settings.channelAutoStableDoneAt, version)) return settings
  return {
    ...settings,
    channelAutoStableDoneAt: version,
    updateChannel: settings.updateChannel === 'beta' ? 'stable' : settings.updateChannel,
  }
}

/** A renderer save must never clear or change an existing marker. */
const keepChannelMarker = (next, previous) => (
  previous?.channelAutoStableDoneAt && next?.channelAutoStableDoneAt !== previous.channelAutoStableDoneAt
    ? { ...next, channelAutoStableDoneAt: previous.channelAutoStableDoneAt }
    : next
)

module.exports = { AUTO_STABLE_ROUND, migrateBetaToStable, keepChannelMarker }
