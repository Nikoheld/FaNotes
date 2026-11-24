/**
 * A PDF page we draw on with raw content-stream operators. Resources
 * (graphics states, fonts, images, transparency groups) are registered on the
 * page and referenced by name. Used for new pages and for pages of an
 * existing PDF (annotations).
 */
import { PDFName, PDFRawStream, type PDFDocument, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import type { InkResources } from './inkGeometry'

/** zlib bytes (a PDF's FlateDecode) with the platform's native compressor; null where it does not exist. */
const nativeDeflate = async (data: Uint8Array): Promise<Uint8Array | null> => {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

export class PageSurface implements InkResources {
  private readonly parts: string[] = []
  private readonly states = new Map<string, string>()
  private readonly fonts = new Map<PDFFont, string>()
  private readonly images = new Map<PDFImage, string>()

  constructor(
    readonly doc: PDFDocument,
    readonly page: PDFPage,
  ) {}

  push(...ops: string[]) {
    for (const op of ops) if (op) this.parts.push(op)
  }

  gs(alpha: number, blend: 'Normal' | 'Multiply' = 'Normal') {
    const level = Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000
    const key = `${level}|${blend}`
    let name = this.states.get(key)
    if (!name) {
      const entries: Record<string, unknown> = { Type: 'ExtGState', CA: level, ca: level }
      if (blend !== 'Normal') entries.BM = blend
      const ref = this.doc.context.register(this.doc.context.obj(entries as never))
      name = this.page.node.newExtGState('G', ref).toString().slice(1)
      this.states.set(key, name)
    }
    return name
  }

  group(content: string, bbox: readonly [number, number, number, number]) {
    const stream = this.doc.context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: bbox.map((value) => Math.round(value * 10) / 10),
      Group: { Type: 'Group', S: 'Transparency', I: true },
    })
    const ref = this.doc.context.register(stream)
    return this.page.node.newXObject('Gr', ref).toString().slice(1)
  }

  font(font: PDFFont) {
    let name = this.fonts.get(font)
    if (!name) {
      name = this.page.node.newFontDictionary('F', font.ref).toString().slice(1)
      this.fonts.set(font, name)
    }
    return name
  }

  image(image: PDFImage) {
    let name = this.images.get(image)
    if (!name) {
      name = this.page.node.newXObject('Im', image.ref).toString().slice(1)
      this.images.set(image, name)
    }
    return name
  }

  /** Writes the collected operators as one compressed content stream. */
  async finish(options: { wrapExisting?: boolean } = {}) {
    if (!this.parts.length) return
    const { context } = this.doc
    const node = this.page.node
    if (options.wrapExisting) {
      // The page's own content may leave its graphics state open: draw in a clean one.
      node.normalize()
      const open = context.register(context.flateStream('q'))
      const close = context.register(context.flateStream('Q'))
      node.wrapContentStreams(open, close)
    }
    const text = this.parts.join('\n')
    const raw = new TextEncoder().encode(text)
    // Large pages (hundreds of thousands of points) compress several times faster natively than in JS.
    const packed = raw.length > 256 * 1024 ? await nativeDeflate(raw) : null
    const stream = packed
      ? PDFRawStream.of(context.obj({ Filter: 'FlateDecode' }), packed)
      : context.flateStream(text)
    node.addContentStream(context.register(stream))
    this.parts.length = 0
  }
}

export const nameOf = (value: string) => PDFName.of(value)
