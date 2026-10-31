'use strict'

/**
 * Dual-format .famd checks against the shipped Electron codec
 * (`electron/famd.cjs`). Modes: format, create, convert, or all.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  FamdCorruptError,
  convertFamdDirectory,
  convertFamdSource,
  createNoteCompanion,
  emptyFamdPayload,
  famdEncodingForSave,
  parseFamd,
  sameFamdPayload,
  serializeFamd,
  stripFamdPayload,
} = require('../electron/famd.cjs')

const ROOT = path.join(__dirname, '..')
const mode = process.argv[2] || 'all'
const MODES = new Set(['format', 'create', 'convert', 'all'])

const assertCorrupt = (fn) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FamdCorruptError)
    assert.equal(error.name, 'FamdCorruptError')
    assert.equal(error.code, 'FAMD_CORRUPT')
    return true
  })
}

const markdown = [
  '# Analysis',
  '',
  'Der Text steht vor der Tinte.',
  '',
  '$$\\int x$$',
  '',
  '<!-- fanotes-ink:abc -->',
  '<!-- fanotes-worksheet:ws-1 -->',
].join('\n')

const richPayload = () => ({
  ...emptyFamdPayload('2026-10-31T12:00:00.000Z'),
  paperStyle: 'lines',
  worksheets: ['ws-1'],
  noteLinks: [{
    id: 'nl-famd-v2',
    sourcePath: 'Mathe/Skript.pdf',
    targetPath: 'Mathe/Skript-Notiz.md',
    page: 3,
    x: 0.72,
    y: 0.18,
    style: 'text',
    label: 'Skript-Notiz',
  }],
  noteBackups: [{
    id: 'nb-famd-v2',
    notePath: 'Mathe/Analysis.md',
    createdAt: '2026-08-19T12:00:00.000Z',
    content: 'Stand A',
  }],
  pageStats: {
    version: 2,
    createdAt: '2026-01-02T03:04:05.000Z',
    modifiedAt: '2026-01-02T03:04:05.000Z',
    lastOpenedAt: '2026-01-02T03:05:05.000Z',
    dwellMs: 1500,
    openCount: 2,
    customCounter: 12,
  },
  textFields: [{
    id: 'tf-famd-v2',
    page: 2,
    x: 0.2,
    y: 0.3,
    width: 0.4,
    fontSize: 18,
    text: 'Hallo',
  }],
  ink: {
    schemaVersion: 1,
    title: 'Handschrift',
    searchTranscript: 'integral',
    strokes: [{
      color: '#3478df',
      baseWidth: 2.5,
      width: 2.5,
      brush: 'fineliner',
      points: [
        { x: 0.123456789, y: 0.2, t: 1.25, pressure: 0.3 },
        { x: 0.9, y: 0.87654321, t: 4, pressure: 0.875 },
      ],
    }],
  },
})

const heavyPayload = () => {
  const brushes = ['fineliner', 'pen', 'marker']
  const colors = ['#3478df', '#111111', '#c0392b']
  const strokes = []
  for (let stroke = 0; stroke < 200; stroke += 1) {
    const points = []
    for (let point = 0; point < 80; point += 1) {
      points.push({
        x: ((stroke * 17 + point * 13) % 10000) / 10000,
        y: ((stroke * 19 + point * 7) % 10000) / 10000,
        t: stroke * 80 + point + 0.125,
        pressure: ((point % 8) + 1) / 8,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
      })
    }
    strokes.push({
      color: colors[stroke % colors.length],
      baseWidth: 1.5 + (stroke % 5) * 0.25,
      width: 1.5 + (stroke % 5) * 0.25,
      brush: brushes[stroke % brushes.length],
      points,
    })
  }
  return {
    ...richPayload(),
    ink: {
      schemaVersion: 1,
      title: 'Viel Tinte',
      strokes,
    },
  }
}

const assertPoints = (original, restored) => {
  assert.equal(restored.length, original.length)
  for (let index = 0; index < original.length; index += 1) {
    const left = original[index]
    const right = restored[index]
    assert.ok(Math.abs(left.x - right.x) <= 1e-4, `x ${left.x} -> ${right.x}`)
    assert.ok(Math.abs(left.y - right.y) <= 1e-4, `y ${left.y} -> ${right.y}`)
    assert.equal(right.pressure, left.pressure)
    assert.equal(right.t, left.t)
    assert.equal(right.tiltX, left.tiltX)
    assert.equal(right.tiltY, left.tiltY)
    assert.equal(right.pointerType, left.pointerType)
  }
}

const checkFormat = async () => {
  const payload = heavyPayload()
  const v1 = serializeFamd(markdown, payload)
  const v2 = serializeFamd(markdown, payload, 'v2')
  assert.match(v1, /<!-- fanotes-famd:v1 chars=\d+ -->/u)
  assert.doesNotMatch(v1, /fanotes-famd:v2/u)
  assert.match(v2, /<!-- fanotes-famd:v2 chars=\d+ crc=[0-9a-f]{8} -->/u)
  assert.doesNotMatch(v2, /fanotes-famd:v1/u)

  const v1Bytes = Buffer.byteLength(v1, 'utf8')
  const v2Bytes = Buffer.byteLength(v2, 'utf8')
  console.log(`ink-heavy bytes v1=${v1Bytes} v2=${v2Bytes} ratio=${(v2Bytes / v1Bytes).toFixed(4)}`)
  assert.ok(v2Bytes * 2 <= v1Bytes, `v2 ${v2Bytes} is not at most half of v1 ${v1Bytes}`)

  const headerAt = v2.lastIndexOf('<!-- fanotes-famd:v2')
  assert.ok(headerAt > 0)
  const textBeforeInk = v2.slice(0, headerAt).trimEnd()
  assert.equal(textBeforeInk, markdown)
  assert.equal(textBeforeInk.includes('famdPts'), false)
  assert.equal(textBeforeInk.includes('"strokes"'), false)
  const stripped = stripFamdPayload(v2)
  assert.equal(stripped, markdown)
  assert.equal(stripped.includes('famdPts'), false)

  const parsedV1 = parseFamd(v1)
  assert.equal(parsedV1.payload?.schema, 'fanotes-famd-v1')
  assert.equal(parsedV1.markdown, markdown)
  const parsedV2 = parseFamd(v2)
  assert.equal(parsedV2.payload?.schema, 'fanotes-famd-v1')
  assert.equal(parsedV2.markdown, markdown)
  assert.ok(sameFamdPayload(parsedV1.payload, parsedV2.payload))

  const originalStrokes = payload.ink.strokes
  const restoredStrokes = parsedV2.payload.ink.strokes
  assert.equal(restoredStrokes.length, originalStrokes.length)
  for (let index = 0; index < originalStrokes.length; index += 1) {
    const original = originalStrokes[index]
    const restored = restoredStrokes[index]
    assert.equal(restored.color, original.color)
    assert.equal(restored.baseWidth, original.baseWidth)
    assert.equal(restored.width, original.width)
    assert.equal(restored.brush, original.brush)
    assertPoints(original.points, restored.points)
  }
  assert.equal(parsedV2.payload.paperStyle, 'lines')
  assert.deepEqual(parsedV2.payload.worksheets, ['ws-1'])
  assert.equal(parsedV2.payload.noteLinks[0].targetPath, 'Mathe/Skript-Notiz.md')
  assert.equal(parsedV2.payload.noteLinks[0].style, 'text')
  assert.equal(parsedV2.payload.noteBackups[0].content, 'Stand A')
  assert.equal(parsedV2.payload.pageStats.customCounter, 12)
  assert.equal(parsedV2.payload.pageStats.dwellMs, 1500)
  assert.equal(parsedV2.payload.textFields[0].text, 'Hallo')
  assert.equal(parsedV2.payload.ink.title, 'Viel Tinte')

  const truncated = v2.slice(0, headerAt + 80)
  assertCorrupt(() => parseFamd(truncated))
  let presentedAsEmpty = false
  try {
    const bad = parseFamd(truncated)
    presentedAsEmpty = bad.payload == null
  } catch (error) {
    assert.equal(error.code, 'FAMD_CORRUPT')
    presentedAsEmpty = false
  }
  assert.equal(presentedAsEmpty, false)

  const flipped = v2.replace(/crc=([0-9a-f]{8})/u, (_match, hex) => {
    const digits = hex.split('')
    digits[0] = digits[0] === 'a' ? 'b' : 'a'
    return `crc=${digits.join('')}`
  })
  assert.notEqual(flipped, v2)
  assertCorrupt(() => parseFamd(flipped))

  const rejected = convertFamdSource(truncated)
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.source, truncated)
  const rejectedCrc = convertFamdSource(flipped)
  assert.equal(rejectedCrc.status, 'failed')
  assert.equal(rejectedCrc.source, flipped)

  const { createServer } = await import('vite')
  const server = await createServer({
    root: ROOT,
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  })
  try {
    const renderer = await server.ssrLoadModule('/src/lib/famd.ts')
    const fromRenderer = renderer.serializeFamd(markdown, payload, 'v2')
    assert.equal(fromRenderer, v2)
    const rendererParsed = renderer.parseFamd(v2)
    assert.equal(rendererParsed.markdown, markdown)
    assert.equal(rendererParsed.payload.ink.strokes.length, 200)
    assert.equal(rendererParsed.payload.ink.strokes[0].brush, 'fineliner')
    assert.throws(() => renderer.parseFamd(truncated))
    const rendererV1 = renderer.serializeFamd(markdown, payload)
    assert.match(rendererV1, /fanotes-famd:v1/u)
    assert.equal(renderer.parseFamd(rendererV1).payload.schema, 'fanotes-famd-v1')
  } finally {
    await server.close()
  }
  console.log('format ok')
}

const readSource = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8')

const functionBody = (source, name) => {
  const start = source.indexOf(`async function ${name}`)
  assert.ok(start >= 0, name)
  const next = source.indexOf('\nasync function ', start + name.length)
  return source.slice(start, next === -1 ? source.length : next)
}

const checkCreate = () => {
  const updatedAt = '2026-10-31T12:00:00.000Z'
  const encoding = famdEncodingForSave(null)
  assert.equal(encoding, 'v2')
  assert.equal(famdEncodingForSave(''), 'v2')
  assert.equal(famdEncodingForSave(undefined), 'v2')
  const created = createNoteCompanion('# Neu\n\n', updatedAt)
  const viaSaveDecision = serializeFamd('# Neu\n\n', emptyFamdPayload(updatedAt), encoding)
  assert.equal(created, viaSaveDecision)
  assert.match(created, /<!-- fanotes-famd:v2 chars=\d+ crc=[0-9a-f]{8} -->/u)
  assert.doesNotMatch(created, /fanotes-famd:v1/u)
  const reloaded = parseFamd(created)
  assert.equal(reloaded.markdown, '# Neu')
  assert.equal(reloaded.payload.updatedAt, updatedAt)
  assert.equal(reloaded.payload.ink, null)
  assert.equal(reloaded.payload.schema, 'fanotes-famd-v1')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-famd-create-'))
  try {
    const file = path.join(dir, 'alt.famd')
    const originalPayload = richPayload()
    const v1 = serializeFamd('# Alt\n\n', originalPayload)
    fs.writeFileSync(file, v1, { mode: 0o600 })
    const existing = fs.readFileSync(file, 'utf8')
    assert.equal(famdEncodingForSave(existing), 'v1')
    const editedMarkdown = '# Alt\n\nEin Satz.'
    const kept = serializeFamd(
      editedMarkdown,
      parseFamd(existing).payload,
      famdEncodingForSave(existing),
    )
    fs.writeFileSync(file, kept, { mode: 0o600 })
    const saved = fs.readFileSync(file, 'utf8')
    assert.equal(saved, kept)
    assert.match(saved, /<!-- fanotes-famd:v1 chars=\d+ -->/u)
    assert.doesNotMatch(saved, /fanotes-famd:v2/u)
    const parsed = parseFamd(saved)
    assert.equal(parsed.markdown, editedMarkdown)
    assert.ok(sameFamdPayload(parseFamd(v1).payload, parsed.payload))
    assert.equal(parsed.payload.ink.strokes[0].brush, 'fineliner')
    assert.equal(parsed.payload.ink.strokes[0].color, '#3478df')
    assert.equal(parsed.payload.ink.strokes[0].baseWidth, 2.5)
    assert.equal(parsed.payload.ink.strokes[0].points[0].pressure, 0.3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const main = readSource('electron/main.cjs')
  const writer = functionBody(main, 'writeFamdCompanionNow')
  // A heavy rewrite is composed off the UI thread. The merge itself still
  // reads the file that is already there, and a missing file is the only
  // error that falls through. Anything else, including a torn note, is thrown.
  assert.match(writer, /composeFamdCompanion\(/)
  assert.match(writer, /if \(error\?\.code !== 'ENOENT'\) throw error/)
  const codec = readSource('electron/famd.cjs')
  const composeStart = codec.indexOf('function composeFamdCompanion')
  assert.ok(composeStart >= 0)
  const composeEnd = codec.indexOf('\nfunction ', composeStart + 10)
  const compose = codec.slice(composeStart, composeEnd === -1 ? codec.length : composeEnd)
  assert.match(compose, /parseFamd\(existingSource\)/)
  const composeSave = compose.indexOf('serializeFamd(body, payload, v2codec.famdEncodingForSave(existingSource))')
  assert.ok(composeSave > 0)
  assert.equal(compose.slice(0, composeSave).includes('catch'), false)
  const mutator = functionBody(main, 'mutateFamdCompanion')
  const mutatorSave = mutator.indexOf('serializeFamd(nextBody, nextPayload, famdEncodingForSave(existingSource))')
  assert.ok(mutatorSave > 0)
  assert.equal(mutator.slice(0, mutatorSave).includes('catch'), false)
  const creator = functionBody(main, 'writeFamdCompanion')
  assert.match(creator, /writeFamdCompanionNow\(/)
  assert.match(main, /await writeFamdCompanion\(entry\.relativePath, `# \$\{title\}\\n\\n`\)/)
  const writeAt = main.indexOf('const existingFamdSource = isFamdFile')
  assert.ok(writeAt >= 0)
  const writeWindow = main.slice(writeAt, writeAt + 700)
  assert.match(writeWindow, /parseFamd\(existingFamdSource \?\? ''\)/)
  assert.match(writeWindow, /famdEncodingForSave\(existingFamdSource\)/)
  assert.equal(writeWindow.includes('catch'), false)
  console.log('create ok')
}

const listFamds = (dir, found = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFamds(full, found)
    else found.push(full)
  }
  return found
}

const checkConvert = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-famd-convert-'))
  try {
    const payload = richPayload()
    const goodText = serializeFamd(markdown, payload)
    const v2Text = serializeFamd('# Schon kompakt\n', emptyFamdPayload('2026-10-31T12:00:00.000Z'), 'v2')
    const brokenText = 'Kaputt\n\n<!-- fanotes-famd:v1 chars=4 -->\n{\n'
    const plainText = '# Nur Text\n'
    const good = path.join(dir, 'gut.famd')
    const already = path.join(dir, 'neu.famd')
    const broken = path.join(dir, 'kaputt.famd')
    const plain = path.join(dir, 'text.md')
    const hiddenDir = path.join(dir, '.fanotes')
    fs.mkdirSync(hiddenDir)
    const hidden = path.join(hiddenDir, 'intern.famd')
    fs.writeFileSync(good, goodText)
    fs.writeFileSync(already, v2Text)
    fs.writeFileSync(broken, brokenText)
    fs.writeFileSync(plain, plainText)
    fs.writeFileSync(hidden, goodText)
    const brokenBefore = fs.readFileSync(broken)
    const hiddenBefore = fs.readFileSync(hidden)
    const alreadyBefore = fs.readFileSync(already)
    const plainBefore = fs.readFileSync(plain)

    const counts = convertFamdDirectory(dir)
    console.log(`convert counts ${JSON.stringify(counts)}`)
    assert.deepEqual(counts, { converted: 1, skipped: 2, failed: 1 })

    const converted = fs.readFileSync(good, 'utf8')
    assert.match(converted, /<!-- fanotes-famd:v2 chars=\d+ crc=[0-9a-f]{8} -->/u)
    const originalParsed = parseFamd(goodText)
    const again = parseFamd(converted)
    assert.equal(again.markdown, originalParsed.markdown)
    assert.ok(sameFamdPayload(originalParsed.payload, again.payload))
    assert.equal(again.payload.ink.strokes[0].brush, 'fineliner')
    assert.equal(again.payload.ink.strokes[0].color, '#3478df')
    assert.equal(again.payload.textFields[0].text, 'Hallo')

    assert.deepEqual(fs.readFileSync(broken), brokenBefore)
    assert.deepEqual(fs.readFileSync(hidden), hiddenBefore)
    assert.deepEqual(fs.readFileSync(already), alreadyBefore)
    assert.deepEqual(fs.readFileSync(plain), plainBefore)
    const leftovers = listFamds(dir).filter((file) => file.endsWith('.famd-new'))
    assert.deepEqual(leftovers, [])

    const settings = readSource('src/components/SettingsModal.tsx')
    assert.ok(settings.includes('title="Alte Notizen auf den aktuellen Standard"'))
    assert.ok(settings.includes('Alles umstellen'))
    assert.ok(settings.includes('onConvertNotes'))
    assert.ok(settings.includes('title="Notizen ins kompakte Format"'))
    assert.ok(settings.includes('Kompakt speichern'))
    assert.ok(settings.includes('onConvertFamd'))
    const hidpiAt = settings.indexOf('Alte Notizen auf den aktuellen Standard')
    const compactAt = settings.indexOf('Notizen ins kompakte Format')
    assert.ok(hidpiAt >= 0 && compactAt > hidpiAt)
    assert.ok(settings.slice(hidpiAt, compactAt).includes('onConvertNotes()'))
    assert.ok(settings.slice(compactAt).includes('onConvertFamd()'))

    const app = readSource('src/App.tsx')
    assert.ok(app.includes('onConvertNotes={convertAllNotesToCurrentStandard}'))
    assert.ok(app.includes('onConvertFamd={convertAllFamdNotes}'))
    assert.ok(app.includes('window.fanotes.convertFamdNotes()'))
    assert.ok(app.includes('convertNoteSourceToCurrentStandard'))

    const preload = readSource('electron/preload.cjs')
    assert.ok(preload.includes("convertFamdNotes: 'fanotes:convert-famd-notes'"))
    assert.ok(preload.includes('convertFamdNotes: () => invoke(CHANNELS.convertFamdNotes)'))

    const main = readSource('electron/main.cjs')
    assert.ok(main.includes("convertFamdNotes: 'fanotes:convert-famd-notes'"))
    assert.match(main, /handle\(IPC\.convertFamdNotes,[\s\S]*return convertFamdDirectory\(root\)/)
    assert.ok(main.includes('famdEncodingForSave'))

    const standard = readSource('src/lib/noteStandard.ts')
    assert.ok(standard.includes('famdEncodingForSave(original)'))
    console.log('convert ok')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const main = async () => {
  if (!MODES.has(mode)) {
    console.error('usage: node scripts/check-famd-v2.cjs [format|create|convert|all]')
    process.exit(2)
  }
  if (mode === 'format' || mode === 'all') await checkFormat()
  if (mode === 'create' || mode === 'all') checkCreate()
  if (mode === 'convert' || mode === 'all') checkConvert()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
