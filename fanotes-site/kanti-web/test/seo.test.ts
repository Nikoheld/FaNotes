import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const index = read('index.html')
const about = read('public/about/index.html')
const notFound = read('public/404.html')

const meta = (html: string, attr: 'name' | 'property', key: string): string | null => {
  const tag = [...html.matchAll(/<meta\s+[^>]*>/gu)].map((m) => m[0]).find((t) => t.includes(`${attr}="${key}"`))
  return tag?.match(/content="([^"]*)"/u)?.[1] ?? null
}
const title = (html: string) => html.match(/<title>([^<]*)<\/title>/u)?.[1] ?? ''
const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]*)"/u)?.[1] ?? ''
const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)].map((m) => JSON.parse(m[1]))
const text = (fragment: string) => fragment.replace(/<[^>]+>/gu, '').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&#x27;/gu, "'").replace(/\s+/gu, ' ').trim()

const pages: [string, string, string][] = [['index.html', index, 'https://schulnetz.fasrv.ch/'], ['about', about, 'https://schulnetz.fasrv.ch/about/']]

describe('head metadata', () => {
  it('the SPA shell carries the exact Search Console verification', () => {
    expect(meta(index, 'name', 'google-site-verification')).toBe('wbNqoq9CsvRbTZbf9dblrVZQEjikSt1OX1n1ggKXr10')
  })
  it.each(pages)('%s: title, description, canonical, Open Graph and Twitter', (_name, html, url) => {
    expect(title(html).length).toBeGreaterThan(10)
    expect(title(html).length).toBeLessThanOrEqual(60)
    expect(meta(html, 'name', 'description')!.length).toBeGreaterThan(50)
    expect(meta(html, 'name', 'description')!.length).toBeLessThanOrEqual(175)
    expect(canonical(html)).toBe(url)
    expect(meta(html, 'property', 'og:type')).toBe('website')
    expect(meta(html, 'property', 'og:site_name')).toBe('Kanti+')
    expect(meta(html, 'property', 'og:locale')).toBe('de_CH')
    expect(meta(html, 'property', 'og:url')).toBe(url)
    expect(meta(html, 'property', 'og:title')).toBeTruthy()
    expect(meta(html, 'property', 'og:description')).toBeTruthy()
    expect(meta(html, 'property', 'og:image')).toBe('https://schulnetz.fasrv.ch/og-kanti.png')
    expect(meta(html, 'property', 'og:image:width')).toBe('1200')
    expect(meta(html, 'property', 'og:image:height')).toBe('630')
    expect(meta(html, 'name', 'twitter:card')).toBe('summary_large_image')
    expect(meta(html, 'name', 'twitter:image')).toMatch(/^https:\/\//u)
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"')
    expect(html).not.toContain('hreflang')
  })
  it('titles differ between the two pages', () => {
    expect(title(index)).not.toBe(title(about))
    expect(meta(index, 'name', 'description')).not.toBe(meta(about, 'name', 'description'))
  })
  it('JSON-LD blocks are valid JSON with absolute https URLs', () => {
    for (const [, html] of pages) {
      const blocks = jsonLd(html)
      expect(blocks.length).toBeGreaterThan(0)
      for (const url of JSON.stringify(blocks).match(/"https?:\/\/[^"]+"/gu) ?? []) expect(url).toMatch(/^"https:\/\//u)
    }
    const graph = jsonLd(about)[0]['@graph']
    const types = graph.map((node: { '@type': string }) => node['@type'])
    expect(types).toEqual(expect.arrayContaining(['MobileApplication', 'Organization', 'WebSite']))
    const app = graph.find((node: { '@type': string }) => node['@type'] === 'MobileApplication')
    expect(app.offers.price).toBe('0')
    expect(app.operatingSystem).toBe('Android, Web')
  })
})

describe('intro in the SPA shell', () => {
  it('is static, crawlable and links to the landing page and the demo', () => {
    const root = index.match(/<div id="root">([\s\S]*?)<\/div>\s*<noscript>/u)?.[1] ?? ''
    expect(root).toContain('<h1>Kanti+</h1>')
    expect(root).toContain('href="/about/"')
    expect(root).toContain('href="/?demo"')
    expect(index).toContain('<link rel="stylesheet" href="/intro.css" />')
    expect(index).toMatch(/<noscript>[^]*href="\/about\/"[^]*<\/noscript>/u)
    expect(index).not.toMatch(/\sstyle="/u)
  })
  it('the intro CSS is scoped to .kp-intro', () => {
    const css = read('public/intro.css').replace(/\/\*[\s\S]*?\*\//gu, '')
    const selectors = css.split('}').map((rule) => rule.split('{')[0].trim()).filter((s) => s && !s.startsWith('@'))
    for (const selector of selectors) expect(selector).toMatch(/^\.kp-intro/u)
  })
})

describe('/about/ landing page', () => {
  it('has the landing text in the raw HTML', () => {
    expect(about).toContain('<html lang="de">')
    expect(about.match(/<h1[\s>]/gu)).toHaveLength(1)
    for (const feature of ['Stundenplan', 'Noten-Push', 'Prüfungen', 'Absenzen', 'Pendeln', 'Widgets', 'Mensa', 'Kanti+ im Browser']) expect(about).toContain(`<h3>${feature}`)
    expect(about).toContain('Kanti+ für Android ist in der Testphase und noch nicht im Play Store.')
    expect(about).not.toMatch(/play\.google\.com/u)
    expect(about).toContain('<a class="btn btn-primary" href="/">')
    expect(about).toContain('href="/?demo"')
    expect(about).toContain('href="https://fanotes.fasrv.ch/kantiplus/datenschutz/"')
    expect(about).toContain('href="https://fanotes.fasrv.ch/kantiplus/konto-loeschen/"')
    expect(about).toContain('href="https://fanotes.fasrv.ch/kantiplus/datenschutz/#verantwortlich"')
    expect(about).toContain('Kanti+ ist ein Projekt von FaStudios.')
    expect(about).toContain('Kanti+ ist eine inoffizielle App.')
  })
  it('uses no inline style or script apart from JSON-LD, and no foreign hosts for assets', () => {
    expect(about).not.toMatch(/<style[\s>]/u)
    expect(about).not.toMatch(/\sstyle="/u)
    expect(about).not.toMatch(/\son[a-z]+="/u)
    for (const tag of about.match(/<script[^>]*>/gu) ?? []) expect(tag).toBe('<script type="application/ld+json">')
    expect(about).not.toMatch(/<(?:link|img|script)[^>]+(?:src|href)="https?:\/\/(?!schulnetz\.fasrv\.ch)[^"]*\.(?:css|js|png|webp|woff2?)"/u)
    expect(read('public/about/about.css')).not.toMatch(/url\(\s*['"]?https?:/u)
  })
  it('every image has width, height and alt', () => {
    const images = about.match(/<img\s[^>]*>/gu) ?? []
    expect(images.length).toBeGreaterThanOrEqual(7)
    for (const image of images) {
      expect(image).toMatch(/\swidth="\d+"/u)
      expect(image).toMatch(/\sheight="\d+"/u)
      expect(image).toMatch(/\salt="/u)
    }
    // The hero shot is above the fold and loads eagerly with a high fetch priority; every other screenshot is lazy.
    for (const image of images.filter((i) => i.includes('/about/img/'))) {
      expect(image).toMatch(/alt="[^"]{20,}"/u)
      if (!image.includes('fetchpriority="high"')) expect(image).toContain('loading="lazy"')
    }
    expect(images.filter((i) => i.includes('fetchpriority="high"'))).toHaveLength(1)
  })
  it('FAQ is visible HTML and the FAQPage JSON-LD matches it', () => {
    const details = [...about.matchAll(/<details>\s*<summary><h3>([\s\S]*?)<\/h3><\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/gu)]
    expect(details.length).toBeGreaterThanOrEqual(5)
    expect(details.length).toBeLessThanOrEqual(7)
    const faq = jsonLd(about).find((block) => block['@type'] === 'FAQPage')
    expect(faq.mainEntity).toHaveLength(details.length)
    details.forEach((match, i) => {
      expect(faq.mainEntity[i].name).toBe(text(match[1]))
      expect(faq.mainEntity[i].acceptedAnswer.text).toBe(text(match[2]))
    })
  })
  it('FAQ keeps to the privacy policy', () => {
    const privacy = readFileSync(new URL('../public/kantiplus/datenschutz/index.html', root), 'utf8')
    expect(privacy).toContain('Kanti+ sieht und speichert dein Passwort nicht')
    expect(about).toContain('Kanti+ sieht und speichert dein Passwort nicht')
    expect(privacy).toContain('spätestens 14 Tage nach deiner letzten Anmeldung')
    expect(about).toContain('spätestens 14 Tage nach deiner letzten Anmeldung')
  })
})

describe('404, sitemap, robots, verification', () => {
  it('the 404 page is noindex and links home', () => {
    expect(meta(notFound, 'name', 'robots')).toBe('noindex')
    expect(notFound).toContain('href="/"')
    expect(notFound).toContain('href="/about/"')
    expect(notFound).not.toMatch(/\sstyle="|<style[\s>]/u)
  })
  it('sitemap lists the two pages with absolute https URLs and lastmod', () => {
    const xml = read('public/sitemap.xml')
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    const urls = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>\s*<\/url>/gu)]
    expect(urls.map((u) => u[1])).toEqual(['https://schulnetz.fasrv.ch/', 'https://schulnetz.fasrv.ch/about/'])
    expect(urls.every((u) => u[2] === '2026-11-11')).toBe(true)
    // Strict well-formedness: every opened tag is closed in order.
    const stack: string[] = []
    for (const tag of xml.replace(/<\?[\s\S]*?\?>/u, '').match(/<\/?[a-z][^>]*>/gu) ?? []) {
      const name = tag.match(/^<\/?([a-z]+)/u)![1]
      if (tag.startsWith('</')) expect(stack.pop()).toBe(name)
      else stack.push(name)
    }
    expect(stack).toEqual([])
  })
  it('robots.txt blocks the API and names the sitemap', () => {
    expect(read('public/robots.txt')).toBe('User-agent: *\nDisallow: /api/\n\nSitemap: https://schulnetz.fasrv.ch/sitemap.xml\n')
  })
  it('the Google verification file has exactly the expected content', () => {
    expect(read('public/googlea9b10026681fc5e3.html')).toBe('google-site-verification: googlea9b10026681fc5e3.html\n')
  })
})
