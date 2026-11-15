// Endnotes for the export: instead of sitting at the bottom of their page,
// footnotes are collected after each chapter or at the end of the book. The
// editor never asks for this (LayoutOptions.endnotes is unset there), so the
// screen layout is unchanged.
//
// The collected notes are ordinary flow blocks added to the layout's block
// list, so every exporter draws them like any other paragraph. They are not
// part of the story: their `ref` is a non-editable `break` (like the scene
// break the flow inserts) and their keys start with `n:` (a notes heading) or
// `e:` (one note), see `isEndnoteBlock`.
import type { FlowBlock } from '../model/flow'
import type { Run } from '../model/types'

export type EndnotePlacement = 'chapter' | 'book'

export type EndnoteOptions = {
  placement: EndnotePlacement
  /** Heading of the notes ("Anmerkungen", "Notes"). */
  title: string
}

export const endnotesHeadingKey = (scope: string) => `n:${scope}`
export const endnoteKey = (footnoteId: string) => `e:${footnoteId}`
export const isEndnoteBlock = (block: Pick<FlowBlock, 'key'>) => block.key.startsWith('n:') || block.key.startsWith('e:')

/**
 * Footnote numbers in reading order. Continuous through the book, or
 * restarting with every chapter (and part) when `perChapter` is set.
 */
export const numberFootnotes = (blocks: FlowBlock[], perChapter = false) => {
  const numbers = new Map<string, string>()
  let count = 0
  for (const block of blocks) {
    if (perChapter && block.chapterStart) count = 0
    for (const run of block.runs) {
      if (run.m?.fn && !numbers.has(run.m.fn)) {
        count += 1
        numbers.set(run.m.fn, String(count))
      }
    }
  }
  return numbers
}

/** The runs of one collected note: its number, then its text. */
export const endnoteRuns = (number: string, runs: Run[]): Run[] => [{ text: `${number} `, m: { sup: true } }, ...runs.filter((run) => !run.m?.fn)]

const generated = (key: string, style: string, text: string, from: FlowBlock | null, extra: Partial<FlowBlock> = {}): FlowBlock => ({
  key,
  ref: { kind: 'break', sceneId: from?.sceneId ?? '' },
  style,
  runs: text ? [{ text }] : [],
  editable: false,
  chapterId: from?.chapterId ?? null,
  chapterTitle: from?.chapterTitle ?? '',
  sceneId: null,
  afterBreak: false,
  chapterStart: false,
  ...extra,
})

/**
 * The flow with the notes added: after the last block of every chapter that
 * has notes ('chapter'), or as a section of its own at the end ('book'),
 * grouped by chapter.
 */
export const insertEndnotes = (blocks: FlowBlock[], numbers: Map<string, string>, options: EndnoteOptions, footnoteRuns: (id: string) => Run[] | null): FlowBlock[] => {
  type Group = { start: FlowBlock | null; ids: string[]; end: number }
  const groups: Group[] = []
  let group: Group = { start: null, ids: [], end: -1 }
  const seen = new Set<string>()
  blocks.forEach((block, index) => {
    if (block.chapterStart) {
      groups.push(group)
      group = { start: block, ids: [], end: index }
    }
    group.end = index
    for (const run of block.runs) {
      const id = run.m?.fn
      if (id && !seen.has(id)) {
        seen.add(id)
        group.ids.push(id)
      }
    }
  })
  groups.push(group)
  const notesOf = (ids: string[], from: FlowBlock | null) => ids.map((id) => generated(endnoteKey(id), 'footnote', '', from, { runs: endnoteRuns(numbers.get(id) ?? '*', footnoteRuns(id) ?? []) }))
  if (options.placement === 'chapter') {
    const out: FlowBlock[] = []
    let next = 0
    for (const entry of groups) {
      if (entry.end < next) continue
      out.push(...blocks.slice(next, entry.end + 1))
      next = entry.end + 1
      if (!entry.ids.length) continue
      const last = blocks[entry.end]
      out.push(generated(endnotesHeadingKey(entry.start?.chapterId ?? 'front'), 'heading', options.title, last), ...notesOf(entry.ids, last))
    }
    out.push(...blocks.slice(next))
    return out
  }
  const withNotes = groups.filter((entry) => entry.ids.length)
  if (!withNotes.length) return blocks
  const heading = generated(endnotesHeadingKey('book'), 'chapter', options.title, null, { chapterStart: true, chapterId: 'endnotes', chapterTitle: options.title })
  const out = [...blocks, heading]
  for (const entry of withNotes) {
    const context = { ...heading, chapterStart: false }
    if (entry.start && withNotes.length > 1) out.push(generated(endnotesHeadingKey(`book:${entry.start.chapterId ?? ''}`), 'subheading', entry.start.chapterTitle, context, { chapterId: 'endnotes', chapterTitle: options.title }))
    out.push(...notesOf(entry.ids, context).map((block) => ({ ...block, chapterId: 'endnotes', chapterTitle: options.title })))
  }
  return out
}
