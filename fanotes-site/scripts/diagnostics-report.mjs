#!/usr/bin/env node
// Aggregates the opt-in diagnostics stored by diagnostics-api.mjs.
//   node scripts/diagnostics-report.mjs [--dir /var/lib/fanotes-diagnostics] [--days 30] [--json]
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null)

export const aggregate = (records, sinceMs = 0) => {
  const installs = new Set()
  const versions = new Map()
  const platforms = new Map()
  const errors = new Map()
  const features = new Map()
  const logErrors = new Map()
  const crashes = new Map()
  const penP50 = []
  const startups = []
  const notes = []
  let reports = 0
  let comments = 0
  const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by)
  for (const record of records) {
    if (!record || record.receivedAt < sinceMs) continue
    reports += 1
    installs.add(record.installId)
    bump(versions, record.app?.version || '?')
    bump(platforms, record.app?.platform || '?')
    if (record.comment) comments += 1
    for (const [key, count] of Object.entries(record.usage?.errors ?? {})) bump(errors, key, count)
    for (const [key, count] of Object.entries(record.usage?.counters ?? {})) bump(features, key, count)
    for (const entry of record.logs ?? []) {
      const frame = entry.frames?.[0]
      bump(logErrors, `${entry.class}${entry.code ? ` ${entry.code}` : ''} #${entry.hash}${frame ? ` @ ${frame.file}:${frame.line}` : ''}`)
    }
    for (const entry of record.crashes ?? []) {
      const frame = entry.frames?.[0]
      bump(crashes, `${entry.type} ${entry.process}${entry.reason ? ` ${entry.reason}` : ''} ${entry.class} #${entry.hash}${frame ? ` @ ${frame.file}:${frame.line}` : ''}`, entry.count || 1)
    }
    if (record.perf?.penLatency?.p50) penP50.push(record.perf.penLatency.p50)
    if (record.perf?.startup?.medianMs) startups.push(record.perf.startup.medianMs)
    else if (record.usage?.perf?.startupMs) startups.push(record.usage.perf.startupMs)
    if (record.usage?.vault) notes.push(record.usage.vault.notes)
  }
  startups.sort((a, b) => a - b)
  penP50.sort((a, b) => a - b)
  notes.sort((a, b) => a - b)
  const top = (map, n = 15) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n)
  return {
    reports, installs: installs.size, comments,
    versions: top(versions), platforms: top(platforms),
    topErrors: top(errors), topLogMessages: top(logErrors), topCrashes: top(crashes), penLatencyP50Ms: { p50: percentile(penP50, 0.5), p90: percentile(penP50, 0.9), samples: penP50.length }, features: top(features, 30),
    startupMs: { p50: percentile(startups, 0.5), p90: percentile(startups, 0.9), p99: percentile(startups, 0.99), samples: startups.length },
    vaultNotes: { p50: percentile(notes, 0.5), p90: percentile(notes, 0.9), samples: notes.length },
  }
}

export const readRecords = async (directory) => {
  const records = []
  let names = []
  try { names = (await fs.readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)).sort() } catch { return records }
  for (const name of names) {
    for (const line of (await fs.readFile(join(directory, name), 'utf8')).split('\n')) {
      if (!line) continue
      try { records.push(JSON.parse(line)) } catch { /* skip a torn line */ }
    }
  }
  return records
}

export const formatReport = (report, days) => {
  const rows = (list) => (list.length ? list.map(([key, count]) => `  ${String(count).padStart(7)}  ${key}`).join('\n') : '  (none)')
  return [
    `FaNotes diagnostics, last ${days} days`,
    `reports: ${report.reports}   installs: ${report.installs}   with comment: ${report.comments}`,
    `startup ms  p50 ${report.startupMs.p50 ?? '-'}  p90 ${report.startupMs.p90 ?? '-'}  p99 ${report.startupMs.p99 ?? '-'}  (n=${report.startupMs.samples})`,
    `vault notes p50 ${report.vaultNotes.p50 ?? '-'}  p90 ${report.vaultNotes.p90 ?? '-'}`,
    '', 'versions', rows(report.versions), '', 'platforms', rows(report.platforms),
    `pen latency (per-install p50, ms)  p50 ${report.penLatencyP50Ms.p50 ?? '-'}  p90 ${report.penLatencyP50Ms.p90 ?? '-'}  (n=${report.penLatencyP50Ms.samples})`,
    '', 'top crashes', rows(report.topCrashes),
    '', 'top errors (class|code|hash)', rows(report.topErrors),
    '', 'top logged errors (class code #hash @ bundle:line)', rows(report.topLogMessages),
    '', 'feature usage', rows(report.features),
  ].join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback }
  const directory = value('--dir', process.env.FANOTES_DIAGNOSTICS_DIR || '/var/lib/fanotes-diagnostics')
  const days = Number(value('--days', '30')) || 30
  const report = aggregate(await readRecords(directory), Date.now() - days * 86_400_000)
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report, days))
}
