import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// UJI Pen Characters v2, CC BY 4.0, DOI 10.24432/C5FG8S.
// One pinned/local dataset is shared read-only by all serial child audits. Every
// writer still gets a fresh Node process, Chromium profile and temporary tree.
const DATASET_URL = 'https://archive.ics.uci.edu/static/public/177/uji+pen+characters+version+2.zip'
const DATASET_SHA256 = '0881b522911b99d9922820289441b50fd3d307f71cd7f9cc70e86872424a5f90'
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const singleWriterAudit = path.join(appRoot, 'scripts', 'audit-uji-pair-selection.mjs')

const boundedInteger = (name, fallback, minimum, maximum) => {
  const requested = Number(process.env[name])
  return Number.isFinite(requested)
    ? Math.max(minimum, Math.min(maximum, Math.round(requested)))
    : fallback
}

const writerCount = boundedInteger('FANOTES_UJI_PAIR_SELECTION_WRITERS', 4, 1, 60)
const writerOffset = boundedInteger('FANOTES_UJI_PAIR_SELECTION_WRITER_OFFSET', 0, 0, 59)
const nodeHeapMb = boundedInteger('FANOTES_UJI_PAIR_SELECTION_NODE_HEAP_MB', 768, 384, 1_536)
const chromiumHeapMb = boundedInteger('FANOTES_UJI_CHROMIUM_HEAP_MB', 512, 384, 1_536)
const chromiumTimeoutMs = boundedInteger(
  'FANOTES_UJI_PAIR_SELECTION_TIMEOUT_MS',
  120_000,
  30_000,
  240_000,
)
const requestedChildTimeoutMs = boundedInteger(
  'FANOTES_UJI_PAIR_SELECTION_CHILD_TIMEOUT_MS',
  180_000,
  60_000,
  360_000,
)
const childTimeoutMs = Math.max(requestedChildTimeoutMs, chromiumTimeoutMs + 30_000)
const maximumStdoutBytes = boundedInteger(
  'FANOTES_UJI_PAIR_SELECTION_MAX_OUTPUT_BYTES',
  16 * 1024 * 1024,
  1024 * 1024,
  32 * 1024 * 1024,
)
const maximumStderrBytes = 512 * 1024
const explicitWriterSource = process.env.FANOTES_UJI_PAIR_SELECTION_WRITER_NAMES?.trim() ?? ''
const explicitWriters = explicitWriterSource
  ? explicitWriterSource.split(',').map((writer) => writer.trim()).filter(Boolean)
  : []
assert.equal(
  new Set(explicitWriters).size,
  explicitWriters.length,
  'FANOTES_UJI_PAIR_SELECTION_WRITER_NAMES enthält doppelte Namen.',
)
explicitWriters.forEach((writer) => {
  assert.match(writer, /^(?:trn|tst)_(?:UJI|UPV)_W\d+$/u, `Ungültiger UJI-Schreibendenname: ${writer}`)
})
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-uji-pair-multiwriter-'))
const archive = path.join(temporary, 'uji.zip')
const downloadedDataset = path.join(temporary, 'ujipenchars2.txt')

const rate = (matches, samples) => (
  Math.round(matches / Math.max(1, samples) * 10_000) / 100
)

const provideDataset = async () => {
  const local = process.env.FANOTES_UJI_DATASET?.trim()
  if (local) {
    assert.ok(fs.statSync(local).isFile(), 'FANOTES_UJI_DATASET muss auf eine Datei zeigen.')
    return { path: path.resolve(local), source: 'local' }
  }

  const response = await fetch(DATASET_URL)
  assert.equal(response.status, 200, 'Der UJI-Datensatz konnte nicht geladen werden.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.ok(
    bytes.byteLength > 0 && bytes.byteLength <= MAX_ARCHIVE_BYTES,
    'Das UJI-Archiv hat eine unerwartete Grösse.',
  )
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    DATASET_SHA256,
    'Die UJI-Prüfsumme stimmt nicht.',
  )
  fs.writeFileSync(archive, bytes)
  const unzip = spawn('unzip', ['-q', archive, 'ujipenchars2.txt', '-d', temporary], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  unzip.stderr.on('data', (chunk) => {
    if (stderr.length < maximumStderrBytes) {
      stderr += chunk.toString().slice(0, maximumStderrBytes - stderr.length)
    }
  })
  const exitCode = await new Promise((resolve, reject) => {
    unzip.once('error', reject)
    unzip.once('close', resolve)
  })
  assert.equal(exitCode, 0, `Das UJI-Archiv konnte nicht entpackt werden: ${stderr}`)
  return { path: downloadedDataset, source: 'pinned-download' }
}

const inspectDataset = (datasetPath) => {
  const headers = fs.readFileSync(datasetPath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => /^WORD\s+([A-Za-z0-9])\s+((?:trn|tst)_(?:UJI|UPV)_W\d+)-(0[12])$/u.exec(line.trim()))
    .filter(Boolean)
  assert.equal(headers.length, 7_440, 'Der vollständige alphanumerische UJI-Satz wurde nicht gelesen.')
  const sessionsByWriter = new Map()
  headers.forEach((match) => {
    const writer = match[2]
    const sessions = sessionsByWriter.get(writer) ?? new Set()
    sessions.add(Number(match[3]))
    sessionsByWriter.set(writer, sessions)
  })
  const writers = [...sessionsByWriter.entries()]
    .filter(([, sessions]) => sessions.has(1) && sessions.has(2))
    .map(([writer]) => writer)
    .sort((first, second) => first.localeCompare(second, 'en'))
  assert.ok(writers.length > 0, 'Der UJI-Datensatz enthält keine sitzungsgetrennten Schreibenden.')
  return { supportedRecords: headers.length, writers }
}

const selectWriters = (availableWriters) => {
  if (explicitWriters.length) {
    explicitWriters.forEach((writer) => {
      assert.ok(availableWriters.includes(writer), `${writer} fehlt im UJI-Datensatz.`)
    })
    return explicitWriters
  }
  const selected = availableWriters.slice(writerOffset, writerOffset + writerCount)
  assert.equal(
    selected.length,
    writerCount,
    `Ab Offset ${writerOffset} sind nicht ${writerCount} UJI-Schreibende verfügbar.`,
  )
  return selected
}

let activeChild = null

const terminateChildTree = (child, signal = 'SIGKILL') => {
  if (!child || child.exitCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the direct child if its process group has already ended.
    }
  }
  try { child.kill(signal) } catch { /* already gone */ }
}

const runWriter = async (writer, datasetPath) => {
  const writerTemporary = path.join(temporary, `writer-${writer}`)
  fs.mkdirSync(writerTemporary, { recursive: true })
  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let stderrBytes = 0
  let timedOut = false
  let outputOverflow = false

  try {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${nodeHeapMb}`, singleWriterAudit],
      {
        cwd: appRoot,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          TMPDIR: writerTemporary,
          TEMP: writerTemporary,
          TMP: writerTemporary,
          UV_THREADPOOL_SIZE: '2',
          FANOTES_UJI_DATASET: datasetPath,
          FANOTES_UJI_PAIR_SELECTION_WRITER: writer,
          FANOTES_UJI_PAIR_SELECTION_CASES: '0',
          FANOTES_UJI_CHROMIUM_HEAP_MB: String(chromiumHeapMb),
          FANOTES_UJI_PAIR_SELECTION_TIMEOUT_MS: String(chromiumTimeoutMs),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    activeChild = child
    try { os.setPriority(child.pid, 18) } catch { /* best effort outside POSIX */ }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maximumStdoutBytes) {
        outputOverflow = true
        terminateChildTree(child)
        return
      }
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= maximumStderrBytes) stderr += chunk.toString()
    })
    const timeout = setTimeout(() => {
      timedOut = true
      terminateChildTree(child)
    }, childTimeoutMs)
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }).finally(() => clearTimeout(timeout))
    activeChild = null
    assert.equal(timedOut, false, `${writer} überschritt das Kindprozesslimit von ${childTimeoutMs} ms.`)
    assert.equal(outputOverflow, false, `${writer} überschritt das JSON-Limit von ${maximumStdoutBytes} Bytes.`)
    assert.equal(exitCode, 0, `${writer} scheiterte im Einzelaudit: ${stderr.slice(-4_000)}`)

    let result
    try {
      result = JSON.parse(stdout.trim())
    } catch (error) {
      throw new Error(`Ungültiges JSON von ${writer}: ${stdout.slice(-1_800)}`, { cause: error })
    }
    assert.equal(result.dataset.writer, writer)
    assert.equal(result.isolation.trainingSession, 1)
    assert.equal(result.isolation.holdoutSession, 2)
    assert.equal(result.isolation.persistentWrites, false)
    assert.equal(result.isolation.sharedRecordObjects, 0)
    assert.equal(result.isolation.sharedTrajectories, 0)
    assert.equal(result.isolation.trainingSessionContamination, 0)
    assert.equal(result.isolation.holdoutSessionContamination, 0)
    return result
  } finally {
    if (activeChild) {
      terminateChildTree(activeChild)
      activeChild = null
    }
    fs.rmSync(writerTemporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
  }
}

const sum = (entries, read) => entries.reduce((total, entry) => total + read(entry), 0)

const aggregateConfusions = (summaries) => {
  const counts = new Map()
  summaries.forEach((summary) => summary.topConfusions.forEach(([confusion, count]) => {
    counts.set(confusion, (counts.get(confusion) ?? 0) + count)
  }))
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'en'))
    .slice(0, 30)
}

const compactFailure = (failure) => ({
  writer: failure.writer,
  variant: failure.variant,
  expected: failure.expected,
  recognized: failure.recognized,
  visibleTokenCount: failure.visibleTokenCount,
  outputCharacterCount: failure.outputCharacterCount,
  collapsed: failure.collapsed,
  expanded: failure.expanded,
  topNOracle: failure.topNOracle,
  boundedSearchOracle: failure.boundedSearchOracle,
})

const compactMetricSummary = (summary) => ({
  samples: summary.samples,
  top1: summary.top1,
  characterCount: summary.characterCount,
  topNOracle: summary.topNOracle,
  boundedSegmentationSearchOracle: summary.boundedSegmentationSearchOracle,
  topConfusions: summary.topConfusions,
  failures: summary.failures.map(compactFailure),
})

const aggregateSummary = (summaries) => {
  const samples = sum(summaries, (summary) => summary.samples)
  const top1 = sum(summaries, (summary) => summary.top1.exact)
  const normalizedTop1 = sum(summaries, (summary) => summary.top1.caseNormalizedExact)
  const exactCount = sum(summaries, (summary) => summary.characterCount.exact)
  const collapsed = sum(summaries, (summary) => summary.characterCount.collapsed)
  const expanded = sum(summaries, (summary) => summary.characterCount.expanded)
  const oracle = sum(summaries, (summary) => summary.topNOracle.exact)
  const normalizedOracle = sum(summaries, (summary) => summary.topNOracle.caseNormalizedExact)
  const boundedOracle = sum(summaries, (summary) => summary.boundedSegmentationSearchOracle.exact)
  const boundedNormalizedOracle = sum(
    summaries,
    (summary) => summary.boundedSegmentationSearchOracle.caseNormalizedExact,
  )
  return {
    samples,
    top1: {
      exact: top1,
      accuracy: rate(top1, samples),
      caseNormalizedExact: normalizedTop1,
      caseNormalizedAccuracy: rate(normalizedTop1, samples),
    },
    characterCount: {
      exact: exactCount,
      accuracy: rate(exactCount, samples),
      collapsed,
      collapseRate: rate(collapsed, samples),
      expanded,
      expansionRate: rate(expanded, samples),
    },
    topNOracle: {
      exact: oracle,
      accuracy: rate(oracle, samples),
      caseNormalizedExact: normalizedOracle,
      caseNormalizedAccuracy: rate(normalizedOracle, samples),
    },
    boundedSegmentationSearchOracle: {
      exact: boundedOracle,
      accuracy: rate(boundedOracle, samples),
      caseNormalizedExact: boundedNormalizedOracle,
      caseNormalizedAccuracy: rate(boundedNormalizedOracle, samples),
    },
    topConfusions: aggregateConfusions(summaries),
    failures: summaries
      .flatMap((summary) => summary.failures)
      .slice(0, 40)
      .map(compactFailure),
  }
}

const cleanup = () => {
  terminateChildTree(activeChild)
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
}
const onSigint = () => { cleanup(); process.exit(130) }
const onSigterm = () => { cleanup(); process.exit(143) }
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

try {
  const dataset = await provideDataset()
  const inspected = inspectDataset(dataset.path)
  const writers = selectWriters(inspected.writers)
  const results = []
  // Deliberately serial: at most one Vite build and one Chromium audit exist.
  for (const writer of writers) results.push(await runWriter(writer, dataset.path))

  const buildTimes = results.map((result) => result.model.buildMs)
  const trainingSamples = sum(results, (result) => result.isolation.trainingSamples)
  const holdoutGlyphs = sum(results, (result) => result.isolation.holdoutGlyphs)
  console.log(JSON.stringify({
    dataset: {
      source: dataset.source,
      supportedRecords: inspected.supportedRecords,
      availableWriters: inspected.writers.length,
      evaluatedWriters: writers.length,
      writers,
    },
    isolation: {
      trainingSession: 1,
      holdoutSession: 2,
      trainingSamples,
      holdoutGlyphs,
      persistentWrites: false,
      freshChildProcessPerWriter: true,
      serialExecution: true,
      maximumConcurrentAuditChromiumProcesses: 1,
      sharedReadOnlyDataset: true,
    },
    resourcePolicy: {
      nodeHeapMb,
      chromiumHeapMb,
      chromiumTimeoutMs,
      childTimeoutMs,
      maximumStdoutBytes,
      uvThreadpoolSize: 2,
      requestedNiceness: 18,
      nicenessIsBestEffort: true,
    },
    configuration: {
      ...results[0].configuration,
      evaluatedWriters: writers.length,
      includeCases: false,
    },
    model: {
      totalBuildMs: buildTimes.reduce((total, value) => total + value, 0),
      averageBuildMs: Math.round(buildTimes.reduce((total, value) => total + value, 0) / buildTimes.length),
      minimumBuildMs: Math.min(...buildTimes),
      maximumBuildMs: Math.max(...buildTimes),
    },
    overall: aggregateSummary(results.map((result) => result.overall)),
    separated: aggregateSummary(results.map((result) => result.separated)),
    connected: aggregateSummary(results.map((result) => result.connected)),
    writers: results.map((result) => ({
      dataset: result.dataset,
      isolation: result.isolation,
      configuration: result.configuration,
      model: result.model,
      overall: compactMetricSummary(result.overall),
      separated: compactMetricSummary(result.separated),
      connected: compactMetricSummary(result.connected),
    })),
  }, null, 2))
} finally {
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  cleanup()
}
