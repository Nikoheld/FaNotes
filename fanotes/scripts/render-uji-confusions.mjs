import assert from 'node:assert/strict'
import fs from 'node:fs'

const datasetPath = process.env.FANOTES_UJI_DATASET?.trim()
const casesPath = process.env.FANOTES_UJI_CASES?.trim()
const outputPath = process.env.FANOTES_UJI_RENDER_OUTPUT?.trim()
const expected = process.env.FANOTES_UJI_EXPECTED?.trim()
const recognized = process.env.FANOTES_UJI_RECOGNIZED?.trim()

assert.ok(datasetPath && fs.statSync(datasetPath).isFile(), 'FANOTES_UJI_DATASET fehlt.')
assert.ok(casesPath && fs.statSync(casesPath).isFile(), 'FANOTES_UJI_CASES fehlt.')
assert.ok(outputPath, 'FANOTES_UJI_RENDER_OUTPUT fehlt.')
assert.match(expected ?? '', /^[A-Za-z0-9]$/u, 'FANOTES_UJI_EXPECTED muss ein Zeichen sein.')
assert.match(recognized ?? '', /^[A-Za-z0-9]$/u, 'FANOTES_UJI_RECOGNIZED muss ein Zeichen sein.')

const parseDataset = (source) => {
  const lines = source.split(/\r?\n/u)
  const records = []
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = /^WORD\s+([A-Za-z0-9])\s+((?:trn|tst)_(?:UJI|UPV)_W\d+)-(0[12])$/u.exec(lines[cursor].trim())
    if (!header) continue
    const strokeCount = Number(/^NUMSTROKES\s+(\d+)$/u.exec((lines[++cursor] ?? '').trim())?.[1])
    assert.ok(Number.isInteger(strokeCount), `Ungültige Strichzahl bei Zeile ${cursor + 1}.`)
    const strokes = []
    for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
      const match = /^POINTS\s+(\d+)\s+#\s+(.+)$/u.exec((lines[++cursor] ?? '').trim())
      assert.ok(match, `Ungültiger UJI-Stiftzug bei Zeile ${cursor + 1}.`)
      const count = Number(match[1])
      const values = match[2].trim().split(/\s+/u).map(Number)
      assert.equal(values.length, count * 2, `UJI-Punktzahl stimmt bei Zeile ${cursor + 1} nicht.`)
      strokes.push(Array.from({ length: count }, (_, index) => [
        values[index * 2],
        values[index * 2 + 1],
      ]))
    }
    records.push({ char: header[1], writer: header[2], session: Number(header[3]), strokes })
  }
  return records
}

const escapeXml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const records = parseDataset(fs.readFileSync(datasetPath, 'utf8'))
const audit = JSON.parse(fs.readFileSync(casesPath, 'utf8'))
const failures = audit.writerIndependent.cases.filter((entry) => (
  entry.expected === expected && entry.recognized === recognized
))
assert.ok(failures.length, `Keine ${expected}→${recognized}-Fälle gefunden.`)

const recordByKey = new Map(records.map((entry) => [
  `${entry.writer}:${entry.session}:${entry.char}`,
  entry,
]))
const cellWidth = 240
const cellHeight = 250
const columns = 3
const rows = failures.length
const glyphPath = (record, column, row) => {
  const points = record.strokes.flat()
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const maxY = Math.max(...points.map(([, y]) => y))
  const scale = Math.min(170 / Math.max(1, maxX - minX), 160 / Math.max(1, maxY - minY))
  const left = column * cellWidth + (cellWidth - (maxX - minX) * scale) / 2
  const top = row * cellHeight + 58 + (160 - (maxY - minY) * scale) / 2
  return record.strokes.map((stroke) => {
    const pointsAttribute = stroke.map(([x, y]) => (
      `${(left + (x - minX) * scale).toFixed(2)},${(top + (y - minY) * scale).toFixed(2)}`
    )).join(' ')
    const [startX, startY] = stroke[0]
    const [endX, endY] = stroke.at(-1)
    return [
      `<polyline points="${pointsAttribute}" fill="none" stroke="#111827" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<circle cx="${(left + (startX - minX) * scale).toFixed(2)}" cy="${(top + (startY - minY) * scale).toFixed(2)}" r="5" fill="#16a34a"/>`,
      `<circle cx="${(left + (endX - minX) * scale).toFixed(2)}" cy="${(top + (endY - minY) * scale).toFixed(2)}" r="5" fill="#dc2626"/>`,
    ].join('')
  }).join('')
}

const cells = failures.flatMap((failure, row) => {
  const expectedRecord = recordByKey.get(`${failure.writer}:${failure.session}:${expected}`)
  const confusedRecord = recordByKey.get(`${failure.writer}:${failure.session}:${recognized}`)
  const otherSession = recordByKey.get(`${failure.writer}:${failure.session === 1 ? 2 : 1}:${expected}`)
  assert.ok(expectedRecord && confusedRecord && otherSession, `Unvollständiger UJI-Fall ${failure.writer}.`)
  return [
    { column: 0, record: expectedRecord, title: `${expected} (Fehlerprobe)` },
    { column: 1, record: confusedRecord, title: `${recognized} (gleiche Sitzung)` },
    { column: 2, record: otherSession, title: `${expected} (andere Sitzung)` },
  ].map(({ column, record, title }) => [
    `<rect x="${column * cellWidth + 8}" y="${row * cellHeight + 8}" width="${cellWidth - 16}" height="${cellHeight - 16}" rx="14" fill="#f8fafc" stroke="#cbd5e1"/>`,
    `<text x="${column * cellWidth + 18}" y="${row * cellHeight + 32}" font-family="sans-serif" font-size="16" fill="#334155">${escapeXml(title)}</text>`,
    column === 0
      ? `<text x="${column * cellWidth + 18}" y="${row * cellHeight + 52}" font-family="sans-serif" font-size="12" fill="#64748b">${escapeXml(failure.writer)} · S${failure.session} · ${failure.strokeCount} Strich(e)</text>`
      : '',
    glyphPath(record, column, row),
  ].join('')).join('')
}).join('')

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cellWidth}" height="${rows * cellHeight}" viewBox="0 0 ${columns * cellWidth} ${rows * cellHeight}">`,
  '<rect width="100%" height="100%" fill="#e2e8f0"/>',
  cells,
  '</svg>',
].join('')
fs.writeFileSync(outputPath, svg, { mode: 0o600 })
console.log(JSON.stringify({ expected, recognized, cases: failures.length, output: outputPath }))
