// Screenshots of Settings → Statistik in light and dark (web build served on a local port).
// usage: node scripts/shoot-statistics.mjs <baseUrl> <outDir>
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
const require = createRequire('/srv/agents/fanotes/.site-redesign-tools/')
const { chromium } = require('playwright-core')
const [base = 'http://127.0.0.1:5337/?web', out = '.'] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })

// Content with realistic stats is built with the app's own serializers.
const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const { writePageStatsIntoNote } = await server.ssrLoadModule('/src/lib/famd.ts')
const { emptyPageStats } = await server.ssrLoadModule('/src/lib/pageStats.ts')
const { embedCards } = await server.ssrLoadModule('/src/lib/flashcards.ts')
const { serializeHomeworkMarkdown, createHomeworkTask } = await server.ssrLoadModule('/src/lib/homeworkStore.ts')
const dayKey = (offset) => { const d = new Date(); d.setDate(d.getDate() - offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const future = (offset) => dayKey(-offset)
let seed = 7
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const files = {}
const subjects = { Mathematik: '#e5484d', Deutsch: '#3e9bd6', Physik: '#46a758', Geschichte: '#f5a524' }
const stats = (days, words, dwellMin) => {
  const base = emptyPageStats(Date.now())
  const weekday = [0, 0, 0, 0, 0, 0, 0]
  weekday[1 + Math.floor(random() * 5)] = dwellMin * 60_000
  return { ...base, dwellMs: dwellMin * 60_000, dwellByWeekday: weekday, activeDays: days, typing: { ...base.typing, wordsTyped: words }, ink: { ...base.ink, strokes: Math.floor(random() * 400), penDownMs: 60_000 * Math.floor(random() * 30) } }
}
let n = 0
for (const [subject] of Object.entries(subjects)) {
  for (let i = 0; i < 9; i += 1) {
    n += 1
    const days = []
    for (let d = 0; d < 330; d += 1) if (random() < 0.12 + (d < 60 ? 0.25 : 0)) days.push(dayKey(d))
    let md = `# ${subject} ${i + 1}\n\n${'Wort '.repeat(40 + Math.floor(random() * 500))}\n`
    if (i % 3 === 0) md = embedCards(md, [{ id: `c${n}a`, front: 'Frage', back: 'Antwort', ease: 2.5, intervalDays: 2, due: dayKey(1), reps: 3, lapses: 1 }, { id: `c${n}b`, front: 'Frage 2', back: 'A', ease: 2.5, intervalDays: 2, due: future(5), reps: 2, lapses: 0 }])
    files[`${subject}/Notiz ${i + 1}.md`] = md
    files[`${subject}/Notiz ${i + 1}.famd`] = writePageStatsIntoNote('', stats(days.sort(), 80 + Math.floor(random() * 900), 10 + Math.floor(random() * 240)))
  }
}
files['Hausaufgaben.md'] = serializeHomeworkMarkdown({ version: 1, tasks: [
  createHomeworkTask({ title: 'Aufgaben S. 42', subject: 'Mathematik', dueDate: dayKey(2) }),
  createHomeworkTask({ title: 'Textanalyse', subject: 'Deutsch', dueDate: future(3) }),
  createHomeworkTask({ title: 'Protokoll', subject: 'Physik', dueDate: future(6), done: true }),
  createHomeworkTask({ title: 'Vokabeln', subject: 'Deutsch', dueDate: dayKey(5), done: true }),
  createHomeworkTask({ title: 'Mathe Klausur', subject: 'Mathematik', dueDate: future(12), kind: 'appointment' }),
  createHomeworkTask({ title: 'Physik Test', subject: 'Physik', dueDate: future(20), kind: 'appointment' }),
] })
await server.close()

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const outputs = []
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1500 }, locale: 'de-CH', colorScheme: scheme })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)))
  let sends = 0
  page.on('request', (request) => { if (request.url().includes('/api/v1/diagnostics')) sends += 1 })
  await page.addInitScript((value) => { try { localStorage.setItem('fanotes-theme-test', value) } catch { /* ignore */ } }, scheme)
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.evaluate(async ({ files, subjects, scheme }) => {
    const api = window.fanotes
    await api.completeOnboarding(Object.keys(subjects))
    for (const [path, content] of Object.entries(files)) {
      const slash = path.lastIndexOf('/')
      if (path.endsWith('.famd')) { await api.writeFile(path, content); continue }
      const created = await api.createNote(slash > 0 ? path.slice(0, slash) : '', path.slice(slash + 1).replace(/\.md$/u, ''))
      await api.writeFile(created.relativePath, content)
    }
    const boot = await api.bootstrap()
    await api.saveSettings({ ...boot.settings, theme: scheme })
  }, { files, subjects, scheme })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.keyboard.press('Control+,').catch(() => undefined)
  await page.locator('.settings-content').first().waitFor({ timeout: 8000 }).catch(() => undefined)
  if (!(await page.locator('.settings-content').count())) await page.locator('button[aria-label*="Einstellungen"], button[title*="Einstellungen"]').first().click()
  await page.locator('.settings-backdrop aside button', { hasText: 'Statistik' }).first().click()
  await page.waitForFunction(() => !document.querySelector('.stat-progress') && document.querySelector('.stat-heatmap'), null, { timeout: 60000 })
  await page.waitForTimeout(600)
  // Tall capture: let the dialog grow to its content so the whole page is in one image.
  await page.addStyleTag({ content: '.settings-modal{height:auto!important;max-height:none!important;animation:none!important}.settings-backdrop{align-items:flex-start!important;overflow:visible!important}.settings-scroll{overflow:visible!important}' })
  await page.setViewportSize({ width: 1280, height: 2600 })
  await page.waitForTimeout(300)
  const file = `${out}/statistics-${scheme}.png`
  await page.locator('.settings-modal').first().screenshot({ path: file })
  outputs.push(file)
  console.log(scheme, 'theme attr:', await page.evaluate(() => document.documentElement.dataset.theme), 'errors:', errors.length, 'diagnostics requests:', sends)
  await context.close()
}
await browser.close()
console.log(outputs.join('\n'))
