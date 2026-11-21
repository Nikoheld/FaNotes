'use strict'
// Every key of src/defaults.ts must survive a save/load round trip through the
// settings sanitizer (electron/settings-sanitize.cjs). A key that is missing from
// SETTINGS_SCHEMA is silently dropped when config.json is written (QA-001, QA-003).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { SETTINGS_SCHEMA, sanitizeSettings } = require('../electron/settings-sanitize.cjs')

// Keys that are deliberately NOT persisted in config.json. Each needs a reason.
// Currently empty: secrets (API keys, tokens) are in the schema because main.cjs
// encrypts them separately (settingsFromDisk) before they reach the disk.
const EXCLUDED = Object.freeze({})

const source = fs.readFileSync(path.join(__dirname, '../src/defaults.ts'), 'utf8')
const start = source.indexOf('=> ({')
const end = source.indexOf('\n})', start)
assert.ok(start > 0 && end > start, 'defaults.ts object literal not found')
const keys = [...source.slice(start, end).matchAll(/^  (\w+):/gm)].map((m) => m[1])
assert.ok(keys.length > 100, 'defaults.ts keys parsed')

const missing = keys.filter((key) => !(key in SETTINGS_SCHEMA) && !(key in EXCLUDED))
assert.deepEqual(missing, [], `defaults.ts keys missing from SETTINGS_SCHEMA (add a rule or list in EXCLUDED with a reason): ${missing.join(', ')}`)
for (const key of Object.keys(EXCLUDED)) assert.ok(!(key in SETTINGS_SCHEMA), `${key} is both excluded and in the schema`)

// Round trip of the sync/share/toolbar keys: explicit values must survive, bad ones must not.
const defaults = { syncVaultEnabled: true, shareMode: 'copy', shareRecent: '', toolbarPosition: 'top' }
const saved = sanitizeSettings({ syncVaultEnabled: false, shareMode: 'edit', shareRecent: '{"shares":[]}', toolbarPosition: 'side' }, defaults, defaults)
assert.equal(saved.syncVaultEnabled, false, 'sync OFF persists')
assert.equal(saved.shareMode, 'edit')
assert.equal(saved.shareRecent, '{"shares":[]}')
assert.equal(saved.toolbarPosition, 'side')
assert.equal(sanitizeSettings({ syncVaultEnabled: true }, { syncVaultEnabled: false }, defaults).syncVaultEnabled, true, 'explicit ON persists')
// An absent key means ON: profiles written before the switch existed were already syncing.
assert.equal(sanitizeSettings({}, {}, defaults).syncVaultEnabled, true, 'absent key keeps legacy sync ON')
const bad = sanitizeSettings({ shareMode: 'x', toolbarPosition: 'left', syncVaultEnabled: 'no' }, defaults, defaults)
assert.deepEqual([bad.shareMode, bad.toolbarPosition, bad.syncVaultEnabled], ['copy', 'top', true], 'invalid values are rejected')

console.log(`Settings-Schema-Prüfung bestanden: ${keys.length} Schlüssel aus defaults.ts sind im Schema oder ausgeschlossen.`)
