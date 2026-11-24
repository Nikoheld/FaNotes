// Share presence in the real desktop app (Electron under Xvfb, temp profile, synthetic vault): no bottom bar, small
// initials circles at the right end of the tab row for the OTHER people editing, "+N" overflow, tooltip, a popover
// that lists editors and present people (closes on Escape and outside click), and nothing when nobody else is there.
// A live share needs a server, so the check feeds the app's share state through its test event
// (`fanotes:test-share-people`); everything else is the real UI.
// Usage: npx vite build && PLAYWRIGHT_CORE=... xvfb-run -a node scripts/check-share-presence.mjs
// FANOTES_SHARE_PRESENCE_SHOTS=<dir> additionally writes screenshots.
import fs from 'node:fs'
import path from 'node:path'
import { connect, createProfile, createReporter, launch, openFile, sleep, stop, until } from './lib/desktop-flow.mjs'

const { ok, failed } = createReporter()
const shots = process.env.FANOTES_SHARE_PRESENCE_SHOTS || ''
if (shots) fs.mkdirSync(shots, { recursive: true })

const run = async (theme, full) => {
  const profile = createProfile(`share-presence-${theme}-`, { theme })
  fs.writeFileSync(path.join(profile.vault, 'Geteilt.md'), '# Geteilt\n\nText der geteilten Notiz.\n')
  const app = launch(profile)
  let browser = null
  try {
    const connected = await connect(app)
    browser = connected.browser
    const page = connected.page
    await openFile(page, 'Geteilt')
    await page.locator('.tabs-bar').waitFor()
    const feed = (people) => page.evaluate((value) => window.dispatchEvent(new CustomEvent('fanotes:test-share-people', { detail: value })), people)
    const avatars = () => page.locator('.share-presence .share-avatar').allInnerTexts()
    const editors = ['Anna Meier', 'Ben', 'carla.keller', 'David Roth', 'Eva Frei', 'Felix', 'Me Self']

    await feed({ editors, present: ['Me Self', 'Anna Meier', 'Ben', 'carla.keller'], self: 'Me Self' })
    await until(async () => (await avatars()).length === 3, `${theme}: three avatars`)
    ok(`${theme}: no bottom bar`, (await page.locator('.share-edit-presence').count()) === 0)
    ok(`${theme}: initials of the others, not of me`, JSON.stringify(await avatars()) === JSON.stringify(['AM', 'BE', 'CK']), JSON.stringify(await avatars()))
    const button = page.locator('.share-presence-button')
    ok(`${theme}: button label counts people`, (await button.getAttribute('aria-label')) === '3 Personen bearbeiten gerade', await button.getAttribute('aria-label'))
    const place = await page.evaluate(() => {
      const bar = document.querySelector('.tabs-bar').getBoundingClientRect()
      const group = document.querySelector('.share-presence').getBoundingClientRect()
      const circle = document.querySelector('.share-avatar').getBoundingClientRect()
      return { inBar: group.top >= bar.top && group.bottom <= bar.bottom + 1, right: group.left > bar.width / 2, size: circle.width }
    })
    ok(`${theme}: circles sit in the tab row, right half, 24 px`, place.inBar && place.right && place.size === 24, JSON.stringify(place))

    if (full) {
      await page.locator('.share-avatar-slot').first().hover()
      const tip = page.locator('.share-presence-tip')
      await tip.waitFor({ timeout: 3000 })
      ok('tooltip names the person', /Anna Meier\s+bearbeitet gerade/u.test(await tip.innerText()), await tip.innerText())
      await page.mouse.move(5, 5)
      await tip.waitFor({ state: 'detached', timeout: 3000 })

      await button.click()
      const popover = page.locator('.share-presence-popover')
      await popover.waitFor({ timeout: 3000 })
      const lists = await popover.locator('section').evaluateAll((sections) => sections.map((section) => ({ title: section.querySelector('h3').textContent, names: [...section.querySelectorAll('li span:last-child')].map((el) => el.textContent) })))
      ok('popover lists who is editing', lists[0].title === 'Gerade am Bearbeiten' && lists[0].names.join('|') === 'Anna Meier|Ben|carla.keller', JSON.stringify(lists[0]))
      ok('popover lists everybody who can edit', lists[1].title === 'Personen, die bearbeiten können' && lists[1].names.length === 7 && lists[1].names.includes('Me Self (du)'), JSON.stringify(lists[1]))
      if (shots) await page.screenshot({ path: path.join(shots, `popover-${theme}.png`), clip: { x: 700, y: 0, width: 740, height: 260 } })
      await page.keyboard.press('Escape')
      ok('Escape closes the popover', (await popover.count()) === 0)
      await button.click()
      await popover.waitFor()
      await page.mouse.click(300, 600)
      ok('a click outside closes the popover', await until(async () => (await popover.count()) === 0, 'outside click', 3000).then(() => true, () => false))

      await feed({ editors, present: ['Me Self', 'Anna Meier', 'Ben', 'carla.keller', 'David Roth', 'Eva Frei', 'Felix'], self: 'Me Self' })
      await until(async () => (await avatars()).length === 5, 'overflow circle')
      const many = await avatars()
      ok('at most four avatars, then +N', JSON.stringify(many) === JSON.stringify(['AM', 'BE', 'CK', 'DR', '+2']), JSON.stringify(many))
      ok('announces joins politely', (await page.locator('.share-presence [role=status]').getAttribute('aria-live')) === 'polite' && /David Roth, Eva Frei, Felix bearbeitet jetzt mit/u.test(await page.locator('.share-presence [role=status]').innerText()), await page.locator('.share-presence [role=status]').innerText())
      await feed({ editors, present: ['Me Self', 'Anna Meier', 'Ben', 'carla.keller'], self: 'Me Self' })
      await until(async () => (await avatars()).length === 3, 'back to three')
    }
    if (shots) {
      await page.mouse.move(5, 5)
      await sleep(400)
      await page.screenshot({ path: path.join(shots, `window-${theme}.png`) })
      await page.screenshot({ path: path.join(shots, `tabs-${theme}.png`), clip: { x: 700, y: 0, width: 740, height: 60 } })
    }

    if (full) {
      // Nobody else present (only me): nothing is shown and the old bar does not come back.
      await feed({ editors, present: ['Me Self'], self: 'Me Self' })
      await until(async () => (await avatars()).length === 0, 'avatars gone')
      ok('nobody else present shows no avatars', (await page.locator('.share-presence-button').count()) === 0 && (await page.locator('.share-edit-presence').count()) === 0)
      await feed(null)
      ok('no share state shows nothing', (await page.locator('.share-presence-button').count()) === 0)
    }
  } catch (error) {
    ok(`${theme}: run finished`, false, `${error.stack}\n${app.output().slice(-600)}`)
  } finally {
    await stop(app, browser)
    profile.dispose()
  }
}

await run('light', true)
await run('dark', false)
console.log(`${failed() === 0 ? 'all passed' : `${failed()} failed`}`)
process.exit(failed() === 0 ? 0 : 1)
