/**
 * PDF pages whose pictures are the note sheet. Node and the renderer can both
 * build the file: the image is raw RGB, compressed with the platform deflate.
 */

export type CanvasPdfPage = {
  width: number
  height: number
  /** Straight RGBA, row-major, `width * height * 4` bytes. */
  rgba: Uint8Array
}

const textBytes = (value: string) => {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 255
  return bytes
}

const concat = (parts: readonly Uint8Array[]) => {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const pdfText = (value: string) => {
  const clean = value.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'FaNotes'
  return `(${clean.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
}

/** Opaque RGB on white. A transparent sample keeps the paper colour already in the bitmap. */
export const rgbaToRgb = (rgba: Uint8Array, width: number, height: number) => {
  const count = Math.max(0, width * height)
  const rgb = new Uint8Array(count * 3)
  const source = rgba.length >= count * 4 ? rgba : new Uint8Array(count * 4)
  for (let index = 0; index < count; index += 1) {
    const at = index * 4
    const alpha = source[at + 3] / 255
    rgb[index * 3] = Math.round(source[at] * alpha + 255 * (1 - alpha))
    rgb[index * 3 + 1] = Math.round(source[at + 1] * alpha + 255 * (1 - alpha))
    rgb[index * 3 + 2] = Math.round(source[at + 2] * alpha + 255 * (1 - alpha))
  }
  return rgb
}

const deflateBytes = async (raw: Uint8Array) => {
  const copy = new ArrayBuffer(raw.byteLength)
  new Uint8Array(copy).set(raw)
  const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * One PDF page per picture, in order, at the picture's aspect (595pt wide).
 * The bytes are a real PDF 1.4 file with an image XObject on each page.
 */
export async function pdfFromRgbaPages(pages: readonly CanvasPdfPage[], title = 'FaNotes'): Promise<Uint8Array> {
  const usable = pages.filter((page) => page.width > 0 && page.height > 0 && page.rgba.length >= page.width * page.height * 4)
  if (!usable.length) throw new Error('PDF-Export fehlgeschlagen.')
  const objects: Uint8Array[] = []
  const pageRefs: number[] = []
  // Catalog and page tree are objects 1 and 2. Each page then uses three objects.
  objects.push(textBytes(''))
  objects.push(textBytes(''))
  for (const page of usable) {
    const widthPt = 595
    const heightPt = Math.max(1, Math.round((595 * page.height) / page.width * 100) / 100)
    const pageId = objects.length + 1
    const contentId = pageId + 1
    const imageId = pageId + 2
    const commands = `q\n${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ`
    const compressed = await deflateBytes(rgbaToRgb(page.rgba, page.width, page.height))
    objects.push(textBytes(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt.toFixed(2)}] /Contents ${contentId} 0 R /Resources << /XObject << /Im0 ${imageId} 0 R >> >> >>`,
    ))
    objects.push(textBytes(`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`))
    objects.push(concat([
      textBytes(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
      compressed,
      textBytes('\nendstream'),
    ]))
    pageRefs.push(pageId)
  }
  const infoId = objects.length + 1
  objects.push(textBytes(`<< /Title ${pdfText(title)} /Producer (FaNotes) /Creator (FaNotes) >>`))
  const kids = pageRefs.map((id) => `${id} 0 R`).join(' ')
  objects[0] = textBytes('<< /Type /Catalog /Pages 2 0 R >>')
  objects[1] = textBytes(`<< /Type /Pages /Kids [${kids}] /Count ${pageRefs.length} >>`)

  const header = textBytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const chunks: Uint8Array[] = [header]
  const offsets = [0]
  let size = header.length
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(size)
    const piece = concat([textBytes(`${index + 1} 0 obj\n`), objects[index], textBytes('\nendobj\n')])
    chunks.push(piece)
    size += piece.length
  }
  const xref = [`xref`, `0 ${objects.length + 1}`, '0000000000 65535 f ']
  for (let index = 1; index <= objects.length; index += 1) xref.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `)
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${size}\n%%EOF\n`
  chunks.push(textBytes(`${xref.join('\n')}\n${trailer}`))
  return concat(chunks)
}
