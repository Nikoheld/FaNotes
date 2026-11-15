#!/usr/bin/env node
// Prints the markdown results table from results/*.json.
//   node summarize.mjs [results-dir]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'results'))
const load = (name) => {
  const file = path.join(dir, name)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}
const electron = load('electron-markdown.json')
const tauri = load('tauri-markdown.json')
const writing = load('electron-writing.json')
const sync = load('sync-ts.json')
const rust = load('sync-rust.json')

const fmt = (stat, unit = '', digits = 0) => {
  if (!stat || !stat.n) return 'not measured'
  const value = (number) => number.toFixed(digits)
  return `${value(stat.median)}${unit} (${value(stat.min)}–${value(stat.max)}, n=${stat.n})`
}
const cell = (report, key, unit, digits) => (report ? fmt(report.summary[key], unit, digits) : 'not measured')
const rows = [
  ['Startup, cold (process start → tree + last note)', 'startupColdMs', ' ms', 0],
  ['Startup, warm', 'startupWarmMs', ' ms', 0],
  ['Memory idle, note open: RSS sum', 'memoryIdleRssMb', ' MB', 0],
  ['Memory idle, note open: PSS sum', 'memoryIdlePssMb', ' MB', 0],
  ['Memory after the long markdown note: RSS sum', 'memoryLongNoteRssMb', ' MB', 0],
  ['Memory after the 200-page PDF: RSS sum', 'memoryPdfRssMb', ' MB', 0],
  ['Memory after the 200-page PDF: PSS sum', 'memoryPdfPssMb', ' MB', 0],
  ['Typing, markdown: key event → frame, p50', 'typingP50Ms', ' ms', 1],
  ['Typing, markdown: key event → frame, p95', 'typingP95Ms', ' ms', 1],
  ['Typing, markdown: XTest injection → frame, p50', 'typingInjectP50Ms', ' ms', 1],
  ['Typing, markdown: XTest injection → frame, p95', 'typingInjectP95Ms', ' ms', 1],
  ['Scroll long markdown note: p95 frame time', 'scrollLongNoteP95Ms', ' ms', 1],
  ['Scroll long markdown note: dropped frames', 'scrollLongNoteDropped', '', 0],
  ['Scroll 200-page PDF: p95 frame time', 'scrollPdfP95Ms', ' ms', 1],
  ['Scroll 200-page PDF: dropped frames', 'scrollPdfDropped', '', 0],
]
const lines = ['| Metric | Electron 43 | Tauri 2 (WebKitGTK) |', '| --- | --- | --- |']
for (const [title, key, unit, digits] of rows) lines.push(`| ${title} | ${cell(electron, key, unit, digits)} | ${cell(tauri, key, unit, digits)} |`)
if (writing) {
  lines.push(`| Writing mode (600-page story): typing p50 / p95 | ${fmt(writing.summary.typingP50Ms, ' ms', 1)} / ${fmt(writing.summary.typingP95Ms, ' ms', 1)} | not measurable (no story channels in the Tauri shell) |`)
  lines.push(`| Writing mode: scroll p95 / dropped | ${fmt(writing.summary.scrollStoryP95Ms, ' ms', 1)} / ${fmt(writing.summary.scrollStoryDropped)} | not measurable |`)
  lines.push(`| Writing mode: memory after opening the story (RSS) | ${fmt(writing.summary.memoryStoryRssMb, ' MB')} | not measurable |`)
}
const phases = [['full-upload', 'Sync: full, upload (2,000 files)'], ['full-download', 'Sync: full, download on a 2nd device'], ['incremental-upload', 'Sync: 20 edits, upload'], ['incremental-download', 'Sync: 20 edits, download'], ['noop', 'Sync: nothing to do']]
lines.push('', '| Sync (local server) | TypeScript engine | Rust engine (WP3) |', '| --- | --- | --- |')
for (const [key, title] of phases) lines.push(`| ${title} | ${sync ? fmt(sync.summary[key].ms, ' ms') : 'not measured'} | ${rust ? fmt(rust.summary[key].ms, ' ms') : 'not measured yet (WP3 CLI)'} |`)
console.log(lines.join('\n'))
