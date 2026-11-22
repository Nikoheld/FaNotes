'use strict'

/** One-time Beta-to-Stable channel migration (desktop settings). */
const assert = require('node:assert/strict')
const { migrateBetaToStable, keepChannelMarker } = require('../electron/channel-migration.cjs')
const { sanitizeSettings } = require('../electron/settings-sanitize.cjs')

const STABLE = '2026.11.3'
const LATER_STABLE = '2026.11.4'
const BETA = '2026.11.3-beta.2'
const NIGHTLY = '2026.11.3-nightly.20261122101010.abcdef1'
const profile = (updateChannel, marker = '') => ({ updateChannel, channelAutoStableDoneAt: marker })

// Fresh beta profile on a stable version: stable, marker set.
let s = migrateBetaToStable(profile('beta'), STABLE)
assert.deepEqual(s, profile('stable', STABLE))

// Manual switch back to beta sticks after restart and after a later stable.
s = { ...s, updateChannel: 'beta' }
assert.equal(migrateBetaToStable(s, STABLE).updateChannel, 'beta')
assert.equal(migrateBetaToStable(s, LATER_STABLE).updateChannel, 'beta')
assert.equal(migrateBetaToStable(s, LATER_STABLE).channelAutoStableDoneAt, STABLE)

// Stable users untouched; marker still set so a later manual beta sticks.
s = migrateBetaToStable(profile('stable'), STABLE)
assert.deepEqual(s, profile('stable', STABLE))
assert.equal(migrateBetaToStable({ ...s, updateChannel: 'beta' }, LATER_STABLE).updateChannel, 'beta')

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
