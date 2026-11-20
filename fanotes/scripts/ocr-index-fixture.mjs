// Synthetic vault for the OCR/indexing checks and benchmark. Deterministic, no real data.
//   text PDFs (text layer), scanned PDFs (300 dpi JPEG pages), mixed PDFs, byte-identical copies
//   of scanned PDFs (same content hash, other path), and ink notes with a stored transcript.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PDFDocument, StandardFonts } = require('pdf-lib')
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas')

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const WORDS = ['Zelle', 'Membran', 'Energie', 'Atom', 'Molekuel', 'Reaktion', 'Gleichung', 'Funktion', 'Ableitung', 'Integral',
  'Wahrscheinlichkeit', 'Geschichte', 'Revolution', 'Verfassung', 'Demokratie', 'Klima', 'Atmosphaere', 'Kontinent', 'Gedicht',
  'Erzaehlung', 'Metapher', 'Grammatik', 'Vokabel', 'Photosynthese', 'Chlorophyll', 'Enzym', 'Saeure', 'Basis', 'Element', 'Periode']

export const rng = (seed) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const sentence = (random, words = 7) => Array.from({ length: words }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ')

let fontReady = false
const renderScan = (lines, dpi = 300) => {
  if (!fontReady) { GlobalFonts.registerFromPath(FONT, 'FixtureSans'); fontReady = true }
  const width = Math.round(8.27 * dpi)
  const height = Math.round(11.69 * dpi)
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#111111'
  const size = Math.round(dpi * 0.15)
  context.font = `${size}px FixtureSans`
  lines.forEach((line, index) => context.fillText(line, Math.round(dpi * 0.8), Math.round(dpi * 1.2 + index * size * 2.1)))
  return canvas.toBuffer('image/jpeg', 80)
}

const pageWithText = (pdf, font, lines) => {
  const page = pdf.addPage([595, 842])
  lines.forEach((line, index) => page.drawText(line, { x: 56, y: 780 - index * 26, size: 14, font }))
}

const pageWithScan = async (pdf, jpeg) => {
  const image = await pdf.embedJpg(jpeg)
  const page = pdf.addPage([595, 842])
  page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 })
}

/**
 * Builds the vault under `root`.
 * options: textPdfs, scannedPdfs, mixedPdfs, copies, inkNotes, scanLines, scanDpi
 */
export const buildOcrIndexVault = async (root, options = {}) => {
  const o = { textPdfs: 14, scannedPdfs: 8, mixedPdfs: 6, copies: 2, inkNotes: 100, scanLines: 8, scanDpi: 300, scanPages: 2, ...options }
  fs.mkdirSync(path.join(root, 'PDF'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Notizen'), { recursive: true })
  const random = rng(20261120)
  const manifest = { pdfs: [], inkNotes: 0, scannedPages: 0, scannedPaths: [] }
  const font = null
  const makeScanLines = (tag) => [`Dokument ${tag}`, ...Array.from({ length: o.scanLines - 1 }, () => sentence(random, 5))]
  for (let i = 0; i < o.textPdfs; i += 1) {
    const pdf = await PDFDocument.create()
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica)
    for (let p = 0; p < 4; p += 1) pageWithText(pdf, helvetica, [`Textdokument ${i} Seite ${p + 1}`, ...Array.from({ length: 12 }, () => sentence(random, 9))])
    const name = `PDF/Text-${String(i).padStart(2, '0')}.pdf`
    fs.writeFileSync(path.join(root, name), await pdf.save({ useObjectStreams: false }))
    manifest.pdfs.push({ path: name, kind: 'text', pages: 4, scanned: 0 })
  }
  const scanned = []
  for (let i = 0; i < o.scannedPdfs; i += 1) {
    const pdf = await PDFDocument.create()
    for (let p = 0; p < o.scanPages; p += 1) await pageWithScan(pdf, renderScan(makeScanLines(`Scan${i}S${p + 1}`), o.scanDpi))
    const name = `PDF/Scan-${String(i).padStart(2, '0')}.pdf`
    const bytes = await pdf.save({ useObjectStreams: false })
    fs.writeFileSync(path.join(root, name), bytes)
    scanned.push(bytes)
    manifest.pdfs.push({ path: name, kind: 'scan', pages: o.scanPages, scanned: o.scanPages })
    manifest.scannedPages += o.scanPages
    manifest.scannedPaths.push(name)
  }
  for (let i = 0; i < o.mixedPdfs; i += 1) {
    const pdf = await PDFDocument.create()
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica)
    pageWithText(pdf, helvetica, [`Gemischt ${i} Textseite`, ...Array.from({ length: 12 }, () => sentence(random, 9))])
    await pageWithScan(pdf, renderScan(makeScanLines(`Mix${i}`), o.scanDpi))
    const name = `PDF/Mix-${String(i).padStart(2, '0')}.pdf`
    fs.writeFileSync(path.join(root, name), await pdf.save({ useObjectStreams: false }))
    manifest.pdfs.push({ path: name, kind: 'mixed', pages: 2, scanned: 1 })
    manifest.scannedPages += 1
    manifest.scannedPaths.push(name)
  }
  for (let i = 0; i < o.copies; i += 1) {
    const name = `PDF/Kopie-${String(i).padStart(2, '0')}.pdf`
    fs.writeFileSync(path.join(root, name), scanned[i % scanned.length])
    manifest.pdfs.push({ path: name, kind: 'copy', pages: o.scanPages, scanned: o.scanPages, copyOf: i % scanned.length })
    manifest.scannedPages += o.scanPages
    manifest.scannedPaths.push(name)
  }
  for (let i = 0; i < o.inkNotes; i += 1) {
    const transcript = Array.from({ length: 6 }, () => sentence(random, 6)).join('\n')
    const strokes = Array.from({ length: 220 }, (_, s) => ({
      id: `s${s}`, tool: 'pen', color: '#111111', width: 2.4,
      points: Array.from({ length: 48 }, (_, k) => ({ x: Math.round(random() * 9000) / 10, y: Math.round(random() * 12000) / 10, p: 0.5, t: k * 8 })),
    }))
    const ink = { schemaVersion: 1, title: `Handschrift ${i}`, updatedAt: '2026-11-01T10:00:00.000Z', strokes, searchTranscript: transcript }
    const payload = { schema: 'fanotes-famd-v1', updatedAt: '2026-11-01T10:00:00.000Z', ink, worksheets: [] }
    const json = JSON.stringify(payload)
    const body = `# Heft ${i}\n\nTypisierter Text ${sentence(random, 5)}\n`
    fs.writeFileSync(path.join(root, 'Notizen', `Ink-${String(i).padStart(3, '0')}.famd`), `${body}\n<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`)
    manifest.inkNotes += 1
  }
  void font
  return manifest
}

/** Words used by the fixture, for search queries. */
export const FIXTURE_WORDS = WORDS
