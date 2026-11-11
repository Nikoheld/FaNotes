import fs from 'node:fs'
import assert from 'node:assert/strict'
import { localizeText } from '../i18n.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = fs.readFileSync(path.join(root, 'public/fanotes-i18n.js'), 'utf8')
const stylesheet = fs.readFileSync(path.join(root, 'public/fanotes-site.css'), 'utf8')
const homepage = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
const sharedCatalog = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/en.json'), 'utf8'))
const siteCatalog = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/site.en.json'), 'utf8'))
const baseStylesheet = fs.readFileSync(path.join(root, 'public/fanotes-base.css'), 'utf8')
const germanHint = /[ÄÖÜäöüß]|\b(?:der|die|das|den|dem|des|ein|eine|einen|einem|und|oder|für|mit|ohne|von|bei|auf|aus|zu|zum|zur|dein|deine|wird|werden|ist|sind|nicht|noch|nur|alle|keine|bitte)\b|(?:ung|keit|heit|lich|isch|ieren|zeichen|schrift|farbe|ordner|notiz|seite|speicher|erkenn|install|herunter|öffnen|laden)/iu

// The browser runtime translates exact matches first and then known German
// fragments. An English result must never be translated a second time.
const checkCatalog = (name, catalog) => {
  const replacements = Object.entries(catalog)
    .filter(([source, translated]) => source !== translated && source.length >= 4)
    .sort(([left], [right]) => right.length - left.length)
  const expression = new RegExp(replacements.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
  const translate = (value) => {
    if (!value?.trim()) return value
    const source = value.trim()
    if (catalog[source] !== undefined) return catalog[source]
    if (!germanHint.test(source)) return source
    return source.replace(expression, (german) => catalog[german] ?? german)
  }
  const unstable = []
  for (const [source, translated] of replacements) {
    const chain = [translated]
    const seen = new Set(chain)
    let current = translated
    for (let pass = 0; pass < 20; pass += 1) {
      const next = translate(current)
      if (next === current) break
      chain.push(next)
      if (seen.has(next)) {
        chain.push('[cycle]')
        break
      }
      seen.add(next)
      current = next
    }
    if (chain.length > 1) unstable.push({ source, chain })
  }
  if (unstable.length) {
    console.error(JSON.stringify(unstable.slice(0, 30), null, 2))
    throw new Error(`${unstable.length} englische Übersetzungen in ${name} sind bei wiederholter Verarbeitung nicht stabil.`)
  }
  return replacements.length
}

const sharedCount = checkCatalog('en.json', sharedCatalog)
const siteCount = checkCatalog('site.en.json', siteCatalog)

assert.match(runtime, /const textTranslations = new WeakMap\(\)/u, 'Text translations must be stabilized per DOM node.')
assert.match(runtime, /const attributeTranslations = new WeakMap\(\)/u, 'Attribute translations must be stabilized per DOM node.')
assert.doesNotMatch(homepage, /class="web-app-shell reveal interactive-surface"/u, 'The large Web-App spotlight must not use nested 3D compositing.')
// Firefox WebRender was unstable with large blurred/backdrop-filtered layers.
// The public pages avoid those effects entirely.
for (const [name, css] of [['fanotes-site.css', stylesheet], ['fanotes-base.css', baseStylesheet]]) {
  assert.doesNotMatch(css, /backdrop-filter|filter:\s*blur|perspective\(/u, `${name} must not use blur, backdrop filters or 3D perspective.`)
}
assert.match(homepage, /data-catalog="\/i18n\/site\.en\.json/u, 'The homepage must load the small site catalogue, not the 430 KB shared one.')
for (const [source, english] of [
  ['Zeitraum', 'Period'],
  ['Kennzahlen', 'Metrics'],
  ['Zeitverlauf', 'Timeline'],
  ['FaNotes Statistik', 'FaNotes Statistics'],
]) {
  if (sharedCatalog[source] !== undefined) assert.equal(localizeText(source, 'en'), english, source)
  assert.equal(localizeText(source, 'de'), source, source)
}

console.log(`${sharedCount} + ${siteCount} englische Übersetzungen sind idempotent; Firefox-Stabilitätsschutz ist aktiv.`)
