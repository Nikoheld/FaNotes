// The folder tree's collapse/expand-all button sits in the sidebar search row as a small icon button, so the tree starts
// right below the search bar. Browser part uses the real styles.css at several sidebar widths and themes (skipped without chromium).
// Usage: node scripts/check-sidebar-fold-button.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')
const app = read('src/App.tsx')
const tree = read('src/components/FileTree.tsx')
const css = read('src/styles.css')

assert.match(app, /<div className="sidebar-search"[\s\S]*?<span className="sidebar-fold-slot" ref=\{setFoldSlot\} \/>\s*<\/div>/, 'slot lives inside the search row')
assert.match(app, /foldSlot=\{foldSlot\}/)
assert.match(tree, /createPortal\(foldButton, foldSlot\)/)
assert.match(tree, /foldSlot \? null : <span>\{foldLabel\}<\/span>/, 'icon only in the search row')
assert.match(tree, /aria-label=\{foldLabel\}/)

const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('sidebar-fold-button ok (browser part skipped: no chromium / playwright-core)')
} else {
  const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
  const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    for (const theme of ['dark', 'light', 'oled']) {
      for (const sidebarWidth of [180, 220, 300, 420]) {
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="app-shell theme-${theme} background-clean" style="--sidebar-width:${sidebarWidth}px">
          <div class="app-body" style="grid-template-columns:${sidebarWidth}px minmax(420px,1fr) auto"><aside class="sidebar">
            <div class="sidebar-search" role="search"><svg width="14" height="14"></svg><input placeholder="Suchen" aria-label="s"><span class="sidebar-fold-slot"><button type="button" class="file-tree__fold-button is-compact" aria-label="Alle Ordner einklappen"><svg width="14" height="14"></svg></button></span></div>
            <div class="file-tree-wrap"><section class="file-tree"><ul class="file-tree__root"><li>Folder</li></ul></section></div>
          </aside><main class="workspace"></main></div></div></body></html>`)
        const m = await page.evaluate(() => {
          const rect = (selector) => document.querySelector(selector).getBoundingClientRect()
          const search = rect('.sidebar-search'); const button = rect('.file-tree__fold-button'); const input = rect('.sidebar-search input'); const wrap = rect('.file-tree-wrap')
          return { searchBottom: search.bottom, searchRight: search.right, searchLeft: search.left, buttonRight: button.right, buttonW: button.width, buttonH: button.height, buttonTop: button.top, buttonBottom: button.bottom, searchTop: search.top, inputW: input.width, wrapTop: wrap.top }
        })
        const tag = `${theme} ${sidebarWidth}px`
        assert.ok(m.buttonRight <= m.searchRight + 0.5 && m.buttonTop >= m.searchTop && m.buttonBottom <= m.searchBottom, `${tag}: button inside the search row`)
        assert.ok(m.buttonW <= 24 && m.buttonH <= 24, `${tag}: small icon button`)
        assert.ok(m.inputW >= 60, `${tag}: search input keeps room (${m.inputW})`)
        assert.ok(m.wrapTop - m.searchBottom <= 12, `${tag}: tree starts right below the search bar (gap ${m.wrapTop - m.searchBottom})`)
      }
    }
  } finally { await browser.close() }
  console.log('sidebar-fold-button ok')
}
