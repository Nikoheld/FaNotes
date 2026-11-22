// Synthetic vault for the desktop latency/memory check: 250 notes (Unicode names, a daily note),
// 5/40/250-page PDFs, an image-only "scanned" PDF, .famd notes with ink and a calendar with events.
import fs from 'node:fs'
import path from 'node:path'
import { famdV1, inkDrawing, markdownNote, pdf, prng, sentence } from './bench-desktop/lib/fixture-formats.mjs'

export const UNICODE_NOTE = 'Ünïcödé – Näme (1) & [x] #y'

const scannedPdf = () => {
  // One A4 page that is a single 400x560 RGB image (no text layer), like a scan.
  const width = 400
  const height = 560
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i += 1) raw[i] = 200 + ((i * 31) % 55)
  const objects = []
  const add = (body) => { objects.push(body); return objects.length }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>')
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q'
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  const parts = []
  let length = 0
  const push = (value) => { const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1'); parts.push(buffer); length += buffer.length }
  push('%PDF-1.4\n')
  const offsets = []
  const stream = (index, dict, data) => { offsets[index] = length; push(`${index + 1} 0 obj\n${dict}\nstream\n`); push(data); push('\nendstream\nendobj\n') }
  for (let index = 0; index < 4; index += 1) { offsets[index] = length; push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`) }
  stream(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${raw.length} >>`, raw)
  const xref = length
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`)
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}

const pad = (value) => String(value).padStart(2, '0')
export const todayStem = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

export const buildVault = (vault, { notes = 250 } = {}) => {
  const random = prng(20261122)
  const write = (relative, content) => {
    const target = path.join(vault, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, content, { mode: 0o600 })
  }
  const at = '2026-11-01T08:00:00.000Z'
  const folders = ['Biologie', 'Mathe', 'Geschichte', 'Ünï Fächer', 'Inbox']
  let written = 0
  write(`Ünï Fächer/${UNICODE_NOTE}.md`, markdownNote(prng(7), UNICODE_NOTE, 4_000)); written += 1
  write(`Tagesnotizen/${todayStem()}.md`, `# ${todayStem()}\n\n${markdownNote(prng(8), 'Heute', 1_500)}\n`); written += 1
  // One long note (50,000 short lines, ~1.3 MB) like the QA sweep's "Huge" note.
  write('Gross/Lang 50000 Zeilen.md', `# Lang\n\n${Array.from({ length: 50_000 }, (_, index) => `Zeile ${index} mit etwas Text`).join('\n')}\n`); written += 1
  for (const [name, pages] of [['Klein 5 Seiten', 5], ['Mittel 40 Seiten', 40], ['Gross 250 Seiten', 250]]) write(`PDFs/${name}.pdf`, pdf(prng(pages), pages, name))
  write('PDFs/Gescannt.pdf', scannedPdf())
  for (let index = 0; index < 8; index += 1) {
    const ink = { ...inkDrawing(prng(500 + index), `famd-${index}`, `Hand ${index}`, 80 + index * 20, at), searchTranscript: sentence(random) }
    write(`Handschrift/Hand ${index}.famd`, famdV1(markdownNote(prng(600 + index), `Hand ${index}`, 800), ink, at))
  }
  for (let index = 0; written < notes; index += 1) {
    const folder = folders[index % folders.length]
    const title = index % 7 === 0 ? `Nötiz ${index} äöü – ß` : `Notiz ${String(index).padStart(3, '0')}`
    write(`${folder}/${title}.md`, markdownNote(prng(1000 + index), title, 300 + ((index * 211) % 6_000)))
    written += 1
  }
  const calendar = {
    version: 1,
    calendars: [{ id: 'personal', name: 'Privat', color: '#7f6df2', visible: true }, { id: 'school', name: 'Schule', color: '#3d8bfd', visible: true }],
    events: Array.from({ length: 60 }, (_, index) => {
      const day = new Date(Date.now() + (index - 20) * 86_400_000)
      const stem = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
      return { id: `ev${index}`, calendarId: index % 2 ? 'school' : 'personal', title: `Termin ${index}`, start: `${stem}T${pad(8 + (index % 9))}:00`, end: `${stem}T${pad(9 + (index % 9))}:00`, allDay: false, location: '', notes: '', notePath: '', recurrence: index % 10 === 0 ? 'weekly' : 'none', recurrenceUntil: null, exceptionDates: [] }
    }),
  }
  write('Kalender.md', `# Kalender\n\n<!-- fanotes-calendar-v1\n${JSON.stringify(calendar)}\n-->\n`)
}
