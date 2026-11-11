// Renders the share card (public/og-kanti.png, 1200x630) and the touch icons from the brand icon.
// Needs the demo screenshots from capture-screenshots.mjs. Usage: node scripts/generate-share-images.mjs
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const root = new URL('..', import.meta.url).pathname
const pub = join(root, 'public')
const work = mkdtempSync(join(tmpdir(), 'kanti-og-'))
copyFileSync(join(root, 'scripts/og-card.html'), join(work, 'card.html'))
copyFileSync(join(pub, 'kanti-icon.svg'), join(work, 'icon.svg'))
for (const name of ['heute', 'noten']) copyFileSync(join(pub, `about/img/${name}.webp`), join(work, `${name}.webp`))
const iconSvg = readFileSync(join(pub, 'kanti-icon.svg'), 'utf8')

const browser = await chromium.launch()
try {
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await card.goto(`file://${join(work, 'card.html')}`)
  await card.waitForLoadState('load')
  const raw = join(work, 'og.png')
  await card.screenshot({ path: raw })
  // 8-bit palette PNG keeps the card small.
  execFileSync('magick', [raw, '-strip', '-dither', 'None', '-colors', '256', '-define', 'png:compression-level=9', `PNG8:${join(pub, 'og-kanti.png')}`])
  for (const size of [180, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(`<body style="margin:0">${iconSvg.replace(/width="108" height="108"/, `width="${size}" height="${size}"`)}</body>`)
    await page.screenshot({ path: join(pub, size === 180 ? 'apple-touch-icon.png' : 'kanti-icon-512.png') })
  }
} finally {
  await browser.close()
}
for (const f of ['og-kanti.png', 'apple-touch-icon.png', 'kanti-icon-512.png']) console.log(f, statSync(join(pub, f)).size)
