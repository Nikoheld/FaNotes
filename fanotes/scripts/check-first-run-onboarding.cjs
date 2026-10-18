'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  REQUIRED_STARTER_FOLDERS,
  STARTER_SUBJECTS,
  STARTER_PROFILES,
  onboardingRequiredFromConfig,
  onboardingRequiredFromVaultStatus,
  parseOnboardingStatus,
  validateStarterSubjectSelection,
} = require('../electron/onboarding.cjs')

const names = STARTER_SUBJECTS.map(({ name }) => name)
assert.equal(new Set(names).size, names.length, 'Vorgefertigte Fächer müssen eindeutig sein.')
assert.ok(names.includes('AMAT'), 'AMAT fehlt in der Fächerauswahl.')
assert.ok(names.includes('Wirtschaft'), 'Wirtschaft fehlt in der Fächerauswahl.')
assert.ok(names.includes('Französisch'), 'Französisch fehlt in der Fächerauswahl.')
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
assert.equal(onboardingRequiredFromVaultStatus('pending'), true)
assert.equal(onboardingRequiredFromVaultStatus('complete'), false)
assert.equal(onboardingRequiredFromVaultStatus(null), false, 'Vaults ohne Marker bleiben ohne nachträgliche Einrichtung.')

const root = path.resolve(__dirname, '..')
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
const selectVault = mainSource.slice(mainSource.indexOf('handle(IPC.selectVault'), mainSource.indexOf('handle(IPC.getCachedTree'))
assert.match(selectVault, /onboardingRequiredFromVaultStatus\(await readOnboardingStatus\(validatedVaultPath\)\)/u)
assert.match(selectVault, /currentOnboardingRequired = onboardingRequired/u)
assert.match(selectVault, /currentOnboardingRequired = previousOnboardingRequired/u)

const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
assert.match(preload, /completeOnboarding:\s*\(subjects\)/u, 'Die sichere Renderer-API fehlt.')
assert.equal(Object.keys(STARTER_PROFILES).length, 4)

const retiredHeadings = [
  'Alles, was dir wichtig ist.',
  'Wofür möchtest du FaNotes verwenden?',
  'Eine Seite. Zwei Arten zu schreiben.',
  'Welche Ordner möchtest du verwenden?',
]
for (const scriptName of ['check-web-app.cjs', 'check-i18n.cjs']) {
  const source = fs.readFileSync(path.join(root, 'scripts', scriptName), 'utf8')
  assert.doesNotMatch(source, /dataset\.step === 'writing'/u, `${scriptName} wartet noch auf die Schreibszene.`)
  for (const heading of retiredHeadings) {
    assert.equal(source.includes(heading), false, `${scriptName} verlangt noch „${heading}“.`)
  }
}

const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
const marker = '@media (max-width: 760px)'
let phone = ''
let phoneStart = css.indexOf(marker)
while (phoneStart >= 0) {
  const phoneEnd = css.indexOf('@media', phoneStart + marker.length)
  const block = css.slice(phoneStart, phoneEnd === -1 ? css.length : phoneEnd)
  if (block.includes('.first-run-setup')) {
    phone = block
    break
  }
  phoneStart = css.indexOf(marker, phoneStart + marker.length)
}
assert.ok(phone, 'Die schmale Einrichtung fehlt.')
for (const selector of ['.first-run-setup', '.first-run-profiles', '.first-run-subjects', '.first-run-actions']) {
  assert.match(phone, new RegExp(`${selector.replace('.', '\\.')}[\\s\\S]{0,220}flex-direction:\\s*column`))
  assert.doesNotMatch(phone, new RegExp(`${selector.replace('.', '\\.')}[^{}]*\\{[^}]*display:\\s*none`))
}
assert.doesNotMatch(phone, /\.first-run-continue[^{}]*\{[^}]*display:\s*none/u)

const installNavigator = () => {
  const localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }
  const windowStub = globalThis.window && typeof globalThis.window === 'object' ? globalThis.window : {}
  Object.assign(windowStub, { localStorage })
  if (!globalThis.window) globalThis.window = windowStub
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'de', languages: ['de'] },
      configurable: true,
    })
  } catch {
    /* Node 22 navigator is a getter. */
  }
}

async function main() {
  installNavigator()
  const { createServer } = await import('vite')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const server = await createServer({
    root,
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  })
  try {
    const { FirstRunOnboarding } = await server.ssrLoadModule('/src/components/FirstRunOnboarding.tsx')
    const subjects = [
      { name: 'Algebra', color: '#2a6f97' },
      { name: 'Chor', color: '#c4554d' },
    ]
    const render = () => renderToStaticMarkup(createElement(FirstRunOnboarding, {
      subjects,
      onComplete: async () => undefined,
    }))
    const html = render()
    assert.equal(render(), html)
    for (const subject of subjects) assert.ok(html.includes(subject.name), `${subject.name} fehlt in der Einrichtung.`)
    assert.equal(html.includes('Mathematik'), false, 'Die Einrichtung muss die übergebene Fächerliste zeigen.')
    for (const purpose of ['Schule', 'UNI', 'Privat', 'Arbeit']) {
      assert.ok(html.includes(purpose), `${purpose} fehlt in der Einrichtung.`)
    }
    assert.ok(html.includes('FaNotes einrichten'), 'Der Abschluss fehlt.')
    assert.match(html, /aria-labelledby="first-run-title"/u)
    assert.match(html, /id="first-run-title"/u)
    assert.match(html, /class="first-run-profiles"/u)
    assert.match(html, /class="first-run-subjects"/u)
    assert.match(html, /<div class="first-run-inbox">[\s\S]*Eingang ist immer dabei/u)
    assert.doesNotMatch(html, /<button\b[^>]*class="[^"]*first-run-inbox/u)
    const pressed = html.match(/aria-pressed="(?:true|false)"/gu) ?? []
    assert.equal(pressed.length, subjects.length + 4, 'Zwecke und Ordner brauchen jeweils einen gedrückten Zustand.')
    assert.ok(html.indexOf('first-run-profiles') < html.indexOf('first-run-subjects'))
    assert.ok(html.indexOf('first-run-subjects') < html.indexOf('FaNotes einrichten'))
    for (const heading of retiredHeadings) assert.equal(html.includes(heading), false, heading)
    assert.equal(html.includes('data-step='), false)
    console.log('Onboarding geprüft: eine Einrichtung, vier Profile, Ordnerauswahl, Abschluss.')
  } finally {
    await server.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
