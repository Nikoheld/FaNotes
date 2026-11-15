// Text measurement for the layout. Layout units are CSS pixels at 96 dpi and
// zoom 1; the page view scales the result. The canvas measurer uses the
// bundled fonts, so the same text breaks the same way on every platform and
// the PDF export (which embeds the same files) matches the screen.
import type { FontFamilyId, StoryLanguage } from '../model/types'

export const MM = 96 / 25.4
export const PT = 96 / 72
export const mmToPx = (mm: number) => mm * MM
export const ptToPx = (pt: number) => pt * PT

export type FontSpec = {
  family: FontFamilyId
  bold: boolean
  italic: boolean
  /** CSS pixels. */
  size: number
}

export interface TextMeasurer {
  width(text: string, font: FontSpec): number
  /** Ascent and descent in CSS pixels for the font at its size. */
  metrics(font: FontSpec): { ascent: number; descent: number }
}

export const FONT_FILES: Record<FontFamilyId, { css: string; name: string; files: Record<'regular' | 'italic' | 'bold' | 'boldItalic', string> }> = {
  literata: { css: 'FaNotes Literata', name: 'Literata', files: { regular: 'Literata-Regular.ttf', italic: 'Literata-Italic.ttf', bold: 'Literata-Bold.ttf', boldItalic: 'Literata-BoldItalic.ttf' } },
  garamond: { css: 'FaNotes Garamond', name: 'EB Garamond', files: { regular: 'EBGaramond-Regular.ttf', italic: 'EBGaramond-Italic.ttf', bold: 'EBGaramond-Bold.ttf', boldItalic: 'EBGaramond-BoldItalic.ttf' } },
  courier: { css: 'FaNotes Courier', name: 'Courier Prime', files: { regular: 'CourierPrime-Regular.ttf', italic: 'CourierPrime-Italic.ttf', bold: 'CourierPrime-Bold.ttf', boldItalic: 'CourierPrime-BoldItalic.ttf' } },
  atkinson: { css: 'FaNotes Atkinson', name: 'Atkinson Hyperlegible', files: { regular: 'AtkinsonHyperlegible-Regular.ttf', italic: 'AtkinsonHyperlegible-Italic.ttf', bold: 'AtkinsonHyperlegible-Bold.ttf', boldItalic: 'AtkinsonHyperlegible-BoldItalic.ttf' } },
}

export const fontFileFor = (font: Pick<FontSpec, 'family' | 'bold' | 'italic'>) => {
  const files = FONT_FILES[font.family].files
  return font.bold ? (font.italic ? files.boldItalic : files.bold) : font.italic ? files.italic : files.regular
}

export const cssFont = (font: FontSpec) => `${font.italic ? 'italic ' : ''}${font.bold ? '700' : '400'} ${font.size}px "${FONT_FILES[font.family].css}"`
const fontKey = (font: FontSpec) => `${font.family}|${font.bold ? 1 : 0}|${font.italic ? 1 : 0}|${font.size}`

/** URL of a bundled font file, relative to the app. */
export const fontUrl = (file: string) => new URL(`./writing/fonts/${file}`, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/').toString()

let fontsLoading: Promise<void> | null = null
/** Registers the bundled fonts once; resolves when every face can be measured. */
export const loadWritingFonts = () => {
  if (fontsLoading) return fontsLoading
  fontsLoading = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return
    const faces: FontFace[] = []
    for (const family of Object.values(FONT_FILES)) {
      for (const [variant, file] of Object.entries(family.files)) {
        const face = new FontFace(family.css, `url("${fontUrl(file)}") format("truetype")`, {
          weight: variant.startsWith('bold') ? '700' : '400',
          style: variant.toLowerCase().includes('italic') ? 'italic' : 'normal',
          display: 'block',
        })
        faces.push(face)
      }
    }
    await Promise.all(faces.map(async (face) => {
      try {
        document.fonts.add(await face.load())
      } catch {
        // A missing face falls back to the browser's font; layout still works.
      }
    }))
  })()
  return fontsLoading
}

export class CanvasMeasurer implements TextMeasurer {
  private context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  private widths = new Map<string, Map<string, number>>()
  private fontMetrics = new Map<string, { ascent: number; descent: number }>()
  private current = ''

  constructor() {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas')
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!context) throw new Error('Canvas 2D is not available.')
    this.context = context
    if ('fontKerning' in this.context) (this.context as CanvasRenderingContext2D).fontKerning = 'normal'
  }

  private use(font: FontSpec) {
    const css = cssFont(font)
    if (css !== this.current) {
      this.context.font = css
      this.current = css
    }
  }

  width(text: string, font: FontSpec) {
    if (!text) return 0
    const key = fontKey(font)
    let cache = this.widths.get(key)
    if (!cache) {
      cache = new Map()
      this.widths.set(key, cache)
    }
    const cached = cache.get(text)
    if (cached !== undefined) return cached
    this.use(font)
    const width = this.context.measureText(text).width
    if (cache.size > 200_000) cache.clear()
    cache.set(text, width)
    return width
  }

  metrics(font: FontSpec) {
    const key = fontKey(font)
    const cached = this.fontMetrics.get(key)
    if (cached) return cached
    this.use(font)
    const sample = this.context.measureText('Hgjpqy')
    const ascent = sample.fontBoundingBoxAscent || font.size * 0.8
    const descent = sample.fontBoundingBoxDescent || font.size * 0.25
    const value = { ascent, descent }
    this.fontMetrics.set(key, value)
    return value
  }

  /** Drops cached widths, e.g. after the fonts finished loading. */
  reset() {
    this.widths.clear()
    this.fontMetrics.clear()
    this.current = ''
  }
}

/** A deterministic measurer for tests: every character is 0.5 em (1 em for wide glyphs). */
export class FixedMeasurer implements TextMeasurer {
  width(text: string, font: FontSpec) {
    let units = 0
    for (const char of text) units += /[mwMW@]/u.test(char) ? 1 : char === ' ' ? 0.3 : 0.5
    return units * font.size * (font.bold ? 1.05 : 1)
  }

  metrics(font: FontSpec) {
    return { ascent: font.size * 0.8, descent: font.size * 0.2 }
  }
}

// ── Hyphenation ──────────────────────────────────────────────────────────

export type Hyphenator = (word: string) => number[]

const hyphenators = new Map<string, Promise<Hyphenator>>()
const ready = new Map<string, Hyphenator>()
const hyphenModule = (language: StoryLanguage) => (language === 'en-US' ? 'en-us' : language === 'en-GB' ? 'en-gb' : 'de')

const fromSync = (hyphenateSync: (text: string, options: { hyphenChar: string; minWordLength?: number }) => string): Hyphenator => (word) => {
  const marked = hyphenateSync(word, { hyphenChar: '­', minWordLength: 5 })
  const points: number[] = []
  let offset = 0
  for (const char of marked) {
    if (char === '­') points.push(offset)
    else offset += char.length
  }
  return points
}

/** Loads the hyphenation patterns of a language (once). */
export const loadHyphenator = (language: StoryLanguage): Promise<Hyphenator> => {
  const key = hyphenModule(language)
  const existing = hyphenators.get(key)
  if (existing) return existing
  const loading = (key === 'en-us' ? import('hyphen/en-us') : key === 'en-gb' ? import('hyphen/en-gb') : import('hyphen/de'))
    .then((module) => {
      // CommonJS module: the functions are on `default` under some bundlers.
      const source = module as { hyphenateSync?: Parameters<typeof fromSync>[0]; default?: { hyphenateSync: Parameters<typeof fromSync>[0] } }
      const hyphenator = fromSync(source.hyphenateSync ?? source.default!.hyphenateSync)
      ready.set(key, hyphenator)
      return hyphenator
    })
  hyphenators.set(key, loading)
  return loading
}

/** The hyphenator of a language if its patterns are loaded, else null (no hyphenation yet). */
export const hyphenatorFor = (language: StoryLanguage): Hyphenator | null => ready.get(hyphenModule(language)) ?? null
