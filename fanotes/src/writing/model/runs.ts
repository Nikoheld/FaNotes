import type { Marks, Paragraph, Run } from './types'

const MARK_KEYS: Array<keyof Marks> = ['b', 'i', 'u', 's', 'sc', 'sup', 'sub', 'font', 'size', 'color', 'hl', 'link', 'fn', 'cm', 'lang']

export const marksEqual = (left: Marks | undefined, right: Marks | undefined) => {
  if (left === right) return true
  for (const key of MARK_KEYS) if ((left?.[key] ?? undefined) !== (right?.[key] ?? undefined)) return false
  return true
}

const cleanMarks = (marks: Marks | undefined): Marks | undefined => {
  if (!marks) return undefined
  const out: Marks = {}
  let any = false
  for (const key of MARK_KEYS) {
    const value = marks[key]
    if (value === undefined || value === null || value === false || value === '') continue
    ;(out as Record<string, unknown>)[key] = value
    any = true
  }
  return any ? out : undefined
}

/** Merges neighbours with equal marks and drops empty runs (footnote anchors are kept). */
export const normalizeRuns = (runs: Run[]): Run[] => {
  const out: Run[] = []
  for (const run of runs) {
    const marks = cleanMarks(run.m)
    if (!run.text && !marks?.fn) continue
    const last = out[out.length - 1]
    if (last && !marks?.fn && !last.m?.fn && marksEqual(last.m, marks)) {
      last.text += run.text
      continue
    }
    out.push(marks ? { text: run.text, m: marks } : { text: run.text })
  }
  return out
}

export const runsText = (runs: Run[]) => runs.map((run) => run.text).join('')
export const paragraphText = (paragraph: Paragraph) => runsText(paragraph.runs)
export const runsLength = (runs: Run[]) => runs.reduce((sum, run) => sum + run.text.length, 0)

/** The runs between two offsets. */
export const sliceRuns = (runs: Run[], from: number, to = Number.POSITIVE_INFINITY): Run[] => {
  const out: Run[] = []
  let position = 0
  for (const run of runs) {
    const start = position
    const end = position + run.text.length
    position = end
    if (end <= from || start >= to) {
      if (!run.text && run.m?.fn && start >= from && start < to) out.push({ ...run })
      continue
    }
    const text = run.text.slice(Math.max(0, from - start), Math.min(run.text.length, to - start))
    out.push(run.m ? { text, m: { ...run.m } } : { text })
  }
  return normalizeRuns(out)
}

/** Marks in force at an offset: those of the character before it (typing continues the formatting). */
export const marksAt = (runs: Run[], offset: number): Marks | undefined => {
  let position = 0
  let previous: Marks | undefined
  for (const run of runs) {
    const end = position + run.text.length
    if (offset > position && offset <= end) return run.m ? withoutAnchors(run.m) : undefined
    if (offset === 0 && run.text) return run.m ? withoutAnchors(run.m) : undefined
    previous = run.m
    position = end
  }
  return previous ? withoutAnchors(previous) : undefined
}

/** Typing next to a footnote marker or inside a link does not extend them. */
const withoutAnchors = (marks: Marks): Marks | undefined => {
  const { fn: _fn, cm: _cm, link: _link, ...rest } = marks
  return cleanMarks(rest)
}

export const insertRuns = (runs: Run[], offset: number, inserted: Run[]): Run[] => normalizeRuns([
  ...sliceRuns(runs, 0, offset),
  ...inserted,
  ...sliceRuns(runs, offset),
])

export const insertText = (runs: Run[], offset: number, text: string, marks?: Marks): Run[] => (
  insertRuns(runs, offset, [{ text, ...(marks ? { m: marks } : {}) }])
)

export const deleteRange = (runs: Run[], from: number, to: number): Run[] => normalizeRuns([
  ...sliceRuns(runs, 0, from),
  ...sliceRuns(runs, to),
])

export type MarkPatch = Partial<Record<keyof Marks, Marks[keyof Marks] | null>>

/** Sets (value) or clears (null) marks on a range. */
export const applyMarks = (runs: Run[], from: number, to: number, patch: MarkPatch): Run[] => {
  if (from >= to) return runs
  const middle = sliceRuns(runs, from, to).map((run) => {
    const next: Record<string, unknown> = { ...(run.m ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[key]
      else next[key] = value
    }
    if (patch.sup) delete next.sub
    if (patch.sub) delete next.sup
    return { text: run.text, m: next as Marks }
  })
  return normalizeRuns([...sliceRuns(runs, 0, from), ...middle, ...sliceRuns(runs, to)])
}

/** True when every character in the range has the mark set to `value` (or any truthy value). */
export const rangeHasMark = (runs: Run[], from: number, to: number, key: keyof Marks, value?: unknown) => {
  const part = sliceRuns(runs, from, to).filter((run) => run.text)
  if (!part.length) return Boolean(value === undefined ? marksAt(runs, from)?.[key] : marksAt(runs, from)?.[key] === value)
  return part.every((run) => (value === undefined ? Boolean(run.m?.[key]) : run.m?.[key] === value))
}

/** Replaces the text in a range, keeping the marks of the range's first character. */
export const replaceText = (runs: Run[], from: number, to: number, text: string): Run[] => {
  const marks = sliceRuns(runs, from, Math.max(from + 1, to))[0]?.m ?? marksAt(runs, from)
  return insertText(deleteRange(runs, from, to), from, text, marks ? withoutAnchors(marks) : undefined)
}
