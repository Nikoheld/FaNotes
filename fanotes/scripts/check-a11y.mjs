// Accessibility check: launches the built renderer in Electron (Xvfb, temp profile, synthetic vault),
// opens every main view and dialog and runs axe-core (WCAG 2 A/AA) on each, plus keyboard checks
// (focus enters a dialog, Tab stays inside, Escape closes, focus returns to the opener).
//   node scripts/check-a11y.mjs                       German/light and English/dark (CI default)
//   FANOTES_A11Y_MATRIX=full node scripts/check-a11y.mjs   de/en x light/dark
//   FANOTES_A11Y_REPORT=1 ...                         print every violation node
// Needs a built renderer (`vite build`), xvfb-run, playwright-core (PLAYWRIGHT_CORE) and axe-core
// (AXE_CORE, default: node_modules/axe-core, else the shared tools copy). Skips when something is missing.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const skip = (why) => { console.log(`a11y: skipped (${why})`); process.exit(0) }
if (process.env.FANOTES_SKIP_BROWSER === '1') skip('FANOTES_SKIP_BROWSER=1')
if (!spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()) skip('no xvfb-run')
if (!fs.existsSync(electron)) skip('no electron')
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) skip('no dist/ (run vite build)')
let playwright
try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { skip('no playwright-core; set PLAYWRIGHT_CORE') }
const chromium = playwright.chromium ?? playwright.default.chromium
const axeCandidates = [process.env.AXE_CORE, path.join(root, 'node_modules', 'axe-core', 'axe.min.js'), '/srv/agents/fanotes/.site-redesign-tools/node_modules/axe-core/axe.min.js'].filter(Boolean)
const axePath = axeCandidates.find((candidate) => fs.existsSync(candidate))
if (!axePath) skip('no axe-core; set AXE_CORE')
const axeSource = fs.readFileSync(axePath, 'utf8')

// Known exceptions: [rule id, css selector fragment, reason]. Keep this list short.
const ALLOW = [
  ['color-contrast', '.textLayer', 'pdf.js text layer is transparent text over the page canvas'],
  ['scrollable-region-focusable', '.textLayer', 'pdf.js text layer'],
  ['region', '.ftb-popover', 'toolbar popovers are portalled to body and are menus, not page content'],
]
const allowed = (ruleId, target) => ALLOW.some(([rule, fragment]) => rule === ruleId && target.includes(fragment))

const report = process.env.FANOTES_A11Y_REPORT === '1'
const full = process.env.FANOTES_A11Y_MATRIX === 'full'
const combos = full
  ? [['de', 'light'], ['de', 'dark'], ['en', 'light'], ['en', 'dark']]
  : [['de', 'light'], ['en', 'dark']]
const only = process.env.FANOTES_A11Y_ONLY ? process.env.FANOTES_A11Y_ONLY.split(',') : null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const makePdf = () => {
  const text = 'BT /F1 24 Tf 40 60 Td (Seite 1) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const results = [] // { combo, view, violations: [{ id, impact, target, summary }] }
const failures = [] // keyboard check failures
let temporaryRoot = null

// The first-run onboarding replaces the whole app, so it is audited in a launch of its own.
const runCombo = async (language, theme, onboarding = false) => {
  const combo = `${language}/${theme}${onboarding ? '/onboarding' : ''}`
  console.log(`combo ${combo}`)
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-a11y-'))
  temporaryRoot = temporary
  const home = path.join(temporary, 'home')
  const configHome = path.join(temporary, 'config')
  const runtime = path.join(temporary, 'runtime')
  const vault = path.join(home, 'Notizen')
  const userData = path.join(configHome, 'FaNotes')
  for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'Biologie')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(vault, 'Biologie', 'Notiz.md'), '# Zelle\n\nSynthetic text note with a [[Link]] and #tag.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
  fs.writeFileSync(path.join(vault, 'Biologie', 'Blatt.pdf'), makePdf())
  fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
    version: 3,
    vaultPath: vault,
    settings: { uiLanguage: language, theme, autoCheckUpdates: false, autoDownloadUpdates: false },
    onboarding: { version: 1, completed: !onboarding },
  }, null, 2)}\n`, { mode: 0o600 })

  // A free port from the OS: fixed ranges collide with other Electron checks running on the same machine.
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)) }); probe.on('error', reject) })
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  let browser = null
  try {
    const deadline = Date.now() + 60_000
    while (!browser && Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
      if (child.exitCode !== null) throw new Error(`Electron exited: ${output.slice(-400)}`)
    }
    if (!browser) throw new Error('Electron did not open a debugging port')
    let page = null
    for (let tries = 0; tries < 120 && !page; tries += 1) {
      page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
      if (!page) await sleep(250)
    }
    if (!page) throw new Error('no renderer page')
    await page.waitForFunction(() => Boolean(window.fanotes && (document.querySelector('.file-tree__row') || document.querySelector('.first-run'))), null, { timeout: 60_000 })
    await sleep(1500)

    const audit = async (view) => {
      if (only && !only.includes(view.split(':')[0])) return
      await sleep(300)
      await page.evaluate(axeSource)
      const found = await page.evaluate(async () => {
        const run = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, resultTypes: ['violations'] })
        return run.violations.flatMap((violation) => violation.nodes.map((node) => ({
          id: violation.id, impact: violation.impact, target: node.target.join(' '), summary: (node.failureSummary || '').split('\n').slice(1, 3).join(' ').slice(0, 220),
        })))
      })
      const kept = found.filter((v) => !allowed(v.id, v.target) && (v.impact === 'critical' || v.impact === 'serious' || v.impact === 'moderate'))
      results.push({ combo, view, violations: kept })
      if (report && kept.length) for (const v of kept) console.log(`  [${combo}] ${view}: ${v.id} (${v.impact}) ${v.target}\n      ${v.summary}`)
    }
    const press = (key) => page.keyboard.press(key)
    const dialogSelector = '[role="dialog"], .settings-modal, .command-palette'
    // Keyboard contract of a modal: focus moves in, Tab/Shift+Tab stay inside, Escape closes, focus returns to the opener.
    const keyboardDialog = async (name, openerSelector, open, { auditOpen = false } = {}) => {
      if (only && !only.includes(name)) return
      if (openerSelector) await page.locator(openerSelector).first().focus().catch(() => {})
      await open()
      await sleep(400)
      const inside = () => page.evaluate((selector) => {
        const dialog = [...document.querySelectorAll(selector)].filter((node) => node.getClientRects().length).pop()
        return Boolean(dialog && dialog.contains(document.activeElement))
      }, dialogSelector)
      if (!(await inside())) failures.push(`[${combo}] ${name}: focus did not move into the dialog`)
      if (auditOpen) await audit(name)
      let escaped = false
      for (let index = 0; index < 60; index += 1) {
        await press('Tab')
        if (!(await inside())) { escaped = true; break }
      }
      if (escaped) failures.push(`[${combo}] ${name}: Tab leaves the dialog`)
      await press('Escape')
      await sleep(400)
      const stillOpen = await page.evaluate((selector) => [...document.querySelectorAll(selector)].some((node) => node.getClientRects().length), dialogSelector)
      if (stillOpen) { failures.push(`[${combo}] ${name}: Escape does not close the dialog`); return }
      if (openerSelector) {
        const returned = await page.evaluate((selector) => Boolean(document.activeElement?.matches?.(selector)), openerSelector)
        if (!returned) failures.push(`[${combo}] ${name}: focus did not return to the opener`)
      }
    }

    // Tab through the current view: every stop needs a visible focus indicator, and custom widgets that
    // announce an interactive role must be reachable by Tab (or be a roving-tabindex member).
    const focusSweep = async (name) => {
      if (only && !only.includes(name)) return
      await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0) })
      const seen = new Set()
      for (let step = 0; step < 70; step += 1) {
        await press('Tab')
        const info = await page.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body) return null
          const style = getComputedStyle(el)
          const hasOutline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)'
          const hasShadow = style.boxShadow !== 'none'
          const editable = el.matches('.cm-content, [contenteditable="true"], input[type="text"], input:not([type]), textarea, input[type="search"]')
          const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
          return { key: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, ok: hasOutline || hasShadow || editable }
        })
        if (!info || seen.has(info.key)) continue
        seen.add(info.key)
        if (!info.ok) failures.push(`[${combo}] ${name}: no visible focus indicator on ${info.key}`)
      }
      if (report) console.log(`  [${combo}] ${name}: ${seen.size} distinct focus stops`)
      const unreachable = await page.evaluate(() => [...document.querySelectorAll('[role="button"], [role="menuitem"], [role="link"], [role="switch"], [role="checkbox"]')]
        .filter((el) => !el.matches('button, a[href], input, select, textarea, summary') && !el.hasAttribute('tabindex') && !el.closest('[aria-hidden="true"], [hidden]') && el.getClientRects().length > 0)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0]}[role=${el.getAttribute('role')}]`))
      for (const key of new Set(unreachable)) failures.push(`[${combo}] ${name}: ${key} has an interactive role but is not focusable`)
      await page.evaluate(() => document.activeElement?.blur?.())
    }

    const openRow = async (text) => {
      const row = page.locator('.file-tree__row', { hasText: text }).first()
      for (let attempt = 0; attempt < 3 && !(await row.isVisible().catch(() => false)); attempt += 1) {
        await page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Biologie' }).first().click()
        await row.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
      }
      await row.click({ timeout: 8000 }).catch(async (error) => {
        const rows = await page.locator('.file-tree__row').allInnerTexts().catch(() => [])
        await page.screenshot({ path: path.join(process.env.TMPDIR || os.tmpdir(), 'a11y-fail.png') }).catch(() => {})
        failures.push(`[${combo}] could not open ${text}: rows=${JSON.stringify(rows)} ${String(error).split('\n')[0]}`)
      })
    }
    if (onboarding) {
      await audit('onboarding')
      await focusSweep('onboarding')
      return
    }
    await audit('notes')
    await focusSweep('focus-notes')
    await openRow('Notiz')
    await page.waitForSelector('.cm-editor, .markdown-editor, .note-editor', { timeout: 20_000 }).catch(() => {})
    await sleep(1500)
    await audit('editor')
    await focusSweep('focus-editor')
    const moreLabel = '.editor-toolbar [aria-haspopup="menu"]'
    if (await page.locator(moreLabel).first().isVisible().catch(() => false)) {
      await page.locator(moreLabel).first().click()
      await sleep(300)
      await audit('editor-menu')
      await press('Escape')
      await sleep(200)
      if (await page.locator('.editor-more-menu').count()) failures.push(`[${combo}] editor-menu: Escape does not close the menu`)
    }
    await openRow('Blatt')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="1"] canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 }).catch(() => {})
    await sleep(1500)
    await audit('pdf')
    await openRow('Notiz')
    await sleep(500)

    await page.locator('.ribbon button').nth(2).click()
    await page.locator('.sidebar-search input').first().fill('Zelle')
    await sleep(1200)
    await audit('search')
    await page.locator('.ribbon button').nth(1).click()
    await sleep(300)

    await keyboardDialog('palette', '', async () => { await press('Control+p') })
    await press('Control+p'); await sleep(400); await audit('palette'); await press('Escape'); await sleep(300)

    await press('Control+,')
    await page.waitForSelector('.settings-modal', { timeout: 10_000 })
    const sectionCount = await page.locator('.settings-nav nav button').count()
    for (let index = 0; index < sectionCount; index += 1) {
      await page.locator('.settings-nav nav button').nth(index).click()
      await sleep(350)
      await audit(`settings:${index}`)
    }
    await press('Escape'); await sleep(300)
    const settingsButton = '.ribbon button[aria-label*="Settings"], .ribbon button[aria-label*="Einstellungen"]'
    await keyboardDialog('settings', settingsButton, async () => { await page.locator(settingsButton).first().press('Enter') })

    const viaPalette = async (query) => {
      await press('Control+p')
      await page.locator('.command-palette input').first().fill(query)
      await sleep(300)
      await press('Enter')
      await sleep(900)
    }
    // Dialogs opened from the command palette: audited, then the keyboard contract (focus in, Tab trap, Escape).
    for (const [name, query] of [['history', 'Versionsverlauf'], ['bugreport', 'Fehler melden'], ['worksheet', 'Arbeitsblatt'], ['ai', 'AI-Assistent'], ['addons', 'Add-on-Store'], ['onenote', 'OneNote'], ['flashcards', 'Karteikarten']]) {
      if (only && !only.includes(name)) continue
      await keyboardDialog(name, '', () => viaPalette(query), { auditOpen: true })
    }
    // Full-page views
    for (const [name, query] of [['overview', 'Vault-Übersicht'], ['glyphenwerk', 'GlyphenWerk'], ['statistics', 'Lernzeit']]) {
      if (only && !only.includes(name)) continue
      await viaPalette(query)
      await audit(name)
      await press('Escape')
      await sleep(300)
      await page.locator('.ribbon button').nth(1).click({ timeout: 3000 }).catch(() => failures.push(`[${combo}] ${name}: ribbon not reachable after leaving the view`))
      await sleep(300)
    }

    await page.locator('.ribbon button[aria-label*="alendar"], .ribbon button[aria-label*="Kalender"]').first().click()
    await sleep(1200)
    await audit('calendar')
    await page.locator('.ribbon button[aria-label*="omework"], .ribbon button[aria-label*="Hausaufgaben"]').first().click()
    await sleep(1000)
    await audit('tasks')

    const live = await page.evaluate(() => Boolean(document.querySelector('.save-status[aria-live], [role="status"]')))
    if (!live) failures.push(`[${combo}] no live region for save status`)
  } finally {
    await browser?.close().catch(() => {})
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
    await sleep(800)
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error('a11y: watchdog (8 min)'); process.exit(1) }, 8 * 60_000)
try {
  for (const [language, theme] of combos) for (const onboarding of [false, true]) await runCombo(language, theme, onboarding).catch((error) => failures.push(`[${language}/${theme}${onboarding ? '/onboarding' : ''}] scenario aborted: ${String(error).split('\n')[0]}`))
} finally {
  clearTimeout(watchdog)
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

let total = 0
for (const entry of results) {
  total += entry.violations.length
  const byRule = {}
  for (const v of entry.violations) byRule[v.id] = (byRule[v.id] || 0) + 1
  console.log(`${entry.combo} ${entry.view}: ${entry.violations.length}${entry.violations.length ? ` ${JSON.stringify(byRule)}` : ''}`)
}
for (const failure of failures) console.log(`keyboard: ${failure}`)
if (total || failures.length) {
  console.error(`a11y: ${total} axe violations, ${failures.length} keyboard failures`)
  process.exit(1)
}
console.log('a11y: ok')
