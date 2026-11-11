// Builds a small SYNTHETIC timetable PDF (fake classes, fake teacher shorts, fake rooms) with
// positioned Courier text, so the real tools (pdftotext -layout, qpdf, pdftoppm) can be exercised.
// It imitates the look of the school's class pages; it contains no real school data.

const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag']
const TIMES = ['7:45', '8:35', '9:30', '10:30', '11:25', '12:15', '13:05', '14:00', '14:55', '15:50', '16:45', '17:35']
const CHAR_W = 4.8 // Courier 8 pt
const COLUMN_AT = [8, 34, 60, 86, 112] // character offsets of the weekday columns
const COLUMN_W = 26

const pdfEscape = (text) => text.replace(/[\\()]/gu, (c) => `\\${c}`)

/**
 * A page: { code, teacher, cells: { 'day:timeIndex': [lines or [left, right]] }, footnotes: [[nr, teacher, subject, room, classes]] }.
 * A cell line that is an array is laid out side by side (half classes).
 */
export const layoutPage = (page) => {
  const items = []
  const put = (col, row, text) => { if (text) items.push({ col, row, text }) }
  put(0, 0, 'ALTE KANTONSSCHULE')
  put(100, 0, page.code)
  put(112, 0, page.teacher)
  put(0, 1, 'Stundenplan Alte Kanti SJ 2026-27')
  DAYS.forEach((name, index) => put(COLUMN_AT[index], 3, name))
  let row = 5
  TIMES.forEach((time, timeIndex) => {
    put(0, row, time)
    let height = 1
    DAYS.forEach((_, day) => {
      const cell = page.cells?.[`${day + 1}:${timeIndex}`] || []
      cell.forEach((line, lineIndex) => {
        if (Array.isArray(line)) line.forEach((part, part_i) => put(COLUMN_AT[day] + part_i * 13, row + lineIndex, part))
        else put(COLUMN_AT[day], row + lineIndex, line)
      })
      height = Math.max(height, cell.length)
    })
    row += height + 1
  })
  row += 1
  if (page.footnotes?.length) {
    put(0, row, 'Nr.')
    put(8, row, 'Le.,Fa.,Rm.')
    put(60, row, 'Kla.')
    page.footnotes.forEach(([nr, teacher, subject, room, classes], index) => {
      put(0, row + 1 + index, `${nr})`)
      put(8, row + 1 + index, `${teacher}, ${subject}, ${room}`)
      put(60, row + 1 + index, classes)
    })
  }
  return items
}

export const buildPdf = (pages) => {
  const objects = []
  const add = (body) => { objects.push(body); return objects.length }
  const catalog = add('')
  const pagesRoot = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>')
  const kids = []
  for (const page of pages) {
    const lines = layoutPage(page).map(({ col, row, text }) => `BT /F1 8 Tf 1 0 0 1 ${(20 + col * CHAR_W).toFixed(2)} ${(570 - row * 11).toFixed(2)} Tm (${pdfEscape(text)}) Tj ET`)
    const stream = lines.join('\n')
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
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
    teacher: 'ZimLu',
    cells: {
      '1:0': ['deu', 'ZimLu', '516'],
      '1:1': ['mat', 'KelAn', '207'],
      '2:0': ['Heng-Sem1', 'WeiSa', 'Telli'],
      '2:1': ['spf 1)'],
      '3:2': ['bio', 'HugTi', 'T49'],
      '3:3': [['Heng-Sem1', 'Heng-Sem2'], ['WeiSa', 'OttPa'], ['Wed_A', '305']],
      '4:4': ['Amos 1.2', 'BauAn', '210'],
      '5:5': ['fra', 'MorJe', '516'],
    },
    footnotes: [[1, 'BauAn', 'spf', 'Telli', 'G26A, G26BFGKL']],
  },
  {
    code: 'G26D',
    teacher: 'PfeMa',
    cells: {
      '1:0': ['deu', 'PfeMa', '516'],
      '1:2': ['mat', 'KelAn', '208'],
      '2:1': ['phy', 'LanFr', 'T49'],
      '2:6': ['spf 1)'],
      '3:0': ['Heng-Sem2', 'OttPa', '305'],
      '4:3': ['geo', 'SchPe', '212'],
      '5:4': ['mus', 'RotEv', 'Wed_A'],
    },
    footnotes: [[1, 'BauAn', 'spf', 'Telli', 'G26D']],
  },
  {
    code: 'G26B',
    teacher: 'KelAn',
    cells: { '1:0': ['mat', 'KelAn', '207'], '5:2': ['deu', 'ZimLu', '516'] },
    footnotes: [],
  },
]
