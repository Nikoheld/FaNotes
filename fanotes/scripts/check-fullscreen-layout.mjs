// Toolbar fullscreen: the document must fill the window, no black slab, and leaving restores the layout.
// Root cause guarded here: App.tsx sets .app-body grid-template-columns inline (sidebar width or 0px); the fullscreen
// CSS rule lost against that inline value, so the workspace sat in the sidebar's column and 4/5 of the window stayed empty.
// Browser part loads the real styles.css with the same markup shape at several window sizes (skipped without chromium).
// Usage: node scripts/check-fullscreen-layout.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')

// Source guards.
const rule = css.match(/\.app-shell\.toolbar-fullscreen \.app-body \{([^}]*)\}/)
assert.ok(rule, 'fullscreen .app-body rule exists')
assert.match(rule[1], /grid-template-columns:[^;]*!important/, 'must beat the inline grid-template-columns from App.tsx')
const inline = app.match(/className="app-body" style=\{\{ gridTemplateColumns: (`[^`]*`) \}\}/)
assert.ok(inline, 'App.tsx still sets the app-body columns inline (update this check if that moved)')
assert.match(css, /\.app-shell\.toolbar-fullscreen \.app-body > :not\(\.workspace\) \{ display: none; \}/)
assert.match(app, /onFullscreenChange\?\.\(\(on\) => \{ if \(!on\) setToolbarFullscreen\(false\) \}\)/, 'OS exit (F11) leaves toolbar fullscreen')

// Browser part.
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('fullscreen-layout ok (browser part skipped: no chromium / playwright-core)')
} else {
  const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
  const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage()
    const html = (sidebarVisible) => `<!doctype html><html><head><style>html,body,#root{margin:0;height:100%}${css}</style></head><body><div id="root">
      <div class="app-shell theme-dark background-clean" style="--sidebar-width:300px">
        <nav class="ribbon"></nav>
        <div class="app-body" style="grid-template-columns:${sidebarVisible ? 'var(--sidebar-width)' : '0px'} minmax(420px, 1fr) auto">
          <aside class="sidebar ${sidebarVisible ? '' : 'is-hidden'}"></aside>
          <main class="workspace"><div class="ribbon-toolbar" style="height:40px"></div><div id="doc" style="min-height:0"></div></main>
          <aside class="inspector" style="width:240px"></aside>
        </div></div></div></body></html>`
    for (const [width, height] of [[1920, 1080], [1280, 720], [900, 700], [3840, 2160]]) {
      for (const sidebarVisible of [true, false]) {
        await page.setViewportSize({ width, height })
        await page.setContent(html(sidebarVisible))
        const measure = () => page.evaluate(() => {
          const r = document.querySelector('.workspace').getBoundingClientRect()
          return { left: r.left, width: r.width, shell: document.querySelector('.app-shell').getBoundingClientRect().width }
        })
        const before = await measure()
        await page.evaluate(() => document.querySelector('.app-shell').classList.add('toolbar-fullscreen'))
        const full = await measure()
        const tag = `${width}x${height} sidebar=${sidebarVisible}`
        assert.equal(full.left, 0, `${tag}: workspace starts at the left edge`)
        assert.ok(Math.abs(full.width - full.shell) <= 1, `${tag}: workspace fills the window (got ${full.width} of ${full.shell})`)
        await page.evaluate(() => document.querySelector('.app-shell').classList.remove('toolbar-fullscreen'))
        const after = await measure()
        assert.deepEqual(after, before, `${tag}: leaving fullscreen restores the layout`)
      }
    }
  } finally { await browser.close() }
  console.log('fullscreen-layout ok')
}
