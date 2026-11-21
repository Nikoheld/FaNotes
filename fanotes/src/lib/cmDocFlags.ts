import type { ChangeSet, Text } from '@codemirror/state'

export type DocFlags = {
  /** Some line contains `<details` (any case). */
  details: boolean
  /** Some line contains `$$`. */
  math: boolean
  /** Some line contains a fanotes study fence. */
  study: boolean
  /** Some line contains a pipe (a table candidate). */
  pipe: boolean
}

const cache = new WeakMap<Text, DocFlags>()

/**
 * One cheap pass over the lines tells which whole-document scanners (details blocks, display math,
 * study blocks, tables) can have any result at all. A 50,000-line note without them then skips every
 * per-line regex scan on each keystroke (QA-006). Cached per document version.
 */
const scanLine = (flags: DocFlags, line: string) => {
  if (!flags.pipe && line.includes('|')) flags.pipe = true
  if (!flags.math && line.includes('$$')) flags.math = true
  if (!flags.details && line.includes('<') && /<details/iu.test(line)) flags.details = true
  if (!flags.study && line.includes('```fanotes-')) flags.study = true
}

export const docFlags = (doc: Text): DocFlags => {
  let flags = cache.get(doc)
  if (flags) return flags
  flags = { details: false, math: false, study: false, pipe: false }
  for (const line of doc.iterLines()) {
    scanLine(flags, line)
    if (flags.pipe && flags.math && flags.details && flags.study) break
  }
  cache.set(doc, flags)
  return flags
}

const NONE: DocFlags = { details: false, math: false, study: false, pipe: false }

/**
 * Typing in a document that has none of the markers only needs the lines the change touched:
 * every marker sits inside one line, so a marker in the new document must be on a changed line.
 * Call this from an update before anything asks `docFlags(newDoc)`. Otherwise `docFlags` scans.
 */
export const primeDocFlags = (oldDoc: Text, newDoc: Text, changes: ChangeSet) => {
  if (cache.has(newDoc)) return
  const before = cache.get(oldDoc)
  if (!before || before.details || before.math || before.study || before.pipe) return
  const flags: DocFlags = { ...NONE }
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const first = newDoc.lineAt(fromB).number
    const last = newDoc.lineAt(Math.min(toB, newDoc.length)).number
    for (let number = first; number <= last; number += 1) scanLine(flags, newDoc.line(number).text)
  })
  cache.set(newDoc, flags)
}
