// Small, dependency-free writers for the benchmark fixtures: a seeded PRNG,
// filler text, PNG images, multi-page PDFs and FaNotes ink drawings. Every
// output is a pure function of its arguments, so the same seed gives the same
// bytes on every machine.
import { deflateSync } from 'node:zlib'

/** mulberry32: tiny, fast, good enough for fixture variety. */
export const prng = (seed) => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
  }
}

const WORDS = (
  'die der und in zu den das nicht von sie ist des sich mit dem dass er es ein ich auf so eine auch als an nach wie im für ' +
  'man aber aus durch wenn nur war noch werden bei hat wir was wird sein einen welche sind oder zur um haben einer mir über ' +
  'Funktion Ableitung Integral Grenzwert Matrix Vektor Gleichung Lösung Beweis Satz Definition Beispiel Aufgabe Übung ' +
  'Zelle Energie Reaktion Molekül Atom Kraft Masse Beschleunigung Spannung Strom Widerstand Welle Frequenz Licht ' +
  'Geschichte Revolution Republik Verfassung Handel Stadt Kloster Reform Krieg Frieden Vertrag Bündnis Kaiser ' +
  'the of and to in is that for it as was with be by on not he this are or his from at which but have an they ' +
  'function derivative integral limit matrix vector equation solution proof theorem definition example exercise ' +
  'cell energy reaction molecule atom force mass acceleration voltage current resistance wave frequency light'
).split(' ')

export const sentence = (random, minWords = 6, maxWords = 18) => {
  const count = random.int(minWords, maxWords)
  const words = Array.from({ length: count }, () => random.pick(WORDS))
  const text = words.join(' ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

export const paragraph = (random, minSentences = 2, maxSentences = 6) => (
  Array.from({ length: random.int(minSentences, maxSentences) }, () => sentence(random)).join(' ')
)

/** A markdown note of roughly `targetChars` characters with the usual structure. */
export const markdownNote = (random, title, targetChars) => {
  const parts = [`# ${title}`, '']
  let length = parts[0].length
  let section = 0
  while (length < targetChars) {
    const kind = random.next()
    let block
    if (kind < 0.12) {
      section += 1
      block = `## ${section}. ${sentence(random, 2, 5).slice(0, -1)}`
    } else if (kind < 0.22) {
      block = Array.from({ length: random.int(2, 5) }, () => `- ${sentence(random, 3, 9)}`).join('\n')
    } else if (kind < 0.27) {
      block = `| Begriff | Wert | Notiz |\n| --- | ---: | --- |\n${Array.from({ length: random.int(2, 5) }, () => `| ${random.pick(WORDS)} | ${random.int(1, 999)} | ${sentence(random, 2, 5)} |`).join('\n')}`
    } else if (kind < 0.31) {
      block = `$$\n\\int_0^{${random.int(1, 9)}} x^{${random.int(2, 5)}} \\, dx = ${random.int(1, 99)}\n$$`
    } else if (kind < 0.34) {
      block = `\`\`\`js\nconst value = ${random.int(1, 999)}\nconsole.log(value * ${random.int(2, 9)})\n\`\`\``
    } else if (kind < 0.38) {
      block = `> ${sentence(random)}`
    } else {
      block = paragraph(random)
    }
    parts.push(block, '')
    length += block.length + 2
  }
  return `${parts.join('\n').trimEnd()}\n`
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An RGB PNG with a seeded gradient and some noise (compresses like a photo-ish sketch). */
export const png = (random, width, height) => {
  const rows = []
  const tint = [random.int(40, 220), random.int(40, 220), random.int(40, 220)]
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      const noise = random.int(0, 24)
      row[1 + x * 3] = (tint[0] + (x * 255) / width + noise) & 0xff
      row[2 + x * 3] = (tint[1] + (y * 255) / height + noise) & 0xff
      row[3 + x * 3] = (tint[2] + noise) & 0xff
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── PDF ─────────────────────────────────────────────────────────────────────

const pdfText = (value) => value.replace(/[^\x20-\x7e]/gu, '?').replace(/[\\()]/gu, (match) => `\\${match}`)

/**
 * A lecture-script PDF: every A4 page has a heading, about 45 lines of text in
 * the standard Helvetica font and a small vector figure. Flate-compressed
 * content streams, classic xref table.
 */
export const pdf = (random, pageCount, title) => {
  const objects = []
  const add = (body) => {
    objects.push(body)
    return objects.length
  }
  const catalogId = add(null)
  const pagesId = add(null)
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const pageIds = []
  for (let page = 1; page <= pageCount; page += 1) {
    const lines = [
      'BT /F2 18 Tf 56 790 Td', `(${pdfText(`${title} - Kapitel ${Math.ceil(page / 10)}.${((page - 1) % 10) + 1}`)}) Tj ET`,
      'BT /F1 10.5 Tf 56 760 Td 14 TL',
    ]
    for (let line = 0; line < 45; line += 1) {
      if (line === 20) {
        lines.push('ET')
        // A small figure: axes, a polyline and boxes.
        lines.push('0.2 0.3 0.6 RG 1 w 320 440 m 540 440 l S 320 440 m 320 560 l S')
        const points = Array.from({ length: 12 }, (_, index) => `${320 + index * 20} ${450 + random.int(0, 100)}`)
        lines.push(`${points[0]} m ${points.slice(1).map((point) => `${point} l`).join(' ')} S`)
        lines.push(`0.9 0.92 0.97 rg 56 440 ${random.int(120, 220)} 100 re f 0 0 0 rg`)
        lines.push(`BT /F1 10.5 Tf 56 ${760 - 14 * 21} Td 14 TL`)
      }
      lines.push(`(${pdfText(sentence(random, 8, 14).slice(0, 92))}) '`)
    }
    lines.push('ET', `BT /F1 9 Tf 290 30 Td (${page}) Tj ET`)
    const stream = deflateSync(Buffer.from(lines.join('\n'), 'latin1'))
    const contentId = add({ dict: `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream })
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`))
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let offset = chunks[0].length
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(offset)
    const head = Buffer.from(`${index + 1} 0 obj\n`, 'latin1')
    const parts = typeof body === 'string'
      ? [head, Buffer.from(`${body}\nendobj\n`, 'latin1')]
      : [head, Buffer.from(`${body.dict}\nstream\n`, 'latin1'), body.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]
    for (const part of parts) {
      chunks.push(part)
      offset += part.length
    }
  })
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)].join('')
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(chunks)
}

// ── Ink ─────────────────────────────────────────────────────────────────────

/** Handwriting-like strokes in page units (0..1), as the drawing board stores them. */
export const inkStrokes = (random, count, t0 = 0) => Array.from({ length: count }, (_, index) => {
  const row = Math.floor(index / 24)
  const column = index % 24
  const startX = 0.06 + column * 0.036
  const startY = 0.07 + (row % 42) * 0.02
  const length = random.int(8, 22)
  const phase = random.next() * Math.PI
  return {
    color: '#202333',
    baseWidth: 3.5,
    pressureEnabled: true,
    purpose: 'handwriting',
    points: Array.from({ length }, (__, point) => ({
      x: Math.round(Math.min(0.97, startX + point * 0.0012) * 1e5) / 1e5,
      y: Math.round(Math.min(0.97, startY + Math.sin(point * 0.7 + phase) * 0.004) * 1e5) / 1e5,
      t: t0 + index * 60 + point * 6,
      pressure: Math.round((0.45 + random.next() * 0.25) * 1000) / 1000,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen',
    })),
  }
})

export const inkDrawing = (random, id, title, strokeCount, at) => ({
  schemaVersion: 1,
  id,
  title,
  paperStyle: 'lines',
  sourceWidth: 900,
  sourceHeight: 1273,
  createdAt: at,
  updatedAt: at,
  strokes: inkStrokes(random, strokeCount),
  searchTranscript: '',
  transcriptMode: 'text-and-math',
  recognitionPreference: 'auto',
  detectedRecognitionMode: 'text',
})

/** `.famd` v1: markdown, then the payload line (see src/lib/famd.ts serializeFamd). */
export const famdV1 = (markdown, ink, at) => {
  const json = JSON.stringify({ schema: 'fanotes-famd-v1', updatedAt: at, ink, worksheets: [] })
  const body = markdown.trimEnd()
  return `${body ? `${body}\n\n` : ''}<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}
