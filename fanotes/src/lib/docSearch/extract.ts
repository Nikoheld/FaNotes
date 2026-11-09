/**
 * Browser-side extraction for the document index: note text, handwriting
 * transcripts, worksheets, PDF annotations, PDF text layers and local OCR of
 * pages without text. Works the same in the desktop renderer and the web app.
 * Originals are only read; OCR text goes into the existing `fanotes-pdf-ocr-v1`
 * sidecar and the `fanotes-page-text-v1` contract file through the host.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { FaNotesApi, VaultEntry, WorksheetDocument } from '../../types'
import { stripFamdPayload } from '../famd'
import { enqueuePdfRender, loadVaultPdfBytes, MAX_PDF_NOTE_PAGES, openPdfDocument } from '../pdfDocument'
import { PDF_OCR_MAX_PAGES, PDF_OCR_MIN_TEXT, collapsedPdfText, pdfByteStamp, sanitizePdfOcrCache } from '../pdfOcr'
import { renderPdfPageForOcr } from '../pdfOcrRun'
import type { IndexUnit, UnitKind } from './docIndex'
import type { DocExtractor, DocSource, ExtractContext, ExtractOutcome } from './indexer'
import { letterCount, recognizeOriented, type RecognizeLine } from './ocrOrientation'
import { preparePageInWorker } from './ocrPrep'
import { buildPageTextRecord, PAGE_TEXT_MAX_DOCUMENT_BYTES, PAGE_TEXT_MAX_PAGE_CHARS, pageTextRecordMatches, sanitizePageTextRecord, type PageTextPage, type PageTextRecord } from './pageText'

export const OCR_ENGINE_ID = 'fanotes-trocr-v1'
const NOTE_CHUNK_CHARS = 6000
const MAX_NOTE_CHARS = 2_000_000
const MAX_WORKSHEETS = 40
const BATCH_PAGES = 4
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu
/** Notes Kanti+ also keeps out of search: they can hold imported school data. */
const EXCLUDED_NOTES = new Set(['hausaufgaben.md', 'kalender.md'])

/** Host methods the index needs; all exist on desktop and web except the page-text pair. */
export type DocSearchHostApi = Pick<FaNotesApi, 'getTree' | 'readFile' | 'readAssetBytes' | 'readWorksheet' | 'readFamdInk'>
  & Partial<Pick<FaNotesApi, 'readNoteCompanion' | 'readPdfOcr' | 'writePdfOcr' | 'platform'>>
  & {
    readPageText?: (relativePath: string) => Promise<unknown>
    writePageText?: (record: PageTextRecord) => Promise<unknown>
  }

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase('en-US') : ''
}
const stemOf = (path: string) => path.replace(/\.[^./]+$/u, '')
const titleOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^.]+$/u, '')

/**
 * Searchable documents of the current vault. Dot folders (`.fanotes` data,
 * sync state, Schulnetz data), dotfiles and excluded notes are never listed.
 * A `.famd` beside a `.pdf` or `.md` is that document's companion, not its own.
 */
export const listSearchDocuments = (tree: VaultEntry[]) => {
  const files = new Map<string, VaultEntry>()
  const walk = (entries: VaultEntry[] | undefined) => {
    for (const entry of entries ?? []) {
      if (!entry?.name || entry.name.startsWith('.')) continue
      if (entry.kind === 'folder') walk(entry.children)
      else files.set(entry.relativePath, entry)
    }
  }
  walk(tree)
  const fp = (entry: VaultEntry | undefined) => (entry ? `${entry.size ?? '?'}:${entry.modifiedAt ?? '?'}` : '-')
  const sources: DocSource[] = []
  for (const [path, entry] of files) {
    const extension = extensionOf(entry.name)
    if (EXCLUDED_NOTES.has(entry.name.toLocaleLowerCase('de-DE')) && !path.includes('/')) continue
    const modifiedAt = Date.parse(entry.modifiedAt ?? '') || 0
    if (extension === 'pdf') {
      const companion = files.get(`${stemOf(path)}.famd`)
      sources.push({ path, title: titleOf(path), kind: 'pdf', fingerprint: `${fp(entry)}|${fp(companion)}`, modifiedAt })
    } else if (extension === 'md') {
      const companion = files.get(`${stemOf(path)}.famd`)
      sources.push({ path, title: titleOf(path), kind: 'note', fingerprint: `${fp(entry)}|${fp(companion)}`, modifiedAt })
    } else if (extension === 'famd') {
      if (files.has(`${stemOf(path)}.pdf`) || files.has(`${stemOf(path)}.md`)) continue
      sources.push({ path, title: titleOf(path), kind: 'note', fingerprint: fp(entry), modifiedAt })
    }
  }
  return sources
}

const unitId = (path: string, kind: UnitKind, n: number) => `${path}#${kind}:${n}`

const chunk = (text: string, size = NOTE_CHUNK_CHARS) => {
  const parts: string[] = []
  let rest = text.slice(0, MAX_NOTE_CHARS)
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.6) cut = rest.lastIndexOf(' ', size)
    if (cut < size * 0.6) cut = size
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

const decodeImage = async (bytes: Uint8Array, mimeType: string) => {
  const blob = new Blob([bytes.slice().buffer], { type: mimeType || 'image/png' })
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, 1600 / Math.max(1, bitmap.width), Math.sqrt(4_000_000 / Math.max(1, bitmap.width * bitmap.height)))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
    if (!context) return null
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    return { pixels: context.getImageData(0, 0, width, height).data, width, height }
  } finally {
    bitmap.close()
  }
}

/** Page text with the PDF's own line ends, so words hyphenated across lines can be joined. */
export const pdfItemsText = (items: readonly unknown[]) => {
  let text = ''
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item) || typeof item.str !== 'string') continue
    text += item.str
    text += 'hasEOL' in item && item.hasEOL ? '\n' : (item.str ? ' ' : '')
  }
  return text.replace(/[ \t]+/gu, ' ').replace(/ ?\n ?/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

const errorName = (error: unknown) => (error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '')
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error ?? 'Unbekannter Fehler'))

type Deps = {
  api: DocSearchHostApi
  recognize: RecognizeLine
  producer: string
}

export const createBrowserExtractor = (deps: Deps): DocExtractor => {
  const { api } = deps

  const ocrBitmap = async (bitmap: { pixels: Uint8ClampedArray; width: number; height: number }, context: ExtractContext) => {
    await context.pause()
    return recognizeOriented(bitmap, deps.recognize, context.shouldStop, 40, preparePageInWorker)
  }

  const extractWorksheets = async (source: DocSource, raw: string, context: ExtractContext, first: number) => {
    const ids = [...new Set([...raw.matchAll(WORKSHEET_MARKER)].map((match) => match[1]!))].slice(0, MAX_WORKSHEETS)
    let ocrBudget = context.ocrBudget
    for (let index = first - 1; index < ids.length; index += 1) {
      if (context.shouldStop()) return { status: 'partial', resumePage: index + 1 } as ExtractOutcome
      const n = index + 1
      let worksheet: WorksheetDocument
      try {
        worksheet = await api.readWorksheet(ids[index]!)
      } catch {
        context.issue({ kind: 'worksheet', page: n, status: 'failed', reason: 'worksheet-missing' })
        await context.commit([], { nextPage: n + 1 })
        continue
      }
      const units: IndexUnit[] = []
      const typed = (worksheet.textBoxes ?? []).map((box) => (typeof box?.text === 'string' ? box.text : '')).filter(Boolean).join('\n')
      let ocrText = ''
      let confidence: number | undefined
      if (worksheet.kind === 'image') {
        if (ocrBudget <= 0) return { status: 'partial', resumePage: n } as ExtractOutcome
        ocrBudget -= 1
        try {
          await context.pause()
          const bytes = await api.readAssetBytes(worksheet.sourceRelativePath)
          const bitmap = await decodeImage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), worksheet.mimeType)
          if (!bitmap) throw new Error('canvas')
          const result = await ocrBitmap(bitmap, context)
          if (letterCount(result.text) >= 3) { ocrText = result.text; confidence = result.confidence }
          else context.issue({ kind: 'worksheet', page: n, status: 'empty', reason: 'no-letters' })
        } catch (error) {
          context.issue({ kind: 'worksheet', page: n, status: 'failed', reason: `ocr: ${errorText(error)}`.slice(0, 120) })
        }
      } else if (worksheet.kind === 'pdf') {
        context.issue({ kind: 'worksheet', page: n, status: 'skipped', reason: 'pdf-worksheet-typed-text-only' })
      }
      const text = [worksheet.title, typed, ocrText].filter(Boolean).join('\n').slice(0, PAGE_TEXT_MAX_PAGE_CHARS)
      if (text.trim()) {
        units.push({
          id: unitId(source.path, 'worksheet', n), path: source.path, kind: 'worksheet', page: n, worksheetId: worksheet.id,
          source: ocrText ? 'ocr' : 'text', ...(confidence !== undefined ? { confidence } : {}), text,
        })
      }
      await context.commit(units, { nextPage: n + 1, ...(ocrText || worksheet.kind === 'image' ? { ocrPages: 1 } : {}) })
    }
    return { status: 'done' } as ExtractOutcome
  }

  const extractNote = async (source: DocSource, context: ExtractContext): Promise<ExtractOutcome> => {
    let raw: string
    try {
      raw = String(await api.readFile(source.path) ?? '')
    } catch (error) {
      return { status: 'failed', reason: `Lesen: ${errorText(error)}` }
    }
    // Page 1 = note text and handwriting; page n + 1 = worksheet n.
    if (context.resumePage <= 1) {
      const markdown = stripFamdPayload(raw).replace(WORKSHEET_MARKER, ' ')
      const units: IndexUnit[] = chunk(markdown).map((text, index) => ({
        id: unitId(source.path, 'note', index + 1), path: source.path, kind: 'note', source: 'text', text,
      }))
      let transcript = ''
      try {
        const companion = await api.readNoteCompanion?.(source.path)
        const ink = companion?.ink ?? (source.path.toLocaleLowerCase('en-US').endsWith('.famd') ? await api.readFamdInk(source.path) : null)
        const stored = (ink as { searchTranscript?: unknown } | null)?.searchTranscript
        transcript = typeof stored === 'string' ? stored.slice(0, 500_000) : ''
      } catch {
        // Handwriting is optional; the note text is still indexed.
      }
      if (transcript.trim()) {
        chunk(transcript).forEach((text, index) => units.push({
          id: unitId(source.path, 'ink', index + 1), path: source.path, kind: 'ink', source: 'transcript', text,
        }))
      }
      await context.commit(units, { nextPage: 2 })
    }
    const outcome = await extractWorksheets(source, raw, { ...context, ocrBudget: context.ocrBudget }, Math.max(1, context.resumePage - 1))
    if (outcome.status === 'partial') return { status: 'partial', resumePage: outcome.resumePage + 1 }
    return outcome
  }

  const extractPdf = async (source: DocSource, context: ExtractContext): Promise<ExtractOutcome> => {
    let bytes: Uint8Array
    try {
      bytes = await loadVaultPdfBytes(source.path)
    } catch (error) {
      return { status: 'failed', reason: `Lesen: ${errorText(error)}` }
    }
    if (bytes.byteLength > PAGE_TEXT_MAX_DOCUMENT_BYTES) return { status: 'unsupported', reason: 'Datei grösser als 96 MB' }
    const size = bytes.byteLength
    const stamp = pdfByteStamp(bytes)
    // Text another FaNotes client already extracted for exactly these bytes.
    let shared: PageTextRecord | null = null
    try {
      const record = sanitizePageTextRecord(await api.readPageText?.(source.path))
      if (pageTextRecordMatches(record, { path: source.path, size, stamp })) shared = record
    } catch { shared = null }
    const known = new Map<number, string>()
    try {
      const cache = sanitizePdfOcrCache(await api.readPdfOcr?.(source.path))
      if (cache && cache.size === size && cache.stamp === stamp) for (const page of cache.pages) known.set(page.page, page.text)
    } catch { /* optional */ }
    // Annotations typed into the PDF note's companion.
    if (context.resumePage <= 1) {
      try {
        const companion = await api.readFile(`${stemOf(source.path)}.famd`)
        const markdown = stripFamdPayload(String(companion ?? '')).replace(WORKSHEET_MARKER, ' ').trim()
        if (markdown) await context.commit([{ id: unitId(source.path, 'annotations', 1), path: source.path, kind: 'annotations', source: 'text', text: markdown.slice(0, PAGE_TEXT_MAX_PAGE_CHARS) }])
      } catch { /* no companion */ }
    }
    let pdf: PDFDocumentProxy | null = null
    let destroy: (() => Promise<void>) | null = null
    try {
      try {
        const opened = await openPdfDocument(bytes)
        pdf = opened.pdf
        destroy = () => opened.task.destroy()
      } catch (error) {
        const name = errorName(error)
        if (name === 'PasswordException') return { status: 'unsupported', reason: 'Passwortgeschützt' }
        if (name === 'InvalidPDFException') return { status: 'unsupported', reason: 'Beschädigte oder ungültige PDF' }
        if (/mehr als/u.test(errorText(error))) return { status: 'unsupported', reason: `Mehr als ${MAX_PDF_NOTE_PAGES} Seiten` }
        return { status: 'failed', reason: `Öffnen: ${errorText(error)}` }
      }
      const pageCount = pdf.numPages
      let ocrBudget = context.ocrBudget
      let batch: IndexUnit[] = []
      let ocrPages = 0
      let newOcr = 0
      const flush = async (nextPage: number) => {
        if (!batch.length && !ocrPages) return
        await context.commit(batch, { nextPage, pageCount, ocrPages })
        batch = []
        ocrPages = 0
      }
      for (let pageNumber = Math.max(1, context.resumePage); pageNumber <= pageCount; pageNumber += 1) {
        if (context.shouldStop()) {
          await flush(pageNumber)
          return { status: 'partial', resumePage: pageNumber, pageCount }
        }
        // Every page is a chance to step aside for typing and pen input.
        await context.pause()
        const sharedPage = shared?.pages.find((page) => page.page === pageNumber && page.status === 'ok')
        let text = ''
        try {
          const page = await pdf.getPage(pageNumber)
          try {
            text = pdfItemsText((await page.getTextContent()).items)
          } finally {
            page.cleanup?.()
          }
        } catch {
          text = ''
        }
        if (collapsedPdfText(text).length >= PDF_OCR_MIN_TEXT) {
          batch.push({ id: unitId(source.path, 'pdf-page', pageNumber), path: source.path, kind: 'pdf-page', page: pageNumber, source: 'text-layer', text: text.slice(0, PAGE_TEXT_MAX_PAGE_CHARS) })
        } else if (sharedPage?.source === 'ocr' || known.has(pageNumber)) {
          const reused = sharedPage?.source === 'ocr' ? sharedPage.text : known.get(pageNumber) ?? ''
          if (letterCount(reused) >= 3) {
            batch.push({ id: unitId(source.path, 'pdf-page', pageNumber), path: source.path, kind: 'pdf-page', page: pageNumber, source: 'ocr', ...(sharedPage?.confidence !== undefined ? { confidence: sharedPage.confidence } : {}), text: reused.slice(0, PAGE_TEXT_MAX_PAGE_CHARS) })
          } else context.issue({ kind: 'pdf-page', page: pageNumber, status: 'empty', reason: 'no-letters' })
        } else {
          if (ocrBudget <= 0) {
            await flush(pageNumber)
            return { status: 'partial', resumePage: pageNumber, pageCount }
          }
          ocrBudget -= 1
          ocrPages += 1
          try {
            await context.pause()
            // Lowest render lane: a page the reader is looking at always goes first.
            const bitmap = await enqueuePdfRender(async () => {
              const page = await pdf!.getPage(pageNumber)
              try {
                return await renderPdfPageForOcr(page)
              } finally {
                page.cleanup?.()
              }
            }, 'thumbnail')
            if (!bitmap) throw new Error('Seite konnte nicht gerendert werden')
            const result = await ocrBitmap(bitmap, context)
            if (letterCount(result.text) >= 3) {
              batch.push({ id: unitId(source.path, 'pdf-page', pageNumber), path: source.path, kind: 'pdf-page', page: pageNumber, source: 'ocr', confidence: result.confidence, text: result.text.slice(0, PAGE_TEXT_MAX_PAGE_CHARS) })
              newOcr += 1
            } else context.issue({ kind: 'pdf-page', page: pageNumber, status: 'empty', reason: 'no-letters' })
          } catch (error) {
            context.issue({ kind: 'pdf-page', page: pageNumber, status: 'failed', reason: `ocr: ${errorText(error)}`.slice(0, 120) })
          }
        }
        if (batch.length >= BATCH_PAGES || ocrPages >= 1) await flush(pageNumber + 1)
      }
      await flush(pageCount + 1)
      await persistSidecars(source.path, size, stamp, pageCount, newOcr > 0 || Boolean(context.previousUnits().some((unit) => unit.source === 'ocr')), known, context)
      return { status: 'done', pageCount }
    } finally {
      await destroy?.().catch(() => undefined)
    }
  }

  /** Shares OCR text: the existing scanned-PDF sidecar and the page-text contract file. */
  const persistSidecars = async (
    path: string,
    size: number,
    stamp: string,
    pageCount: number,
    hasOcr: boolean,
    known: Map<number, string>,
    context: ExtractContext,
  ) => {
    const units = context.previousUnits().filter((unit) => unit.kind === 'pdf-page' && unit.page)
    if (hasOcr && api.writePdfOcr) {
      const merged = new Map(known)
      for (const unit of units) if (unit.source === 'ocr') merged.set(unit.page!, unit.text)
      const pages = [...merged.entries()].sort((a, b) => a[0] - b[0]).slice(0, PDF_OCR_MAX_PAGES).map(([page, text]) => ({ page, text }))
      if (pages.length) await api.writePdfOcr({ path, size, stamp, pages }).catch(() => undefined)
    }
    if (!api.writePageText) return
    const pages: PageTextPage[] = units.map((unit) => ({
      page: unit.page!,
      source: unit.source === 'ocr' ? 'ocr' : 'text-layer',
      status: 'ok',
      text: unit.text,
      ...(unit.confidence !== undefined ? { confidence: unit.confidence } : {}),
    }))
    const record = buildPageTextRecord({ path, size, stamp, pageCount, producer: deps.producer, ocrEngine: OCR_ENGINE_ID, pages })
    if (record) await api.writePageText(record).catch(() => undefined)
  }

  return {
    extract: (source, context) => (source.kind === 'pdf' ? extractPdf(source, context) : extractNote(source, context)),
  }
}
