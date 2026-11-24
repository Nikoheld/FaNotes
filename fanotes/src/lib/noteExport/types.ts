// Shared types for the note export (dialog, PDF, DOCX, LaTeX, Markdown).
// `NoteExportOptions` is also the contract with the handwriting / PDF-note export.

export type NoteExportFormat = 'pdf' | 'docx' | 'latex' | 'markdown'
export type NoteExportPageSize = 'a4' | 'letter'
export type NoteExportMargins = 'narrow' | 'normal' | 'wide'

export type NoteExportOptions = {
  format: NoteExportFormat
  pageSize: NoteExportPageSize
  margins: NoteExportMargins
  includeTitle: boolean
  /** PDF only: a "page / pages" footer. */
  pageNumbers: boolean
}

export const DEFAULT_NOTE_EXPORT_OPTIONS: NoteExportOptions = {
  format: 'pdf',
  pageSize: 'a4',
  margins: 'normal',
  includeTitle: true,
  pageNumbers: true,
}

/** Page sizes in millimetres. */
export const PAGE_SIZES_MM: Record<NoteExportPageSize, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
}

/** Margins in millimetres. */
export const MARGINS_MM: Record<NoteExportMargins, number> = { narrow: 12.7, normal: 22, wide: 32 }

export type NoteImageData = { bytes: Uint8Array; mime: string; width: number; height: number }

/** Resolves a Markdown image source to its bytes; null when it cannot be read. */
export type NoteImageResolver = (source: string) => Promise<NoteImageData | null>

export type NoteExportInput = {
  markdown: string
  title: string
  resolveImage?: NoteImageResolver
  signal?: AbortSignal
}

const FORMATS: readonly NoteExportFormat[] = ['pdf', 'docx', 'latex', 'markdown']

/** Reads stored options defensively; unknown values fall back to the defaults. */
export function normalizeNoteExportOptions(value: unknown): NoteExportOptions {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const d = DEFAULT_NOTE_EXPORT_OPTIONS
  return {
    format: FORMATS.includes(raw.format as NoteExportFormat) ? raw.format as NoteExportFormat : d.format,
    pageSize: raw.pageSize === 'letter' ? 'letter' : raw.pageSize === 'a4' ? 'a4' : d.pageSize,
    margins: raw.margins === 'narrow' || raw.margins === 'wide' || raw.margins === 'normal' ? raw.margins : d.margins,
    includeTitle: typeof raw.includeTitle === 'boolean' ? raw.includeTitle : d.includeTitle,
    pageNumbers: typeof raw.pageNumbers === 'boolean' ? raw.pageNumbers : d.pageNumbers,
  }
}
