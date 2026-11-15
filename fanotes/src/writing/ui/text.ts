// Counting and clipboard conversion for the writing mode.
import type { FlowBlock } from '../model/flow'
import { normalizeRuns, runsText } from '../model/runs'
import type { Marks, Run } from '../model/types'

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
const counts = new WeakMap<Run[], { words: number; chars: number; charsNoSpaces: number }>()

/** Words and characters of a block's runs, cached by identity. */
export const countRuns = (runs: Run[]) => {
  const cached = counts.get(runs)
  if (cached) return cached
  const text = runsText(runs)
  let words = 0
  if (segmenter) for (const segment of segmenter.segment(text)) { if (segment.isWordLike) words += 1 }
  else words = text.split(/\s+/u).filter(Boolean).length
  const value = { words, chars: text.length, charsNoSpaces: text.replace(/\s/gu, '').length }
  counts.set(runs, value)
  return value
}

export const countText = (text: string) => {
  let words = 0
  if (segmenter) for (const segment of segmenter.segment(text)) { if (segment.isWordLike) words += 1 }
  else words = text.split(/\s+/u).filter(Boolean).length
  return { words, chars: text.length, charsNoSpaces: text.replace(/\s/gu, '').length }
}

export const countBlocks = (blocks: FlowBlock[]) => {
  let words = 0
  let chars = 0
  let charsNoSpaces = 0
  let paragraphs = 0
  for (const block of blocks) {
    if (block.ref.kind !== 'para') continue
    const value = countRuns(block.runs)
    words += value.words
    chars += value.chars
    charsNoSpaces += value.charsNoSpaces
    if (value.chars) paragraphs += 1
  }
  return { words, chars, charsNoSpaces, paragraphs }
}

const escape = (text: string) => text.replace(/[&<>"]/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

export const runsToHtml = (paragraphs: Array<{ runs: Run[]; style: string }>) => paragraphs.map((paragraph) => {
  const tag = paragraph.style === 'chapter' ? 'h1' : paragraph.style === 'heading' ? 'h2' : paragraph.style === 'subheading' ? 'h3' : paragraph.style === 'quote' ? 'blockquote' : 'p'
  const inner = paragraph.runs.map((run) => {
    let html = escape(run.text).replace(/\n/gu, '<br>')
    const marks = run.m
    if (!marks) return html
    if (marks.b) html = `<strong>${html}</strong>`
    if (marks.i) html = `<em>${html}</em>`
    if (marks.u) html = `<u>${html}</u>`
    if (marks.s) html = `<s>${html}</s>`
    if (marks.sup) html = `<sup>${html}</sup>`
    if (marks.sub) html = `<sub>${html}</sub>`
    if (marks.link) html = `<a href="${escape(marks.link)}">${html}</a>`
    return html
  }).join('')
  return `<${tag}>${inner}</${tag}>`
}).join('')

const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'SECTION', 'ARTICLE'])

/** Parses pasted HTML into paragraphs with emphasis kept (fonts and colours from other apps are dropped). */
export const htmlToParagraphs = (html: string): Array<{ runs: Run[]; style?: string }> => {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const out: Array<{ runs: Run[]; style?: string }> = []
  let current: { runs: Run[]; style?: string } = { runs: [] }
  const flush = () => {
    const runs = normalizeRuns(current.runs)
    if (runs.length || current.style) out.push({ runs, ...(current.style ? { style: current.style } : {}) })
    current = { runs: [] }
  }
  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/gu, ' ')
      if (text) current.runs.push({ text, ...(Object.keys(marks).length ? { m: { ...marks } } : {}) })
      return
    }
    if (!(node instanceof Element)) return
    const tag = node.tagName
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'HEAD') return
    if (tag === 'BR') {
      current.runs.push({ text: '\n' })
      return
    }
    const next: Marks = { ...marks }
    const style = (node as HTMLElement).style
    if (tag === 'B' || tag === 'STRONG' || Number(style?.fontWeight) >= 600 || style?.fontWeight === 'bold') next.b = true
    if (tag === 'I' || tag === 'EM' || style?.fontStyle === 'italic') next.i = true
    if (tag === 'U' || style?.textDecoration?.includes('underline')) next.u = true
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.s = true
    if (tag === 'SUP') next.sup = true
    if (tag === 'SUB') next.sub = true
    if (tag === 'A' && /^(https?:|mailto:)/iu.test(node.getAttribute('href') ?? '')) next.link = node.getAttribute('href')!
    const block = BLOCKS.has(tag)
    if (block) {
      flush()
      if (/^H[12]$/u.test(tag)) current.style = 'heading'
      else if (/^H[3-6]$/u.test(tag)) current.style = 'subheading'
      else if (tag === 'BLOCKQUOTE') current.style = 'quote'
    }
    for (const child of node.childNodes) walk(child, next)
    if (block) flush()
  }
  walk(document.body, {})
  flush()
  // Trim the spaces that HTML layout added at paragraph edges.
  return out.map((paragraph) => {
    const runs = paragraph.runs.slice()
    if (runs[0]) runs[0] = { ...runs[0], text: runs[0].text.replace(/^ +/u, '') }
    const last = runs.length - 1
    if (runs[last]) runs[last] = { ...runs[last], text: runs[last].text.replace(/ +$/u, '') }
    return { ...paragraph, runs: normalizeRuns(runs) }
  }).filter((paragraph, index, all) => paragraph.runs.length || (index > 0 && index < all.length - 1))
}

export const textToParagraphs = (text: string) => text.replace(/\r\n?/gu, '\n').split('\n').map((line) => ({ runs: line ? [{ text: line }] : [] }))
