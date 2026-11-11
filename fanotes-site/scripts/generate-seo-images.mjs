// Renders the share images (Open Graph / Twitter) and the touch/logo icons for the public site.
// Usage: PLAYWRIGHT_BROWSERS_PATH=<dir> node scripts/generate-seo-images.mjs
// Needs playwright (from kanti-web/node_modules) and ImageMagick (`magick`) for PNG compression.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const site = resolve(here, '..')
const pub = join(site, 'public')
const require = createRequire(join(site, 'kanti-web', 'package.json'))
const { chromium } = require('playwright')

const fanotesSvg = readFileSync(join(pub, 'assets/fanotes.svg'), 'utf8')
const kantiSvg = readFileSync(join(site, 'kanti-web/public/kanti-icon.svg'), 'utf8')
const fileUrl = (path) => pathToFileURL(join(pub, path)).href
const dataSvg = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

const fonts = `
@font-face{font-family:'Newsreader';src:url('${fileUrl('assets/fonts/newsreader-latin-wght.v5-3-0.woff2')}');font-weight:200 800}
@font-face{font-family:'Atkinson';src:url('${fileUrl('assets/fonts/atkinson-hyperlegible-next-latin-wght.v5-3-0.woff2')}');font-weight:200 800}`

const card = ({ icon, kicker, title, lines, screen }) => `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;background:#f7f5f0;color:#1b1f27;font-family:'Atkinson',system-ui,sans-serif;position:relative;
 background-image:radial-gradient(rgb(27 31 39/.11) 1.5px,transparent 1.6px);background-size:28px 28px}
.copy{position:absolute;left:72px;top:64px;width:${screen ? 560 : 1000}px}
.brand{display:flex;align-items:center;gap:18px;font-family:'Newsreader',Georgia,serif;font-size:40px;font-weight:600}
.brand img{width:64px;height:64px;border-radius:16px}
.kicker{margin-top:56px;font-size:24px;font-weight:600;color:#1a6690;letter-spacing:.02em}
h1{margin-top:14px;font-family:'Newsreader',Georgia,serif;font-weight:500;font-size:${screen ? 66 : 76}px;line-height:1.06;letter-spacing:-.01em}
h1 em{font-style:normal;background:linear-gradient(transparent 62%,rgb(245 219 92/.55) 62%)}
p{margin-top:26px;font-size:28px;line-height:1.38;color:#3f444f}
.slip{position:absolute;right:-60px;top:112px;width:640px;border-radius:14px;overflow:hidden;background:#fffefb;
 box-shadow:0 1px 2px rgb(27 31 39/.06),0 24px 48px -18px rgb(27 31 39/.35);border:1px solid #e2ddd1;transform:rotate(1.2deg)}
.slip img{display:block;width:100%}
.url{position:absolute;left:72px;bottom:44px;font-size:24px;color:#5c616b}
</style></head><body>
<div class="copy"><div class="brand"><img src="${dataSvg(icon)}" alt="">${title}</div>
<div class="kicker">${kicker}</div>
<h1>${lines}</h1></div>
${screen ? `<div class="slip"><img src="${fileUrl(screen)}" alt=""></div>` : ''}
<div class="url">fanotes.fasrv.ch</div>
</body></html>`

const squareFanotes = fanotesSvg.replace('<rect width="512" height="512" rx="116"', '<rect width="512" height="512" rx="0"')

const jobs = [
  {
    out: 'assets/og/fanotes-og.png', w: 1200, h: 630,
    html: card({
      icon: fanotesSvg, title: 'FaNotes', kicker: 'Notizen für Tastatur und Stift',
      lines: 'Tippen und von Hand schreiben. <em>Auf derselben Seite.</em>',
      screen: 'assets/screens/note-pen.17a30351.1200.webp',
    }),
  },
  {
    out: 'assets/og/kantiplus-og.png', w: 1200, h: 630,
    html: card({
      icon: kantiSvg, title: 'Kanti+', kicker: 'Android-App für den Schulalltag',
      lines: 'Stundenplan, Noten und Prüfungen <em>auf dem Telefon.</em>',
    }),
  },
  { out: 'assets/fanotes-logo-512.png', w: 512, h: 512, html: iconPage(fanotesSvg, 512) },
  { out: 'assets/apple-touch-icon.png', w: 180, h: 180, html: iconPage(squareFanotes, 180), opaque: true },
]

function iconPage(svg, size) {
  return `<!doctype html><html><body style="margin:0;background:transparent"><img src="${dataSvg(svg)}" width="${size}" height="${size}" style="display:block"></body></html>`
}

const dir = mkdtempSync(join(tmpdir(), 'fanotes-seo-'))
const browser = await chromium.launch()
try {
  for (const [index, job] of jobs.entries()) {
    const htmlPath = join(dir, `${index}.html`)
    writeFileSync(htmlPath, job.html)
    const page = await browser.newPage({ viewport: { width: job.w, height: job.h } })
    await page.goto(pathToFileURL(htmlPath).href)
    await page.evaluate(() => document.fonts.ready)
    const target = join(pub, job.out)
    await page.screenshot({ path: target, omitBackground: !job.opaque && job.w === 512 })
    await page.close()
    // Quantize to keep share images small; flat brand art survives 128 colours well.
    execFileSync('magick', [target, '-strip', '-colors', job.w === 1200 ? '160' : '256', '-define', 'png:compression-level=9', target])
    console.log(`${job.out} ${job.w}x${job.h} ${statSync(target).size} bytes`)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
