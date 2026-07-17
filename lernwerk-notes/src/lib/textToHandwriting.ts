import type { Sample, Stroke, StrokePoint } from '../../../src/types'
import { normalizeGermanSharpS } from '../../../src/lib/orthography'

export type SynthesizedInkStroke = Stroke & { color: string }

export type HandwritingSynthesisOptions = {
  fontSize: number
  lineSpacing: number
  variation: number
  connectLetters: boolean
  color: string
  baseWidth: number
  pressureEnabled: boolean
  seed: number
  marginLeft?: number
  marginRight?: number
  marginTop?: number
  marginBottom?: number
  startY?: number
}

export type HandwritingSynthesisResult = {
  strokes: SynthesizedInkStroke[]
  normalizedText: string
  missingCharacters: string[]
  overflow: boolean
  overflowCharacters: number
  glyphCount: number
  lineCount: number
  connectionCount: number
  usedSampleIds: string[]
  fontSizeUsed: number
  bounds: [number, number, number, number] | null
}

type Random = () => number

type GlyphProfile = {
  top: number
  bottom: number
  widthScale: number
}

type GlyphPlan = {
  kind: 'glyph'
  char: string
  sample: Sample
  diacritic?: 'umlaut'
  width: number
  advance: number
  height: number
  top: number
  bottom: number
  scaleX: number
  scaleY: number
  slant: number
  rotation: number
  baselineJitter: number
  warpPhase: number
  widthVariation: number
  pressurePhase: number
}

type SpacePlan = { kind: 'space'; width: number }
type NewlinePlan = { kind: 'newline' }
type MissingPlan = { kind: 'missing'; char: string; width: number }
type Plan = GlyphPlan | SpacePlan | NewlinePlan | MissingPlan

type Anchor = {
  x: number
  y: number
  tangentX: number
  tangentY: number
  pressure: number
  width: number
  char: string
  line: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount
const between = (random: Random, min: number, max: number) => mix(min, max, random())

/** A small deterministic generator keeps previews stable until “Neu variieren” is pressed. */
const createRandom = (seed: number): Random => {
  let value = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ next >>> 15, next | 1)
    next ^= next + Math.imul(next ^ next >>> 7, next | 61)
    return ((next ^ next >>> 14) >>> 0) / 4_294_967_296
  }
}

export const createHandwritingSeed = () => {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
  }
  return Math.floor(Math.random() * 4_294_967_295)
}

const normalizeText = (value: string) => normalizeGermanSharpS(value)
  .replace(/\r\n?/gu, '\n')
  .replace(/\t/gu, '    ')
  .replace(/\u00a0/gu, ' ')
  .replace(/[…]/gu, '...')
  .replace(/[–—−]/gu, '-')
  .replace(/[“”„«»]/gu, '"')
  .replace(/[‘’]/gu, "'")
  .slice(0, 8_000)

const isValidSample = (sample: Sample) => sample.strokes.length > 0
  && sample.strokes.some((stroke) => stroke.points.length > 0)
  && sample.bbox.length === 4
  && sample.bbox.every(Number.isFinite)
  && sample.bbox[2] > 0
  && sample.bbox[3] > 0
  && sample.sourceCanvas.width > 0
  && sample.sourceCanvas.height > 0

const aliasesFor = (char: string) => {
  if (char === '-') return new Set(['-', '−', 'operator_minus'])
  if (char === "'") return new Set(["'", '’', '‘', 'apostrophe'])
  if (char === '"') return new Set(['"', '“', '”', '„', 'quote'])
  return new Set([char])
}

const samplesForCharacter = (char: string, samples: Sample[]) => {
  const aliases = aliasesFor(char)
  const exact = samples.filter((sample) => isValidSample(sample)
    && (aliases.has(sample.label) || aliases.has(sample.labelId)))
  if (exact.length) return { samples: exact }

  const umlautBase: Record<string, string> = {
    ä: 'a', ö: 'o', ü: 'u', Ä: 'A', Ö: 'O', Ü: 'U',
  }
  const base = umlautBase[char]
  if (!base) return { samples: [] as Sample[] }
  return {
    samples: samples.filter((sample) => isValidSample(sample) && sample.label === base),
    diacritic: 'umlaut' as const,
  }
}

const glyphProfile = (char: string): GlyphProfile => {
  if (/^[A-ZÄÖÜ]$/u.test(char)) return { top: 0.92, bottom: 0.05, widthScale: 1 }
  if (/^[0-9]$/u.test(char)) return { top: 0.86, bottom: 0.05, widthScale: 0.93 }
  if (/^[bdfhklt]$/u.test(char)) return { top: 0.9, bottom: 0.05, widthScale: 0.96 }
  if (/^[gjpqy]$/u.test(char)) return { top: 0.66, bottom: 0.29, widthScale: 0.98 }
  if (/^[a-zäöü]$/u.test(char)) return { top: 0.66, bottom: 0.05, widthScale: 1 }
  return { top: 0.56, bottom: 0.12, widthScale: 0.72 }
}

const sampleAspect = (sample: Sample) => clamp(
  (sample.bbox[2] * sample.sourceCanvas.width) / (sample.bbox[3] * sample.sourceCanvas.height),
  0.12,
  2.4,
)

const canJoin = (char: string) => /^[A-Za-zÄÖÜäöü]$/u.test(char)

const selectSample = (
  matches: Sample[],
  random: Random,
  previousSampleId: string | undefined,
) => {
  if (matches.length === 1) return matches[0]
  const preferred = matches.filter((sample) => sample.id !== previousSampleId)
  const pool = preferred.length ? preferred : matches
  // Context-learned samples remain usable, but manually imported glyphs are preferred.
  const trusted = pool.filter((sample) => !sample.sessionId.startsWith('context-'))
  const candidates = trusted.length && random() < 0.82 ? trusted : pool
  return candidates[Math.floor(random() * candidates.length)]
}

const createPlans = (
  text: string,
  samples: Sample[],
  options: HandwritingSynthesisOptions,
  random: Random,
): { plans: Plan[]; missing: string[] } => {
  const plans: Plan[] = []
  const missing = new Set<string>()
  const variation = clamp(options.variation, 0, 1)
  const em = clamp(options.fontSize, 16, 96)
  const globalSlant = between(random, -0.035, 0.045) * variation
  const globalWidth = 1 + between(random, -0.025, 0.025) * variation
  let previousSampleId: string | undefined

  for (const char of text) {
    if (char === '\n') {
      plans.push({ kind: 'newline' })
      previousSampleId = undefined
      continue
    }
    if (char === ' ') {
      plans.push({ kind: 'space', width: em * (0.3 + between(random, -0.025, 0.035) * variation) })
      previousSampleId = undefined
      continue
    }

    const match = samplesForCharacter(char, samples)
    if (!match.samples.length) {
      missing.add(char)
      plans.push({ kind: 'missing', char, width: em * 0.56 })
      previousSampleId = undefined
      continue
    }

    const sample = selectSample(match.samples, random, previousSampleId)
    const profile = glyphProfile(char)
    const scaleX = globalWidth * (1 + between(random, -0.075, 0.075) * variation)
    const scaleY = 1 + between(random, -0.04, 0.04) * variation
    const height = em * (profile.top + profile.bottom) * scaleY
    const rawWidth = height * sampleAspect(sample) * profile.widthScale * scaleX
    const width = clamp(rawWidth, em * 0.16, em * (/^[MWmw]$/u.test(char) ? 1.32 : 1.08))
    const plan: GlyphPlan = {
      kind: 'glyph',
      char,
      sample,
      diacritic: match.diacritic,
      width,
      advance: width + em * (0.075 + between(random, -0.018, 0.025) * variation),
      height,
      top: profile.top,
      bottom: profile.bottom,
      scaleX,
      scaleY,
      slant: globalSlant + between(random, -0.045, 0.045) * variation,
      rotation: between(random, -1.25, 1.25) * Math.PI / 180 * variation,
      baselineJitter: between(random, -1.65, 1.65) * variation,
      warpPhase: between(random, 0, Math.PI * 2),
      widthVariation: 1 + between(random, -0.09, 0.09) * variation,
      pressurePhase: between(random, 0, Math.PI * 2),
    }
    plans.push(plan)
    previousSampleId = sample.id
  }

  if (options.connectLetters) {
    plans.forEach((plan, index) => {
      const next = plans[index + 1]
      if (plan.kind === 'glyph' && next?.kind === 'glyph' && canJoin(plan.char) && canJoin(next.char)) {
        plan.advance = Math.max(plan.width * 0.84, plan.advance - em * 0.12)
      }
    })
  }
  return { plans, missing: [...missing] }
}

const planWidth = (plans: Plan[]) => plans.reduce((sum, plan) => {
  if (plan.kind === 'glyph') return sum + plan.advance
  if (plan.kind === 'space' || plan.kind === 'missing') return sum + plan.width
  return sum
}, 0)

const wordEnd = (plans: Plan[], start: number) => {
  let end = start
  while (end < plans.length && plans[end].kind !== 'space' && plans[end].kind !== 'newline') end += 1
  return end
}

const pointDistance = (left: StrokePoint, right: StrokePoint, width: number, height: number) => Math.hypot(
  (right.x - left.x) * width,
  (right.y - left.y) * height,
)

const anchorsForGlyph = (
  strokes: SynthesizedInkStroke[],
  char: string,
  line: number,
  baseline: number,
  width: number,
  height: number,
): { entry: Anchor; exit: Anchor } | null => {
  const lengths = strokes.map((stroke) => stroke.points.slice(1).reduce(
    (sum, point, index) => sum + pointDistance(stroke.points[index], point, width, height),
    0,
  ))
  const maxLength = Math.max(0, ...lengths)
  const candidates = strokes.flatMap((stroke, index) => {
    if (!stroke.points.length || lengths[index] < Math.max(2, maxLength * 0.2)) return []
    const first = stroke.points[0]
    const last = stroke.points[stroke.points.length - 1]
    const afterFirst = stroke.points[Math.min(1, stroke.points.length - 1)]
    const beforeLast = stroke.points[Math.max(0, stroke.points.length - 2)]
    return [
      { point: first, inward: afterFirst, stroke },
      { point: last, inward: beforeLast, stroke },
    ]
  })
  if (!candidates.length) return null

  const baselineNormalized = baseline / height
  const entryCandidate = candidates.reduce((best, candidate) => {
    const score = candidate.point.x * width + Math.abs(candidate.point.y - baselineNormalized) * height * 0.38
    const bestScore = best.point.x * width + Math.abs(best.point.y - baselineNormalized) * height * 0.38
    return score < bestScore ? candidate : best
  })
  const exitCandidate = candidates.reduce((best, candidate) => {
    const score = candidate.point.x * width - Math.abs(candidate.point.y - baselineNormalized) * height * 0.38
    const bestScore = best.point.x * width - Math.abs(best.point.y - baselineNormalized) * height * 0.38
    return score > bestScore ? candidate : best
  })
  const makeAnchor = (candidate: typeof entryCandidate, role: 'entry' | 'exit'): Anchor => {
    const inwardX = (candidate.inward.x - candidate.point.x) * width
    const inwardY = (candidate.inward.y - candidate.point.y) * height
    const inwardLength = Math.hypot(inwardX, inwardY) || 1
    const direction = role === 'entry' ? 1 : -1
    return {
      x: candidate.point.x * width,
      y: candidate.point.y * height,
      tangentX: inwardX / inwardLength * direction,
      tangentY: inwardY / inwardLength * direction,
      pressure: candidate.point.pressure,
      width: candidate.stroke.baseWidth,
      char,
      line,
    }
  }
  return { entry: makeAnchor(entryCandidate, 'entry'), exit: makeAnchor(exitCandidate, 'exit') }
}

const transformGlyph = (
  plan: GlyphPlan,
  x: number,
  baseline: number,
  line: number,
  options: HandwritingSynthesisOptions,
  width: number,
  height: number,
  clock: { value: number },
) => {
  const variation = clamp(options.variation, 0, 1)
  const em = clamp(options.fontSize, 16, 96)
  const targetHeight = plan.height
  const targetTop = baseline - plan.top * em * plan.scaleY + plan.baselineJitter
  const centerX = x + plan.width / 2
  const centerY = targetTop + targetHeight / 2
  const cosine = Math.cos(plan.rotation)
  const sine = Math.sin(plan.rotation)
  const generated: SynthesizedInkStroke[] = []

  for (const sourceStroke of plan.sample.strokes) {
    if (!sourceStroke.points.length) continue
    const points = sourceStroke.points.map((point, pointIndex): StrokePoint => {
      const localX = clamp((point.x - plan.sample.bbox[0]) / plan.sample.bbox[2], -0.18, 1.18)
      const localY = clamp((point.y - plan.sample.bbox[1]) / plan.sample.bbox[3], -0.18, 1.18)
      let pixelX = x + localX * plan.width
      let pixelY = targetTop + localY * targetHeight
      pixelX += plan.slant * (baseline - pixelY)
      pixelX += Math.sin(localY * Math.PI * 1.7 + plan.warpPhase) * em * 0.009 * variation
      pixelY += Math.sin(localX * Math.PI * 1.4 + plan.warpPhase * 0.73) * em * 0.006 * variation
      const relativeX = pixelX - centerX
      const relativeY = pixelY - centerY
      const rotatedX = centerX + relativeX * cosine - relativeY * sine
      const rotatedY = centerY + relativeX * sine + relativeY * cosine
      const pressure = options.pressureEnabled
        ? clamp((Number.isFinite(point.pressure) && point.pressure > 0 ? point.pressure : 0.5)
          * (1 + Math.sin(pointIndex * 0.42 + plan.pressurePhase) * 0.055 * variation), 0.08, 1)
        : 0.5
      clock.value += 4
      return {
        x: clamp(rotatedX / width, 0, 1),
        y: clamp(rotatedY / height, 0, 1),
        t: clock.value,
        pressure,
        tiltX: clamp(point.tiltX || 0, -90, 90),
        tiltY: clamp(point.tiltY || 0, -90, 90),
        pointerType: 'pen',
      }
    })
    generated.push({
      points,
      baseWidth: clamp(options.baseWidth * plan.widthVariation, 0.5, 48),
      pressureEnabled: options.pressureEnabled,
      color: options.color,
    })
  }

  if (plan.diacritic === 'umlaut') {
    const markY = clamp((targetTop - em * 0.105) / height, 0, 1)
    for (const offset of [0.34, 0.67]) {
      clock.value += 4
      const point = {
        x: clamp((x + plan.width * offset) / width, 0, 1),
        y: markY,
        t: clock.value,
        pressure: 0.55,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
      }
      generated.push({
        points: [point],
        baseWidth: clamp(options.baseWidth * 1.08, 0.5, 48),
        pressureEnabled: options.pressureEnabled,
        color: options.color,
      })
    }
  }

  return {
    strokes: generated,
    anchors: anchorsForGlyph(generated, plan.char, line, baseline, width, height),
  }
}

const connectorStroke = (
  from: Anchor,
  to: Anchor,
  options: HandwritingSynthesisOptions,
  width: number,
  height: number,
  random: Random,
  clock: { value: number },
): SynthesizedInkStroke | null => {
  const em = clamp(options.fontSize, 16, 96)
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (from.line !== to.line || dx < -em * 0.2 || dx > em * 0.72 || Math.abs(dy) > em * 0.46) return null
  const variation = clamp(options.variation, 0, 1)
  const lift = between(random, -0.035, 0.035) * em * variation
  const controlDistance = clamp(Math.hypot(dx, dy) * 0.36, em * 0.08, em * 0.28)
  const firstControl = {
    x: from.x + from.tangentX * controlDistance,
    y: from.y + from.tangentY * controlDistance + lift,
  }
  const secondControl = {
    x: to.x - to.tangentX * controlDistance,
    y: to.y - to.tangentY * controlDistance - lift * 0.45,
  }
  const points = Array.from({ length: 13 }, (_, index): StrokePoint => {
    const t = index / 12
    const inverse = 1 - t
    const x = inverse ** 3 * from.x
      + 3 * inverse ** 2 * t * firstControl.x
      + 3 * inverse * t ** 2 * secondControl.x
      + t ** 3 * to.x
    const y = inverse ** 3 * from.y
      + 3 * inverse ** 2 * t * firstControl.y
      + 3 * inverse * t ** 2 * secondControl.y
      + t ** 3 * to.y
    clock.value += 4
    return {
      x: clamp(x / width, 0, 1),
      y: clamp(y / height, 0, 1),
      t: clock.value,
      pressure: mix(from.pressure, to.pressure, t),
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen',
    }
  })
  return {
    points,
    baseWidth: clamp((from.width + to.width) / 2 * 0.92, 0.5, 48),
    pressureEnabled: options.pressureEnabled,
    color: options.color,
  }
}

const strokeBounds = (
  strokes: SynthesizedInkStroke[],
  width: number,
  height: number,
): [number, number, number, number] | null => {
  const points = strokes.flatMap((stroke) => stroke.points)
  if (!points.length) return null
  const left = Math.min(...points.map((point) => point.x))
  const top = Math.min(...points.map((point) => point.y))
  const right = Math.max(...points.map((point) => point.x))
  const bottom = Math.max(...points.map((point) => point.y))
  return [left * width, top * height, (right - left) * width, (bottom - top) * height]
}

export const synthesizeHandwriting = (
  input: string,
  samples: Sample[],
  options: HandwritingSynthesisOptions,
  page = { width: 900, height: 1273 },
): HandwritingSynthesisResult => {
  const width = Math.max(240, page.width)
  const height = Math.max(300, page.height)
  const text = normalizeText(input)
  const random = createRandom(options.seed)
  const { plans, missing } = createPlans(text, samples, options, random)
  const em = clamp(options.fontSize, 16, 96)
  const left = clamp(options.marginLeft ?? 72, 0, width - 24)
  const right = Math.max(left + 12, width - clamp(options.marginRight ?? 72, 0, width - 24))
  const top = clamp(options.marginTop ?? 72, 0, height * 0.4)
  const bottom = height - clamp(options.marginBottom ?? 72, 0, height * 0.4)
  const lineHeight = em * clamp(options.lineSpacing, 1, 2.4)
  let baseline = Math.max(top + em * 0.92, options.startY ?? top + em * 0.92)
  let cursorX = left
  let line = 0
  let lineCount = text ? 1 : 0
  let glyphCount = 0
  let connectionCount = 0
  let overflow = false
  let overflowCharacters = 0
  let previousExit: Anchor | null = null
  let previousChar = ''
  const strokes: SynthesizedInkStroke[] = []
  const usedSampleIds = new Set<string>()
  const clock = { value: Date.now() }

  const nextLine = () => {
    cursorX = left
    baseline += lineHeight
    line += 1
    lineCount += 1
    previousExit = null
    previousChar = ''
  }

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]
    if (plan.kind === 'newline') {
      nextLine()
      continue
    }
    if (plan.kind === 'space') {
      cursorX += plan.width
      previousExit = null
      previousChar = ''
      continue
    }

    const previousPlan = plans[index - 1]
    const startsWord = index === 0 || previousPlan?.kind === 'space' || previousPlan?.kind === 'newline'
    if (startsWord && cursorX > left) {
      const end = wordEnd(plans, index)
      const widthOfWord = planWidth(plans.slice(index, end))
      if (widthOfWord <= right - left && cursorX + widthOfWord > right) nextLine()
    }
    const requiredWidth = plan.kind === 'glyph' ? plan.width : plan.width
    if (cursorX > left && cursorX + requiredWidth > right) nextLine()

    const planBottom = plan.kind === 'glyph' ? plan.bottom * em * plan.scaleY : em * 0.12
    if (baseline + planBottom > bottom) {
      overflow = true
      overflowCharacters = plans.slice(index).filter((remaining) => remaining.kind === 'glyph' || remaining.kind === 'missing').length
      break
    }

    if (plan.kind === 'missing') {
      cursorX += plan.width
      previousExit = null
      previousChar = ''
      continue
    }

    const generated = transformGlyph(plan, cursorX, baseline, line, options, width, height, clock)
    if (options.connectLetters && previousExit && generated.anchors && canJoin(previousChar) && canJoin(plan.char)) {
      const connector = connectorStroke(previousExit, generated.anchors.entry, options, width, height, random, clock)
      if (connector) {
        strokes.push(connector)
        connectionCount += 1
      }
    }
    strokes.push(...generated.strokes)
    previousExit = generated.anchors?.exit ?? null
    previousChar = plan.char
    cursorX += plan.advance
    glyphCount += 1
    usedSampleIds.add(plan.sample.id)
  }

  return {
    strokes,
    normalizedText: text,
    missingCharacters: missing,
    overflow,
    overflowCharacters,
    glyphCount,
    lineCount,
    connectionCount,
    usedSampleIds: [...usedSampleIds],
    fontSizeUsed: em,
    bounds: strokeBounds(strokes, width, height),
  }
}

export const synthesizeHandwritingToFit = (
  input: string,
  samples: Sample[],
  options: HandwritingSynthesisOptions,
  page = { width: 900, height: 1273 },
  minimumFontSize = 18,
) => {
  const requestedSize = clamp(options.fontSize, minimumFontSize, 96)
  let result = synthesizeHandwriting(input, samples, { ...options, fontSize: requestedSize }, page)
  for (let fontSize = requestedSize - 2; result.overflow && fontSize >= minimumFontSize; fontSize -= 2) {
    result = synthesizeHandwriting(input, samples, { ...options, fontSize }, page)
  }
  return result
}
