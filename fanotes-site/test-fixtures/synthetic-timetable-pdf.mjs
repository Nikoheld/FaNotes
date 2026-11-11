// SYNTHETIC timetable pages (fake classes, fake teacher shorts, fake rooms) that imitate the geometry of
// the school's class pages, as `pdftotext -bbox-layout` XHTML (buildBboxXhtml) and as a real PDF
// (buildPdf, for the poppler/qpdf pipeline test). It contains no real school data.
//
// Geometry (PDF points, page 595 x 842): weekday header centred over five columns, time labels at the
// left, lesson text vertically CENTRED on its time label (single lesson) or between two labels (double
// lesson), stacked entries (half classes) one line below the other, side-by-side entries left to right,
// footnote markers `n)` right of the cell, and a footnote table in up to three column groups.

export const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag']
export const TIMES = ['7:45', '8:35', '9:30', '10:30', '11:25', '12:15', '13:05', '14:00', '14:55', '15:50', '16:45', '17:35']
const PAGE = { width: 595.22, height: 842 }
const FONT = 6
const CHAR = 3.3 // average glyph advance of 6 pt text (bbox fixture)
const SPACE = 1.4 // gap between two words of one string
const LINE = 6.5
const COLUMN_PITCH = 94.25
const CELL_LEFT = 99
const FIRST_CENTRE = 141.5
const LABEL_Y = 123.7 // centre of the first time label
const ROW_PITCH = 41.8
const MARKER_DX = 59.5
const FOOT_Y = 631
const GROUP_PITCH = 129

const textWidth = (text, size = FONT) => text.length * CHAR * (size / FONT)

/**
 * A page: { code, teacher, cells, footnotes, perGroup, omit }.
 * cell: { day: 1-5, row: first time label (0-based), rows: lessons spanned (default 1), tracks: [[entry, ...], ...] }
 *   tracks are side by side, the entries of a track are stacked (half classes). entry: [subject, teacher?, room?, marker?].
 * footnotes: [{ nr?, text: 'teacher, subject, room', classes }] in reading order; a row without nr continues the previous one.
 * omit: ['header' | 'code' | 'labels'] leaves that part out (for tests of odd pages).
 */
export const layoutPage = (page) => {
  const items = [] // { x, top, text, size }
  const put = (x, top, text, size = FONT) => { if (text) items.push({ x, top, text, size }) }
  const omit = new Set(page.omit || [])
  put(56.16, 33.24, 'ALTE KANTONSSCHULE', 8)
  put(56.16, 46.06, 'CH-5001 AARAU', 8)
  put(185.76, 33.1, 'Stundenplan Alte Kanti', 8)
  put(185.76, 46.06, 'SJ 2026-27', 8)
  if (!omit.has('code')) {
    put(349.92, 61.86, page.code, 14)
    put(402, 64, page.teacher, 10)
  }
  if (!omit.has('header')) {
    DAYS.forEach((name, day) => put(FIRST_CENTRE + day * COLUMN_PITCH - textWidth(name, 10) / 2, 87.1, name, 10))
  }
  const labelCentre = (row) => LABEL_Y + row * ROW_PITCH
  if (!omit.has('labels')) TIMES.forEach((time, row) => put(70, labelCentre(row) - FONT / 2, time))
  for (const cell of page.cells || []) {
    const rows = cell.rows || 1
    const centre = (labelCentre(cell.row) + labelCentre(cell.row + rows - 1)) / 2
    const left = CELL_LEFT + (cell.day - 1) * COLUMN_PITCH
    const step = cell.tracks.length >= 3 ? 31 : 47
    cell.tracks.forEach((track, trackIndex) => {
      const lines = track.reduce((sum, entry) => sum + entry.slice(0, 3).filter(Boolean).length, 0)
      let top = centre - (lines * LINE - 0.5) / 2
      for (const [subject, teacher, room, marker] of track) {
        const own = [subject, teacher, room].filter(Boolean)
        own.forEach((text, index) => put(left + trackIndex * step, top + index * LINE, text))
        if (marker) put(left + MARKER_DX, top + (own.length > 1 ? LINE : 0), `${marker})`)
        top += own.length * LINE
      }
    })
  }
  const notes = page.footnotes || []
  if (notes.length) {
    const perGroup = page.perGroup || 12
    const groups = Math.min(3, Math.ceil(notes.length / perGroup))
    for (let group = 0; group < groups; group += 1) {
      const gx = 59 + group * GROUP_PITCH
      put(gx, FOOT_Y, 'Nr.', 5)
      put(gx + 12, FOOT_Y, 'Le.,Fa.,Rm.', 5)
      put(gx + 72, FOOT_Y, 'Kla.', 5)
    }
    notes.forEach((note, index) => {
      const gx = 59 + Math.min(2, Math.floor(index / perGroup)) * GROUP_PITCH
      const top = FOOT_Y + 7.9 + (index % perGroup) * LINE
      if (note.nr) put(gx, top, `${note.nr})`, 5)
      put(gx + 12, top, note.text, 5)
      put(gx + 72, top, note.classes, 5)
    })
  }
  return items
}

const escapeXml = (text) => text.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** Pages -> `pdftotext -bbox-layout` XHTML (words with xMin/yMin/xMax/yMax, entities escaped). */
export const buildBboxXhtml = (pages) => {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<html xmlns="http://www.w3.org/1999/xhtml">', '<body>', '<doc>']
  for (const page of pages) {
    out.push(`  <page width="${PAGE.width.toFixed(6)}" height="${PAGE.height.toFixed(6)}">`, '    <flow>')
    for (const item of layoutPage(page)) {
      let x = item.x
      const scale = item.size / FONT
      for (const word of item.text.split(' ')) {
        const width = word.length * CHAR * scale
        out.push(`      <word xMin="${x.toFixed(6)}" yMin="${item.top.toFixed(6)}" xMax="${(x + width).toFixed(6)}" yMax="${(item.top + item.size).toFixed(6)}">${escapeXml(word)}</word>`)
        x += width + SPACE * scale
      }
    }
    out.push('    </flow>', '  </page>')
  }
  out.push('</doc>', '</body>', '</html>', '')
  return out.join('\n')
}

const pdfEscape = (text) => text.replace(/[\\()]/gu, (c) => `\\${c}`)

/** Pages -> a small PDF (Helvetica text at the same positions) for the real poppler/qpdf tools. */
export const buildPdf = (pages) => {
  const objects = []
  const add = (body) => { objects.push(body); return objects.length }
  const catalog = add('')
  const pagesRoot = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids = []
  for (const page of pages) {
    const stream = layoutPage(page)
      .map(({ x, top, text, size }) => `BT /F1 ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${(PAGE.height - top - size * 0.8).toFixed(2)} Tm (${pdfEscape(text)}) Tj ET`)
      .join('\n')
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`
  objects[pagesRoot - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out))
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

export const SYNTHETIC_PAGES = [
  {
    code: 'G26A',
    teacher: 'Anna Muster',
    perGroup: 3,
    cells: [
      // Double lesson with two stacked half-class entries and a marker on the first.
      { day: 1, row: 0, rows: 2, tracks: [[['spf', 'TstAa', 'Telli', '1'], ['spm', 'TstMm', 'Telli']]] },
      // Single lesson with two stacked entries (centred on the label, taller than three lines).
      { day: 1, row: 3, tracks: [[['Amos 1.2', 'TstBb', '036', '2'], ['Amos 1.1', 'TstKk', '025']]] },
      { day: 2, row: 0, tracks: [[['abt', 'TstDd', '228']]] },
      { day: 2, row: 5, rows: 2, tracks: [[['eng', 'TstDd', '505']]] },
      // Two half classes side by side (subjects with a prefix letter).
      { day: 4, row: 0, tracks: [[['eng-Sem2', 'TstDd', '227']], [['Heng-Sem1', 'TstDd', '227']]] },
      // Three side by side.
      { day: 4, row: 2, tracks: [[['deu', 'TstIi', '516']], [['fra', 'TstNn', '507']], [['wir', 'TstGg', '035']]] },
      // An entry without teacher and room, with a marker.
      { day: 5, row: 5, rows: 2, tracks: [[['sit', '', '', '3']]] },
      { day: 3, row: 7, tracks: [[['B&W', 'TstCc', 'T49']]] },
    ],
    footnotes: [
      { nr: 1, text: 'TstAa, spf, Telli', classes: 'G26A' },
      { text: 'TstMm, spm, Telli', classes: 'G26ABI' },
      { nr: 2, text: 'TstBb, Amos 1.2, 036', classes: 'G26ABK' },
      { text: 'TstKk, Amos 1.1, 025', classes: 'G26ABK' },
      { nr: 3, text: 'sit', classes: 'G23DL4B4D4E4K4L5B5K5L6A..' },
    ],
  },
  {
    code: 'G26D',
    teacher: 'Peter Probe',
    perGroup: 1,
    cells: [
      { day: 1, row: 0, rows: 2, tracks: [[['deu', 'TstIi', '516']]] },
      { day: 2, row: 1, tracks: [[['phy', 'TstFf', 'T49']]] },
      { day: 2, row: 6, rows: 2, tracks: [[['spf', 'TstAa', 'Telli', '1']]] },
      { day: 3, row: 0, tracks: [[['Heng-Sem2', 'TstHh', '305']]] },
      { day: 4, row: 3, tracks: [[['geo', 'TstLl', '212']]] },
      { day: 5, row: 4, tracks: [[['mus', 'TstJj', 'Wed_A']]] },
    ],
    footnotes: [
      { nr: 1, text: 'TstAa, spf, Telli', classes: 'G26D' },
      { nr: 2, text: 'TstFf, phy, T49', classes: 'G26DE' },
      { text: 'TstJj, mus, Wed_A', classes: 'G26D' },
    ],
  },
  {
    code: 'I26B',
    teacher: 'Eva Beispiel',
    cells: [
      { day: 1, row: 0, tracks: [[['mat', 'TstEe', '207']]] },
      { day: 5, row: 2, tracks: [[['deu', 'TstOo', '516']]] },
    ],
    footnotes: [],
  },
]
