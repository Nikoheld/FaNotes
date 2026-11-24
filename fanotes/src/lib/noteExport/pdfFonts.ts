/**
 * Unicode text for exported PDFs: bundled fonts embedded as subsets, with a
 * per-character fallback (the writing fonts have no Greek or math signs, so
 * "x ≤ 1 α" comes from Liberation Sans, which pdf.js ships for the app).
 */
import fontkit from '@pdf-lib/fontkit'
import type { PDFDocument, PDFFont } from 'pdf-lib'

export type FontFace = 'regular' | 'bold' | 'italic' | 'boldItalic'
export type FontFamily = 'sans' | 'mono'

/** Reads one font file by its key, e.g. `writing/AtkinsonHyperlegible-Regular.ttf` or `pdfjs/LiberationSans-Bold.ttf`. */
export type FontFileLoader = (key: string) => Promise<Uint8Array>

const FACE_SUFFIX: Record<FontFace, string> = { regular: 'Regular', bold: 'Bold', italic: 'Italic', boldItalic: 'BoldItalic' }

/** Families in fallback order. The first one that has a character's glyph draws it. */
const CHAINS: Record<FontFamily, readonly string[]> = {
  sans: ['writing/AtkinsonHyperlegible', 'pdfjs/LiberationSans'],
  mono: ['writing/CourierPrime', 'writing/AtkinsonHyperlegible', 'pdfjs/LiberationSans'],
}

export const fontFileKey = (stem: string, face: FontFace) => `${stem}-${FACE_SUFFIX[face]}.ttf`

type Entry = { key: string; font: PDFFont; chars: Set<number> }

export type TextPiece = { text: string; entry: Entry }

export class PdfFontBook {
  private readonly entries = new Map<string, Entry>()
  private readonly widths = new Map<string, number>()
  private registered = false

  constructor(
    private readonly doc: PDFDocument,
    private readonly load: FontFileLoader,
  ) {}

  private register() {
    if (this.registered) return
    this.doc.registerFontkit(fontkit)
    this.registered = true
  }

  private async open(stem: string, face: FontFace): Promise<Entry | null> {
    const key = fontFileKey(stem, face)
    const known = this.entries.get(key)
    if (known) return known
    try {
      this.register()
      const bytes = await this.load(key)
      const font = await this.doc.embedFont(bytes, { subset: true })
      const entry: Entry = { key, font, chars: new Set(font.getCharacterSet()) }
      this.entries.set(key, entry)
      return entry
    } catch {
      return null
    }
  }

  /**
   * Loads what `texts` need. Faces are `faces`; a fallback family loads only
   * when some character is missing from the families before it.
   */
  async prepare(texts: Iterable<string>, family: FontFamily, faces: ReadonlySet<FontFace>) {
    const wanted = new Set<number>()
    for (const text of texts) for (const char of text) wanted.add(char.codePointAt(0)!)
    wanted.delete(10)
    wanted.delete(13)
    wanted.delete(9)
    const faceList = [...new Set<FontFace>(['regular', ...faces])]
    let missing = wanted
    for (const stem of CHAINS[family]) {
      if (!missing.size) break
      for (const face of faceList) await this.open(stem, face)
      const regular = this.entries.get(fontFileKey(stem, 'regular'))
      if (!regular) continue
      const still = new Set<number>()
      for (const code of missing) if (!regular.chars.has(code)) still.add(code)
      missing = still
    }
  }

  /** Splits `text` by the first loaded family that has each character. */
  split(text: string, family: FontFamily, face: FontFace): TextPiece[] {
    const pieces: TextPiece[] = []
    const chain = CHAINS[family]
    const pick = (code: number): Entry | null => {
      for (const stem of chain) {
        const entry = this.entries.get(fontFileKey(stem, face)) ?? this.entries.get(fontFileKey(stem, 'regular'))
        if (entry?.chars.has(code)) return entry
      }
      return this.entries.get(fontFileKey(chain[0], face)) ?? this.entries.get(fontFileKey(chain[0], 'regular')) ?? null
    }
    for (const char of text) {
      const code = char.codePointAt(0)!
      if (code < 32 && code !== 9) continue
      const space = code === 9 || code === 32
      const previous = pieces[pieces.length - 1]?.entry
      // A space stays with the text before it: no needless change of font.
      const entry = space && previous ? previous : pick(space ? 32 : code)
      if (!entry) continue
      const last = pieces[pieces.length - 1]
      const piece = code === 9 ? ' ' : char
      if (last && last.entry === entry) last.text += piece
      else pieces.push({ text: piece, entry })
    }
    return pieces
  }

  /** Width of `text` at `size`, in the same unit as `size`. */
  width(text: string, family: FontFamily, face: FontFace, size: number): number {
    let total = 0
    for (const piece of this.split(text, family, face)) {
      const key = `${piece.entry.key}|${piece.text}`
      let unit = this.widths.get(key)
      if (unit === undefined) {
        unit = piece.entry.font.widthOfTextAtSize(piece.text, 1000)
        if (this.widths.size < 20_000) this.widths.set(key, unit)
      }
      total += (unit * size) / 1000
    }
    return total
  }

  /** Hex strings for `Tj`, one per piece, with the font that draws it. */
  encode(text: string, family: FontFamily, face: FontFace): Array<{ entry: Entry; hex: string; text: string }> {
    return this.split(text, family, face).map((piece) => ({
      entry: piece.entry,
      text: piece.text,
      hex: piece.entry.font.encodeText(piece.text).toString(),
    }))
  }
}

export type { Entry as PdfFontEntry }
