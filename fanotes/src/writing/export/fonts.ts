// The bundled font files for the exporters: bytes for embedding (PDF, EPUB)
// and a fontkit-based measurer that measures with exactly those files. The
// screen measures with canvas on the same files; where no canvas exists (a
// worker, Node tests) this measurer gives the same widths the PDF is drawn
// with.
import type { Font as FontkitFont } from '@pdf-lib/fontkit'
import { FONT_FILES, fontFileFor, fontUrl, type FontSpec, type TextMeasurer } from '../layout/measure'
import type { FontFamilyId, StoryManifest } from '../model/types'

export type FontLoader = (file: string) => Promise<Uint8Array>

/** Fetches a font from the app's `writing/fonts/` folder (web, Electron, Android WebView). */
export const fetchFont: FontLoader = async (file) => {
  const response = await fetch(fontUrl(file))
  if (!response.ok) throw new Error(`Font ${file}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Loads each font file once and keeps its bytes and parsed fontkit font. */
export class FontFiles {
  private bytes = new Map<string, Promise<Uint8Array>>()
  private parsed = new Map<string, FontkitFont>()

  constructor(private readonly loader: FontLoader = fetchFont) {}

  load(file: string): Promise<Uint8Array> {
    let pending = this.bytes.get(file)
    if (!pending) {
      pending = this.loader(file)
      this.bytes.set(file, pending)
    }
    return pending
  }

  async font(file: string): Promise<FontkitFont> {
    const cached = this.parsed.get(file)
    if (cached) return cached
    // Loaded on first use: fontkit is large and only the exporters need it.
    const { default: fontkit } = await import('@pdf-lib/fontkit')
    const font = fontkit.create(await this.load(file))
    this.parsed.set(file, font)
    return font
  }

  /** A font that was loaded before (see `preload`). */
  loaded(file: string): FontkitFont | null {
    return this.parsed.get(file) ?? null
  }

  async preload(files: Iterable<string>) {
    await Promise.all([...new Set(files)].map((file) => this.font(file)))
  }
}

/** Every font file a manuscript can use: its styles' families and any run's font, in all four faces. */
export const fontFilesOf = (manifest: StoryManifest, extraFamilies: FontFamilyId[] = []) => {
  const families = new Set<FontFamilyId>(['literata', ...extraFamilies])
  for (const style of Object.values(manifest.styles)) families.add(style.font)
  return families
}

export const allFaces = (families: Iterable<FontFamilyId>) => [...families].flatMap((family) => Object.values(FONT_FILES[family].files))

/** Adds the families used in runs (direct formatting). */
export const familiesInRuns = (runs: Iterable<{ m?: { font?: FontFamilyId } }>, into: Set<FontFamilyId>) => {
  for (const run of runs) if (run.m?.font) into.add(run.m.font)
  return into
}

/**
 * Measures with fontkit (kerning and ligatures applied, like canvas text).
 * The fonts must be preloaded in `files`.
 */
export class FontkitMeasurer implements TextMeasurer {
  private widths = new Map<string, Map<string, number>>()
  private fontMetrics = new Map<string, { ascent: number; descent: number }>()

  constructor(private readonly files: FontFiles) {}

  private fontOf(font: Pick<FontSpec, 'family' | 'bold' | 'italic'>) {
    const file = fontFileFor(font)
    const loaded = this.files.loaded(file)
    if (!loaded) throw new Error(`Font ${file} was not loaded`)
    return loaded
  }

  width(text: string, font: FontSpec) {
    if (!text) return 0
    const key = `${font.family}|${font.bold ? 1 : 0}|${font.italic ? 1 : 0}`
    let cache = this.widths.get(key)
    if (!cache) {
      cache = new Map()
      this.widths.set(key, cache)
    }
    let units = cache.get(text)
    if (units === undefined) {
      const face = this.fontOf(font)
      const run = face.layout(text)
      units = 0
      for (const position of run.positions) units += position.xAdvance
      units /= face.unitsPerEm
      if (cache.size > 200_000) cache.clear()
      cache.set(text, units)
    }
    return units * font.size
  }

  metrics(font: FontSpec) {
    const key = `${font.family}|${font.bold ? 1 : 0}|${font.italic ? 1 : 0}`
    let value = this.fontMetrics.get(key)
    if (!value) {
      const face = this.fontOf(font)
      value = { ascent: face.ascent / face.unitsPerEm, descent: Math.abs(face.descent) / face.unitsPerEm }
      this.fontMetrics.set(key, value)
    }
    return { ascent: value.ascent * font.size, descent: value.descent * font.size }
  }
}
