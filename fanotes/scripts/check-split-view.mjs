// Split view (Geteilte Ansicht): pure layout rules plus a real Chromium run
// through open, divider (mouse, keyboard, double click), orientation, swap,
// focus routing, drop-on-edge, the same note requested in both panes and the
// layout surviving a reload. The browser part is skipped with
// FANOTES_SKIP_BROWSER=1 or when no Chromium / playwright-core exists.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
})
await server.listen()

try {
  // ---- Part 1: pure rules ------------------------------------------------
  const nav = await server.ssrLoadModule('/src/lib/workspaceNav.ts')
  const box = { left: 100, top: 50, width: 1000, height: 800 }
  assert.equal(nav.splitDropZone(box, { x: 120, y: 450 }), 'left')
  assert.equal(nav.splitDropZone(box, { x: 1090, y: 450 }), 'right')
  assert.equal(nav.splitDropZone(box, { x: 600, y: 60 }), 'top')
  assert.equal(nav.splitDropZone(box, { x: 600, y: 840 }), 'bottom')
  assert.equal(nav.splitDropZone(box, { x: 600, y: 450 }), null, 'the middle is not a split drop')
  assert.equal(nav.splitDropZone(box, { x: 20, y: 450 }), null, 'outside the editor is not a split drop')
  assert.equal(nav.splitDropZone({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 }), null)
  assert.deepEqual(nav.splitPlacementForZone('left'), { orientation: 'columns', first: true })
  assert.deepEqual(nav.splitPlacementForZone('right'), { orientation: 'columns', first: false })
  assert.deepEqual(nav.splitPlacementForZone('top'), { orientation: 'rows', first: true })
  assert.deepEqual(nav.splitPlacementForZone('bottom'), { orientation: 'rows', first: false })
  assert.equal(nav.splitFitZoom(1000), 1, 'a wide pane never zooms in')
  assert.equal(nav.splitFitZoom(553), 0.65)
  assert.equal(nav.splitFitZoom(100), 0.4, 'a tiny pane keeps readable text')
  assert.equal(nav.splitFitZoom(Number.NaN), 1)
  assert.equal(nav.clampSplitRatio(0), nav.SPLIT_MIN_RATIO)
  assert.equal(nav.clampSplitRatio(1), nav.SPLIT_MAX_RATIO)
  assert.equal(nav.nudgeSplitRatio(0.5, 1), 0.55)

  // ---- Part 2: source guards --------------------------------------------
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const drag = app.slice(app.indexOf('const beginSplitDrag'), app.indexOf('const splitDividerKey'))
  assert.ok(drag.includes('requestAnimationFrame'), 'the divider drag is throttled to one update per frame')
  const move = drag.slice(drag.indexOf('const move ='), drag.indexOf('const finish'))
  assert.ok(!move.includes('setSplitLayout'), 'a divider move must not re-render the app; the ratio is committed on release')

  // ---- Part 3: browser --------------------------------------------------
  const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
  const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
  if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
    console.log('split-view ok (browser part skipped: no chromium / playwright-core)')
  } else {
    const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
    const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'de-CH' })
    const page = await context.newPage()
    if (process.env.FANOTES_SPLIT_THROTTLE) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.FANOTES_SPLIT_THROTTLE) })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    const settle = (ms) => page.waitForTimeout(ms)
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?web`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.first-run-continue, button[aria-label="Neue Notiz"]', { timeout: 90_000 })
      for (let step = 0; step < 6 && await page.locator('.first-run-continue').count(); step += 1) {
        await page.locator('.first-run-continue').first().click()
        await settle(800)
      }
      const makeNote = async (word) => {
        await page.locator('button[aria-label="Neue Notiz"]').first().click()
        await page.waitForSelector('.cm-content', { timeout: 60_000 })
        await settle(500)
        await page.locator('.cm-content').first().click()
        await page.keyboard.press('Control+End')
        await page.keyboard.type(` ${word}`)
        await settle(700)
      }
      await makeNote('ALPHAWORD')
      await makeNote('BETAWORD')
      const texts = () => page.evaluate(() => [...document.querySelectorAll('.cm-content')].map((node) => node.textContent ?? ''))
      const state = () => page.evaluate(() => {
        const container = document.querySelector('.editor-split')
        const divider = document.querySelector('.split-divider')
        const pane = document.querySelector('.split-pane')
        const main = document.querySelector('.editor-split > .is-main-pane')
        return {
          split: Boolean(container?.classList.contains('is-split')),
          rows: Boolean(container?.classList.contains('is-rows')),
          focus: /focus-(main|split)/.exec(container?.className ?? '')?.[1] ?? '',
          ratio: Number(divider?.getAttribute('aria-valuenow')),
          mainW: Math.round(main?.getBoundingClientRect().width ?? 0),
          paneW: Math.round(pane?.getBoundingClientRect().width ?? 0),
          mainH: Math.round(main?.getBoundingClientRect().height ?? 0),
          paneH: Math.round(pane?.getBoundingClientRect().height ?? 0),
          paneTitle: pane?.querySelector('.split-pane-head strong')?.textContent ?? '',
        }
      })

      // Open: Ctrl+\ puts the most recent other note on the right.
      assert.equal((await state()).split, false)
      await page.keyboard.press('Control+\\')
      await page.waitForSelector('.editor-split.is-split .split-pane .cm-content', { timeout: 15_000 })
      await settle(800)
      let current = await state()
      assert.equal(current.split, true)
      let both = await texts()
      assert.ok(both[0].includes('BETAWORD') && both[1].includes('ALPHAWORD'), `main shows the active note, the pane the previous one: ${both.join(' | ')}`)
      assert.ok(Math.abs(current.mainW - current.paneW) <= 2, `starts at 50/50 (${current.mainW}/${current.paneW})`)
      assert.equal(current.focus, 'main')

      // The second pane opens at a zoom that shows its whole sheet (no clipped text).
      const clipped = await page.waitForFunction(() => {
        const scroller = document.querySelector('.split-pane .unified-note-view')
        const cm = scroller?.querySelector('.cm-content')
        return Boolean(cm && scroller && cm.getBoundingClientRect().left >= scroller.getBoundingClientRect().left - 1)
      }, null, { timeout: 5_000 }).then(() => false, () => true)
      const clipInfo = clipped ? await page.evaluate(() => {
        const scroller = document.querySelector('.split-pane .unified-note-view')
        const rect = (node) => node ? [Math.round(node.getBoundingClientRect().left), Math.round(node.getBoundingClientRect().width)] : null
        return JSON.stringify({ scroller: rect(scroller), paper: rect(scroller?.querySelector('.unified-paper')), cm: rect(scroller?.querySelector('.cm-content')), scrollLeft: scroller?.scrollLeft, dpr: devicePixelRatio })
      }) : ''
      assert.equal(clipped, false, `the second pane does not start with its text cut off at the left edge ${clipInfo}`)

      // Divider drag: one storage write, live track, clamped.
      await page.evaluate(() => {
        window.__splitWrites = 0
        const original = Storage.prototype.setItem
        Storage.prototype.setItem = function (key, value) { if (/split/i.test(key)) window.__splitWrites += 1; return original.call(this, key, value) }
      })
      const handle = await page.locator('.split-divider').boundingBox()
      const y = handle.y + 150
      await page.mouse.move(handle.x + 3, y)
      await page.mouse.down()
      for (let i = 1; i <= 30; i += 1) await page.mouse.move(handle.x + 3 + i * 5, y)
      const duringDrag = await page.evaluate(() => document.querySelector('.editor-split').classList.contains('is-resizing'))
      assert.equal(duringDrag, true, 'the container marks the drag so panes ignore the pointer')
      await page.mouse.up()
      await settle(300)
      current = await state()
      assert.ok(current.mainW > current.paneW + 100, `dragging right widens the first pane (${current.mainW}/${current.paneW})`)
      assert.equal(await page.evaluate(() => window.__splitWrites), 1, 'the layout is stored once per drag, not per pixel')
      await page.mouse.move(handle.x + 3 + 150, y)
      await page.mouse.down()
      await page.mouse.move(2, y, { steps: 6 })
      await page.mouse.up()
      await settle(300)
      current = await state()
      assert.equal(current.ratio, 20, 'the first pane stops at 20 %')
      assert.ok(current.mainW > 150, 'the collapsed pane keeps a usable width')

      // Double click resets; keyboard resizes.
      await page.locator('.split-divider').dblclick()
      await settle(200)
      assert.equal((await state()).ratio, 50)
      await page.locator('.split-divider').focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      assert.equal((await state()).ratio, 60)
      await page.keyboard.press('End')
      assert.equal((await state()).ratio, 80)
      await page.keyboard.press('Home')
      assert.equal((await state()).ratio, 20)
      await page.keyboard.press('Enter')
      assert.equal((await state()).ratio, 50)

      // Focus routing: typing and the toolbar act on the clicked pane.
      await page.locator('.split-pane .cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' RIGHTTYPED')
      await settle(300)
      current = await state()
      assert.equal(current.focus, 'split')
      both = await texts()
      assert.ok(both[1].includes('RIGHTTYPED') && !both[0].includes('RIGHTTYPED'), 'keystrokes land in the focused pane only')
      await page.keyboard.press('Control+Shift+\\')
      await settle(1200)
      both = await texts()
      assert.ok(both[0].includes('ALPHAWORD') && both[1].includes('BETAWORD'), `Ctrl+Shift+\\ swaps the panes: ${both.join(' | ')}`)
      assert.ok(both[0].includes('RIGHTTYPED'), 'the typed text moved with its note')
      await page.locator('.split-pane-head button[aria-label="Notizen tauschen"]').click()
      await settle(1200)
      both = await texts()
      assert.ok(both[0].includes('BETAWORD') && both[1].includes('ALPHAWORD'), 'the header button swaps back')

      // The same note cannot be shown twice: opening the pane's note from its tab swaps instead of duplicating,
      // so there is one buffer and no save conflict.
      const paneTitle = (await state()).paneTitle
      await page.locator('.note-tab').filter({ hasText: paneTitle }).first().click()
      await settle(1200)
      both = await texts()
      assert.equal(both.length, 2)
      assert.notEqual(both[0], both[1], 'one note never fills both panes')
      assert.ok(both[0].includes('ALPHAWORD') && both[1].includes('BETAWORD'), 'activating the other pane note swaps the panes')

      // Orientation toggle and persistence.
      await page.locator('.split-pane-head button[aria-label="Untereinander anordnen"]').click()
      await settle(500)
      current = await state()
      assert.equal(current.rows, true)
      assert.ok(Math.abs(current.mainH - current.paneH) <= 40, `rows are about equal (${current.mainH}/${current.paneH})`)
      await page.locator('.split-divider').focus()
      await page.keyboard.press('ArrowDown')
      assert.equal((await state()).ratio, 55, 'the vertical divider uses the up and down arrows')
      await settle(300)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.editor-split.is-split .split-pane .cm-content', { timeout: 60_000 })
      await settle(800)
      current = await state()
      assert.equal(current.split, true, 'the split survives a reload')
      assert.equal(current.rows, true, 'the orientation survives a reload')
      assert.equal(current.ratio, 55, 'the ratio survives a reload')
      both = await texts()
      assert.ok(both[0].includes('ALPHAWORD') && both[1].includes('BETAWORD'), 'both notes survive a reload')

      // Close: the editor goes back to one pane and focus resets.
      await page.locator('.split-pane-head button[aria-label="Teilung schließen"]').click()
      await settle(500)
      current = await state()
      assert.equal(current.split, false)
      assert.equal(await page.locator('.split-pane').count(), 0)

      // Drop on an edge: a tab dragged to the right opens beside the note; to the left it takes the main pane.
      const dropOn = (type, value, fx, fy) => page.evaluate(async ({ type, value, fx, fy }) => {
        const target = document.querySelector('.editor-split')
        const rect = target.getBoundingClientRect()
        const transfer = new DataTransfer()
        transfer.setData(type, value)
        const point = { clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy, bubbles: true, cancelable: true, dataTransfer: transfer }
        target.dispatchEvent(new DragEvent('dragenter', point))
        target.dispatchEvent(new DragEvent('dragover', point))
        await new Promise((resolve) => setTimeout(resolve, 120))
        const overlay = document.querySelector('.split-drop-overlay')?.className ?? ''
        target.dispatchEvent(new DragEvent('drop', point))
        return overlay
      }, { type, value, fx, fy })
      const paths = await page.evaluate(() => [...document.querySelectorAll('.note-tab:not(.active)')].map((tab) => tab.getAttribute('title') ?? ''))
      const alphaPath = paths.find((path) => /Unbenannte Notiz( 2)?\.md$/.test(path))
      assert.ok(alphaPath, `tab paths: ${paths.join(' | ')}`)
      const otherWord = (await texts())[0].includes('ALPHAWORD') ? 'BETAWORD' : 'ALPHAWORD'
      const before = await texts()
      const overlay = await dropOn('application/x-fanotes-tab', alphaPath, 0.97, 0.5)
      assert.match(overlay, /is-right/, 'dragging over the right edge shows the drop preview')
      await page.waitForSelector('.editor-split.is-split .split-pane .cm-content', { timeout: 10_000 })
      await settle(800)
      both = await texts()
      assert.notEqual(both[0], both[1])
      assert.equal(both[0], before[0], 'the main note stays on the left')
      assert.ok(both[1].includes(otherWord), 'the dropped note opens on the right')
      assert.equal((await state()).rows, false)
      await page.locator('.split-pane-head button[aria-label="Teilung schließen"]').click()
      await settle(400)
      const overlayTop = await dropOn('application/x-fanotes-tab', alphaPath, 0.5, 0.02)
      assert.match(overlayTop, /is-top/)
      await page.waitForSelector('.editor-split.is-split .split-pane .cm-content', { timeout: 10_000 })
      await settle(800)
      both = await texts()
      assert.ok(both[0].includes(otherWord) && both[1] === before[0], 'a top drop puts the note first and the former main note below')
      assert.equal((await state()).rows, true)
      // A drop in the middle opens nothing.
      await page.locator('.split-pane-head button[aria-label="Teilung schließen"]').click()
      await settle(300)
      await dropOn('application/x-fanotes-tab', alphaPath, 0.5, 0.5)
      await settle(300)
      assert.equal((await state()).split, false, 'a drop in the middle does not split')

      assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`)
      console.log('split-view ok')
    } finally {
      await browser.close()
    }
  }
} finally {
  await server.close()
}
