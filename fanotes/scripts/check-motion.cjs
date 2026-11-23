'use strict'
// Motion system guard: shared tokens exist and are used, keyframes only touch opacity/transform,
// reduced motion (OS preference and the app setting) zeroes the tokens and ends animations, and exit
// ghosts are inert. Static, so it runs anywhere without a browser.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

const styles = read('src/styles.css')
const motion = read('src/motion.css')
const exits = read('src/lib/motion.ts')
const main = read('src/main.tsx')
const app = read('src/App.tsx')

for (const token of ['--dur-1', '--dur-2', '--dur-3', '--ease-standard', '--ease-decel', '--ease-accel']) {
  assert.match(styles, new RegExp(`${token}:`), `${token} missing in styles.css :root`)
}
for (const [token, ms] of [['--dur-1', 120], ['--dur-2', 160], ['--dur-3', 200]]) {
  assert.match(styles, new RegExp(`${token}: ${ms}ms`), `${token} must be ${ms}ms`)
}

// Every duration in motion.css comes from a token; no literal ms/s except the reduced-motion overrides and the skeleton loop.
const withoutReduced = motion.slice(0, motion.indexOf('/* Reduced motion'))
const literal = [...withoutReduced.matchAll(/(?:animation|transition)\s*:[^;{}]*?(\d*\.?\d+m?s)\b/g)].filter((m) => !/var\(--dur/.test(m[0]) && !m[0].includes('motion-skeleton-sweep'))
assert.deepEqual(literal.map((m) => m[0]), [], 'motion.css durations must use --dur-* tokens')
assert.ok((motion.match(/var\(--dur-[123]\)/g) || []).length >= 15, 'motion tokens should be used throughout motion.css')

// Keyframes animate opacity and transform only (compositor friendly, no layout).
for (const block of motion.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
  const properties = [...block[2].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
  const bad = properties.filter((p) => !['opacity', 'transform', 'from', 'to'].includes(p))
  assert.deepEqual(bad, [], `@keyframes ${block[1]} animates non-compositor properties: ${bad.join(', ')}`)
}
assert.doesNotMatch(motion.replace(/\/\*[\s\S]*?\*\//g, ''), /transition[^;]*\b(width|height|top|left|right|bottom|margin|padding)\b/, 'no layout transitions')

// Reduced motion: OS preference plus the app setting.
assert.match(motion, /@media \(prefers-reduced-motion: reduce\)[\s\S]*--dur-1: \.001ms/, 'OS reduced motion zeroes tokens')
assert.match(motion, /:root\.motion-off \{[^}]*--dur-1: \.001ms/, 'app reduceMotion zeroes tokens')
assert.match(motion, /:root\.motion-off \*[\s\S]*animation-duration: \.001ms !important/, 'app reduceMotion ends animations')
assert.match(app, /classList\.toggle\('motion-off', settings\.reduceMotion\)/, 'App toggles html.motion-off from settings.reduceMotion')
assert.match(main, /import '\.\/motion\.css'/)
assert.match(main, /installExitMotion\(\)/)

// Exit ghosts: skipped under reduced motion, inert, bounded.
assert.match(exits, /motionDisabled\(\)/)
assert.match(exits, /prefers-reduced-motion: reduce/)
assert.match(exits, /setAttribute\('inert'/)
assert.match(exits, /removeAttribute\('id'\)/)
assert.match(exits, /MAX_GHOSTS/)
assert.match(motion, /\.motion-ghost \{[^}]*pointer-events: none/)
const exitMs = Number(/EXIT_MS = (\d+)/.exec(exits)?.[1])
assert.ok(exitMs >= 100 && exitMs <= 200, 'exit duration within 100-200 ms')

// The note sheet, ink canvas and note open path are not animated by this file.
assert.doesNotMatch(motion, /paper-view|drawing-board|lw-drawing|ink-canvas|\.cm-editor|\.markdown-editor|text-field-layer/, 'motion.css must not touch the note sheet or ink canvas')

console.log('motion check passed')
