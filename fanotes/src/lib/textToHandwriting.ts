import type { Sample, Stroke, StrokePoint } from '../../../src/types'
import { personalStyle, spliceTrajectories, optimizeDesktopSplice, type PersonalModel, type StyleObservation } from './personalHandwriting.mjs'
import { planDesktopWord, primaryTrajectory, type WordCandidate, type WordSelection } from './desktopWordPlanner.mjs'
import { schoolScript } from './schoolScript.mjs'
import { WRITE_CAP_HEIGHT, WRITE_CAP_WIDTH } from './noteCanvas'

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
  model?: PersonalModel
  desktopQuality?: boolean
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
  pageWidth: number
  pageHeight: number
}

type Random = () => number

type GlyphProfile = {
  top: number
  bottom: number
  widthScale: number
}

type TrajectorySample = Pick<Sample, 'id' | 'label' | 'labelId' | 'sessionId' | 'bbox' | 'strokes'> & { sourceCanvas: { width: number; height: number } }

type GlyphPlan = {
  kind: 'glyph'
  char: string
  sample: TrajectorySample
  diacritic?: 'umlaut'
  width: number
  advance: number
  height: number
  top: number
  bottom: number
  scaleY: number
  slant: number
  baselineJitter: number
  observation?: StyleObservation
}

type SpacePlan = { kind: 'space'; width: number }
type NewlinePlan = { kind: 'newline' }
type MissingPlan = { kind: 'missing'; char: string; width: number }
type Plan = GlyphPlan | SpacePlan | NewlinePlan | MissingPlan

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

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

const normalizeText = (value: string) => value.normalize('NFC')
  .replace(/\r\n?/gu, '\n')
  .replace(/\t/gu, '    ')
  .replace(/\u00a0/gu, ' ')
  .replace(/[…]/gu, '...')
  .replace(/[–—−]/gu, '-')
  .replace(/[“”„«»]/gu, '"')
  .replace(/[‘’]/gu, "'")
  .slice(0, 8_000)

const validatedSamples = new WeakMap<Sample, boolean>()
const isValidSample = (sample: Sample) => {
  const cached = validatedSamples.get(sample)
  if (cached !== undefined) return cached
  const result = sample.strokes.length > 0
  && sample.strokes.some((stroke) => stroke.points.length > 0)
  && sample.bbox.length === 4
  && sample.bbox.every(Number.isFinite)
  && sample.bbox[2] > 0
  && sample.bbox[3] > 0
  && sample.sourceCanvas.width > 0
  && sample.sourceCanvas.height > 0
  && Number.isFinite(sample.sourceCanvas.width + sample.sourceCanvas.height)
  && sample.strokes.every(s => s.points.every(p => [p.x, p.y, p.t].every(Number.isFinite)))

  validatedSamples.set(sample, result)
  return result
}

const aliasesFor = (char: string) => {
  if (char === '-') return new Set(['-', '−', 'operator_minus'])
  if (char === "'") return new Set(["'", '’', '‘', 'apostrophe'])
  if (char === '"') return new Set(['"', '“', '”', '„', 'quote'])
  return new Set([char])
}

const samplesForCharacter = (char: string, samples: Map<string, Sample[]>) => {
  const exact = [...new Set([...aliasesFor(char)].flatMap(alias => samples.get(alias) ?? []))]
  if (exact.length) return { samples: exact }
  const base: Record<string, string> = { ä: 'a', ö: 'o', ü: 'u', Ä: 'A', Ö: 'O', Ü: 'U' }
  return { samples: samples.get(base[char]) ?? [], diacritic: base[char] ? 'umlaut' as const : undefined }
}

const glyphProfile = (char: string): GlyphProfile => {
  if (char === '.') return { top: .065, bottom: .01, widthScale: 1 }
  if (char === ',') return { top: .07, bottom: .15, widthScale: .65 }
  if (char === ':') return { top: .5, bottom: .02, widthScale: .2 }
  if (char === ';') return { top: .5, bottom: .15, widthScale: .2 }
  if (char === "'") return { top: .93, bottom: -.62, widthScale: .3 }
  if (char === '"') return { top: .93, bottom: -.62, widthScale: .6 }
  if (char === '-') return { top: .35, bottom: -.30, widthScale: 3.8 }
  if (char === '!') return { top: .92, bottom: .05, widthScale: .35 }
  if (char === '?') return { top: .92, bottom: .05, widthScale: .75 }
  if (/^[()[\]{}]$/u.test(char)) return { top: .92, bottom: .05, widthScale: .42 }

  if (/^\p{Lu}$/u.test(char)) return { top: 0.92, bottom: 0.05, widthScale: 1 }
  if (/^[0-9]$/u.test(char)) return { top: 0.86, bottom: 0.05, widthScale: 0.93 }
  if (/^[bdfhkltß]$/u.test(char)) return { top: 0.9, bottom: 0.05, widthScale: 0.96 }
  if (/^[gjpqy]$/u.test(char)) return { top: 0.66, bottom: 0.29, widthScale: 0.98 }
  if (/^\p{Ll}$/u.test(char)) return { top: 0.66, bottom: 0.05, widthScale: 1 }
  return { top: 0.56, bottom: 0.12, widthScale: 0.72 }
}

const sampleAspect = (sample: TrajectorySample) => clamp(
  (sample.bbox[2] * sample.sourceCanvas.width) / (sample.bbox[3] * sample.sourceCanvas.height),
  0.12,
  2.4,
)

const canJoin = (char: string) => /^[\p{L}]+$/u.test(char)

const selectSample = (
  matches: TrajectorySample[],
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
  availableWidth: number,
  learned: ReturnType<typeof personalStyle>,
): { plans: Plan[]; missing: string[] } => {
  const indexed = new Map<string, Sample[]>()
  for (const sample of samples) if (!/^(?:fanotes-context-|context-)/u.test(sample.sessionId) && isValidSample(sample)) for (const label of new Set([sample.label, sample.labelId])) indexed.set(label, [...(indexed.get(label) ?? []), sample])
  const unitsByFirst = new Map<string, typeof learned.units>()
  for (const unit of learned.units) { const key = [...unit.label][0]; unitsByFirst.set(key, [...(unitsByFirst.get(key) ?? []), unit]) }
  const plans: Plan[] = []
  const missing = new Set<string>()
  const variation = clamp(options.variation, 0, 1)
  const em = clamp(options.fontSize, 16, 96)
  let previousSampleId: string | undefined

  const chars = [...text]
  const desktopSelections = new Map<number, WordSelection>()
  if (options.desktopQuality) {
    const beamWidth = options.model?.desktop?.beamWidth ?? 12
    const variants = options.model?.desktop?.variants ?? 16
    const center = learned.observations[0]
    let start = 0
    while (start < chars.length) {
      if (/\s/u.test(chars[start])) { start++; continue }
      let end = start
      while (end < chars.length && !/\s/u.test(chars[end])) end++
      const word = chars.slice(start,end)
      const selections = planDesktopWord(word.join(''), position => {
        const char = word[position]
        const observed = (unitsByFirst.get(char) ?? []).filter(u => word.slice(position,position+[...u.label].length).join('') === u.label)
        const candidates: WordCandidate[] = observed.map(unit => {
          const height = Math.max(...[...unit.label].map(c => { const p=glyphProfile(c); return p.top+p.bottom }))
          return {text:unit.label,sample:unit,unit,width:height*unit.sourceCanvas.width/unit.sourceCanvas.height,height,top:unit.baseline*height}
        }).filter(c => c.width*em <= availableWidth)
        const fallback = samplesForCharacter(char,indexed)
        const profile = glyphProfile(char), height = profile.top+profile.bottom
        candidates.push(...fallback.samples.filter(s => s.sessionId !== 'school-script' || !observed.some(u => u.label === char)).slice(0,variants).map(sample => ({text:char,sample,diacritic:fallback.diacritic,width:clamp(height*sampleAspect(sample)*profile.widthScale,.06,/^[MWmw]$/u.test(char)?1.32:1.08),height,top:profile.top})))
        return candidates
      }, {random,beamWidth,variants,connect:options.connectLetters && (center?.joinRate ?? 1)>.5,gap:(center?.gap ?? .075)-.025})
      for (const selection of selections) desktopSelections.set(start+selection.position,selection)
      start = end
    }
  }
  let previousObservation: StyleObservation | undefined
  let flowObservation: StyleObservation | undefined
  for (let index = 0; index < chars.length; index++) {
    let char = chars[index]
    const leftContext = index === 0 || /\s/u.test(chars[index - 1]) ? '^' : chars[index - 1]
    const units = (unitsByFirst.get(char) ?? []).filter(u => chars.slice(index, index + [...u.label].length).join('') === u.label
      && em * Math.max(...[...u.label].map(c => { const p = glyphProfile(c); return p.top + p.bottom })) * u.sourceCanvas.width / u.sourceCanvas.height <= availableWidth)
      .sort((a, b) => b.label.length - a.label.length)
    const longest = units[0]?.label
    const contextual = units.filter(u => u.label === longest && u.context === `${leftContext}|${chars[index + [...u.label].length] ?? '$'}`)
    const pool = contextual.length ? contextual : units.filter(u => u.label === longest)
    const desktopSelection = desktopSelections.get(index)
    const selectedUnit = desktopSelection ? desktopSelection.unit : pool.length ? pool[Math.floor(random() * Math.min(pool.length, 8))] : undefined
    if (selectedUnit) { char = selectedUnit.label; index += [...char].length - 1 }
    const observation = previousObservation ?? learned.observations[Math.floor(random() * learned.observations.length)]
    previousObservation = observation
    if (char === '\n') {
      plans.push({ kind: 'newline' })
      previousSampleId = undefined
      previousObservation = undefined
      flowObservation = undefined
      continue
    }
    if (char === ' ') {
      plans.push({ kind: 'space', width: em * (observation?.wordGap ?? 0.3) })
      previousSampleId = undefined
      previousObservation = undefined
      flowObservation = undefined
      continue
    }

    const match = desktopSelection ? { samples: [desktopSelection.sample], diacritic: desktopSelection.diacritic } : selectedUnit ? { samples: [selectedUnit], diacritic: undefined } : samplesForCharacter(char, indexed)
    if (!match.samples.length) {
      missing.add(char)
      plans.push({ kind: 'missing', char, width: em * 0.56 })
      previousSampleId = undefined
      previousObservation = undefined
      flowObservation = undefined
      continue
    }

    const sample = selectSample(match.samples, random, previousSampleId)
    const unitHeight = selectedUnit ? Math.max(...[...char].map(c => { const p = glyphProfile(c); return p.top + p.bottom })) : 1
    const profile = selectedUnit ? { top: selectedUnit.baseline * unitHeight, bottom: (1 - selectedUnit.baseline) * unitHeight, widthScale: 1 } : glyphProfile(char)
    const sampledObservation = learned.observations[Math.floor(random() * learned.observations.length)] ?? observation
    const observed = options.desktopQuality && flowObservation && sampledObservation
      ? { ...sampledObservation, height: flowObservation.height*.8+sampledObservation.height*.2, baseline: flowObservation.baseline*.8+sampledObservation.baseline*.2 }
      : sampledObservation
    flowObservation = observed
    // Replay correlated empirical observations; no sinusoidal per-point shape noise.
    const heightRatio = observation && observed ? clamp(observed.height / observation.height, .88, 1.12) : 1
    // Per-glyph height and baseline must move a little at the default
    // variation so repeated letters are not obviously typeset. Variation 0
    // keeps both uniform (the multipliers collapse to zero).
    const scaleY = 1 + (heightRatio - 1) * variation
    const height = em * (profile.top + profile.bottom) * scaleY
    const rawWidth = height * (selectedUnit ? selectedUnit.sourceCanvas.width / selectedUnit.sourceCanvas.height : sampleAspect(sample)) * profile.widthScale
    const width = clamp(rawWidth, em * 0.06, em * (selectedUnit ? Math.max(1, char.length * 1.4) : /^[MWmw]$/u.test(char) ? 1.32 : 1.08))
    const plan: GlyphPlan = {
      kind: 'glyph',
      char,
      sample,
      diacritic: match.diacritic,
      width,
      advance: width + em * (observation?.gap ?? 0.075),
      height,
      top: profile.top,
      bottom: profile.bottom,
      scaleY,
      slant: sample.sessionId === 'school-script' ? observation?.slant ?? 0 : 0,
      baselineJitter: (observed?.baseline ?? 0) * em * variation,
      observation,
    }
    plans.push(plan)
    previousSampleId = sample.id
  }

  if (options.connectLetters) {
    plans.forEach((plan, index) => {
      const next = plans[index + 1]
      if (plan.kind === 'glyph' && next?.kind === 'glyph' && canJoin(plan.char) && canJoin(next.char)) {
        plan.advance = Math.max(plan.width * 0.84, plan.advance - em * 0.025)
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

const transformGlyph = (
  plan: GlyphPlan,
  x: number,
  baseline: number,
  _line: number,
  options: HandwritingSynthesisOptions,
  width: number,
  height: number,
  clock: { value: number },
) => {
  const em = clamp(options.fontSize, 16, 96)
  const targetHeight = plan.height
  const targetTop = baseline - plan.top * em * plan.scaleY + plan.baselineJitter
  const generated: SynthesizedInkStroke[] = []

  for (const sourceStroke of plan.sample.strokes) {
    if (!sourceStroke.points.length) continue
    const points = sourceStroke.points.map((point, _pointIndex): StrokePoint => {
      const localX = clamp((point.x - plan.sample.bbox[0]) / plan.sample.bbox[2], -0.18, 1.18)
      const localY = clamp((point.y - plan.sample.bbox[1]) / plan.sample.bbox[3], -0.18, 1.18)
      let pixelX = x + localX * plan.width
      let pixelY = targetTop + localY * targetHeight
      pixelX += plan.slant * (baseline - pixelY)
      const pressure = options.pressureEnabled
        ? clamp((Number.isFinite(point.pressure) && point.pressure >= 0 ? point.pressure : 0.5)
          * (plan.sample.sessionId === 'school-script' && plan.observation ? plan.observation.pressure / .55 : 1), 0.08, 1)
        : 0.5
      const before = sourceStroke.points[Math.max(0, _pointIndex - 1)]
      clock.value += clamp(point.t - before.t || 4, 1, 50)
      return {
        x: clamp(pixelX / width, 0, 1),
        y: clamp(pixelY / height, 0, 1),
        t: clock.value,
        pressure,
        tiltX: clamp(point.tiltX || 0, -90, 90),
        tiltY: clamp(point.tiltY || 0, -90, 90),
        pointerType: 'pen',
      }
    })
    generated.push({
      points,
      baseWidth: clamp(options.baseWidth * (plan.observation ? clamp(plan.observation.nibRatio / .08, .6, 1.6) : 1), 0.5, 48),
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

  }
}

const strokeBounds = (
  strokes: SynthesizedInkStroke[],
  width: number,
  height: number,
): [number, number, number, number] | null => {
  if (!strokes.some(s => s.points.length)) return null
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const s of strokes) for (const p of s.points) { left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y) }
  return [left * width, top * height, (right - left) * width, (bottom - top) * height]
}

type LayoutSlot = {
  plan: Plan
  x: number
  baseline: number
  line: number
  bottom: number
}

const layoutSlots = (
  plans: Plan[],
  options: HandwritingSynthesisOptions,
  width: number,
  startHeight: number,
): { slots: LayoutSlot[]; lineCount: number; maxBottom: number } => {
  const em = clamp(options.fontSize, 16, 96)
  const left = clamp(options.marginLeft ?? 72, 0, width - 24)
  const right = Math.max(left + 12, width - clamp(options.marginRight ?? 72, 0, width - 24))
  const top = clamp(options.marginTop ?? 72, 0, startHeight * 0.4)
  const lineHeight = em * clamp(options.lineSpacing, 1, 2.4)
  let baseline = Math.max(top + em * 0.92, options.startY ?? top + em * 0.92)
  let cursorX = left
  let line = 0
  let lineCount = plans.length ? 1 : 0
  let maxBottom = 0
  const slots: LayoutSlot[] = []

  const nextLine = () => {
    cursorX = left
    baseline += lineHeight
    line += 1
    lineCount += 1
  }

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]
    if (plan.kind === 'newline') {
      nextLine()
      slots.push({ plan, x: cursorX, baseline, line, bottom: baseline })
      continue
    }
    if (plan.kind === 'space') {
      cursorX += plan.width
      slots.push({ plan, x: cursorX, baseline, line, bottom: baseline })
      continue
    }

    const previousPlan = plans[index - 1]
    const startsWord = index === 0 || previousPlan?.kind === 'space' || previousPlan?.kind === 'newline'
    if (startsWord && cursorX > left) {
      const end = wordEnd(plans, index)
      const widthOfWord = planWidth(plans.slice(index, end))
      if (widthOfWord <= right - left && cursorX + widthOfWord > right) nextLine()
    }
    const requiredWidth = plan.width
    if (cursorX > left && cursorX + requiredWidth > right) nextLine()

    const planBottom = plan.kind === 'glyph' ? plan.bottom * em * plan.scaleY : em * 0.12
    const bottom = baseline + planBottom + (plan.kind === 'glyph' ? plan.baselineJitter : 0)
    maxBottom = Math.max(maxBottom, bottom)
    slots.push({ plan, x: cursorX, baseline, line, bottom })
    cursorX += plan.kind === 'glyph' ? plan.advance : plan.width
  }

  return { slots, lineCount, maxBottom }
}

export const synthesizeHandwriting = (
  input: string,
  samples: Sample[],
  options: HandwritingSynthesisOptions,
  page = { width: 900, height: 1273 },
  preparedStyle?: ReturnType<typeof personalStyle>,
): HandwritingSynthesisResult => {
  const width = Math.min(WRITE_CAP_WIDTH, Math.max(240, page.width))
  const startHeight = Math.min(WRITE_CAP_HEIGHT, Math.max(300, page.height))
  const text = normalizeText(input)
  const random = createRandom(options.seed)
  const covered = new Set(samples.map(s => s.label))
  const library = [...samples, ...schoolScript.filter(s => !covered.has(s.label))]
  const learned = preparedStyle ?? personalStyle(options.model, options.desktopQuality ? options.model?.desktop?.motions ?? 512 : 128)
  const { plans, missing } = createPlans(text, library, options, random, Math.max(12, width - (options.marginLeft ?? 72) - (options.marginRight ?? 72)), learned)
  const em = clamp(options.fontSize, 16, 96)
  const marginBottom = clamp(options.marginBottom ?? 72, 0, startHeight * 0.4)
  const { slots, lineCount: plannedLines, maxBottom } = layoutSlots(plans, options, width, startHeight)
  const neededHeight = Math.max(startHeight, Math.ceil(maxBottom + marginBottom))
  const height = Math.min(WRITE_CAP_HEIGHT, neededHeight)
  const writableBottom = height - marginBottom
  const overflow = neededHeight > WRITE_CAP_HEIGHT
  let overflowCharacters = 0
  let lineCount = text ? plannedLines : 0
  let glyphCount = 0
  let connectionCount = 0
  let previousBody = -1
  let previousLine = -1
  let previousChar = ''
  const strokes: SynthesizedInkStroke[] = []
  const usedSampleIds = new Set<string>()
  const clock = { value: 0 }
  const learnedMotions = learned.joins

  for (const slot of slots) {
    const { plan } = slot
    if (plan.kind === 'newline' || plan.kind === 'space') {
      previousBody = -1
      previousChar = ''
      continue
    }
    if (slot.bottom > writableBottom) {
      overflowCharacters = slots
        .slice(slots.indexOf(slot))
        .reduce((sum, remaining) => sum + (remaining.plan.kind === 'glyph' ? [...remaining.plan.char].length : remaining.plan.kind === 'missing' ? 1 : 0), 0)
      break
    }
    if (plan.kind === 'missing') {
      previousBody = -1
      previousChar = ''
      continue
    }

    const generated = transformGlyph(plan, slot.x, slot.baseline, slot.line, options, width, height, clock)
    // The longest pen-down body carries the join. Delayed dots/crossbars remain separate.
    const bodyIndex = options.desktopQuality ? primaryTrajectory(generated.strokes,width,height) : generated.strokes.reduce((best, stroke, i, all) => stroke.points.length > (all[best]?.points.length ?? 0) ? i : best, 0)
    const body = generated.strokes[bodyIndex]
    let merged = false
    if (body && options.connectLetters && previousBody >= 0 && previousLine === slot.line && canJoin(previousChar) && canJoin(plan.char)
      && (plan.observation?.joinRate ?? 1) > .5 && [...plan.char].length === 1 && [...previousChar].length === 1) {
      const left = strokes[previousBody]
      const toPixels = (p: StrokePoint) => ({ ...p, x: p.x * width, y: p.y * height })
      const leftPoints = left.points.map(toPixels), rightPoints = body.points.map(toPixels)
      const joined = options.desktopQuality ? optimizeDesktopSplice(leftPoints,rightPoints,em,learnedMotions,(options.model?.desktop?.beamWidth ?? 12)>8?7:4)?.points : spliceTrajectories(leftPoints,rightPoints,em,learnedMotions)
      if (joined) {
        strokes[previousBody] = { ...left, points: joined.map(p => ({ ...p, x: p.x / width, y: p.y / height })) }
        merged = true
        connectionCount++
      }
    }
    const offset = strokes.length
    strokes.push(...generated.strokes.filter((_, i) => !merged || i !== bodyIndex))
    previousBody = merged ? previousBody : offset + bodyIndex
    previousLine = slot.line
    previousChar = plan.char
    glyphCount += [...plan.char].length
    usedSampleIds.add(plan.sample.id)
  }

  if (overflow && overflowCharacters === 0) {
    overflowCharacters = plans.reduce((sum, p) => sum + (p.kind === 'glyph' ? [...p.char].length : p.kind === 'missing' ? 1 : 0), 0) - glyphCount
  }

  let time = 0
  const speed = learned.observations
  const targetSpeed = speed.length ? speed.reduce((n, o) => n + o.speed, 0) / speed.length : .3
  for (const stroke of strokes) {
    time += 35
    const points = stroke.points
    let previousSpeed = targetSpeed
    stroke.points = points.map((point, i) => {
      const previous = points[Math.max(0, i - 1)]
      const distance = Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height)
      const localSpeed = clamp(distance / Math.max(1, point.t - previous.t), targetSpeed * .5, targetSpeed * 2)
      previousSpeed = previousSpeed * .7 + localSpeed * .3
      time += Math.max(1, distance / previousSpeed)
      return { ...point, t: time }
    })
    Object.assign(stroke, { synthesis: { engine: 2, seed: options.seed } })
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
    pageWidth: width,
    pageHeight: height,
  }
}

export const synthesizeHandwritingToFit = (
  input: string,
  samples: Sample[],
  options: HandwritingSynthesisOptions,
  page = { width: 900, height: 1273 },
  minimumFontSize = 18,
  preparedStyle?: ReturnType<typeof personalStyle>,
) => {
  const requestedSize = clamp(options.fontSize, minimumFontSize, 96)
  let result = synthesizeHandwriting(input, samples, { ...options, fontSize: requestedSize }, page, preparedStyle)
  for (let fontSize = requestedSize - 2; result.overflow && fontSize >= minimumFontSize; fontSize -= 2) {
    result = synthesizeHandwriting(input, samples, { ...options, fontSize }, page, preparedStyle)
  }
  return result
}
