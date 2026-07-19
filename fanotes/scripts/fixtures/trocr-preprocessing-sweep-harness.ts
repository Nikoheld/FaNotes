import type { Stroke } from '../../../src/types'
import iamOnlineFixture from './iam-online-a01-001z-01.json'
import {
  renderNeuralTextLineImage,
  type NeuralLineRenderOptions,
} from '../../src/lib/neuralTextRecognition'
import { recognizeTrocrLine } from '../../src/lib/trocrClient'

type UjiRecord = {
  char: string
  writer: string
  session: 1 | 2
  strokes: [number, number][][]
}

type Case = {
  id: string
  expected: string
  strokes: Stroke[]
  width: number
  height: number
}

const editDistance = (first: string, second: string) => {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex]
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current.push(Math.min(
        previous[secondIndex] + 1,
        current[secondIndex - 1] + 1,
        previous[secondIndex - 1] + Number(first[firstIndex - 1] !== second[secondIndex - 1]),
      ))
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[second.length]
}

const normalized = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim()

const normalizedUjiStrokes = (record: UjiRecord): Stroke[] => {
  const points = record.strokes.flat()
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const maxY = Math.max(...points.map(([, y]) => y))
  const scale = Math.min(310 / Math.max(1, maxX - minX), 300 / Math.max(1, maxY - minY))
  let time = 0
  return record.strokes.map((stroke) => ({
    baseWidth: 3.7,
    pressureEnabled: false,
    points: stroke.map(([x, y]) => ({
      x: 0.5 + (x - (minX + maxX) / 2) * scale / 900,
      y: 0.5 + (y - (minY + maxY) / 2) * scale / 560,
      t: time++, pressure: 0.62, tiltX: 0, tiltY: 0, pointerType: 'pen',
    })),
  }))
}

const createUjiWordStrokes = (records: UjiRecord[], writer: string, value: string): Stroke[] => {
  let cursor = 0.08
  let time = 0
  return [...value].flatMap((char) => {
    const record = records.find((entry) => entry.writer === writer && entry.session === 2 && entry.char === char)
    if (!record) return []
    const source = normalizedUjiStrokes(record)
    const points = source.flatMap((stroke) => stroke.points)
    const minX = Math.min(...points.map((point) => point.x))
    const maxX = Math.max(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxY = Math.max(...points.map((point) => point.y))
    const scale = 0.16 / Math.max(0.001, maxY - minY)
    const width = Math.max(0.012, (maxX - minX) * scale)
    const positioned = source.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        x: cursor + (point.x - minX) * scale,
        y: 0.18 + (point.y - minY) * scale,
        t: time++,
      })),
    }))
    cursor += width + 0.009
    return positioned
  })
}

const iamStrokes: Stroke[] = iamOnlineFixture.strokes.map((points) => ({
  baseWidth: 3.7,
  pressureEnabled: true,
  points: points.map(([x, y, t]) => ({
    x,
    y,
    t,
    pressure: 0.62,
    tiltX: 0,
    tiltY: 0,
    pointerType: 'pen',
  })),
}))

const variants: Array<{ id: string; options: NeuralLineRenderOptions }> = [
  { id: 'baseline', options: {} },
  { id: 'vertical-22', options: { marginXRatio: 0.22, marginYRatio: 0.22 } },
  { id: 'vertical-28', options: { marginXRatio: 0.22, marginYRatio: 0.28 } },
  { id: 'vertical-34', options: { marginXRatio: 0.22, marginYRatio: 0.34 } },
  { id: 'vertical-40', options: { marginXRatio: 0.22, marginYRatio: 0.40 } },
]

Object.assign(window, {
  fanotes: {
    platform: 'web',
  },
})

export const runTrocrPreprocessingSweep = async (records: UjiRecord[]) => {
  const usableWriters = [...new Set(records.map((entry) => entry.writer))]
    .filter((writer) => writer.startsWith('tst_'))
    .slice(0, 12)
  const wordValues = [
    'test', 'hallo', 'lernen', 'mathe', 'computer', 'schule',
    'arbeit', 'privat', 'notizen', 'wissen', 'gleichung', 'formel',
  ]
  const cases: Case[] = usableWriters.flatMap((writer, writerIndex) => {
    const expected = wordValues[writerIndex % wordValues.length]
    const strokes = createUjiWordStrokes(records, writer, expected)
    return strokes.length ? [{
      id: `${writer}-${expected}`,
      expected,
      strokes,
      width: 900,
      height: 560,
    }] : []
  })
  cases.push({
    id: 'iam-online-a01-001z-01',
    expected: iamOnlineFixture.truth,
    strokes: iamStrokes,
    width: iamOnlineFixture.sourceWidth,
    height: iamOnlineFixture.sourceHeight,
  })

  const results = []
  for (const variant of variants) {
    const predictions = []
    let edits = 0
    let characters = 0
    const startedAt = performance.now()
    for (const item of cases) {
      const image = renderNeuralTextLineImage(item.strokes, item.width, item.height, variant.options)
      if (!image) throw new Error(`Keine physische Zeile für ${item.id}.`)
      const prediction = normalized(await recognizeTrocrLine(image.pixels, image.width, image.height))
      const expected = normalized(item.expected)
      const distance = editDistance(expected, prediction)
      edits += distance
      characters += expected.length
      predictions.push({
        id: item.id,
        expected,
        prediction,
        edits: distance,
        width: image.width,
        height: image.height,
      })
    }
    results.push({
      id: variant.id,
      options: variant.options,
      cer: edits / Math.max(1, characters),
      edits,
      characters,
      durationMs: Math.round(performance.now() - startedAt),
      predictions,
    })
  }
  return results.sort((first, second) => first.cer - second.cer)
}
