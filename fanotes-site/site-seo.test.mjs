import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const publicDir = join(root, 'public')
const ORIGIN = 'https://fanotes.fasrv.ch'
const read = (rel) => readFileSync(join(publicDir, rel), 'utf8')
const PAGES = [
  { file: 'index.html', url: `${ORIGIN}/` },
  { file: 'kantiplus/datenschutz/index.html', url: `${ORIGIN}/kantiplus/datenschutz/` },
  { file: 'kantiplus/konto-loeschen/index.html', url: `${ORIGIN}/kantiplus/konto-loeschen/` },
]
const meta = (html, attr, name) => {
  const m = new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"\\s*/?>`, 'u').exec(html)
  return m ? m[1] : null
}
const fileForUrl = (url) => {
  const path = new URL(url).pathname
  return join(publicDir, path.endsWith('/') ? `${path}index.html` : path)
}

test('public pages carry complete SEO metadata', () => {
  const titles = new Set()
  for (const { file, url } of PAGES) {
    const html = read(file)
    assert.match(html, /<html lang="de"/u, file)
    const title = /<title>([^<]+)<\/title>/u.exec(html)?.[1]
    assert.ok(title, `${file} title`)
    assert.ok(!titles.has(title), `${file} title is unique`)
    titles.add(title)
    const description = meta(html, 'name', 'description')
    assert.ok(description && description.length <= 160, `${file} description <= 160 (${description?.length})`)
    assert.equal(/<link rel="canonical" href="([^"]+)"/u.exec(html)?.[1], url, `${file} canonical`)
    for (const key of ['og:type', 'og:site_name', 'og:locale', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) {
      assert.ok(meta(html, 'property', key), `${file} ${key}`)
    }
    assert.equal(meta(html, 'property', 'og:locale'), 'de_CH')
    assert.equal(meta(html, 'property', 'og:url'), url)
    assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image')
    for (const key of ['twitter:title', 'twitter:description', 'twitter:image']) assert.ok(meta(html, 'name', key), `${file} ${key}`)
    for (const image of [meta(html, 'property', 'og:image'), meta(html, 'name', 'twitter:image')]) {
      assert.ok(image.startsWith(`${ORIGIN}/`), `${file} absolute image`)
      assert.ok(existsSync(fileForUrl(image)), `${file} image exists: ${image}`)
    }
    assert.match(html, /<link rel="icon" href="\/assets\/fanotes\.svg"/u)
    const touch = /<link rel="apple-touch-icon" href="([^"]+)"/u.exec(html)?.[1]
    assert.ok(touch && existsSync(join(publicDir, touch)), `${file} apple-touch-icon`)
    assert.match(html, /<meta name="theme-color"/u)
  }
})

test('JSON-LD parses and describes the right entities', () => {
  const blocks = (file) => [...read(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)].map((m) => JSON.parse(m[1]))
  const home = blocks('index.html').flatMap((b) => b['@graph'] ?? [b])
  const types = home.map((n) => n['@type'])
  assert.deepEqual(types.sort(), ['Organization', 'SoftwareApplication', 'WebSite'])
  const org = home.find((n) => n['@type'] === 'Organization')
  assert.equal(org.name, 'FaStudios')
  assert.ok(existsSync(fileForUrl(org.logo.url)))
  assert.equal(home.find((n) => n['@type'] === 'SoftwareApplication').offers.price, '0')
  for (const file of PAGES.slice(1).map((p) => p.file)) {
    const [page] = blocks(file)
    assert.equal(page['@type'], 'WebPage')
    assert.equal(page.about['@type'], 'MobileApplication')
    assert.equal(page.about.name, 'Kanti+')
    assert.equal(page.publisher.name, 'FaStudios')
  }
})

test('Google verification on the home page and as file', () => {
  assert.ok(read('index.html').includes('<meta name="google-site-verification" content="wbNqoq9CsvRbTZbf9dblrVZQEjikSt1OX1n1ggKXr10" />'))
  assert.equal(read('googlea9b10026681fc5e3.html'), 'google-site-verification: googlea9b10026681fc5e3.html\n')
})

test('private and utility pages are noindex', () => {
  for (const file of ['share/index.html', 'viewer/index.html', 'user/index.html', 'stats/index.html', '404.html']) {
    assert.match(read(file), /<meta name="robots" content="noindex[^"]*"\s*\/?>/u, file)
  }
})

test('sitemap.xml is well-formed and lists exactly the public pages', () => {
  const xml = read('sitemap.xml')
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'))
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/u)
  assert.ok(xml.trimEnd().endsWith('</urlset>'))
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((m) => m[1])
  assert.equal((xml.match(/<url>/gu) ?? []).length, entries.length)
  assert.deepEqual(entries.map((e) => /<loc>([^<]+)<\/loc>/u.exec(e)?.[1]), PAGES.map((p) => p.url))
  for (const entry of entries) {
    const loc = /<loc>([^<]+)<\/loc>/u.exec(entry)[1]
    assert.match(loc, /^https:\/\//u)
    assert.ok(existsSync(fileForUrl(loc)), loc)
    const lastmod = /<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/u.exec(entry)?.[1]
    assert.ok(lastmod && !Number.isNaN(Date.parse(lastmod)), `${loc} lastmod`)
  }
})

test('robots.txt blocks the API and points at the sitemap', () => {
  const robots = read('robots.txt')
  assert.match(robots, /^User-agent: \*$/mu)
  assert.match(robots, /^Disallow: \/api\/$/mu)
  assert.match(robots, /^Sitemap: https:\/\/fanotes\.fasrv\.ch\/sitemap\.xml$/mu)
})

test('server maps .xml and serves the HTML 404 to crawlers', () => {
  const server = readFileSync(join(root, 'server.mjs'), 'utf8')
  assert.ok(server.includes("['.xml', 'application/xml; charset=utf-8']"))
  assert.match(server, /import \{[^}]*\bjoin\b[^}]*\} from 'node:path'/u)
  assert.match(server, /accept === '\*\/\*'/u)
})

test('home page images declare dimensions and below-the-fold ones are lazy', () => {
  const html = read('index.html')
  const imgs = [...html.matchAll(/<img\b[^>]*>/gu)].map((m) => m[0])
  assert.ok(imgs.length > 0)
  for (const img of imgs) assert.match(img, /\bwidth="\d+"/u), assert.match(img, /\bheight="\d+"/u)
  for (const img of imgs.filter((i) => i.includes('/assets/screens/') && !i.includes('fetchpriority="high"'))) assert.match(img, /loading="lazy"/u)
})
