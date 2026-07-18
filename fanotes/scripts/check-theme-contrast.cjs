'use strict'

const fs = require('node:fs')
const path = require('node:path')

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
const themeNames = ['dark', 'light', 'midnight', 'forest', 'aurora', 'sepia']
const foregrounds = ['text', 'text-soft', 'text-muted', 'danger', 'success', 'warning']
const backgrounds = ['bg', 'bg-elevated', 'panel', 'panel-strong']

function variablesFrom(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+)\s*:\s*(#[\da-f]{3,8})\s*;/gi)].map((match) => [match[1], match[2]]))
}

function blockFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? ''
}

function rgb(value) {
  const raw = value.replace('#', '')
  const hex = raw.length === 3 ? raw.split('').map((part) => `${part}${part}`).join('') : raw.slice(0, 6)
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
}

function luminance(value) {
  const channels = rgb(value).map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ))
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(first, second) {
  const lighter = Math.max(luminance(first), luminance(second))
  const darker = Math.min(luminance(first), luminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

const defaults = variablesFrom(blockFor(':root'))
let failures = 0

for (const theme of themeNames) {
  const variables = theme === 'dark'
    ? defaults
    : { ...defaults, ...variablesFrom(blockFor(`.app-shell.theme-${theme}`)) }
  const ratios = []
  for (const foreground of foregrounds) {
    for (const background of backgrounds) {
      const ratio = contrast(variables[foreground], variables[background])
      ratios.push(ratio)
      if (ratio < 4.5) {
        failures += 1
        console.error(`${theme}: --${foreground} auf --${background} erreicht nur ${ratio.toFixed(2)}:1`)
      }
    }
  }
  console.log(`${theme.padEnd(8)} Mindestkontrast ${Math.min(...ratios).toFixed(2)}:1`)
}

if (failures) {
  console.error(`${failures} Theme-Kontrastprüfung(en) fehlgeschlagen.`)
  process.exitCode = 1
} else {
  console.log('Alle Theme-Textfarben erreichen mindestens WCAG AA (4.5:1).')
}
