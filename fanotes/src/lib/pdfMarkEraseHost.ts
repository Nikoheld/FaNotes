import type { ForeignEraseHost } from '../components/DrawingBoard'
import { pdfMarkSpansUnderEraser, type ErasedPdfMarkSpans } from './pdfMarkErase'
import { readPdfMarks, unmarkPdfSpans, writePdfMarks, type PdfTextMark } from './pdfTextMarks'

/** The note with the highlight taken off `hits`; null when none of them was highlighted. */
export const unmarkPdfNote = (content: string, hits: readonly ErasedPdfMarkSpans[]) => {
  const marks = readPdfMarks(content)
  let next: readonly PdfTextMark[] = marks
  for (const hit of hits) next = unmarkPdfSpans(next, hit.page, hit.spanTexts, hit.spans)
  return next === marks ? null : { before: marks, content: writePdfMarks(content, next) }
}

type Step = { path: string; before: PdfTextMark[]; after: PdfTextMark[] }

const STEP_LIMIT = 100

/**
 * Lets the ink eraser take PDF text highlights off the open PDF note, with
 * undo and redo through the ink history (see `ForeignEraseHost`).
 */
export const createPdfMarkEraseHost = (deps: {
  /** Path of the open PDF note, null when none is open. */
  notePath: () => string | null
  /** Element holding the note's PDF pages. */
  pages: () => ParentNode | null
  /** Latest text of a note, unsaved edits included. */
  read: (path: string) => string | null
  write: (path: string, content: string) => void
}): ForeignEraseHost => {
  let pending: { path: string; before: PdfTextMark[] } | null = null
  const steps = new Map<number, Step>()
  let serial = 0
  const apply = (path: string, marks: readonly PdfTextMark[]) => {
    const content = deps.read(path)
    if (content === null) return
    const next = writePdfMarks(content, marks)
    if (next !== content) deps.write(path, next)
  }
  return {
    erase: (path, radius) => {
      const notePath = deps.notePath()
      const pages = deps.pages()
      if (!notePath || !pages) return false
      const hits = pdfMarkSpansUnderEraser(pages, path, radius)
      if (!hits.length) return false
      const content = deps.read(notePath)
      if (content === null) return false
      const result = unmarkPdfNote(content, hits)
      if (!result) return false
      if (!pending || pending.path !== notePath) pending = { path: notePath, before: result.before }
      deps.write(notePath, result.content)
      return true
    },
    commit: () => {
      if (!pending) return null
      const content = deps.read(pending.path)
      const step: Step = { ...pending, after: content === null ? [] : readPdfMarks(content) }
      pending = null
      serial += 1
      steps.set(serial, step)
      for (const old of steps.keys()) {
        if (steps.size <= STEP_LIMIT) break
        steps.delete(old)
      }
      return serial
    },
    undo: (id) => {
      const step = steps.get(id)
      if (step) apply(step.path, step.before)
    },
    redo: (id) => {
      const step = steps.get(id)
      if (step) apply(step.path, step.after)
    },
  }
}
