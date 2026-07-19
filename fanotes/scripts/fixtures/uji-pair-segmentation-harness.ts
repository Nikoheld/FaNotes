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

const strokePathLength = (stroke: Stroke) => stroke.points.slice(1).reduce((sum, point, index) => {
  const previous = stroke.points[index]
  return sum + Math.hypot(
    (point.x - previous.x) * SOURCE_WIDTH,
    (point.y - previous.y) * SOURCE_HEIGHT,
  )
}, 0)

/**
 * Joins the dominant body stroke of two real UJI glyphs into one uninterrupted
 * pen-down path. All remaining strokes are deliberately delayed until after
 * the complete body, matching writers who add dots/crossbars at word end.
 */
const connectedPairStrokes = (
  first: UjiPairRecord,
  second: UjiPairRecord,
  gapPixels = -3,
) => {
  const left = positionGlyph(first, 0.18, 0)
  const right = positionGlyph(second, 0.18 + left.width + gapPixels / SOURCE_WIDTH, left.nextTime)
  const primaryIndex = (strokes: Stroke[]) => strokes
    .map((stroke, index) => ({ index, length: strokePathLength(stroke) }))
    .sort((a, b) => b.length - a.length)[0]?.index ?? 0
  const leftPrimaryIndex = primaryIndex(left.strokes)
  const rightPrimaryIndex = primaryIndex(right.strokes)
  const orient = (stroke: Stroke, edge: 'left' | 'right') => {
    const points = stroke.points.map((point) => ({ ...point }))
    if (points.length < 2) return points
    const firstPoint = points[0]
    const lastPoint = points.at(-1)!
    const reverse = edge === 'right'
      ? lastPoint.x < firstPoint.x
      : firstPoint.x > lastPoint.x
    return reverse ? points.reverse() : points
  }
  const leftBody = orient(left.strokes[leftPrimaryIndex], 'right')
  const rightBody = orient(right.strokes[rightPrimaryIndex], 'left')
  const connector = {
    ...leftBody.at(-1)!,
    x: (leftBody.at(-1)!.x + rightBody[0].x) / 2,
    y: (leftBody.at(-1)!.y + rightBody[0].y) / 2,
  }
  let time = 0
  const joinedBody: Stroke = {
    baseWidth: 3.7,
    pressureEnabled: false,
    points: [...leftBody, connector, ...rightBody].map((point) => ({ ...point, t: time++ })),
  }
  const delayed = [
    ...left.strokes.flatMap((stroke, index) => index === leftPrimaryIndex ? [] : [{ owner: 0, stroke }]),
    ...right.strokes.flatMap((stroke, index) => index === rightPrimaryIndex ? [] : [{ owner: 1, stroke }]),
  ].map(({ owner, stroke }) => {
    time += 7
    const delayedStroke = {
      ...stroke,
      points: stroke.points.map((point) => ({ ...point, t: time++ })),
    }
    return { owner, stroke: delayedStroke }
  })
  return {
    strokes: [joinedBody, ...delayed.map((entry) => entry.stroke)],
    delayed,
    joinX: (0.18 + left.width + 0.18 + left.width + gapPixels / SOURCE_WIDTH) / 2,
  }
}

const completeStrokePart = (
  parts: Array<{ strokes: Stroke[] }>,
  reference: Stroke,
) => {
  const referenceTimes = reference.points.map((point) => point.t)
  const matches = parts.flatMap((part, partIndex) => part.strokes.flatMap((stroke) => (
    stroke.points.some((point) => referenceTimes.includes(point.t))
      ? [{ partIndex, stroke }]
      : []
  )))
  return matches.length === 1 &&
    matches[0].stroke.points.length === reference.points.length &&
    matches[0].stroke.points.every((point, index) => point.t === referenceTimes[index])
    ? matches[0].partIndex
    : null
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
  const connectedResults: Array<{
    writer: string
    expected: string
    strokeCounts: [number, number]
    pointCount: number
    physicalAspect: number
    joinX: number
    longestBodySegments: Array<{ x: number; length: number; deltaX: number }>
    baseClusters: number
    detachedConnectorRanges: [number, number][]
    hypothesisSizes: number[]
    cutCandidates: ReturnType<typeof textCutCandidatesForTests>
    hypotheses: number
    hasTwoPartPath: boolean
    hasUnfragmentedPath: boolean
    hasOwnerCorrectPath: boolean
    delayedStrokeBounds: Array<{
      owner: number
      minX: number
      maxX: number
      minY: number
      maxY: number
      endpointSpan: number
      horizontalTravel: number
      verticalTravel: number
    }>
    hypothesisAllocations: Array<{
      parts: Array<[number, number]>
      delayedParts: Array<number | null>
    }>
  }> = []

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

        const connected = connectedPairStrokes(first, second)
        const connectedClusters = segmentStrokes(connected.strokes, 'text')
        const connectedPoints = connected.strokes.flatMap((stroke) => stroke.points)
        const connectedMinX = Math.min(...connectedPoints.map((point) => point.x))
        const connectedMaxX = Math.max(...connectedPoints.map((point) => point.x))
        const connectedMinY = Math.min(...connectedPoints.map((point) => point.y))
        const connectedMaxY = Math.max(...connectedPoints.map((point) => point.y))
        // Production recognition adds the same bounded whole-line path when
        // a dot/crossbar temporarily forms its own geometric cluster. Audit
        // that real path rather than declaring every detached i-dot a second
        // character before segmentation has even run.
        const combinedCluster = {
          strokes: connected.strokes,
          minX: connectedMinX,
          maxX: connectedMaxX,
          minY: connectedMinY,
          maxY: connectedMaxY,
        }
        const allConnectedHypotheses = connectedTextSegmentationHypotheses(combinedCluster, 2)
        const twoPartHypotheses = allConnectedHypotheses
          .filter((hypothesis) => hypothesis.length === 2)
        const hasUnfragmentedPath = twoPartHypotheses.some((hypothesis) => (
          connected.delayed.every(({ stroke }) => completeStrokePart(hypothesis, stroke) !== null)
        ))
        const hasOwnerCorrectPath = twoPartHypotheses.some((hypothesis) => (
          connected.delayed.every(({ owner, stroke }) => completeStrokePart(hypothesis, stroke) === owner)
        ))
        connectedResults.push({
          writer,
          expected: `${firstChar}${secondChar}`,
          strokeCounts: [first.strokes.length, second.strokes.length],
          pointCount: connectedPoints.length,
          physicalAspect: Math.round(
            (connectedMaxX - connectedMinX) * SOURCE_WIDTH /
            Math.max(1, (connectedMaxY - connectedMinY) * SOURCE_HEIGHT) * 1_000,
          ) / 1_000,
          joinX: connected.joinX,
          longestBodySegments: connected.strokes[0].points.slice(1).map((point, index) => {
            const previous = connected.strokes[0].points[index]
            return {
              x: (previous.x + point.x) / 2,
              length: Math.hypot(
                (point.x - previous.x) * SOURCE_WIDTH,
                (point.y - previous.y) * SOURCE_HEIGHT,
              ),
              deltaX: (point.x - previous.x) * SOURCE_WIDTH,
            }
          }).sort((a, b) => b.length - a.length).slice(0, 6),
          baseClusters: connectedClusters.length,
          detachedConnectorRanges: connectedClusters[0]?.detachedTextConnectorRanges ?? [],
          hypothesisSizes: [...new Set(allConnectedHypotheses.map((hypothesis) => hypothesis.length))],
          cutCandidates: textCutCandidatesForTests(connected.strokes),
          hypotheses: twoPartHypotheses.length,
          hasTwoPartPath: twoPartHypotheses.length > 0,
          hasUnfragmentedPath,
          hasOwnerCorrectPath,
          delayedStrokeBounds: connected.delayed.map(({ owner, stroke }) => {
            const points = stroke.points
            return {
              owner,
              minX: Math.min(...points.map((point) => point.x)),
              maxX: Math.max(...points.map((point) => point.x)),
              minY: Math.min(...points.map((point) => point.y)),
              maxY: Math.max(...points.map((point) => point.y)),
              endpointSpan: Math.abs(points.at(-1)!.x - points[0].x) * SOURCE_WIDTH,
              horizontalTravel: points.slice(1).reduce((sum, point, index) => (
                sum + Math.abs(point.x - points[index].x) * SOURCE_WIDTH
              ), 0),
              verticalTravel: points.slice(1).reduce((sum, point, index) => (
                sum + Math.abs(point.y - points[index].y) * SOURCE_HEIGHT
              ), 0),
            }
          }),
          hypothesisAllocations: twoPartHypotheses.map((hypothesis) => ({
            parts: hypothesis.map((part) => [part.minX, part.maxX]),
            delayedParts: connected.delayed.map(({ stroke }) => completeStrokePart(hypothesis, stroke)),
          })),
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
  const connectedFailures = connectedResults.filter((entry) => !entry.hasTwoPartPath)
  const connectedFragmentationFailures = connectedResults.filter((entry) => !entry.hasUnfragmentedPath)
  const connectedOwnershipFailures = connectedResults.filter((entry) => !entry.hasOwnerCorrectPath)
  const percent = (passed: number, total: number) => (
    Math.round(passed / Math.max(1, total) * 10_000) / 100
  )

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
    connected: {
      pairs: connectedResults.length,
      available: connectedResults.length - connectedFailures.length,
      availability: percent(connectedResults.length - connectedFailures.length, connectedResults.length),
      unfragmented: connectedResults.length - connectedFragmentationFailures.length,
      unfragmentedRate: percent(
        connectedResults.length - connectedFragmentationFailures.length,
        connectedResults.length,
      ),
      ownerCorrect: connectedResults.length - connectedOwnershipFailures.length,
      ownerCorrectRate: percent(
        connectedResults.length - connectedOwnershipFailures.length,
        connectedResults.length,
      ),
      failures: connectedFailures.slice(0, 60),
      fragmentationFailures: connectedFragmentationFailures.slice(0, 60),
      ownershipFailures: connectedOwnershipFailures.slice(0, 60),
    },
    ...summarize(results),
  }
}
