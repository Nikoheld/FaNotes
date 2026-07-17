import type { LabelDefinition, Sample, Stroke, StrokePoint } from '../types'
import characterNumbers from 'hershey/src/characterNumbers.js'
import encodedRomanSimplex from 'hershey/src/rowmans.js'
import '@fontsource/caveat/latin-400.css'
import '@fontsource/caveat/latin-ext-400.css'
import '@fontsource/dancing-script/latin-400.css'
import '@fontsource/dancing-script/latin-ext-400.css'
import '@fontsource/kalam/latin-400.css'
import '@fontsource/kalam/latin-ext-400.css'

export const STANDARD_RECOGNITION_VERSION = '5'
export const STANDARD_RECOGNITION_SESSION = `fanotes-standard-${STANDARD_RECOGNITION_VERSION}`

const IMAGE_SIZE = 256
const GLYPH_MARGIN = 27
const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560

type FontVariant = {
  family: string
  style: 'normal' | 'italic'
  weight: 400 | 500
}

const textFonts: FontVariant[] = [
  { family: 'KaTeX_SansSerif, "Segoe UI", Arial, sans-serif', style: 'normal', weight: 400 },
  { family: 'KaTeX_Math, KaTeX_Main, "Times New Roman", serif', style: 'italic', weight: 400 },
  { family: 'Caveat, cursive', style: 'normal', weight: 400 },
  { family: 'Kalam, cursive', style: 'normal', weight: 400 },
  { family: '"Dancing Script", cursive', style: 'normal', weight: 400 },
]

const mathFonts: FontVariant[] = [
  { family: 'KaTeX_Main, "STIX Two Math", "Cambria Math", serif', style: 'normal', weight: 400 },
  { family: 'KaTeX_AMS, KaTeX_Main, "STIX Two Math", serif', style: 'normal', weight: 400 },
]

const greekFonts: FontVariant[] = [
  { family: 'KaTeX_Math, KaTeX_Main, serif', style: 'italic', weight: 400 },
  { family: 'KaTeX_Main, "Times New Roman", serif', style: 'normal', weight: 400 },
]

const largeOperatorIds = new Set([
  'operator_sum',
  'operator_product',
  'operator_integral',
  'operator_double_integral',
  'operator_triple_integral',
  'operator_contour_integral',
  'operator_big_union',
  'operator_big_intersection',
])

type HersheyDescriptor = {
  left: number
  right: number
  paths: [number, number][][]
}

let hersheyCharacters: Map<number, HersheyDescriptor> | null = null

const romanSimplexCharacters = () => {
  if (hersheyCharacters) return hersheyCharacters
  const result = new Map<number, HersheyDescriptor>()
  const origin = 'R'.charCodeAt(0)
  atob(encodedRomanSimplex).split('\n').forEach((line) => {
    if (!line.trim()) return
    const number = Number.parseInt(line.slice(0, 5), 10)
    const vertexCount = Number.parseInt(line.slice(5, 8), 10) - 1
    const left = line.charCodeAt(8) - origin
    const right = line.charCodeAt(9) - origin
    const paths: [number, number][][] = [[]]
    for (let index = 0; index < vertexCount; index += 1) {
      const x = line.charCodeAt(10 + index * 2) - origin
      const y = line.charCodeAt(11 + index * 2) - origin
      if (x === -50 && y === 0) paths.push([])
      else paths.at(-1)!.push([x, -y])
    }
    result.set(number, { left, right, paths: paths.filter((path) => path.length) })
  })
  hersheyCharacters = result
  return result
}

const hersheyPaths = (char: string) => {
  const number = characterNumbers[char]
  if (!number) return null
  const descriptor = romanSimplexCharacters().get(number)
  if (!descriptor?.paths.length) return null
  const points = descriptor.paths.flat()
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const maxY = Math.max(...points.map(([, y]) => y))
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const scale = 0.66 / Math.max(width, height)
  return descriptor.paths.map((path) => path.map(([x, y]) => [
    0.5 + (x - (minX + maxX) / 2) * scale,
    0.5 + (y - (minY + maxY) / 2) * scale,
  ] as [number, number]))
}

/**
 * Adds the short entry and exit strokes that remain attached to a glyph after
 * a cursive word is split.  The small shear also covers the most common
 * right-leaning handwriting without requiring a personal sample first.
 */
const connectedHersheyPaths = (paths: StandardPath[]): StandardPath[] => {
  const slanted = paths.map((path) => path.map(([x, y]) => [
    Math.max(0.04, Math.min(0.96, x + (0.58 - y) * 0.11)),
    y,
  ] as [number, number]))
  const points = slanted.flat()
  if (!points.length) return slanted
  const left = points.reduce((best, point) => point[0] < best[0] ? point : best)
  const right = points.reduce((best, point) => point[0] > best[0] ? point : best)
  const entryY = Math.max(0.56, Math.min(0.72, left[1]))
  const exitY = Math.max(0.56, Math.min(0.72, right[1]))
  return [
    [[Math.max(0.04, left[0] - 0.2), entryY], left],
    ...slanted,
    [right, [Math.min(0.96, right[0] + 0.2), exitY]],
  ]
}

type StandardPath = [number, number][]

const ellipsePath = (
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  start = 0,
  end = Math.PI * 2,
): StandardPath => Array.from({ length: 25 }, (_, index) => {
  const angle = start + (end - start) * index / 24
  return [centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY]
})

const wavePath = (y: number): StandardPath => Array.from({ length: 17 }, (_, index) => {
  const progress = index / 16
  return [0.2 + progress * 0.6, y + Math.sin(progress * Math.PI * 2) * 0.055]
})

const integralPath = (offsetX = 0): StandardPath => [
  [0.62 + offsetX, 0.17], [0.52 + offsetX, 0.13], [0.43 + offsetX, 0.2],
  [0.42 + offsetX, 0.34], [0.49 + offsetX, 0.5], [0.56 + offsetX, 0.66],
  [0.55 + offsetX, 0.8], [0.46 + offsetX, 0.87], [0.36 + offsetX, 0.83],
]

const manualMathPaths: Record<string, StandardPath[]> = {
  digit_0: [ellipsePath(0.5, 0.5, 0.18, 0.3)],
  digit_1: [[[0.43, 0.3], [0.5, 0.22], [0.5, 0.78]], [[0.38, 0.78], [0.62, 0.78]]],
  digit_2: [[[0.2, 0.31], [0.29, 0.17], [0.54, 0.12], [0.76, 0.25], [0.74, 0.4], [0.58, 0.55], [0.23, 0.82], [0.79, 0.82]]],
  digit_3: [[[0.21, 0.23], [0.4, 0.13], [0.68, 0.17], [0.75, 0.34], [0.61, 0.49], [0.43, 0.5], [0.64, 0.52], [0.78, 0.67], [0.66, 0.83], [0.37, 0.87], [0.2, 0.76]]],
  digit_4: [[[0.67, 0.86], [0.67, 0.13], [0.2, 0.63], [0.8, 0.63]]],
  digit_5: [[[0.75, 0.15], [0.31, 0.15], [0.25, 0.46], [0.51, 0.42], [0.73, 0.54], [0.72, 0.74], [0.56, 0.86], [0.31, 0.83], [0.19, 0.74]]],
  digit_6: [[[0.69, 0.18], [0.5, 0.12], [0.31, 0.24], [0.21, 0.52], [0.25, 0.77], [0.43, 0.87], [0.66, 0.8], [0.74, 0.62], [0.61, 0.48], [0.39, 0.46], [0.22, 0.58]]],
  digit_7: [[[0.32, 0.22], [0.68, 0.22], [0.42, 0.78]]],
  digit_8: [[[0.49, 0.5], [0.3, 0.37], [0.31, 0.19], [0.5, 0.11], [0.69, 0.2], [0.67, 0.39], [0.49, 0.5], [0.29, 0.61], [0.28, 0.79], [0.48, 0.89], [0.69, 0.79], [0.68, 0.61], [0.49, 0.5]]],
  digit_9: [[[0.74, 0.45], [0.61, 0.54], [0.37, 0.51], [0.24, 0.34], [0.32, 0.15], [0.57, 0.11], [0.75, 0.28], [0.72, 0.57], [0.57, 0.81], [0.37, 0.88]]],
  operator_plus: [[[0.25, 0.5], [0.75, 0.5]], [[0.5, 0.25], [0.5, 0.75]]],
  operator_minus: [[[0.22, 0.5], [0.78, 0.5]]],
  punctuation_underscore: [[[0.18, 0.8], [0.82, 0.8]]],
  operator_multiply: [[[0.28, 0.28], [0.72, 0.72]], [[0.72, 0.28], [0.28, 0.72]]],
  operator_dot: [[[0.5, 0.5]]],
  operator_divide: [[[0.23, 0.5], [0.77, 0.5]], [[0.5, 0.27]], [[0.5, 0.73]]],
  relation_equal: [[[0.25, 0.43], [0.75, 0.43]], [[0.25, 0.57], [0.75, 0.57]]],
  relation_not_equal: [[[0.25, 0.43], [0.75, 0.43]], [[0.25, 0.57], [0.75, 0.57]], [[0.65, 0.22], [0.35, 0.78]]],
  relation_less: [[[0.7, 0.25], [0.3, 0.5], [0.7, 0.75]]],
  relation_greater: [[[0.3, 0.25], [0.7, 0.5], [0.3, 0.75]]],
  relation_less_equal: [[[0.7, 0.2], [0.3, 0.43], [0.7, 0.66]], [[0.31, 0.78], [0.71, 0.78]]],
  relation_greater_equal: [[[0.3, 0.2], [0.7, 0.43], [0.3, 0.66]], [[0.29, 0.78], [0.69, 0.78]]],
  operator_plus_minus: [[[0.25, 0.38], [0.75, 0.38]], [[0.5, 0.18], [0.5, 0.58]], [[0.25, 0.76], [0.75, 0.76]]],
  relation_approx: [wavePath(0.41), wavePath(0.59)],
  relation_equiv: [[[0.23, 0.34], [0.77, 0.34]], [[0.23, 0.5], [0.77, 0.5]], [[0.23, 0.66], [0.77, 0.66]]],
  symbol_infinity: [[...ellipsePath(0.38, 0.5, 0.2, 0.18), ...ellipsePath(0.62, 0.5, 0.2, 0.18).reverse()]],
  operator_sum: [[[0.7, 0.18], [0.3, 0.18], [0.56, 0.5], [0.3, 0.82], [0.7, 0.82]]],
  operator_product: [[[0.27, 0.8], [0.27, 0.2], [0.73, 0.2], [0.73, 0.8]], [[0.18, 0.2], [0.82, 0.2]]],
  operator_integral: [integralPath()],
  operator_double_integral: [integralPath(-0.11), integralPath(0.11)],
  operator_triple_integral: [integralPath(-0.17), integralPath(), integralPath(0.17)],
  operator_contour_integral: [integralPath(), ellipsePath(0.5, 0.5, 0.25, 0.17)],
  operator_big_union: [ellipsePath(0.5, 0.38, 0.28, 0.38, 0, Math.PI)],
  operator_big_intersection: [ellipsePath(0.5, 0.62, 0.28, 0.38, Math.PI, Math.PI * 2)],
  operator_sqrt: [[[0.1, 0.55], [0.22, 0.7], [0.34, 0.26], [0.42, 0.2], [0.9, 0.2]]],
  operator_nabla: [[[0.2, 0.25], [0.5, 0.78], [0.8, 0.25], [0.2, 0.25]]],
  operator_percent: [ellipsePath(0.32, 0.3, 0.11, 0.13), [[0.7, 0.18], [0.3, 0.82]], ellipsePath(0.68, 0.7, 0.11, 0.13)],
  operator_factorial: [[[0.5, 0.18], [0.5, 0.63]], [[0.5, 0.8]]],
  operator_prime: [[[0.56, 0.18], [0.48, 0.38]]],
  symbol_degree: [ellipsePath(0.5, 0.5, 0.22, 0.22)],
  operator_slash: [[[0.7, 0.18], [0.3, 0.82]]],
  operator_caret: [[[0.25, 0.62], [0.5, 0.34], [0.75, 0.62]]],
  absolute_bar: [[[0.5, 0.16], [0.5, 0.84]]],
  set_element: [ellipsePath(0.55, 0.5, 0.28, 0.31, Math.PI / 2, Math.PI * 1.5), [[0.34, 0.42], [0.67, 0.42]], [[0.34, 0.58], [0.67, 0.58]]],
  set_not_element: [ellipsePath(0.55, 0.5, 0.28, 0.31, Math.PI / 2, Math.PI * 1.5), [[0.34, 0.42], [0.67, 0.42]], [[0.34, 0.58], [0.67, 0.58]], [[0.7, 0.18], [0.3, 0.82]]],
  set_subset: [ellipsePath(0.53, 0.5, 0.28, 0.31, Math.PI / 2, Math.PI * 1.5)],
  set_subset_equal: [ellipsePath(0.53, 0.43, 0.28, 0.27, Math.PI / 2, Math.PI * 1.5), [[0.26, 0.78], [0.75, 0.78]]],
  set_union: [ellipsePath(0.5, 0.38, 0.28, 0.38, 0, Math.PI)],
  set_intersection: [ellipsePath(0.5, 0.62, 0.28, 0.38, Math.PI, Math.PI * 2)],
  set_empty: [ellipsePath(0.5, 0.5, 0.24, 0.3), [[0.7, 0.16], [0.3, 0.84]]],
  logic_forall: [[[0.22, 0.2], [0.5, 0.8], [0.78, 0.2]], [[0.32, 0.5], [0.68, 0.5]]],
  logic_exists: [[[0.72, 0.2], [0.3, 0.2], [0.3, 0.8], [0.72, 0.8]], [[0.3, 0.5], [0.65, 0.5]]],
  logic_and: [[[0.22, 0.72], [0.5, 0.25], [0.78, 0.72]]],
  logic_or: [[[0.22, 0.28], [0.5, 0.75], [0.78, 0.28]]],
  logic_not: [[[0.22, 0.45], [0.72, 0.45], [0.72, 0.7]]],
  arrow_right: [[[0.18, 0.5], [0.82, 0.5]], [[0.62, 0.3], [0.82, 0.5], [0.62, 0.7]]],
  arrow_both: [[[0.18, 0.5], [0.82, 0.5]], [[0.38, 0.3], [0.18, 0.5], [0.38, 0.7]], [[0.62, 0.3], [0.82, 0.5], [0.62, 0.7]]],
  arrow_implies: [[[0.18, 0.42], [0.78, 0.42]], [[0.18, 0.58], [0.78, 0.58]], [[0.62, 0.25], [0.82, 0.5], [0.62, 0.75]]],
  arrow_iff: [[[0.22, 0.42], [0.78, 0.42]], [[0.22, 0.58], [0.78, 0.58]], [[0.38, 0.24], [0.18, 0.5], [0.38, 0.76]], [[0.62, 0.24], [0.82, 0.5], [0.62, 0.76]]],
  geometry_parallel: [[[0.38, 0.18], [0.38, 0.82]], [[0.62, 0.18], [0.62, 0.82]]],
  geometry_perpendicular: [[[0.5, 0.18], [0.5, 0.76]], [[0.25, 0.76], [0.75, 0.76]]],
}

// Single-line school-handwriting forms complement printed fonts and Hershey
// outlines. Their entry and exit strokes deliberately survive the clipping
// that happens when a continuously written word is segmented into letters.
const manualHandwritingPaths: Record<string, StandardPath[]> = {
  a: [[[0, .68], [.14, .51], [.42, .3], [.7, .35], [.76, .56], [.59, .78], [.28, .76], [.18, .56], [.4, .34], [.7, .35], [.69, .77], [1, .66]]],
  c: [[[0, .67], [.2, .46], [.45, .3], [.72, .32], [.84, .43], [.62, .34], [.31, .43], [.22, .65], [.4, .8], [.72, .78], [1, .66]]],
  e: [[[0, .68], [.22, .51], [.72, .49], [.64, .27], [.25, .25], [.1, .48], [.18, .76], [.65, .82], [1, .65]]],
  h: [[[0, .68], [.17, .62], [.34, .1], [.43, .05], [.48, .25], [.42, .78], [.47, .48], [.64, .34], [.8, .44], [.78, .76], [1, .66]]],
  l: [[[0, .68], [.2, .6], [.38, .12], [.54, .06], [.6, .24], [.48, .68], [.57, .8], [.78, .76], [1, .66]]],
  m: [[[0, .68], [.18, .61], [.22, .38], [.24, .76], [.29, .48], [.43, .35], [.57, .45], [.55, .76], [.61, .46], [.75, .35], [.88, .45], [.87, .76], [1, .66]]],
  n: [[[0, .68], [.2, .61], [.24, .38], [.25, .76], [.31, .49], [.53, .34], [.72, .45], [.7, .76], [1, .66]]],
  o: [[[0, .68], [.18, .5], [.42, .31], [.7, .36], [.78, .57], [.6, .78], [.33, .77], [.2, .57], [.42, .34], [.72, .37], [1, .66]]],
  p: [[[0, .68], [.2, .61], [.27, .38], [.26, .98], [.25, .44], [.48, .31], [.72, .39], [.76, .61], [.57, .76], [.29, .66], [1, .66]]],
  r: [[[0, .68], [.2, .61], [.27, .39], [.29, .75], [.34, .48], [.51, .34], [.7, .45], [.82, .55], [1, .66]]],
  s: [[[0, .65], [.28, .31], [.73, .3], [.84, .45], [.25, .66], [.2, .78], [.48, .87], [.86, .75], [1, .66]]],
  t: [
    [[0, .7], [.22, .64], [.44, .08], [.48, .82], [.72, .72], [1, .67]],
    [[.24, .35], [.72, .34]],
  ],
  u: [[[0, .52], [.18, .43], [.18, .71], [.31, .8], [.52, .72], [.66, .42], [.65, .76], [1, .66]]],
}

const manualUppercaseHandwritingPaths: Record<string, StandardPath[]> = {
  T: [
    [[0.16, 0.18], [0.84, 0.18]],
    [[0.5, 0.18], [0.5, 0.86]],
  ],
}

const handwritingPaths = (label: LabelDefinition) => {
  if (label.category === 'uppercase' && manualUppercaseHandwritingPaths[label.char]) {
    return manualUppercaseHandwritingPaths[label.char]
  }
  return label.category === 'lowercase' && manualHandwritingPaths[label.char]
    ? manualHandwritingPaths[label.char].map((path) => path.map(([x, y]) => [
        0.5 + (x - 0.5) * 0.36,
        y,
      ] as [number, number]))
    : null
}

const manualPaths = (labelId: string) => manualMathPaths[labelId] ?? null

const handwritingMathPaths = (labelId: string) => manualMathPaths[labelId]?.map((path) => (
  path.map(([x, y]) => [0.5 + (x - 0.5) * 0.36, y] as [number, number])
)) ?? null

const variantsForLabel = (label: LabelDefinition): FontVariant[] => {
  if (manualPaths(label.id)) {
    return [largeOperatorIds.has(label.id)
      ? { family: 'KaTeX_Size1, KaTeX_Main, "STIX Two Math", serif', style: 'normal', weight: 400 }
      : label.category === 'math' ? mathFonts[0] : textFonts[0]]
  }
  if (largeOperatorIds.has(label.id)) {
    return [
      { family: 'KaTeX_Size1, KaTeX_Main, "STIX Two Math", serif', style: 'normal', weight: 400 },
      mathFonts[0],
    ]
  }
  if (label.category === 'math') return [mathFonts[0]]
  if (label.category === 'greek') return [greekFonts[0]]
  return textFonts
}

const waitForBundledFonts = async () => {
  if (!('fonts' in document)) return
  const fonts = [
    '400 160px KaTeX_Main',
    '400 160px KaTeX_SansSerif',
    'italic 400 160px KaTeX_Math',
    '400 160px KaTeX_AMS',
    '400 160px KaTeX_Size1',
    '400 160px Caveat',
    '400 160px Kalam',
    '400 160px "Dancing Script"',
  ]
  await Promise.all(fonts.map((font) => document.fonts.load(font).catch(() => [])))
}

const fontString = (font: FontVariant, size: number) =>
  `${font.style} ${font.weight} ${size}px ${font.family}`

const renderedGlyph = (label: LabelDefinition, font: FontVariant) => {
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_SIZE
  canvas.height = IMAGE_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Der Standardzeichensatz konnte nicht gerendert werden.')

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE)
  context.fillStyle = '#142b2a'
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'

  let fontSize = largeOperatorIds.has(label.id) ? 188 : 176
  let metrics: TextMetrics
  const available = IMAGE_SIZE - GLYPH_MARGIN * 2
  do {
    context.font = fontString(font, fontSize)
    metrics = context.measureText(label.char)
    const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
    if (width <= available && height <= available) break
    fontSize -= 4
  } while (fontSize >= 76)

  context.font = fontString(font, fontSize)
  metrics = context.measureText(label.char)
  const x = IMAGE_SIZE / 2 + (metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2
  const y = IMAGE_SIZE / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2
  context.fillText(label.char, x, y)
  return canvas.toDataURL('image/png')
}

const referencePoint = (x: number, y: number, t: number): StrokePoint => ({
  x,
  y,
  t,
  pressure: 0.55,
  tiltX: 0,
  tiltY: 0,
  pointerType: 'standard',
})

// The standard classifier deliberately uses only visual channels. These strokes
// preserve the dataset schema without pretending that a font glyph has a pen
// order. Once personal examples exist, their real pen geometry is preferred.
const referenceStrokes = (variant: number): Stroke[] => [{
  baseWidth: 5,
  pressureEnabled: false,
  points: variant === 0
    ? [referencePoint(0.42, 0.24, 0), referencePoint(0.58, 0.76, 1)]
    : [referencePoint(0.38, 0.28, 0), referencePoint(0.62, 0.72, 1)],
}]

const strokesFromPaths = (paths: [number, number][][], baseWidth = 5): Stroke[] => paths
  .filter((path) => path.length)
  .map((path, strokeIndex) => ({
    baseWidth,
    pressureEnabled: false,
    points: path.map(([x, y], pointIndex) => referencePoint(x, y, strokeIndex * 100 + pointIndex)),
  }))

const renderedStrokeGlyph = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  const minX = Math.min(...points.map((point) => point.x * SOURCE_WIDTH)) - 7.5
  const maxX = Math.max(...points.map((point) => point.x * SOURCE_WIDTH)) + 7.5
  const minY = Math.min(...points.map((point) => point.y * SOURCE_HEIGHT)) - 7.5
  const maxY = Math.max(...points.map((point) => point.y * SOURCE_HEIGHT)) + 7.5
  const width = Math.max(15, maxX - minX)
  const height = Math.max(15, maxY - minY)
  const scale = Math.min(
    (IMAGE_SIZE - GLYPH_MARGIN * 2) / width,
    (IMAGE_SIZE - GLYPH_MARGIN * 2) / height,
  )
  const offsetX = (IMAGE_SIZE - width * scale) / 2
  const offsetY = (IMAGE_SIZE - height * scale) / 2
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_SIZE
  canvas.height = IMAGE_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Der Standardzeichensatz konnte nicht gerendert werden.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE)
  context.strokeStyle = '#142b2a'
  context.fillStyle = '#142b2a'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  strokes.forEach((stroke) => {
    if (stroke.points.length === 1) {
      const point = stroke.points[0]
      context.beginPath()
      context.arc(
        offsetX + (point.x * SOURCE_WIDTH - minX) * scale,
        offsetY + (point.y * SOURCE_HEIGHT - minY) * scale,
        stroke.baseWidth * scale / 2,
        0,
        Math.PI * 2,
      )
      context.fill()
      return
    }
    context.beginPath()
    stroke.points.forEach((point, index) => {
      const x = offsetX + (point.x * SOURCE_WIDTH - minX) * scale
      const y = offsetY + (point.y * SOURCE_HEIGHT - minY) * scale
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.lineWidth = stroke.baseWidth * scale
    context.stroke()
  })
  return canvas.toDataURL('image/png')
}

const sampleRecord = (
  label: LabelDefinition,
  variant: number,
  imageData: string,
  strokes: Stroke[],
): Sample => ({
  id: `${STANDARD_RECOGNITION_SESSION}-${label.id}-${variant}`,
  labelId: label.id,
  label: label.char,
  labelName: label.name,
  latex: label.latex,
  category: label.category,
  writerId: 'FaNotes Standardmodell',
  sessionId: STANDARD_RECOGNITION_SESSION,
  createdAt: '2026-01-01T00:00:00.000Z',
  imageData,
  imageWidth: IMAGE_SIZE,
  imageHeight: IMAGE_SIZE,
  sourceCanvas: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, devicePixelRatio: 1 },
  bbox: [0, 0, 1, 1],
  strokes,
  strokeCount: strokes.length,
  pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
  schemaVersion: 1,
})

const cache = new Map<string, Promise<Sample[]>>()

/**
 * Produces a trusted, read-only baseline from bundled fonts. It never enters
 * IndexedDB and therefore cannot be mistaken for personal GlyphenWerk data.
 */
export const createStandardRecognitionSamples = async (
  labels: LabelDefinition[],
): Promise<Sample[]> => {
  const supported = labels.filter((label) => Array.from(label.char).length === 1)
  const signature = supported.map((label) => `${label.id}:${label.char}:${label.category}`).join('|')
  const cached = cache.get(signature)
  if (cached) return cached

  const pending = (async () => {
    await waitForBundledFonts()
    const samples: Sample[] = []
    supported.forEach((label) => {
      let variant = 0
      variantsForLabel(label).forEach((font) => {
        const strokes = referenceStrokes(variant)
        samples.push(sampleRecord(label, variant++, renderedGlyph(label, font), strokes))
      })
      const standardMathPaths = manualPaths(label.id)
      const paths = standardMathPaths ? null : hersheyPaths(label.char)
      if (paths) {
        const strokes = strokesFromPaths(paths)
        samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(strokes), strokes))
        if (!manualPaths(label.id)) {
          const broadStrokes = strokesFromPaths(paths, 28)
          samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(broadStrokes), broadStrokes))
          if (label.category === 'lowercase' || label.category === 'uppercase' || label.category === 'german') {
            const connectedStrokes = strokesFromPaths(connectedHersheyPaths(paths), 7)
            samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(connectedStrokes), connectedStrokes))
          }
        }
      }
      const handwrittenPaths = handwritingPaths(label)
      if (handwrittenPaths) {
        const strokes = strokesFromPaths(handwrittenPaths, 12)
        samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(strokes), strokes))
        const strongerStrokes = strokesFromPaths(handwrittenPaths, 24)
        samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(strongerStrokes), strongerStrokes))
      }
      if (standardMathPaths) {
        const strokes = strokesFromPaths(standardMathPaths)
        samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(strokes), strokes))
        const broadStrokes = strokesFromPaths(standardMathPaths, 28)
        samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(broadStrokes), broadStrokes))
        const handwrittenMath = handwritingMathPaths(label.id)
        if (handwrittenMath) {
          const handwrittenStrokes = strokesFromPaths(handwrittenMath, 12)
          samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(handwrittenStrokes), handwrittenStrokes))
          const broadHandwrittenStrokes = strokesFromPaths(handwrittenMath, 24)
          samples.push(sampleRecord(label, variant++, renderedStrokeGlyph(broadHandwrittenStrokes), broadHandwrittenStrokes))
        }
      }
    })
    return samples
  })()
  cache.set(signature, pending)
  return pending
}

export const isStandardRecognitionSample = (sample: Pick<Sample, 'sessionId'>) =>
  sample.sessionId === STANDARD_RECOGNITION_SESSION
