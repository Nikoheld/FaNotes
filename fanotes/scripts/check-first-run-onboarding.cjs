'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  REQUIRED_STARTER_FOLDERS,
  STARTER_SUBJECTS,
  STARTER_PROFILES,
  onboardingRequiredFromConfig,
  parseOnboardingStatus,
  validateStarterSubjectSelection,
} = require('../electron/onboarding.cjs')

const names = STARTER_SUBJECTS.map(({ name }) => name)
assert.equal(new Set(names).size, names.length, 'Vorgefertigte Fächer müssen eindeutig sein.')
assert.ok(names.includes('AMAT'), 'AMAT fehlt in der Fächerauswahl.')
assert.ok(names.includes('Wirtschaft'), 'Wirtschaft fehlt in der Fächerauswahl.')
assert.deepEqual(REQUIRED_STARTER_FOLDERS.map(({ name }) => name), ['Eingang'])
assert.ok([...REQUIRED_STARTER_FOLDERS, ...STARTER_SUBJECTS].every(({ color }) => /^#[\da-f]{6}$/i.test(color)))

assert.deepEqual(validateStarterSubjectSelection(['AMAT', 'Wirtschaft']), ['AMAT', 'Wirtschaft'])
assert.deepEqual(validateStarterSubjectSelection([]), [])
assert.throws(() => validateStarterSubjectSelection(['AMAT', 'AMAT']), /doppelten/u)
assert.deepEqual(validateStarterSubjectSelection(['Vorlesungen', 'Forschung']), ['Vorlesungen', 'Forschung'])
assert.deepEqual(validateStarterSubjectSelection(['Persönlich', 'Tagebuch']), ['Persönlich', 'Tagebuch'])
assert.deepEqual(validateStarterSubjectSelection(['Projekte', 'Meetings']), ['Projekte', 'Meetings'])
assert.throws(() => validateStarterSubjectSelection(['Unbekannt']), /ungültigen/u)
assert.throws(() => validateStarterSubjectSelection('Mathematik'), /ungültig/u)

assert.equal(onboardingRequiredFromConfig({ version: 2, vaultPath: '/existing' }), false, 'Alte Vaults dürfen kein Onboarding erhalten.')
assert.equal(onboardingRequiredFromConfig({ version: 3, onboarding: { version: 1, completed: false } }), true)
assert.equal(onboardingRequiredFromConfig({ version: 3, onboarding: { version: 1, completed: true } }), false)
assert.equal(parseOnboardingStatus({ version: 1, status: 'pending' }), 'pending')
assert.equal(parseOnboardingStatus({ version: 1, status: 'complete' }), 'complete')
assert.equal(parseOnboardingStatus({ version: 1, status: 'invalid' }), null)

const root = path.resolve(__dirname, '..')
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'src', 'components', 'FirstRunOnboarding.tsx'), 'utf8')
assert.match(preload, /completeOnboarding:\s*\(subjects\)/u, 'Die sichere Renderer-API fehlt.')
assert.match(renderer, /data-step=\{STEPS\[step\]\.id\}/u, 'Die geführten Onboarding-Schritte fehlen.')
assert.match(renderer, /Willkommen bei FaNotes/u)
assert.match(renderer, /Wofür möchtest du FaNotes verwenden\?/u)
assert.match(renderer, /Eine Seite\. Zwei Arten zu schreiben\./u)
assert.match(renderer, /Welche Ordner möchtest du verwenden\?/u)
assert.match(renderer, /'school'.*'university'.*'private'.*'work'/su, 'Die vier Einsatzprofile fehlen.')
assert.match(renderer, /Eingang ist immer dabei/u)
assert.match(renderer, /first-run-preview-ink/u, 'Die animierte Handschriftvorschau fehlt.')
assert.match(renderer, /Unsichtbare Transkription/u, 'Die Suche in unkonvertierter Handschrift wird nicht erklärt.')

assert.equal(Object.keys(STARTER_PROFILES).length, 4)
console.log(`First-run-Onboarding geprüft: 4 Schritte, Schule/UNI/Privat/Arbeit, animierte Handschrift, ${names.length} Schulfächer, Eingang fest, Altbestand kompatibel.`)
