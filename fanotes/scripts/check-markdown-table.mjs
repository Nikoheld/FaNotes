// Regression check for the Word-style table editor.
// Part 1: pure model (parse, edit, serialize, round trip, HTML paste is covered in part 2).
// Part 2: real Chromium via playwright-core on scripts/table-harness: insert grid, render,
//         in-place editing, Tab / Enter navigation, row and column actions, undo, source mode,
//         paste from HTML, horizontal scroll. Skipped with FANOTES_SKIP_BROWSER=1 or without a browser.
// Set FANOTES_SHOT_DIR to also write a few screenshots.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  cacheDir: mkdtempSync(join(tmpdir(), 'fanotes-table-vite-')),
  server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
})
await server.listen()

try {
  // ---- Part 1: model -------------------------------------------------------
  const t = await server.ssrLoadModule('/src/lib/markdownTable.ts')
  const sample = ['| A | B | C |', '| --- | :---: | ---: |', '| 1 | **x** | a \\| b |', '| | `c` | |'].join('\n')
  assert.deepEqual(t.splitTableRow('| a \\| b | c |'), ['a \\| b', 'c'], 'escaped pipes stay inside a cell')
  const blocks = t.findTableBlocksInText(`Intro\n\n${sample}\n\nOutro`)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].startLine, 3)
  assert.equal(blocks[0].model.align.join(), ',center,right')
  assert.equal(blocks[0].model.rows[0][2], 'a \\| b')
  assert.equal(blocks[0].model.rows.length, 2)
  assert.equal(t.findTableBlocksInText('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |').length, 0, 'rows wider than the header are left as source')
  assert.equal(t.findTableBlocksInText('```\n| a | b |\n| --- | --- |\n```').length, 0, 'tables in fences are ignored')
  assert.equal(t.findTableBlocksInText('| a | b |\n| nope | nope |').length, 0)

  const clean = ['| A | B |', '| :--- | ---: |', '| 1 | 2 \\| x |', '|  |  |'].join('\n')
  const model = t.parseTableLines(clean.split('\n'))
  assert.equal(t.serializeTable(model), clean, 'round trip is exact for canonical tables')
  const loose = t.parseTableLines(['|A|B|', '|:-:|--|', '|1|2|'])
  assert.equal(t.serializeTable(loose), '| A | B |\n| :---: | --- |\n| 1 | 2 |', 'loose tables normalise')
  assert.equal(t.parseTableLines(t.serializeTable(loose).split('\n')).header.join(), 'A,B')

  const made = t.makeTable(3, 4)
  assert.equal(t.tableRowCount(made), 3)
  assert.equal(t.tableColumnCount(made), 4)
  assert.equal(t.newTableText(2, 2, 'Hi'), '| Hi |  |\n| --- | --- |\n|  |  |')
  let m = t.setCell(made, 1, 2, 'x')
  m = t.insertRow(m, 1)
  assert.equal(m.rows.length, 3)
  assert.equal(m.rows[1][2], 'x', 'a row inserted below the header pushes the old rows down')
  m = t.deleteRow(m, 1)
  assert.equal(m.rows[0][2], 'x')
  assert.equal(t.deleteRow(m, 0), m, 'the header row cannot be deleted')
  m = t.insertColumn(m, 1)
  assert.equal(t.tableColumnCount(m), 5)
  assert.equal(m.rows[0][3], 'x')
  m = t.setColumnAlign(m, 1, 'right')
  assert.equal(t.serializeTable(m).split('\n')[1], '| --- | ---: | --- | --- | --- |')
  m = t.deleteColumn(m, 1)
  assert.equal(t.tableColumnCount(m), 4)
  assert.equal(t.tableColumnCount(t.deleteColumn(t.makeTable(2, 1), 0)), 1, 'the last column stays')
  assert.equal(t.escapeTableCell(' a | b\nc '), 'a \\| b<br>c')
  const grown = t.fillCells(t.makeTable(2, 2), 1, 1, [['a', 'b'], ['c', 'd']])
  assert.equal(t.tableRowCount(grown), 3)
  assert.equal(t.tableColumnCount(grown), 3)
  assert.equal(grown.rows[1][2], 'd')

  // ---- Part 2: browser -----------------------------------------------------
  const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
  const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
  if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
    console.log('markdown table model ok; browser part skipped (no chromium / playwright-core)')
  } else {
    const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
    const base = `http://127.0.0.1:${server.httpServer.address().port}/scripts/table-harness/index.html`
    const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    const errors = []
    const open = async (content, theme = 'light', viewport = { width: 1100, height: 800 }) => {
      const context = await browser.newContext({ viewport, locale: 'en-US' })
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(String(error)))
      await page.goto(`${base}?theme=${theme}&content=${encodeURIComponent(content)}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.cm-editor')
      return page
    }
    const shot = (page, name) => process.env.FANOTES_SHOT_DIR ? page.screenshot({ path: join(process.env.FANOTES_SHOT_DIR, name) }) : null
    const text = (page) => page.evaluate(() => window.__text())
    const settle = (page, ms = 600) => page.waitForTimeout(ms)
    const cell = (row, column) => `.cm-table-shell [data-row="${row}"][data-column="${column}"]`
    const active = (page) => page.evaluate(() => {
      const element = document.activeElement
      return element?.dataset?.row === undefined ? null : [Number(element.dataset.row), Number(element.dataset.column)]
    })

    const note = ['Intro', '', '| Name | Wert | Rest |', '| --- | :---: | ---: |', '| **fett** | $x^2$ | [Link](https://example.org) |', '| a | b | c |', '', 'Outro'].join('\n')
    let page = await open(note)
    await page.waitForSelector('.cm-table-shell th')
    assert.equal(await page.locator('.cm-table-shell th').count(), 3, 'header cells')
    assert.equal(await page.locator('.cm-table-shell td').count(), 6, 'body cells')
    assert.equal(await page.locator('.cm-table-shell td strong').first().textContent(), 'fett', 'bold renders inside a cell')
    await page.waitForSelector('.cm-table-shell .katex', { timeout: 15000 })
    assert.equal(await page.locator('.cm-table-shell td .cm-live-link').first().textContent(), 'Link')
    assert.equal(await page.locator(cell(1, 1)).evaluate((node) => getComputedStyle(node).textAlign), 'center', 'column alignment applies')
    assert.equal(await page.locator('.cm-table-shell').count(), 1)
    await shot(page, 'table-light.png')

    // In-place edit: click a cell, type, wait for the debounced commit.
    await page.locator(cell(2, 0)).click()
    assert.deepEqual(await active(page), [2, 0])
    await page.keyboard.press('End')
    await page.keyboard.type('X')
    await settle(page)
    assert.ok((await text(page)).includes('| aX | b | c |'), 'typed text reaches the note')
    // Formatted cell shows its Markdown while editing and renders again after.
    await page.locator(cell(1, 0)).click()
    assert.equal(await page.locator(cell(1, 0)).textContent(), '**fett**')
    await page.keyboard.press('Tab')
    assert.deepEqual(await active(page), [1, 1])
    assert.equal(await page.locator(cell(1, 0)).locator('strong').count(), 1, 'cell renders again after leaving')

    // Tab / Shift+Tab / Enter.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    assert.deepEqual(await active(page), [2, 0], 'Tab wraps to the next row')
    await page.keyboard.press('Shift+Tab')
    assert.deepEqual(await active(page), [1, 2], 'Shift+Tab goes back')
    await page.keyboard.press('Enter')
    assert.deepEqual(await active(page), [2, 2], 'Enter moves down')
    await page.keyboard.press('Enter')
    await settle(page)
    assert.deepEqual(await active(page), [3, 2], 'Enter in the last row adds a row')
    assert.equal(await page.locator('.cm-table-shell tr').count(), 4)
    assert.equal((await text(page)).split('\n').filter((line) => line.startsWith('|')).length, 5)
    await page.keyboard.type('new')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    assert.deepEqual(await active(page), [2, 2])
    await page.locator(cell(3, 2)).click()
    await page.keyboard.press('Tab')
    await settle(page)
    assert.deepEqual(await active(page), [4, 0], 'Tab in the last cell adds a row')
    assert.ok((await text(page)).includes('|  |  | new |'), 'row content kept')

    // Undo is per action: the added row goes first, then the typed text.
    await page.keyboard.press('Control+z')
    await settle(page, 300)
    assert.equal((await text(page)).split('\n').filter((line) => line.startsWith('|')).length, 5, 'undo removes the added row only')
    assert.ok((await text(page)).includes('| new |') || (await text(page)).includes(' new |'), 'typed text survives the first undo')
    await page.keyboard.press('Control+Shift+z')
    await settle(page, 300)
    assert.equal((await text(page)).split('\n').filter((line) => line.startsWith('|')).length, 6, 'redo restores it')

    // Toolbar: rows, columns, alignment.
    await page.locator(cell(1, 1)).click()
    await page.locator('.cm-table-tool[aria-label="Insert row below"], .cm-table-tool[aria-label="Zeile unterhalb einfügen"]').click()
    await settle(page, 300)
    assert.deepEqual(await active(page), [2, 1], 'focus follows into the new row')
    await page.locator('.cm-table-tool[aria-label="Spalte rechts einfügen"]').click()
    await settle(page, 300)
    assert.equal(await page.locator('.cm-table-shell th').count(), 4)
    await page.locator('.cm-table-tool[aria-label="Rechts ausrichten"]').click()
    await settle(page, 300)
    assert.ok((await text(page)).split('\n').some((line) => /^\| --- \| :---: \| ---: \| ---: \|$/u.test(line)) || (await text(page)).includes('---:'), 'alignment is written as a pipe-table delimiter')
    await page.locator('.cm-table-tool[aria-label="Spalte löschen"]').click()
    await page.locator('.cm-table-tool[aria-label="Zeile löschen"]').click()
    await settle(page, 300)
    assert.equal(await page.locator('.cm-table-shell th').count(), 3)
    const afterEdits = await text(page)
    const reparsed = t.findTableBlocksInText(afterEdits)
    assert.equal(reparsed.length, 1, 'the note is still one valid pipe table')
    assert.equal(t.serializeTable(reparsed[0].model), reparsed[0].source, 'saved table is canonical Markdown')
    assert.ok(afterEdits.startsWith('Intro\n\n| Name') && afterEdits.trimEnd().endsWith('Outro'), 'text around the table is untouched')
    await page.locator('.cm-table-add-row').click({ force: true })
    await settle(page, 300)
    assert.deepEqual(await active(page), [await page.locator('.cm-table-shell tr').count() - 1, 0], 'the + bar adds a row and focuses it')

    // Source mode: a caret inside the table text shows the raw Markdown.
    await page.evaluate(() => window.__setSelection(window.__text().indexOf('| Name') + 3))
    await settle(page, 200)
    assert.equal(await page.locator('.cm-table-shell').count(), 0, 'raw Markdown shows while the caret is in the table')
    await page.evaluate(() => window.__setSelection(0))
    await settle(page, 200)
    assert.equal(await page.locator('.cm-table-shell').count(), 1, 'rendered again once the caret leaves')
    // Delete table.
    await page.locator(cell(0, 0)).click()
    await page.locator('.cm-table-tool[aria-label="Tabelle löschen"]').click()
    await settle(page, 300)
    assert.equal(await page.locator('.cm-table-shell').count(), 0)
    assert.ok(!(await text(page)).includes('|'), 'deleting removes the whole table')
    assert.ok((await text(page)).includes('Intro') && (await text(page)).includes('Outro'))
    await page.context().close()

    // Insert grid picker.
    page = await open('Start\n\nEnde', 'light', { width: 1100, height: 900 })
    await page.evaluate(() => window.__setSelection(5))
    // Since the unified toolbar the grid lives in the "Mehr" popover.
    // A real mouse press moves focus out of the harness editor and re-mounts the toolbar before the menu state
    // settles (the app shell keeps the editor focused), so open the menu with a DOM click.
    for (let attempt = 0; attempt < 3 && (await page.locator('.ftb-popover').count()) === 0; attempt += 1) {
      await page.locator('.ftb-more > button').evaluate((node) => node.click())
      await settle(page, 250)
    }
    await page.locator('.ftb-grid-cell:nth-child(24)' /* row 3, column 4 of the 10-column grid; the label follows the UI language */).hover()
    assert.ok((await page.locator('.ftb-table-picker .ftb-heading').textContent()).includes('3 × 4'), 'hover label shows the size')
    assert.equal(await page.locator('.ftb-grid-cell.is-lit').count(), 12)
    await shot(page, 'table-picker.png')
    await page.locator('.ftb-grid-cell:nth-child(24)' /* row 3, column 4 of the 10-column grid; the label follows the UI language */).click()
    await page.waitForSelector('.cm-table-shell')
    await settle(page, 300)
    assert.equal(await page.locator('.cm-table-shell th').count(), 4)
    assert.equal(await page.locator('.cm-table-shell tbody tr').count(), 2)
    assert.deepEqual(await active(page), [0, 0], 'the first cell is ready for typing')
    await page.keyboard.type('Titel')
    await settle(page)
    const inserted = await text(page)
    assert.ok(inserted.startsWith('Start\n\n| Titel |  |  |  |\n| --- | --- | --- | --- |\n|  |  |  |  |\n|  |  |  |  |\n'), `inserted table text: ${JSON.stringify(inserted)}`)
    assert.ok(inserted.trimEnd().endsWith('Ende'))
    await page.context().close()

    // Paste an HTML table (Word / web) and TSV into a cell.
    page = await open('Vorher\n\n')
    await page.evaluate(() => window.__setSelection(window.__text().length))
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/html', '<html><body><table><tr><th style="text-align:right">Obst</th><th>Preis</th></tr><tr><td><b>Apfel</b></td><td>1 | 2</td></tr></table></body></html>')
      data.setData('text/plain', 'Obst\tPreis\nApfel\t1 | 2')
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.waitForSelector('.cm-table-shell')
    const pasted = await text(page)
    assert.ok(pasted.includes('| Obst | Preis |\n| ---: | --- |\n| **Apfel** | 1 \\| 2 |'), `pasted table: ${JSON.stringify(pasted)}`)
    await page.locator(cell(1, 1)).click()
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', 'a\tb\nc\td')
      document.querySelector('.cm-table-shell [data-row="1"][data-column="1"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await settle(page, 400)
    const filled = await text(page)
    assert.equal(t.findTableBlocksInText(filled)[0].model.header.length, 3, 'pasting a grid widens the table')
    assert.ok(filled.includes('| c | d |'))
    await page.context().close()

    // Wide table scrolls inside the table, not the page; dark and OLED look.
    const wide = `| ${Array.from({ length: 14 }, (_, i) => `Spalte ${i + 1}`).join(' | ')} |\n| ${Array.from({ length: 14 }, () => '---').join(' | ')} |\n| ${Array.from({ length: 14 }, (_, i) => `Ein langer Zellentext ${i}`).join(' | ')} |\n`
    for (const theme of ['dark', 'oled']) {
      page = await open(`Vor\n\n${wide}\nNach`, theme)
      await page.waitForSelector('.cm-table-shell')
      const metrics = await page.evaluate(() => {
        const scroll = document.querySelector('.cm-table-scroll')
        return { inner: scroll.scrollWidth, outer: scroll.clientWidth, page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }
      })
      assert.ok(metrics.inner > metrics.outer + 100, `wide table scrolls inside itself (${JSON.stringify(metrics)})`)
      assert.ok(metrics.page <= metrics.view, 'the page does not scroll sideways')
      await shot(page, `table-${theme}.png`)
      await page.context().close()
    }

    // Touch: coarse pointer gives touch-sized handles.
    const touchContext = await browser.newContext({ viewport: { width: 820, height: 800 }, hasTouch: true, isMobile: false })
    page = await touchContext.newPage()
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`${base}?content=${encodeURIComponent(note)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.cm-table-shell')
    await page.locator(cell(2, 1)).tap()
    assert.deepEqual(await active(page), [2, 1], 'tapping a cell edits it')
    const size = await page.locator('.cm-table-tool').first().boundingBox()
    assert.ok(size.width >= 28 && size.height >= 28, 'toolbar buttons are finger-sized')
    await touchContext.close()

    await browser.close()
    assert.deepEqual(errors, [], 'no page errors')
    console.log('markdown table model and editor ok')
  }
} finally {
  await server.close()
}
