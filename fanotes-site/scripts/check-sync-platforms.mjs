import assert from 'node:assert/strict'
import { normalizeSyncPlatform } from '../sync-api.mjs'

assert.equal(normalizeSyncPlatform('android'), 'android')
assert.equal(normalizeSyncPlatform('Android'), 'android')
assert.equal(normalizeSyncPlatform(' android '), 'android')
assert.equal(normalizeSyncPlatform('linux'), 'linux')
assert.equal(normalizeSyncPlatform('win32'), 'win32')
assert.equal(normalizeSyncPlatform('darwin'), 'darwin')
assert.equal(normalizeSyncPlatform('web'), 'web')
assert.equal(normalizeSyncPlatform('browser-preview'), 'browser-preview')
assert.equal(normalizeSyncPlatform('Android Tablet'), 'unknown')
assert.equal(normalizeSyncPlatform(''), 'unknown')
assert.equal(normalizeSyncPlatform(null), 'unknown')
console.log('sync platforms ok')
