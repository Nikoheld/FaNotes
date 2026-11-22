'use strict'

const { VERSION_PATTERN, channelForPackagedVersion } = require('./releaseVersion.cjs')

/**
 * One-time migration: a device on the Beta channel that first runs a Stable
 * version is moved to the Stable channel, silently. The marker
 * `channelAutoStableDoneAt` (the version that ran the migration) is stored in
 * the settings so the migration never runs again; a later manual switch back
 * to Beta therefore sticks, also across later stables.
 *
 * Only "beta" is migrated. Nightly is not beta-like: it already prefers
 * stable builds that are newer than the installed one and is an explicit
 * opt-in to unfinished builds, so nightly users stay unchanged.
 * Switching the channel never installs an older build: the updater only
 * offers releases newer than the installed version.
 */
const migrateBetaToStable = (settings, version) => {
  if (!settings || typeof settings.channelAutoStableDoneAt !== 'string') return settings
  if (settings.channelAutoStableDoneAt) return settings
  if (!VERSION_PATTERN.test(version || '') || channelForPackagedVersion(version) !== 'stable') return settings
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

module.exports = { migrateBetaToStable, keepChannelMarker }
