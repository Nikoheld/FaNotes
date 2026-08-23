import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// UJI Pen Characters v2, CC BY 4.0, DOI 10.24432/C5FG8S. The caller
// supplies the pinned data locally; this light audit neither downloads data
// nor starts Chromium or a recognition model.
const dataset = process.env.FANOTES_UJI_DATASET?.trim()
assert.ok(
  dataset && fs.statSync(dataset).isFile(),
  'FANOTES_UJI_DATASET muss auf den geprueften UJI-Datensatz zeigen.',
)

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const GLYPH_HEIGHT = 0.15
const TOP = 0.22
const LEFT = 0.14
const APPEND_GAP_PIXELS = 6
const CONNECTED_GAP_PIXELS = -3
const PAIR_OFFSETS = [1, 7, 19]
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const requestedWriterCount = Number(process.env.FANOTES_UJI_INCREMENTAL_WRITERS ?? 8)
const writerCount = Number.isFinite(requestedWriterCount)
  ? Math.max(2, Math.min(60, Math.round(requestedWriterCount)))
  : 8

const parseDataset = (source) => {
  const lines = source.split(/\r?\n/u)
  const records = []
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = /^WORD\s+([A-Za-z0-9])\s+((?:trn|tst)_(?:UJI|UPV)_W\d+)-(0[12])$/u
      .exec(lines[cursor].trim())
    if (!header) continue
    const strokeHeader = /^NUMSTROKES\s+(\d+)$/u.exec((lines[++cursor] ?? '').trim())
    assert.ok(strokeHeader, `Ungueltiger UJI-Stiftkopf bei Zeile ${cursor + 1}.`)
    const strokeCount = Number(strokeHeader[1])
    const strokes = []
    for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
      const match = /^POINTS\s+(\d+)\s+#\s+(.+)$/u.exec((lines[++cursor] ?? '').trim())
      assert.ok(match, `Ungueltiger UJI-Stiftzug bei Zeile ${cursor + 1}.`)
      const pointCount = Number(match[1])
      const values = match[2].trim().split(/\s+/u).map(Number)
      assert.equal(values.length, pointCount * 2, `UJI-Punktzahl stimmt bei Zeile ${cursor + 1} nicht.`)
      strokes.push(Array.from({ length: pointCount }, (_, pointIndex) => [
        values[pointIndex * 2],
        values[pointIndex * 2 + 1],
      ]))
    }
    records.push({
      char: header[1],
      writer: header[2],
      session: Number(header[3]),
      strokes,
    })
  }
  return records
}

const strokeExtent = (strokes) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  assert.ok(points.length, 'Ein Audit-Stiftzug darf nicht leer sein.')
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

const extentWidth = (extent) => extent.maxX - extent.minX
const extentHeight = (extent) => extent.maxY - extent.minY

const positionGlyph = (record, left, timeStart) => {
  const rawPoints = record.strokes.flat()
  const minX = Math.min(...rawPoints.map(([x]) => x))
  const maxX = Math.max(...rawPoints.map(([x]) => x))
  const minY = Math.min(...rawPoints.map(([, y]) => y))
  const maxY = Math.max(...rawPoints.map(([, y]) => y))
  const scale = GLYPH_HEIGHT / Math.max(1, maxY - minY)
  let time = timeStart
  const strokes = record.strokes.map((rawStroke) => ({
    baseWidth: 3.7,
    pressureEnabled: false,
    points: rawStroke
      .filter(([x, y], index) => (
        index === 0 || x !== rawStroke[index - 1][0] || y !== rawStroke[index - 1][1]
      ))
      .map(([x, y]) => ({
        x: left + (x - minX) * scale * SOURCE_HEIGHT / SOURCE_WIDTH,
        y: TOP + (y - minY) * scale,
        t: time++,
        pressure: 0.62,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
      })),
  })).filter((stroke) => stroke.points.length)
  return {
    strokes,
    width: Math.max(1 / SOURCE_WIDTH, (maxX - minX) * scale * SOURCE_HEIGHT / SOURCE_WIDTH),
    nextTime: time + 8,
  }
}

const strokePathLength = (stroke) => stroke.points.slice(1).reduce((sum, point, index) => {
  const previous = stroke.points[index]
  return sum + Math.hypot(
    (point.x - previous.x) * SOURCE_WIDTH,
    (point.y - previous.y) * SOURCE_HEIGHT,
  )
}, 0)

const primaryStrokeIndex = (strokes) => strokes
  .map((stroke, index) => ({ index, length: strokePathLength(stroke) }))
  .sort((first, second) => second.length - first.length)[0]?.index ?? 0

const orientTowards = (stroke, edge) => {
  const points = stroke.points.map((point) => ({ ...point }))
  if (points.length < 2) return points
  const first = points[0]
  const last = points.at(-1)
  const shouldReverse = edge === 'right' ? last.x < first.x : first.x > last.x
  return shouldReverse ? points.reverse() : points
}

// Joins the dominant, real body strokes of two glyphs into one uninterrupted
// pen-down trajectory. Every remaining real UJI stroke is delayed behind that
// body, exactly the ordering that must not prove a hard one-character count.
const connectedPair = (firstRecord, secondRecord, left, timeStart) => {
  const first = positionGlyph(firstRecord, left, timeStart)
  const second = positionGlyph(
    secondRecord,
    left + first.width + CONNECTED_GAP_PIXELS / SOURCE_WIDTH,
    first.nextTime,
  )
  const firstPrimary = primaryStrokeIndex(first.strokes)
  const secondPrimary = primaryStrokeIndex(second.strokes)
  const firstBody = orientTowards(first.strokes[firstPrimary], 'right')
  const secondBody = orientTowards(second.strokes[secondPrimary], 'left')
  assert.ok(firstBody.length && secondBody.length, 'Ein verbundenes Paar braucht zwei echte Koerper.')
  const connector = {
    ...firstBody.at(-1),
    x: (firstBody.at(-1).x + secondBody[0].x) / 2,
    y: (firstBody.at(-1).y + secondBody[0].y) / 2,
  }
  let time = timeStart
  const joinedBody = {
    baseWidth: 3.7,
    pressureEnabled: false,
    points: [...firstBody, connector, ...secondBody].map((point) => ({
      ...point,
      t: time++,
    })),
  }
  const delayed = [
    ...first.strokes.filter((_, index) => index !== firstPrimary),
    ...second.strokes.filter((_, index) => index !== secondPrimary),
  ].map((stroke) => {
    time += 7
    return {
      ...stroke,
      points: stroke.points.map((point) => ({ ...point, t: time++ })),
    }
  })
  return [joinedBody, ...delayed]
}

const physicalGeometry = (strokes) => {
  const extent = strokeExtent(strokes)
  const width = extentWidth(extent) * SOURCE_WIDTH
  const height = extentHeight(extent) * SOURCE_HEIGHT
  return {
    width,
    height,
    ratio: width / Math.max(1, height),
  }
}

const round = (value, digits = 3) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const percentile = (sorted, fraction) => sorted[Math.round((sorted.length - 1) * fraction)] ?? 0

const distribution = (values) => {
  const sorted = [...values].sort((first, second) => first - second)
  return {
    count: sorted.length,
    min: round(sorted[0] ?? 0),
    p10: round(percentile(sorted, 0.1)),
    p25: round(percentile(sorted, 0.25)),
    p50: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    p90: round(percentile(sorted, 0.9)),
    max: round(sorted.at(-1) ?? 0),
  }
}

const geometrySummary = (geometries) => ({
  addedWidthPixels: distribution(geometries.map((entry) => entry.width)),
  addedHeightPixels: distribution(geometries.map((entry) => entry.height)),
  addedWidthHeightRatio: distribution(geometries.map((entry) => entry.ratio)),
})

const percent = (part, total) => round(part / Math.max(1, total) * 100, 2)

const increment = (object, key) => {
  object[key] = (object[key] ?? 0) + 1
}

const resultCount = (hint) => hint?.characterCount

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  // One Vite SSR load is sufficient; all writer/case work below is synchronous
  // and in-process. This module has no browser, Chromium, ONNX, or ML runtime.
  const { incrementalTextCharacterHint } = await server.ssrLoadModule(
    '/../src/lib/incrementalTextRecognition.ts',
  )
  const allRecords = parseDataset(fs.readFileSync(dataset, 'utf8'))
  const sessionTwo = allRecords.filter((record) => record.session === 2)
  const writers = [...new Set(sessionTwo.map((record) => record.writer))]
    .sort((first, second) => first.localeCompare(second, 'en', { numeric: true }))
    .slice(0, writerCount)
  assert.ok(writers.length >= 2, 'Der UJI-Audit braucht mindestens zwei Writer mit Session 2.')

  const singleOutcome = { plusOne: 0, abstention: 0, incorrectCount: 0 }
  const connectedOutcome = {
    falsePlusOne: 0,
    correctPlusTwo: 0,
    retainedPrefixCount: 0,
    abstention: 0,
    otherCount: 0,
  }
  const accessoryOutcome = {
    retainedCharacterCount: 0,
    abstention: 0,
    falsePlusOne: 0,
    otherCount: 0,
  }
  const singleGeometry = []
  const connectedGeometry = []
  const accessoryGeometry = []
  let realAccessoryStrokeCount = 0
  const singleIncorrect = []
  const connectedFalsePlusOne = []
  const accessoryFalsePlusOne = []
  const byWriter = []

  // Writers are deliberately processed one after another, retaining only the
  // compact aggregate and bounded failure samples.
  writers.forEach((writer) => {
    const lookup = new Map(sessionTwo
      .filter((record) => record.writer === writer)
      .map((record) => [record.char, record]))
    const chars = [...lookup.keys()].sort((first, second) => first.localeCompare(second, 'en'))
    const prefixRecord = lookup.get('o') ?? lookup.get('O') ?? lookup.get(chars[0])
    assert.ok(prefixRecord, `Kein stabiles Praefix fuer ${writer}.`)
    const prefix = positionGlyph(prefixRecord, LEFT, 0)
    const previousPrefix = {
      strokes: prefix.strokes,
      characterCount: 1,
      text: prefixRecord.char,
      pendingStrokeIndex: 0,
      prefixText: '',
    }
    const writerSingle = { plusOne: 0, abstention: 0, incorrectCount: 0 }
    const writerConnected = {
      falsePlusOne: 0,
      correctPlusTwo: 0,
      retainedPrefixCount: 0,
      abstention: 0,
      otherCount: 0,
    }
    const writerAccessory = {
      retainedCharacterCount: 0,
      abstention: 0,
      falsePlusOne: 0,
      otherCount: 0,
    }

    chars.forEach((char, charIndex) => {
      const record = lookup.get(char)
      const appended = positionGlyph(
        record,
        LEFT + prefix.width + APPEND_GAP_PIXELS / SOURCE_WIDTH,
        prefix.nextTime,
      )
      const singleHint = incrementalTextCharacterHint(
        previousPrefix,
        [...prefix.strokes, ...appended.strokes],
      )
      const singleCount = resultCount(singleHint)
      const singleKey = singleCount === 2
        ? 'plusOne'
        : singleCount === undefined
          ? 'abstention'
          : 'incorrectCount'
      increment(singleOutcome, singleKey)
      increment(writerSingle, singleKey)
      const singleShape = physicalGeometry(appended.strokes)
      singleGeometry.push(singleShape)
      if (singleKey === 'incorrectCount' && singleIncorrect.length < 24) {
        singleIncorrect.push({
          writer,
          char,
          returnedCount: singleCount,
          strokes: record.strokes.length,
          addedWidthHeightRatio: round(singleShape.ratio),
        })
      }

      PAIR_OFFSETS.forEach((offset) => {
        const secondChar = chars[(charIndex + offset) % chars.length]
        const secondRecord = lookup.get(secondChar)
        if (!secondRecord) return
        const connected = connectedPair(
          record,
          secondRecord,
          LEFT + prefix.width + APPEND_GAP_PIXELS / SOURCE_WIDTH,
          prefix.nextTime,
        )
        const connectedHint = incrementalTextCharacterHint(
          previousPrefix,
          [...prefix.strokes, ...connected],
        )
        const connectedCount = resultCount(connectedHint)
        const connectedKey = connectedCount === 2
          ? 'falsePlusOne'
          : connectedCount === 3
            ? 'correctPlusTwo'
            : connectedCount === 1
              ? 'retainedPrefixCount'
              : connectedCount === undefined
                ? 'abstention'
                : 'otherCount'
        increment(connectedOutcome, connectedKey)
        increment(writerConnected, connectedKey)
        const connectedShape = physicalGeometry(connected)
        connectedGeometry.push(connectedShape)
        if (connectedKey === 'falsePlusOne' && connectedFalsePlusOne.length < 24) {
          connectedFalsePlusOne.push({
            writer,
            expected: `${char}${secondChar}`,
            returnedCount: connectedCount,
            strokeCounts: [record.strokes.length, secondRecord.strokes.length],
            addedWidthHeightRatio: round(connectedShape.ratio),
          })
        }
      })

      // A delayed-accessory case uses one real dominant body followed by all
      // remaining real strokes only when every remainder is small and near
      // that body. Thus no second structural stem is mislabeled as accessory.
      if (appended.strokes.length < 2) return
      const primaryIndex = primaryStrokeIndex(appended.strokes)
      const body = appended.strokes[primaryIndex]
      const accessories = appended.strokes.filter((_, index) => index !== primaryIndex)
      const fullExtent = strokeExtent(appended.strokes)
      const bodyExtent = strokeExtent([body])
      const glyphHeight = Math.max(0.001, extentHeight(fullExtent))
      const bodyIsSubstantial = extentHeight(bodyExtent) >= glyphHeight * 0.45
      const everyRemainderIsAccessory = accessories.every((stroke) => {
        const extent = strokeExtent([stroke])
        return (
          extentHeight(extent) <= glyphHeight * 0.3 &&
          extentWidth(extent) <= glyphHeight * 1.25 &&
          extent.maxX >= bodyExtent.minX - glyphHeight * 0.58 &&
          extent.minX <= bodyExtent.maxX + glyphHeight * 0.58
        )
      })
      if (!bodyIsSubstantial || !everyRemainderIsAccessory) return

      const beforeAccessoryStrokes = [...prefix.strokes, body]
      let accessoryTime = Math.max(
        ...beforeAccessoryStrokes.flatMap((stroke) => stroke.points.map((point) => point.t)),
      ) + 7
      const delayedAccessories = accessories.map((stroke) => ({
        ...stroke,
        points: stroke.points.map((point) => ({ ...point, t: accessoryTime++ })),
      }))
      const previousWithBody = {
        strokes: beforeAccessoryStrokes,
        characterCount: 2,
        text: `${prefixRecord.char}${char}`,
        pendingStrokeIndex: prefix.strokes.length,
        prefixText: prefixRecord.char,
      }
      const accessoryHint = incrementalTextCharacterHint(
        previousWithBody,
        [...beforeAccessoryStrokes, ...delayedAccessories],
      )
      const accessoryCount = resultCount(accessoryHint)
      const accessoryKey = accessoryCount === 2
        ? 'retainedCharacterCount'
        : accessoryCount === undefined
          ? 'abstention'
          : accessoryCount === 3
            ? 'falsePlusOne'
            : 'otherCount'
      increment(accessoryOutcome, accessoryKey)
      increment(writerAccessory, accessoryKey)
      const accessoryShape = physicalGeometry(delayedAccessories)
      accessoryGeometry.push(accessoryShape)
      realAccessoryStrokeCount += delayedAccessories.length
      if (accessoryKey === 'falsePlusOne' && accessoryFalsePlusOne.length < 24) {
        accessoryFalsePlusOne.push({
          writer,
          char,
          returnedCount: accessoryCount,
          accessoryStrokes: accessories.length,
          addedWidthHeightRatio: round(accessoryShape.ratio),
        })
      }
    })

    byWriter.push({
      writer,
      characters: chars.length,
      appendedSingle: writerSingle,
      connectedDouble: writerConnected,
      delayedAccessory: writerAccessory,
    })
  })

  const singleCases = singleGeometry.length
  const connectedCases = connectedGeometry.length
  const accessoryCases = accessoryGeometry.length
  const result = {
    dataset: {
      session: 2,
      writers: writers.length,
      writerNames: writers,
      alphanumericRecords: sessionTwo.filter((record) => writers.includes(record.writer)).length,
      geometrySpace: `${SOURCE_WIDTH}x${SOURCE_HEIGHT} physical pixels`,
    },
    appendedSingle: {
      cases: singleCases,
      ...singleOutcome,
      plusOneRate: percent(singleOutcome.plusOne, singleCases),
      abstentionRate: percent(singleOutcome.abstention, singleCases),
      incorrectCountRate: percent(singleOutcome.incorrectCount, singleCases),
      geometry: geometrySummary(singleGeometry),
      incorrect: singleIncorrect,
    },
    connectedDouble: {
      cases: connectedCases,
      ...connectedOutcome,
      falsePlusOneRate: percent(connectedOutcome.falsePlusOne, connectedCases),
      geometry: geometrySummary(connectedGeometry),
      falsePlusOneExamples: connectedFalsePlusOne,
    },
    delayedAccessory: {
      cases: accessoryCases,
      realAccessoryStrokes: realAccessoryStrokeCount,
      ...accessoryOutcome,
      falsePlusOneRate: percent(accessoryOutcome.falsePlusOne, accessoryCases),
      geometry: geometrySummary(accessoryGeometry),
      falsePlusOneExamples: accessoryFalsePlusOne,
    },
    byWriter,
  }

  console.log(JSON.stringify(result, null, 2))

  if (process.env.FANOTES_UJI_INCREMENTAL_STRICT === '1') {
    assert.equal(
      singleOutcome.incorrectCount,
      0,
      `Einzelne echte Glyphen erzeugen falsche exakte Counts: ${JSON.stringify(singleIncorrect)}`,
    )
    assert.equal(
      connectedOutcome.falsePlusOne,
      0,
      `Zwei verbundene neue Glyphen werden faelschlich als exakt +1 gezaehlt: ${JSON.stringify(connectedFalsePlusOne)}`,
    )
    assert.equal(
      accessoryOutcome.falsePlusOne,
      0,
      `Echte nachtraegliche Zubehoerstriche werden faelschlich als +1 gezaehlt: ${JSON.stringify(accessoryFalsePlusOne)}`,
    )
  }
} finally {
  await server.close()
}
