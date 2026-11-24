// Entry point of the text-note export. The dialog imports this module lazily on first use, so none of the
// Markdown, KaTeX, JSZip or OOXML code is part of the startup path.
import { exportNoteLatex, exportNotePdf, noteExportBaseName } from '../simpleLatex'
import { collectImageSources, parseNoteMarkdown } from './ast'
import { noteToDocx } from './docx'
import { printSettings, renderNoteHtml } from './html'
import { prepareNoteMarkdown, resolveNoteImages } from './prepare'
import type { NoteExportInput, NoteExportOptions } from './types'

export type NoteExportFile = { filename: string; blob: Blob }

export { createVaultImageResolver } from './prepare'

const toBlob = (bytes: Uint8Array, type: string) => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type })
}

const abortIfNeeded = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Der Export wurde abgebrochen.', 'AbortError')
}

type FanotesPdfApi = {
  renderNoteHtmlToPdf?: (payload: { id: string; html: string; title: string; pageSize: 'A4' | 'Letter'; margins: { top: number; bottom: number; left: number; right: number }; pageNumbers: boolean }) => Promise<Uint8Array>
  cancelNoteHtmlToPdf?: (id: string) => Promise<void>
}

async function exportPdf(input: NoteExportInput, options: NoteExportOptions): Promise<Uint8Array> {
  const api = (typeof window !== 'undefined' ? window.fanotes : undefined) as FanotesPdfApi | undefined
  if (!api?.renderNoteHtmlToPdf) {
    // Browser and Android builds have no print window: the plain-text PDF is the fallback.
    return exportNotePdf(prepareNoteMarkdown(input.markdown), input.title)
  }
  const { html } = await renderNoteHtml(input, options)
  abortIfNeeded(input.signal)
  const settings = printSettings(options)
  const id = `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const cancel = () => { void api.cancelNoteHtmlToPdf?.(id) }
  input.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const bytes = await api.renderNoteHtmlToPdf({ id, html, title: input.title, pageSize: settings.pageSize, margins: settings.margins, pageNumbers: settings.pageNumbers })
    abortIfNeeded(input.signal)
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
  } finally {
    input.signal?.removeEventListener('abort', cancel)
  }
}

/** Markdown export: the note text, with its pictures in an `images` folder next to it (as a .zip) when it has any. */
async function exportMarkdown(input: NoteExportInput, base: string): Promise<NoteExportFile> {
  const markdown = prepareNoteMarkdown(input.markdown)
  const sources = collectImageSources(parseNoteMarkdown(markdown))
  const images = await resolveNoteImages(sources, input.resolveImage, input.signal)
  const files = [...images].filter(([source]) => !source.startsWith('data:'))
  if (!files.length) return { filename: `${base}.md`, blob: new Blob([markdown], { type: 'text/markdown;charset=utf-8' }) }
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  let text = markdown
  files.forEach(([source, image], index) => {
    const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1]
    const name = `images/bild-${index + 1}.${extension}`
    text = text.split(`](${source}`).join(`](${name}`).split(`](<${source}>`).join(`](${name}`)
    zip.file(`${base}/${name}`, image.bytes)
  })
  zip.file(`${base}/${base}.md`, text)
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { filename: `${base}.zip`, blob: toBlob(bytes, 'application/zip') }
}

/** Runs the export of a text note and returns the file to save. */
export async function exportTextNote(input: NoteExportInput, options: NoteExportOptions): Promise<NoteExportFile> {
  const base = noteExportBaseName(input.title)
  abortIfNeeded(input.signal)
  switch (options.format) {
    case 'pdf': return { filename: `${base}.pdf`, blob: toBlob(await exportPdf(input, options), 'application/pdf') }
    case 'docx': return { filename: `${base}.docx`, blob: toBlob(await noteToDocx(input, options), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') }
    case 'latex': return { filename: `${base}.tex`, blob: new Blob([exportNoteLatex(input.markdown, input.title)], { type: 'text/plain;charset=utf-8' }) }
    case 'markdown': return exportMarkdown(input, base)
  }
}
