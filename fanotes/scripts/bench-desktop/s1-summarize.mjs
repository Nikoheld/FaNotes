#!/usr/bin/env node
// Spike S1: the results table for Electron, Tauri 3 + CEF and Tauri 2 (WebKitGTK)
// from results/s1-<host>-markdown.json, plus the load averages of the runs.
//   node s1-summarize.mjs [results-dir] [markdown|gpupath|idle60]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'results'))
const suffix = process.argv[3] || 'markdown'
const load = (host) => {
  const file = path.join(dir, `s1-${host}-${suffix}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}
const hosts = [['electron', 'Electron 43.1 (Chromium 150)'], ['cef', 'Tauri 3 α + CEF 154'], ['tauri', 'Tauri 2 + WebKitGTK 2.54']]
const reports = hosts.map(([host]) => load(host))
const fmt = (stat, unit = '', digits = 0) => {
  if (!stat || !stat.n) return 'not measured'
  const value = (number) => number.toFixed(digits)
  return `${value(stat.median)}${unit} (${value(stat.min)}–${value(stat.max)}, n=${stat.n})`
}
const rows = [
  ['Startup, cold (exec → tree + last note)', 'startupColdMs', ' ms', 0],
  ['Startup, warm', 'startupWarmMs', ' ms', 0],
  ['Memory idle, note open: PSS sum', 'memoryIdlePssMb', ' MB', 0],
  ['Memory idle, note open: RSS sum', 'memoryIdleRssMb', ' MB', 0],
  ['Idle CPU, 10 s, whole process tree (% of one core)', 'cpuIdlePercent', ' %', 1],
  ['Memory after the long note: RSS sum', 'memoryLongNoteRssMb', ' MB', 0],
  ['Memory after the 200-page PDF: PSS sum', 'memoryPdfPssMb', ' MB', 0],
  ['Memory after the 200-page PDF: RSS sum', 'memoryPdfRssMb', ' MB', 0],
  ['Typing: key event → frame, p50', 'typingP50Ms', ' ms', 1],
  ['Typing: key event → frame, p95', 'typingP95Ms', ' ms', 1],
  ['Typing: XTest injection → frame, p95', 'typingInjectP95Ms', ' ms', 1],
  ['Scroll long note: p95 frame time', 'scrollLongNoteP95Ms', ' ms', 1],
  ['Scroll long note: dropped frames', 'scrollLongNoteDropped', '', 0],
  ['Scroll 200-page PDF: p95 frame time', 'scrollPdfP95Ms', ' ms', 1],
  ['Scroll 200-page PDF: dropped frames', 'scrollPdfDropped', '', 0],
]
const lines = [`| Metric | ${hosts.map(([, title]) => title).join(' | ')} |`, `| --- |${hosts.map(() => ' --- |').join('')}`]
for (const [title, key, unit, digits] of rows) lines.push(`| ${title} | ${reports.map((report) => (report ? fmt(report.summary[key], unit, digits) : 'not measured')).join(' | ')} |`)
const loads = (report) => {
  if (!report) return 'n/a'
  const values = [...report.startupCold, ...report.startupWarm].map((item) => item.load?.[0]).filter(Number.isFinite)
  return values.length ? `${Math.min(...values).toFixed(1)}–${Math.max(...values).toFixed(1)}` : 'n/a'
}
lines.push(`| 1-min load average at the starts | ${reports.map(loads).join(' | ')} |`)
lines.push(`| Errors in the run | ${reports.map((report) => (report ? String(report.errors.length) : 'n/a')).join(' | ')} |`)
console.log(lines.join('\n'))
for (const [index, report] of reports.entries()) {
  if (!report) continue
  console.log(`\n${hosts[index][0]}: renderer ${JSON.stringify(report.renderer?.webgl ?? null)}; idle CPU by process ${JSON.stringify(report.cpuIdle.map((item) => Object.fromEntries(Object.entries(item.byProcess).map(([name, value]) => [name.split(' --')[0].slice(0, 32) + (name.includes('--type=') ? ` ${name.match(/--type=(\S+)/u)[1]}` : ''), value]))))}`)
  for (const error of report.errors) console.log(`  error ${error.suite} run ${error.run}: ${error.error.slice(0, 200)}`)
}
