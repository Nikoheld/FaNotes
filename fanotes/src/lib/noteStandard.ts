import { INK_MAX_VIEW_QUALITY_ZOOM, INK_MIN_INLINE_QUALITY } from './paperGrow'
import { emptyFamdPayload, parseFamd, serializeFamd } from './famd'
import type { PageStats } from './pageStats'

export const CURRENT_NOTE_INK_QUALITY = INK_MIN_INLINE_QUALITY
export const CURRENT_NOTE_INK_QUALITY_ZOOM = INK_MAX_VIEW_QUALITY_ZOOM

export type ConvertibleNote = {
  markdown: string
  ink: Record<string, unknown> | null
  worksheets: string[]
  pageStats?: PageStats
}

export const noteInkStrokes = (ink: Record<string, unknown> | null | undefined) => (
  Array.isArray(ink?.strokes) ? ink.strokes : []
)

export const noteInkQuality = (ink: Record<string, unknown> | null | undefined) => {
  const quality = Number(ink?.overlayQuality)
  return Number.isFinite(quality) ? quality : 0
}

/** Old notes lack the current HiDPI overlay stamp, so ink paints pixelated. */
export const isOldPixelatedNote = (ink: Record<string, unknown> | null | undefined) => {
  if (!ink) return false
  if (noteInkStrokes(ink).length === 0) return false
  return noteInkQuality(ink) + 1e-6 < CURRENT_NOTE_INK_QUALITY
}

export const upgradeInkToCurrentStandard = (ink: Record<string, unknown> | null) => {
  if (!ink) return null
  const strokes = noteInkStrokes(ink)
  return {
    ...ink,
    strokes: [...strokes],
    overlayQuality: CURRENT_NOTE_INK_QUALITY,
    overlayQualityZoom: CURRENT_NOTE_INK_QUALITY_ZOOM,
  }
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/**
 * Copy-then-replace upgrade. Apply runs on the copy; the original is kept until
 * strokes, markdown, worksheets, and page stats still match.
 */
export const convertNoteToCurrentStandard = (
  note: ConvertibleNote,
  apply: (upgraded: ConvertibleNote) => ConvertibleNote = (value) => value,
): ConvertibleNote => {
  const originalStrokes = noteInkStrokes(note.ink)
  const originalMarkdown = note.markdown
  const originalWorksheets = [...note.worksheets]
  const originalStats = note.pageStats
  const copied: ConvertibleNote = {
    markdown: note.markdown,
    ink: note.ink
      ? { ...note.ink, strokes: [...noteInkStrokes(note.ink)] }
      : null,
    worksheets: [...note.worksheets],
    pageStats: note.pageStats ? { ...note.pageStats } : undefined,
  }
  const upgraded: ConvertibleNote = {
    ...copied,
    ink: upgradeInkToCurrentStandard(copied.ink),
  }
  const applied = apply(upgraded)
  if (!sameJson(noteInkStrokes(applied.ink), originalStrokes)) {
    throw new Error('convert dropped or changed ink strokes')
  }
  if (applied.markdown !== originalMarkdown) {
    throw new Error('convert dropped markdown')
  }
  if (!sameJson(applied.worksheets, originalWorksheets)) {
    throw new Error('convert dropped worksheets')
  }
  if (originalStats && !sameJson(applied.pageStats, originalStats)) {
    throw new Error('convert dropped page stats')
  }
  if (applied.ink && noteInkQuality(applied.ink) + 1e-6 < CURRENT_NOTE_INK_QUALITY) {
    throw new Error('convert did not reach current ink quality')
  }
  return applied
}

export const convertNoteSourceToCurrentStandard = (
  source: string,
  apply?: (upgraded: ConvertibleNote) => ConvertibleNote,
) => {
  const original = typeof source === 'string' ? source : ''
  const { markdown, payload } = parseFamd(original)
  const note: ConvertibleNote = {
    markdown,
    ink: payload?.ink ?? null,
    worksheets: payload?.worksheets ?? [],
    pageStats: payload?.pageStats,
  }
  if (!isOldPixelatedNote(note.ink) && note.ink) {
    return { source: original, converted: false, note }
  }
  if (!note.ink || noteInkStrokes(note.ink).length === 0) {
    return { source: original, converted: false, note }
  }
  const converted = convertNoteToCurrentStandard(note, apply)
  const nextPayload = payload ?? emptyFamdPayload()
  const nextSource = serializeFamd(converted.markdown, {
    ...nextPayload,
    ink: converted.ink,
    worksheets: converted.worksheets,
    ...(converted.pageStats ? { pageStats: converted.pageStats } : {}),
  })
  const roundTrip = parseFamd(nextSource)
  if (roundTrip.markdown !== converted.markdown) {
    throw new Error('convert round-trip dropped markdown')
  }
  if (!sameJson(noteInkStrokes(roundTrip.payload?.ink), noteInkStrokes(converted.ink))) {
    throw new Error('convert round-trip dropped or changed ink strokes')
  }
  if (!sameJson(roundTrip.payload?.worksheets ?? [], converted.worksheets)) {
    throw new Error('convert round-trip dropped worksheets')
  }
  if (converted.pageStats && !sameJson(roundTrip.payload?.pageStats, converted.pageStats)) {
    throw new Error('convert round-trip dropped page stats')
  }
  if (payload?.noteLinks && !sameJson(roundTrip.payload?.noteLinks, payload.noteLinks)) {
    throw new Error('convert round-trip dropped note links')
  }
  if (payload?.noteBackups && !sameJson(roundTrip.payload?.noteBackups, payload.noteBackups)) {
    throw new Error('convert round-trip dropped note backups')
  }
  if (payload?.paperStyle && roundTrip.payload?.paperStyle !== payload.paperStyle) {
    throw new Error('convert round-trip dropped paper style')
  }
  if (noteInkQuality(roundTrip.payload?.ink) + 1e-6 < CURRENT_NOTE_INK_QUALITY) {
    throw new Error('convert round-trip did not keep current ink quality')
  }
  return {
    source: nextSource,
    converted: true,
    note: converted,
  }
}
