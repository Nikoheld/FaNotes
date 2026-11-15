// Editing commands. Each takes the current state and returns the next one
// (or null when it does nothing). They never mutate: undo is a snapshot swap.
import { breakKey, paragraphKey, type FlowBlock } from '../model/flow'
import { newId } from '../model/ids'
import { keysBetween } from '../model/keys'
import {
  applyMarks,
  deleteRange,
  insertRuns,
  insertText as insertIntoRuns,
  marksAt,
  normalizeRuns,
  rangeHasMark,
  runsText,
  sliceRuns,
  type MarkPatch,
} from '../model/runs'
import { SCENE_FORMAT, type Align, type BinderNode, type Marks, type Paragraph, type Run, type Scene } from '../model/types'
import {
  blockAt,
  blockLength,
  caret,
  chapterOfScene,
  clampPos,
  comparePos,
  insertNodesAfter,
  insertParagraph,
  isCollapsed,
  keyAfter,
  keyBefore,
  makeDoc,
  ordered,
  removeParagraphs,
  setNodeTitle,
  updateParagraph,
  withScene,
  type Doc,
  type Pos,
  type Selection,
} from './doc'

export type EditorState = {
  doc: Doc
  selection: Selection
  /** Formatting for the next typed text when the selection is empty (Ctrl+B with nothing selected). */
  storedMarks: Marks | null
}

export type Result = EditorState | null

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const words = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

/** Offset of the grapheme boundary before/after `offset`. */
export const graphemeStep = (text: string, offset: number, direction: 1 | -1) => {
  if (!graphemes) return Math.max(0, Math.min(text.length, offset + direction))
  let previous = 0
  for (const segment of graphemes.segment(text)) {
    const end = segment.index + segment.segment.length
    if (direction === -1 && end >= offset) return segment.index < offset ? segment.index : previous
    if (direction === 1 && segment.index >= offset) return end
    previous = segment.index
  }
  return direction === -1 ? previous : text.length
}

/** Offset of the previous/next word boundary (skipping spaces and punctuation, like Ctrl+arrow). */
export const wordStep = (text: string, offset: number, direction: 1 | -1) => {
  if (!words) return direction === 1 ? text.length : 0
  const segments = [...words.segment(text)].filter((segment) => segment.isWordLike)
  if (direction === -1) {
    for (let index = segments.length - 1; index >= 0; index -= 1) if (segments[index].index < offset) return segments[index].index
    return 0
  }
  for (const segment of segments) {
    const end = segment.index + segment.segment.length
    if (end > offset) return end
  }
  return text.length
}

/** The word around an offset (double click). */
export const wordAt = (text: string, offset: number): [number, number] => {
  if (!words) return [offset, offset]
  for (const segment of words.segment(text)) {
    const end = segment.index + segment.segment.length
    if (offset >= segment.index && offset <= end && (segment.isWordLike || offset < end)) return [segment.index, end]
  }
  return [offset, offset]
}

const paragraphOf = (doc: Doc, block: FlowBlock): { scene: Scene; paragraph: Paragraph } | null => {
  if (block.ref.kind !== 'para') return null
  const scene = doc.scenes.get(block.ref.sceneId)
  const paragraph = scene?.paragraphs.find((candidate) => candidate.id === (block.ref as { paragraphId: string }).paragraphId)
  return scene && paragraph ? { scene, paragraph } : null
}

const newParagraph = (style: string, key: string, runs: Run[] = [], extra: Partial<Paragraph> = {}): Paragraph => ({ id: newId(), key, v: {}, style, runs, ...extra })

/** Replaces the text range of one block (paragraph or chapter title). */
const replaceInBlock = (doc: Doc, block: FlowBlock, from: number, to: number, inserted: Run[]): Doc => {
  if (block.ref.kind === 'title') {
    const text = runsText(block.runs)
    const title = (text.slice(0, from) + runsText(inserted).replace(/\n/gu, ' ') + text.slice(to)).slice(0, 300)
    return setNodeTitle(doc, block.ref.nodeId, title)
  }
  if (block.ref.kind !== 'para') return doc
  return updateParagraph(doc, block.ref.sceneId, block.ref.paragraphId, (paragraph) => ({
    ...paragraph,
    runs: insertRuns(deleteRange(paragraph.runs, from, to), from, inserted),
  }))
}

// ── Deleting ───────────────────────────────────────────────────────────────

/** Deletes the selected text. Paragraphs fully inside go away; chapter titles and scene boundaries stay. */
export const deleteSelection = (state: EditorState): Result => {
  if (isCollapsed(state.selection)) return null
  const { doc } = state
  const { from, to } = ordered(doc, state.selection)
  const start = doc.index.get(from.block)!
  const end = doc.index.get(to.block)!
  if (start === end) {
    const block = doc.flow[start]
    if (!block.editable) return null
    return { ...state, doc: replaceInBlock(doc, block, from.offset, to.offset, []), selection: caret(from), storedMarks: null }
  }
  let next = doc
  const firstBlock = doc.flow[start]
  const lastBlock = doc.flow[end]
  const removed = new Map<string, Set<string>>()
  for (let index = start + 1; index < end; index += 1) {
    const block = doc.flow[index]
    if (block.ref.kind === 'para') {
      const set = removed.get(block.ref.sceneId) ?? new Set<string>()
      set.add(block.ref.paragraphId)
      removed.set(block.ref.sceneId, set)
    } else if (block.ref.kind === 'title') {
      next = setNodeTitle(next, block.ref.nodeId, '')
    }
  }
  if (firstBlock.editable) next = replaceInBlock(next, blockAt(next, firstBlock.key)!, from.offset, blockLength(firstBlock), [])
  if (lastBlock.editable) next = replaceInBlock(next, blockAt(next, lastBlock.key)!, 0, to.offset, [])
  for (const [sceneId, ids] of removed) next = removeParagraphs(next, sceneId, ids)
  // The two ends join when they are paragraphs of the same scene.
  if (firstBlock.ref.kind === 'para' && lastBlock.ref.kind === 'para' && firstBlock.ref.sceneId === lastBlock.ref.sceneId) {
    const tail = blockAt(next, lastBlock.key)
    if (tail) {
      const sceneId = firstBlock.ref.sceneId
      next = updateParagraph(next, sceneId, firstBlock.ref.paragraphId, (paragraph) => ({ ...paragraph, runs: normalizeRuns([...paragraph.runs, ...tail.runs]) }))
      next = removeParagraphs(next, sceneId, new Set([lastBlock.ref.paragraphId]))
    }
  }
  const position = firstBlock.editable ? from : clampPos(next, from, start)
  return { ...state, doc: next, selection: caret(clampPos(next, position, start)), storedMarks: null }
}

/** Joins a paragraph with the one before it in the same scene. */
const joinWithPrevious = (doc: Doc, block: FlowBlock): { doc: Doc; caret: Pos } | null => {
  const position = doc.index.get(block.key)!
  const previous = doc.flow[position - 1]
  if (!previous || block.ref.kind !== 'para' || previous.ref.kind !== 'para' || previous.ref.sceneId !== block.ref.sceneId) return null
  const sceneId = block.ref.sceneId
  const join = blockLength(previous)
  let next = updateParagraph(doc, sceneId, previous.ref.paragraphId, (paragraph) => ({
    ...paragraph,
    runs: normalizeRuns([...paragraph.runs, ...block.runs]),
    // An empty paragraph takes the style of the one joined into it.
    ...(join === 0 ? { style: block.style } : {}),
  }))
  next = removeParagraphs(next, sceneId, new Set([block.ref.paragraphId]))
  return { doc: next, caret: { block: previous.key, offset: join } }
}

export const deleteBackward = (state: EditorState, unit: 'char' | 'word' = 'char'): Result => {
  if (!isCollapsed(state.selection)) return deleteSelection(state)
  const { doc } = state
  const pos = state.selection.head
  const block = blockAt(doc, pos.block)
  if (!block?.editable) return null
  if (pos.offset > 0) {
    const text = runsText(block.runs)
    const from = unit === 'word' ? wordStep(text, pos.offset, -1) : graphemeStep(text, pos.offset, -1)
    return { ...state, doc: replaceInBlock(doc, block, from, pos.offset, []), selection: caret({ block: block.key, offset: from }), storedMarks: null }
  }
  const joined = joinWithPrevious(doc, block)
  if (joined) return { ...state, doc: joined.doc, selection: caret(joined.caret), storedMarks: null }
  // An empty paragraph after a scene break or title is removed if its scene keeps another paragraph.
  if (block.ref.kind === 'para' && !blockLength(block)) {
    const scene = doc.scenes.get(block.ref.sceneId)!
    const visible = scene.paragraphs.filter((paragraph) => !paragraph.deleted)
    if (visible.length > 1) {
      const next = removeParagraphs(doc, scene.id, new Set([block.ref.paragraphId]))
      return { ...state, doc: next, selection: caret(clampPos(next, { block: paragraphKey(visible[1].id), offset: 0 })) }
    }
  }
  return null
}

export const deleteForward = (state: EditorState, unit: 'char' | 'word' = 'char'): Result => {
  if (!isCollapsed(state.selection)) return deleteSelection(state)
  const { doc } = state
  const pos = state.selection.head
  const block = blockAt(doc, pos.block)
  if (!block?.editable) return null
  const length = blockLength(block)
  if (pos.offset < length) {
    const text = runsText(block.runs)
    const to = unit === 'word' ? wordStep(text, pos.offset, 1) : graphemeStep(text, pos.offset, 1)
    return { ...state, doc: replaceInBlock(doc, block, pos.offset, to, []), selection: caret(pos), storedMarks: null }
  }
  const nextBlock = doc.flow[doc.index.get(block.key)! + 1]
  if (!nextBlock) return null
  const joined = joinWithPrevious(doc, nextBlock)
  return joined ? { ...state, doc: joined.doc, selection: caret(pos), storedMarks: null } : null
}

// ── Typing ─────────────────────────────────────────────────────────────────

export const insertText = (state: EditorState, text: string): Result => {
  if (!text) return null
  let current = state
  if (!isCollapsed(current.selection)) current = deleteSelection(current) ?? current
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  if (lines.length > 1) {
    let result: EditorState = current
    for (let index = 0; index < lines.length; index += 1) {
      if (index > 0) result = splitParagraph(result) ?? result
      if (lines[index]) result = insertText(result, lines[index]) ?? result
    }
    return result
  }
  const { doc } = current
  let pos = current.selection.head
  let block = blockAt(doc, pos.block)
  if (!block?.editable) {
    pos = clampPos(doc, pos)
    block = blockAt(doc, pos.block)
    if (!block?.editable) return null
  }
  const marks = current.storedMarks ?? marksAt(block.runs, pos.offset)
  const nextDoc = replaceInBlock(doc, block, pos.offset, pos.offset, [{ text, ...(marks ? { m: marks } : {}) }])
  const offset = block.ref.kind === 'title' ? Math.min(pos.offset + text.length, 300) : pos.offset + text.length
  return { doc: nextDoc, selection: caret({ block: block.key, offset }), storedMarks: current.storedMarks }
}

/** Inserts formatted runs (paste). Runs may contain line breaks that become paragraphs. */
export const insertRunsAt = (state: EditorState, paragraphs: Array<{ runs: Run[]; style?: string }>): Result => {
  let current = state
  if (!isCollapsed(current.selection)) current = deleteSelection(current) ?? current
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) current = splitParagraph(current) ?? current
    const block = blockAt(current.doc, current.selection.head.block)
    if (!block?.editable) return
    const at = current.selection.head.offset
    const runs = block.ref.kind === 'title' ? [{ text: runsText(paragraph.runs) }] : paragraph.runs
    let doc = replaceInBlock(current.doc, block, at, at, runs)
    if (paragraph.style && block.ref.kind === 'para' && current.doc.manifest.styles[paragraph.style]) {
      const ref = block.ref
      doc = updateParagraph(doc, ref.sceneId, ref.paragraphId, (value) => ({ ...value, style: paragraph.style! }))
    }
    current = { doc, selection: caret({ block: block.key, offset: at + runsText(runs).length }), storedMarks: null }
  })
  return current
}

/** Enter. In a title it moves to the text; at the start of a paragraph it inserts an empty one before. */
export const splitParagraph = (state: EditorState, options: { breakBefore?: 'page' } = {}): Result => {
  let current = state
  if (!isCollapsed(current.selection)) current = deleteSelection(current) ?? current
  const { doc } = current
  const pos = current.selection.head
  const block = blockAt(doc, pos.block)
  if (!block) return null
  if (block.ref.kind === 'title') {
    const next = clampPos(doc, { block: doc.flow[doc.index.get(block.key)! + 1]?.key ?? block.key, offset: 0 }, doc.index.get(block.key)! + 1)
    return { ...current, selection: caret({ ...next, offset: 0 }) }
  }
  const found = paragraphOf(doc, block)
  if (!found) return null
  const { scene, paragraph } = found
  const style = doc.manifest.styles[paragraph.style]
  const length = blockLength(block)
  if (pos.offset === 0 && length > 0 && !options.breakBefore) {
    const before = newParagraph(paragraph.style, keyBefore(scene, paragraph.id))
    return { ...current, doc: insertParagraph(doc, scene.id, before), selection: caret(pos) }
  }
  const tail = sliceRuns(paragraph.runs, pos.offset)
  const head = sliceRuns(paragraph.runs, 0, pos.offset)
  const nextStyle = pos.offset >= length ? style?.next ?? paragraph.style : paragraph.style
  const created = newParagraph(doc.manifest.styles[nextStyle] ? nextStyle : 'body', keyAfter(scene, paragraph.id), tail, {
    ...(paragraph.align && pos.offset < length ? { align: paragraph.align } : {}),
    ...(paragraph.lang ? { lang: paragraph.lang } : {}),
    ...(options.breakBefore ? { breakBefore: options.breakBefore } : {}),
  })
  let next = updateParagraph(doc, scene.id, paragraph.id, (value) => ({ ...value, runs: head }))
  next = insertParagraph(next, scene.id, created)
  return { doc: next, selection: caret({ block: paragraphKey(created.id), offset: 0 }), storedMarks: current.storedMarks }
}

/** Shift+Enter: a line break inside the paragraph. */
export const insertLineBreak = (state: EditorState): Result => {
  let current = state
  if (!isCollapsed(current.selection)) current = deleteSelection(current) ?? current
  const pos = current.selection.head
  const block = blockAt(current.doc, pos.block)
  if (block?.ref.kind !== 'para') return null
  const marks = marksAt(block.runs, pos.offset)
  return { ...current, doc: replaceInBlock(current.doc, block, pos.offset, pos.offset, [{ text: '\n', ...(marks ? { m: marks } : {}) }]), selection: caret({ block: block.key, offset: pos.offset + 1 }) }
}

/** Ctrl+Enter: the text after the caret starts on a new page. */
export const insertPageBreak = (state: EditorState) => splitParagraph(state, { breakBefore: 'page' })

/**
 * Splits the scene at the caret: the text after it becomes a new scene, right
 * after this one in the binder (`chapter: true` → in a new chapter after this
 * scene's chapter).
 */
export const splitScene = (state: EditorState, options: { chapter?: boolean; titles: { scene: string; chapter: string } }): Result => {
  let current = state
  if (!isCollapsed(current.selection)) current = deleteSelection(current) ?? current
  const { doc } = current
  const pos = current.selection.head
  const block = blockAt(doc, pos.block)
  if (block?.ref.kind !== 'para') return null
  const scene = doc.scenes.get(block.ref.sceneId)!
  const position = scene.paragraphs.findIndex((paragraph) => paragraph.id === (block.ref as { paragraphId: string }).paragraphId)
  const paragraph = scene.paragraphs[position]
  const head = sliceRuns(paragraph.runs, 0, pos.offset)
  const tail = sliceRuns(paragraph.runs, pos.offset)
  const following = scene.paragraphs.slice(position + 1).filter((value) => !value.deleted)
  const movedKeys = keysBetween(null, null, following.length + 1)
  const moved: Paragraph[] = [
    newParagraph('first', movedKeys[0], tail),
    // Moved paragraphs get new ids in the new scene; the old ones become tombstones in the old scene on save.
    ...following.map((value, index) => ({ ...value, id: newId(), key: movedKeys[index + 1], v: {} })),
  ]
  const newScene: Scene = { format: SCENE_FORMAT, id: newId(), paragraphs: moved }
  const keepIds = new Set(scene.paragraphs.slice(0, position + 1).map((value) => value.id))
  const oldScene: Scene = {
    ...scene,
    paragraphs: scene.paragraphs
      .filter((value) => keepIds.has(value.id) || value.deleted)
      .map((value) => (value.id === paragraph.id ? { ...value, runs: head } : value)),
  }
  const sceneNode: BinderNode = { id: newScene.id, kind: 'scene', title: options.titles.scene, status: 'draft' }
  let binder = doc.manifest.binder
  if (options.chapter) {
    const chapter = chapterOfScene(binder, scene.id)
    const chapterNode: BinderNode = { id: newId(), kind: 'chapter', title: options.titles.chapter, children: [sceneNode] }
    // Scenes after this one in the chapter move into the new chapter too.
    if (chapter?.children) {
      const sceneIndex = chapter.children.findIndex((node) => node.id === scene.id)
      const later = chapter.children.slice(sceneIndex + 1)
      chapterNode.children = [sceneNode, ...later]
      const trimmed = { ...chapter, children: chapter.children.slice(0, sceneIndex + 1) }
      binder = insertNodesAfter(binder.map(function replace(node): BinderNode {
        if (node.id === chapter.id) return trimmed
        return node.children ? { ...node, children: node.children.map(replace) } : node
      }), chapter.id, [chapterNode])
    } else {
      binder = insertNodesAfter(binder, scene.id, [chapterNode])
    }
  } else {
    binder = insertNodesAfter(binder, scene.id, [sceneNode])
  }
  const scenes = new Map(doc.scenes)
  scenes.set(oldScene.id, oldScene)
  scenes.set(newScene.id, newScene)
  const next = makeDoc({ ...doc.manifest, binder }, scenes)
  return { doc: next, selection: caret({ block: paragraphKey(moved[0].id), offset: 0 }), storedMarks: null }
}

// ── Formatting ─────────────────────────────────────────────────────────────

const forEachParagraphInSelection = (state: EditorState, update: (paragraph: Paragraph, from: number, to: number, block: FlowBlock) => Paragraph): Doc => {
  const { doc } = state
  const { from, to } = ordered(doc, state.selection)
  const start = doc.index.get(from.block)!
  const end = doc.index.get(to.block)!
  let next = doc
  for (let index = start; index <= end; index += 1) {
    const block = doc.flow[index]
    if (block.ref.kind !== 'para') continue
    const length = blockLength(block)
    const a = index === start ? from.offset : 0
    const b = index === end ? to.offset : length
    const ref = block.ref
    next = updateParagraph(next, ref.sceneId, ref.paragraphId, (paragraph) => update(paragraph, a, b, block))
  }
  return next
}

/** Ctrl+B and friends: on a selection toggles the mark, on a caret sets it for the next typing. */
export const toggleMark = (state: EditorState, key: 'b' | 'i' | 'u' | 's' | 'sc' | 'sup' | 'sub'): Result => {
  if (isCollapsed(state.selection)) {
    const block = blockAt(state.doc, state.selection.head.block)
    const marks = state.storedMarks ?? (block ? marksAt(block.runs, state.selection.head.offset) : undefined) ?? {}
    const next: Marks = { ...marks }
    if (next[key]) delete next[key]
    else {
      next[key] = true
      if (key === 'sup') delete next.sub
      if (key === 'sub') delete next.sup
    }
    return { ...state, storedMarks: next }
  }
  const { doc } = state
  const { from, to } = ordered(doc, state.selection)
  const start = doc.index.get(from.block)!
  const end = doc.index.get(to.block)!
  let all = true
  for (let index = start; index <= end && all; index += 1) {
    const block = doc.flow[index]
    if (block.ref.kind !== 'para') continue
    const a = index === start ? from.offset : 0
    const b = index === end ? to.offset : blockLength(block)
    if (a < b && !rangeHasMark(block.runs, a, b, key)) all = false
  }
  const patch: MarkPatch = { [key]: all ? null : true }
  return { ...state, doc: forEachParagraphInSelection(state, (paragraph, a, b) => (a < b ? { ...paragraph, runs: applyMarks(paragraph.runs, a, b, patch) } : paragraph)) }
}

/** Font, size, colour, highlight, link, language on the selection (null clears). */
export const setMark = (state: EditorState, patch: MarkPatch): Result => {
  if (isCollapsed(state.selection)) {
    const block = blockAt(state.doc, state.selection.head.block)
    const marks: Record<string, unknown> = { ...(state.storedMarks ?? (block ? marksAt(block.runs, state.selection.head.offset) : undefined) ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete marks[key]
      else marks[key] = value
    }
    return { ...state, storedMarks: marks as Marks }
  }
  return { ...state, doc: forEachParagraphInSelection(state, (paragraph, a, b) => (a < b ? { ...paragraph, runs: applyMarks(paragraph.runs, a, b, patch) } : paragraph)) }
}

export const clearFormatting = (state: EditorState): Result => setMark(state, { b: null, i: null, u: null, s: null, sc: null, sup: null, sub: null, font: null, size: null, color: null, hl: null })

export const setParagraphStyle = (state: EditorState, style: string): Result => {
  if (!state.doc.manifest.styles[style]) return null
  return { ...state, doc: forEachParagraphInSelection(state, (paragraph) => (paragraph.style === style ? paragraph : { ...paragraph, style })) }
}

export const setAlign = (state: EditorState, align: Align | null): Result => ({
  ...state,
  doc: forEachParagraphInSelection(state, (paragraph) => {
    if ((paragraph.align ?? null) === align) return paragraph
    const { align: _old, ...rest } = paragraph
    return align ? { ...rest, align } : rest
  }),
})

export const setParagraphLanguage = (state: EditorState, lang: Paragraph['lang'] | null): Result => ({
  ...state,
  doc: forEachParagraphInSelection(state, (paragraph) => {
    const { lang: _old, ...rest } = paragraph
    return lang ? { ...rest, lang } : rest
  }),
})

// ── Footnotes and comments ─────────────────────────────────────────────────

export const insertFootnote = (state: EditorState, text = ''): { state: EditorState; id: string } | null => {
  const collapsed = isCollapsed(state.selection) ? state : deleteSelection(state) ?? state
  const pos = collapsed.selection.head
  const block = blockAt(collapsed.doc, pos.block)
  if (block?.ref.kind !== 'para') return null
  const id = newId()
  const ref = block.ref
  let doc = updateParagraph(collapsed.doc, ref.sceneId, ref.paragraphId, (paragraph) => ({ ...paragraph, runs: insertRuns(paragraph.runs, pos.offset, [{ text: '', m: { fn: id } }]) }))
  const scene = doc.scenes.get(ref.sceneId)!
  doc = withScene(doc, { ...scene, footnotes: { ...(scene.footnotes ?? {}), [id]: { id, runs: text ? [{ text }] : [] } } })
  return { state: { ...collapsed, doc, selection: caret(pos) }, id }
}

export const setFootnoteText = (state: EditorState, sceneId: string, id: string, runs: Run[]): Result => {
  const scene = state.doc.scenes.get(sceneId)
  if (!scene?.footnotes?.[id]) return null
  return { ...state, doc: withScene(state.doc, { ...scene, footnotes: { ...scene.footnotes, [id]: { id, runs: normalizeRuns(runs) } } }) }
}

export const addComment = (state: EditorState, author: string, text: string): { state: EditorState; id: string } | null => {
  if (isCollapsed(state.selection)) return null
  const id = newId()
  let doc = forEachParagraphInSelection(state, (paragraph, a, b) => (a < b ? { ...paragraph, runs: applyMarks(paragraph.runs, a, b, { cm: id }) } : paragraph))
  const { from } = ordered(state.doc, state.selection)
  const block = blockAt(state.doc, from.block)
  if (block?.ref.kind !== 'para') return null
  const scene = doc.scenes.get(block.ref.sceneId)!
  doc = withScene(doc, { ...scene, comments: { ...(scene.comments ?? {}), [id]: { id, author, at: new Date().toISOString(), text } } })
  return { state: { ...state, doc }, id }
}

export const resolveComment = (state: EditorState, sceneId: string, id: string, remove = false): Result => {
  const scene = state.doc.scenes.get(sceneId)
  const comment = scene?.comments?.[id]
  if (!scene || !comment) return null
  if (!remove) return { ...state, doc: withScene(state.doc, { ...scene, comments: { ...scene.comments, [id]: { ...comment, resolved: !comment.resolved } } }) }
  const comments = { ...scene.comments }
  delete comments[id]
  const paragraphs = scene.paragraphs.map((paragraph) => (paragraph.runs.some((run) => run.m?.cm === id)
    ? { ...paragraph, runs: normalizeRuns(paragraph.runs.map((run) => (run.m?.cm === id ? { text: run.text, ...(() => { const { cm: _cm, ...rest } = run.m!; return Object.keys(rest).length ? { m: rest } : {} })() } : run))) }
    : paragraph))
  return { ...state, doc: withScene(state.doc, { ...scene, paragraphs, comments }) }
}

// ── Selection helpers ──────────────────────────────────────────────────────

export const selectAll = (state: EditorState): Result => {
  const first = state.doc.flow.find((block) => block.editable)
  const last = [...state.doc.flow].reverse().find((block) => block.editable)
  if (!first || !last) return null
  return { ...state, selection: { anchor: { block: first.key, offset: 0 }, head: { block: last.key, offset: blockLength(last) } } }
}

/** The selected text as plain text (paragraphs separated by blank lines? no: by newlines). */
export const selectedRuns = (state: EditorState): Array<{ runs: Run[]; style: string }> => {
  const { doc } = state
  const { from, to } = ordered(doc, state.selection)
  const start = doc.index.get(from.block)!
  const end = doc.index.get(to.block)!
  const out: Array<{ runs: Run[]; style: string }> = []
  for (let index = start; index <= end; index += 1) {
    const block = doc.flow[index]
    const a = index === start ? from.offset : 0
    const b = index === end ? to.offset : blockLength(block)
    out.push({ runs: sliceRuns(block.runs, a, b), style: block.style })
  }
  return out
}

export const selectedText = (state: EditorState) => selectedRuns(state).map((paragraph) => runsText(paragraph.runs)).join('\n')

export { comparePos, breakKey }
