'use strict'

/** One-time Beta-to-Stable channel migration (desktop settings). */
const assert = require('node:assert/strict')
const { AUTO_STABLE_ROUND, migrateBetaToStable, keepChannelMarker } = require('../electron/channel-migration.cjs')
const { sanitizeSettings } = require('../electron/settings-sanitize.cjs')

const STABLE = '2026.11.3'
const ROUND = '2026.11.4'
const AFTER_ROUND = '2026.12.1'
const BETA = '2026.11.3-beta.2'
const NIGHTLY = '2026.11.3-nightly.20261122101010.abcdef1'
const profile = (updateChannel, marker = '') => ({ updateChannel, channelAutoStableDoneAt: marker })

// Fresh beta profile on a stable version: stable, marker set.
let s = migrateBetaToStable(profile('beta'), STABLE)
assert.deepEqual(s, profile('stable', STABLE))

// Manual switch back to beta sticks after a restart within the round.
s = { ...s, updateChannel: 'beta' }
assert.equal(migrateBetaToStable(s, STABLE).updateChannel, 'beta')
assert.equal(migrateBetaToStable(s, STABLE).channelAutoStableDoneAt, STABLE)

// Second round (owner, 2026-11-24): a marker from before AUTO_STABLE_ROUND moves beta to stable once more,
// on 2026.11.4 or on any later stable the device installs first.
assert.equal(AUTO_STABLE_ROUND, ROUND)
assert.deepEqual(migrateBetaToStable(s, ROUND), profile('stable', ROUND))
assert.deepEqual(migrateBetaToStable(s, AFTER_ROUND), profile('stable', AFTER_ROUND))
// Within the new round a manual beta sticks again, also across later stables.
const roundTwo = { ...migrateBetaToStable(s, ROUND), updateChannel: 'beta' }
assert.equal(migrateBetaToStable(roundTwo, ROUND).updateChannel, 'beta')
assert.equal(migrateBetaToStable(roundTwo, AFTER_ROUND).updateChannel, 'beta')
assert.equal(migrateBetaToStable(roundTwo, AFTER_ROUND).channelAutoStableDoneAt, ROUND)
// A beta build of the round does not migrate; a broken marker is left alone.
assert.deepEqual(migrateBetaToStable(s, '2026.11.5-beta.1'), s)
assert.deepEqual(migrateBetaToStable(profile('beta', 'garbage'), ROUND), profile('beta', 'garbage'))

// Stable users untouched; marker still set so a later manual beta sticks within the round.
s = migrateBetaToStable(profile('stable'), ROUND)
assert.deepEqual(s, profile('stable', ROUND))
assert.equal(migrateBetaToStable({ ...s, updateChannel: 'beta' }, AFTER_ROUND).updateChannel, 'beta')

// Nightly users unchanged (nightly is not beta-like); marker set.
assert.deepEqual(migrateBetaToStable(profile('nightly'), STABLE), profile('nightly', STABLE))

// Running a beta or nightly version: no change, no marker.
assert.deepEqual(migrateBetaToStable(profile('beta'), BETA), profile('beta'))
assert.deepEqual(migrateBetaToStable(profile('beta'), NIGHTLY), profile('beta'))
assert.deepEqual(migrateBetaToStable(profile('beta'), 'garbage'), profile('beta'))
// ...and the first stable afterwards migrates.
assert.equal(migrateBetaToStable(migrateBetaToStable(profile('beta'), BETA), STABLE).updateChannel, 'stable')

// Renderer saves cannot clear or change the marker; the marker survives sanitizing.
assert.equal(keepChannelMarker(profile('beta', ''), profile('beta', STABLE)).channelAutoStableDoneAt, STABLE)
assert.equal(keepChannelMarker(profile('beta', ''), profile('beta')).channelAutoStableDoneAt, '')
const defaults = { updateChannel: 'stable', channelAutoStableDoneAt: '' }
assert.equal(sanitizeSettings({ channelAutoStableDoneAt: STABLE }, defaults, defaults).channelAutoStableDoneAt, STABLE)

console.log('Kanal-Migration Beta -> Stable: OK')
