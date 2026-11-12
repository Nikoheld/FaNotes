'use strict'

/**
 * Which handwriting page a save may replace, and which one a note opens.
 *
 * A board whose stored page never loaded (still restoring, or unreadable)
 * holds an empty stroke list under the note's real ink id. Its save looked
 * like a real page and replaced a multi-megabyte drawing record and `.famd`
 * with a few hundred bytes. A deliberate empty page always leaves an undo or
 * redo step behind: an erase, `clear()`, and an undo each push one, and the
 * board saves them as `inkHistory`. An empty page without that step, over a
 * stored page that still has strokes, is refused.
 */
const { famdLooksStored, parseFamd } = require('./famd.cjs')

// Collapsed sections park their strokes in `hidden`, and a collapsed section
// can hold collapsed subsections. famd.cjs `inkHasMarks` stops at depth 6,
// which is one level short of a subsection's strokes.
const MAX_WALK_DEPTH = 24

/** Strokes anywhere on the page: live, in collapsed (sub)sections, packed (`famdPts`) or not. */
function pageHasStrokes(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_WALK_DEPTH) return false
  if (Array.isArray(value)) return value.some((item) => pageHasStrokes(item, depth + 1))
  if (typeof value.famdPts === 'string' && value.famdPts.length > 0) return true
  if (Array.isArray(value.points) && value.points.length > 0) return true
  if (Array.isArray(value.figurePaths) && value.figurePaths.length > 0) return true
  return pageHasStrokes(value.strokes, depth + 1)
    || pageHasStrokes(value.sections, depth + 1)
    || pageHasStrokes(value.hidden, depth + 1)
    || pageHasStrokes(value.ink, depth + 1)
}

/** The page saved at least one undo or redo step. */
function inkHistoryHasSteps(document) {
  const history = document && typeof document === 'object' ? document.inkHistory : null
  if (!history || typeof history !== 'object') return false
  return (Array.isArray(history.undo) && history.undo.length > 0)
    || (Array.isArray(history.redo) && history.redo.length > 0)
}

/** No strokes anywhere, and nothing that says they were removed on purpose. */
function isUnexplainedEmptyPage(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false
  return !pageHasStrokes(document) && !inkHistoryHasSteps(document)
}

/** The drawing record's text holds strokes. A record that cannot be parsed counts as holding them. */
function recordTextHasInk(text) {
  if (typeof text !== 'string' || !text) return false
  try {
    return pageHasStrokes(JSON.parse(text))
  } catch {
    return true
  }
}

/** The `.famd` companion's text holds strokes. A companion that cannot be parsed counts as holding them. */
function companionTextHasInk(text) {
  if (typeof text !== 'string' || !text) return false
  try {
    const parsed = parseFamd(text, { unpack: false })
    if (!parsed.payload) return famdLooksStored(text)
    return pageHasStrokes(parsed.payload.ink)
  } catch {
    return true
  }
}

/**
 * True when this save must not be written. `recordText` and `companionText`
 * are the files on disk (null when missing); `undefined` means the file could
 * not be read (or was not read) and is kept. A large drawing is never a
 * skeleton, and its strokes are not in `document` (the worker sends only the
 * top-level fields).
 */
function refusesEmptyInkSave({ document, large, recordText, companionText }) {
  if (large === true || !isUnexplainedEmptyPage(document)) return false
  if (recordText === undefined || companionText === undefined) return true
  return recordTextHasInk(recordText) || companionTextHasInk(companionText)
}

/**
 * A note opens its `.famd` ink, unless that ink is an unexplained empty page:
 * then the drawing record under the same id is read, and used when it parses
 * and has strokes (`pageHasStrokes`). That is the state an empty save written
 * before the guard above left behind. A packed companion always has strokes.
 */
function companionInkNeedsRecord(loaded) {
  if (!loaded || !loaded.ink || typeof loaded.ink !== 'object') return false
  if (loaded.packedInk && loaded.packedInk.columns) return false
  return isUnexplainedEmptyPage(loaded.ink)
}

/**
 * The parsed drawing record a note opens instead of its companion ink, or
 * null to open the companion as before. `loaded` is the opened companion
 * (`openFamdFile`), `recordText` the record's text (null when missing).
 */
function recordDocumentForEmptyCompanion(loaded, recordText) {
  if (!companionInkNeedsRecord(loaded) || typeof recordText !== 'string' || !recordText) return null
  let document
  try {
    document = JSON.parse(recordText)
  } catch {
    return null
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null
  return pageHasStrokes(document) ? document : null
}

module.exports = {
  companionInkNeedsRecord,
  companionTextHasInk,
  inkHistoryHasSteps,
  isUnexplainedEmptyPage,
  pageHasStrokes,
  recordDocumentForEmptyCompanion,
  recordTextHasInk,
  refusesEmptyInkSave,
}
