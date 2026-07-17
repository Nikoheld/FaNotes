import {
  connectedTextSegmentationHypotheses,
  estimatePenLiftTextCharacterCount,
  segmentStrokes,
  textCutCandidatesForTests,
} from '../../../src/lib/recognition'
import type { Stroke } from '../../../src/types'

type RawStroke = [number, number][]

export type UjiPairRecord = {
  char: string
  writer: string
  session: 1 | 2
  strokes: RawStroke[]
}

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const GLYPH_HEIGHT = 0.16
const TOP = 0.22

const normalizedStrokes = (record: UjiPairRecord): Stroke[] => {
  const points = record.strokes.flat()
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const maxY = Math.max(...points.map(([, y]) => y))
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const scale = Math.min(310 / width, 300 / height)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  let time = 0
  return record.strokes.map((raw) => ({
    baseWidth: 3.7,
    pressureEnabled: false,
    points: raw
      .filter(([x, y], index) => index === 0 || x !== raw[index - 1][0] || y !== raw[index - 1][1])
      .map(([x, y]) => ({
        x: 0.5 + (x - centerX) * scale / SOURCE_WIDTH,
        y: 0.5 + (y - centerY) * scale / SOURCE_HEIGHT,
        t: time++,
        pressure: 0.62,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen' as const,
      })),
  })).filter((stroke) => stroke.points.length)
}

const positionGlyph = (
  record: UjiPairRecord,
  left: number,
  timeStart: number,
) => {
  const source = normalizedStrokes(record)
  const points = source.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  const scale = GLYPH_HEIGHT / Math.max(0.001, maxY - minY)
  let time = timeStart
  const strokes = source.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      x: left + (point.x - minX) * scale,
      y: TOP + (point.y - minY) * scale,
      t: time++,
    })),
  }))
  return {
    strokes,
    width: Math.max(0.004, (maxX - minX) * scale),
    nextTime: time + 8,
  }
}

const pairStrokes = (
  first: UjiPairRecord,
  second: UjiPairRecord,
  gapPixels: number,
) => {
  const left = positionGlyph(first, 0.18, 0)
  const right = positionGlyph(second, 0.18 + left.width + gapPixels / SOURCE_WIDTH, left.nextTime)
  return [...left.strokes, ...right.strokes]
}

type PairResult = {
  writer: string
  expected: string
  gapPixels: number
  strokeCounts: [number, number]
  baseClusters: number
  estimatedCount: number | null
  hypothesisSizes: number[]
  hasTwoPartPath: boolean
}

const summarize = (results: PairResult[]) => {
  const failures = results.filter((entry) => !entry.hasTwoPartPath)
  const direct = results.filter((entry) => entry.baseClusters === 2)
  const estimated = results.filter((entry) => entry.estimatedCount === 2)
  const ratesByGap = [...new Set(results.map((entry) => entry.gapPixels))].map((gapPixels) => {
    const group = results.filter((entry) => entry.gapPixels === gapPixels)
    const missed = group.filter((entry) => !entry.hasTwoPartPath)
    return {
      gapPixels,
      pairs: group.length,
      available: group.length - missed.length,
      rate: Math.round((group.length - missed.length) / Math.max(1, group.length) * 10_000) / 100,
    }
  })
  const failurePairs = new Map<string, number>()
  failures.forEach((entry) => failurePairs.set(entry.expected, (failurePairs.get(entry.expected) ?? 0) + 1))
  return {
    pairs: results.length,
    directClusters: direct.length,
    exactCount: estimated.length,
    available: results.length - failures.length,
    availability: Math.round((results.length - failures.length) / Math.max(1, results.length) * 10_000) / 100,
    ratesByGap,
    topFailurePairs: [...failurePairs.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
      .slice(0, 30),
    failures: failures.slice(0, 80),
  }
}

export const runUjiPairSegmentationAudit = (records: UjiPairRecord[]) => {
  const writers = [...new Set(records.map((entry) => entry.writer))].sort()
  const chars = [...new Set(records.map((entry) => entry.char))].sort((a, b) => a.localeCompare(b, 'en'))
  const offsets = [1, 7, 19]
  const gaps = [-4, 0, 1]
  const results: PairResult[] = []

  writers.forEach((writer) => {
    const lookup = new Map(records
      .filter((entry) => entry.writer === writer && entry.session === 1)
      .map((entry) => [entry.char, entry]))
    chars.forEach((firstChar, charIndex) => {
      offsets.forEach((offset) => {
        const secondChar = chars[(charIndex + offset) % chars.length]
        const first = lookup.get(firstChar)
        const second = lookup.get(secondChar)
        if (!first || !second) return
        gaps.forEach((gapPixels) => {
          const strokes = pairStrokes(first, second, gapPixels)
          const clusters = segmentStrokes(strokes, 'text')
          const estimatedCount = estimatePenLiftTextCharacterCount(strokes)
          const hypothesisSizes = [...new Set(clusters.flatMap((cluster) => (
            connectedTextSegmentationHypotheses(
              cluster,
              clusters.length === 1 && estimatedCount === 2 ? 2 : undefined,
            ).map((hypothesis) => hypothesis.length)
          )))].sort((a, b) => a - b)
          results.push({
            writer,
            expected: `${firstChar}${secondChar}`,
            gapPixels,
            strokeCounts: [first.strokes.length, second.strokes.length],
            baseClusters: clusters.length,
            estimatedCount,
            hypothesisSizes,
            hasTwoPartPath: clusters.length === 2 || (
              clusters.length === 1 && hypothesisSizes.includes(2)
            ),
          })
        })
      })
    })
  })

  const singleResults = records
    .filter((entry) => entry.session === 1)
    .map((entry) => {
      const strokes = normalizedStrokes(entry)
      const clusters = segmentStrokes(strokes, 'text')
      return {
        writer: entry.writer,
        char: entry.char,
        strokeCount: entry.strokes.length,
        strokeBoxes: strokes.map((stroke) => {
          const points = stroke.points
          return {
            minX: Math.round(Math.min(...points.map((point) => point.x)) * SOURCE_WIDTH * 10) / 10,
            maxX: Math.round(Math.max(...points.map((point) => point.x)) * SOURCE_WIDTH * 10) / 10,
            minY: Math.round(Math.min(...points.map((point) => point.y)) * SOURCE_HEIGHT * 10) / 10,
            maxY: Math.round(Math.max(...points.map((point) => point.y)) * SOURCE_HEIGHT * 10) / 10,
          }
        }),
        baseClusters: clusters.length,
        estimatedCount: estimatePenLiftTextCharacterCount(strokes),
        cutCandidates: textCutCandidatesForTests(strokes),
      }
    })
  const unsafeSingles = singleResults.filter((entry) => (
    entry.baseClusters !== 1 || (entry.estimatedCount ?? 1) !== 1
  ))
  const unsafeByCharacter = new Map<string, number>()
  unsafeSingles.forEach((entry) => (
    unsafeByCharacter.set(entry.char, (unsafeByCharacter.get(entry.char) ?? 0) + 1)
  ))

  return {
    writers: writers.length,
    characters: chars.length,
    singles: {
      samples: singleResults.length,
      unsafe: unsafeSingles.length,
      safety: Math.round((singleResults.length - unsafeSingles.length) / Math.max(1, singleResults.length) * 10_000) / 100,
      unsafeByCharacter: [...unsafeByCharacter.entries()]
        .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
        .slice(0, 30),
      failures: unsafeSingles.slice(0, 60),
    },
    ...summarize(results),
  }
}
