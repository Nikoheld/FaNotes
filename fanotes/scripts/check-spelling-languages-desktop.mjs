// Real desktop app (Electron under Xvfb): the spellchecker and autocorrect tell the languages of a
// note apart while the user types. A German line, a French line with a typo, a vocabulary pair
// "le chien – der Hund" and an Italian line go into one note; the French typo must be underlined
// or corrected to the right French word, "chien" and "Hund" must stay untouched, a German typo
// must still be corrected, and the Italian line is neither underlined nor changed.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs xvfb-run -a node scripts/check-spelling-languages-desktop.mjs
//
// Needs a built renderer (`vite build`, dist/), xvfb-run and playwright-core.
import fs from 'node:fs'
import path from 'node:path'
import { createProfile, createReporter, connect, launch, openFile, quit, root, sleep, stop, until, dismissNotices } from './lib/desktop-flow.mjs'

if (process.env.FANOTES_SKIP_BROWSER === '1') {
  console.log('spelling languages (desktop): skipped (FANOTES_SKIP_BROWSER=1)')
  process.exit(0)
}
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.log('spelling languages (desktop): skipped (no dist/, run vite build)')
  process.exit(0)
}

const profile = createProfile('fanotes-spell-lang-', { spellcheck: true, autocorrect: true })
fs.writeFileSync(path.join(profile.vault, 'Sprachen.md'), '')
const app = launch(profile)
const { ok, failed } = createReporter()
let browser = null
let page = null
const watchdog = setTimeout(() => {
  console.error('watchdog: check did not finish in time')
  void stop(app, browser).finally(() => process.exit(1))
}, 4 * 60_000)

const editorText = () => page.evaluate(() => [...document.querySelectorAll('.markdown-editor .cm-line')].map((line) => line.textContent).join('\n'))
const underlined = () => page.evaluate(() => [...document.querySelectorAll('.markdown-editor .cm-spelling-error')].map((mark) => mark.textContent))
const typeLine = async (text, { enter = true } = {}) => {
  // About 65 ms per key: autocorrect answers asynchronously and drops a fix once the user has typed on.
  await page.keyboard.type(text, { delay: 65 })
  if (enter) await page.keyboard.press('Enter')
}

try {
  ;({ browser, page } = await connect(app))
  await dismissNotices(page)
  await openFile(page, 'Sprachen')
  await page.waitForSelector('.markdown-editor .cm-content', { timeout: 30_000 })
  await page.locator('.markdown-editor .cm-content').click()
  // The dictionaries load a few seconds after the note opens; autocorrect waits for them.
  await sleep(9000)

  await typeLine('Der Lehrer hat gesagt, dass wir die Wörter lernen müssen und das ist wichtig.')
  await typeLine('Ich sehe auf den Bidlschirm und die Maus liegt neben der Tastatur.')
  await typeLine('Hier soir nous avons regardé un film et le chien mange une pomem dans le jardin.')
  await typeLine('le chien – der Hund')
  await typeLine('Il cane è molto grande e la casa è vicino al fiume.')
  await typeLine('Die Katze schläft', { enter: false })
  // Let the debounced spelling pass finish.
  await until(async () => (await page.locator('.markdown-editor .cm-editor').getAttribute('data-detected-languages')) !== null, 'language profile published', 20_000)
  await sleep(1500)

  const text = await editorText()
  const marks = await underlined()
  const lines = text.split('\n')
  console.log(JSON.stringify({ underlined: marks, lines }, null, 1))
  const detected = await page.locator('.markdown-editor .cm-editor').getAttribute('data-detected-languages')

  ok('a German typo is still corrected to the German word', /Bildschirm/u.test(text) && !/Bidlschirm/u.test(text), lines[1])
  const frenchLine = lines.find((line) => /nous avons regardé/u.test(line)) ?? ''
  ok('the French typo is corrected to the French word or underlined', /pomme/u.test(frenchLine) || marks.includes('pomem'), `${frenchLine.slice(-40)} | underlined: ${marks.join(',')}`)
  ok('the French typo is not turned into a German or English word', !/pomem|Pommes|pomelo|poem/iu.test(frenchLine.replace(/pomem/u, '')) || marks.includes('pomem'), frenchLine.slice(-40))
  const vocabulary = lines.find((line) => /chien –/u.test(line)) ?? ''
  ok('"le chien – der Hund" stays as typed', vocabulary === 'le chien – der Hund', vocabulary)
  ok('"chien" and "Hund" are not underlined', !marks.includes('chien') && !marks.includes('Hund'), marks.join(','))
  const italian = lines.find((line) => /Il cane/u.test(line)) ?? ''
  ok('an Italian line is left alone', italian === 'Il cane è molto grande e la casa è vicino al fiume.', italian)
  ok('an Italian line is not underlined', !marks.some((mark) => ['cane', 'molto', 'grande', 'casa', 'vicino', 'fiume'].includes(mark)), marks.join(','))
  ok('correct German is not underlined', !marks.some((mark) => ['Lehrer', 'Wörter', 'Tastatur', 'Katze'].includes(mark)), marks.join(','))
  ok('the language profile of the note lists German and French', Boolean(detected) && detected.includes('de') && detected.includes('fr'), detected ?? '')
} catch (error) {
  console.error(error)
  ok('the check ran to the end', false, String(error).slice(0, 200))
} finally {
  clearTimeout(watchdog)
  await quit(app, page)
  await stop(app, browser)
  profile.dispose()
}
console.log(failed() === 0 ? 'spelling-languages (desktop) ok' : `spelling-languages (desktop): ${failed()} failed`)
process.exit(failed() === 0 ? 0 : 1)
