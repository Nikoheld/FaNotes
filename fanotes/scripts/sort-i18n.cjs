#!/usr/bin/env node
// Keeps the English catalogs in one canonical order (German collation of the source text,
// 2-space JSON, trailing newline), the same order scripts/apply-i18n-overrides.cjs writes.
// New strings land in the middle of the file instead of at its end, so two pull requests that
// each add strings rarely touch the same lines and merge without conflicts.
//
//   node scripts/sort-i18n.cjs           rewrite the catalogs in place
//   node scripts/sort-i18n.cjs --check   fail when a catalog is unsorted, invalid or has a repeated key
//
// After an en.json merge conflict: keep both sides (delete the conflict markers), then run this.
const fs = require('node:fs')
const path = require('node:path')

const targets = [
  path.resolve(__dirname, '../resources/i18n/en.json'),
  path.resolve(__dirname, '../../fanotes-site/public/i18n/en.json'),
].filter((file) => fs.existsSync(file))

const check = process.argv.includes('--check')
const KEY_LINE = /^\s*("(?:[^"\\]|\\.)*")\s*:/

/** Keys that appear more than once. JSON.parse keeps the last one silently; Android's catalog test rejects them. */
const repeatedKeys = (text) => {
  const seen = new Set()
  const repeated = new Set()
  for (const line of text.split('\n')) {
    const match = line.match(KEY_LINE)
    if (!match) continue
    const key = JSON.parse(match[1])
    if (seen.has(key)) repeated.add(key)
    seen.add(key)
  }
  return [...repeated]
}

/** Leftover merge markers, a missing comma between two entries, or a trailing comma before the end. */
const repairMergeLeftovers = (text) => {
  let lines = text.split('\n').filter((line) => !/^(<{7}|={7}|>{7})( |$)/.test(line))
  for (let index = 1; index < lines.length; index += 1) {
    if (KEY_LINE.test(lines[index]) && /"\s*$/.test(lines[index - 1])) lines[index - 1] = lines[index - 1].replace(/"\s*$/, '",')
  }
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (/^\s*}\s*$/.test(lines[index])) {
      lines[index - 1] = lines[index - 1].replace(/,\s*$/, '')
      break
    }
  }
  return lines.join('\n')
}

const canonical = (catalog) => `${JSON.stringify(Object.fromEntries(
  Object.entries(catalog).sort(([left], [right]) => left.localeCompare(right, 'de')),
), null, 2)}\n`

let failed = false
for (const file of targets) {
  const relative = path.relative(path.resolve(__dirname, '../..'), file)
  const raw = fs.readFileSync(file, 'utf8')
  if (check) {
    let catalog
    try {
      catalog = JSON.parse(raw)
    } catch (error) {
      console.error(`${relative}: invalid JSON (${error.message})`)
      failed = true
      continue
    }
    const repeated = repeatedKeys(raw)
    if (repeated.length) {
      console.error(`${relative}: ${repeated.length} key(s) defined more than once: ${repeated.slice(0, 5).map((key) => JSON.stringify(key)).join(', ')}`)
      failed = true
    }
    if (raw !== canonical(catalog)) {
      console.error(`${relative}: not in canonical order. Run: npm run i18n:sort (in fanotes/)`)
      failed = true
    }
    continue
  }
  const text = repairMergeLeftovers(raw)
  const repeated = repeatedKeys(text)
  const catalog = JSON.parse(text)
  if (repeated.length) console.log(`${relative}: merged ${repeated.length} repeated key(s); the last translation wins`)
  fs.writeFileSync(file, canonical(catalog))
  console.log(`${relative}: ${Object.keys(catalog).length} strings, sorted`)
}
if (failed) process.exit(1)
if (check) console.log('i18n catalogs: valid, no repeated keys, canonical order')
