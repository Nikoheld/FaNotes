// Markdown and plain text export. Markdown: YAML front matter, headings for
// parts, chapters (and optionally scenes), emphasis, links, `[^n]` footnotes,
// `* * *` between scenes. Plain text: the same structure without markup.
import { numberFootnotes } from '../layout/endnotes'
import type { FlowBlock } from '../model/flow'
import type { Marks, Run } from '../model/types'
import { notesLabel, sceneStarts, titleKind, type NotesPlacement, type Prepared } from './prepare'

export type TextInput = { prepared: Prepared; notes?: NotesPlacement; sceneTitles?: boolean }

type InlineMark = 'b' | 'i' | 's' | 'u' | 'sup' | 'sub' | 'link'
const ORDER: InlineMark[] = ['link', 'b', 'i', 's', 'u', 'sup', 'sub']
const OPEN: Record<Exclude<InlineMark, 'link'>, string> = { b: '**', i: '*', s: '~~', u: '<u>', sup: '<sup>', sub: '<sub>' }
const CLOSE: Record<Exclude<InlineMark, 'link'>, string> = { b: '**', i: '*', s: '~~', u: '</u>', sup: '</sup>', sub: '</sub>' }

/** Escapes characters Markdown would read as markup. */
export const escapeMarkdown = (text: string) => text
  .replace(/[\\`*_[\]<>~]/gu, (char) => `\\${char}`)
  .replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/gmu, (_, space: string, mark: string) => `${space}${mark.replace(/^(\d+)([.)])$/u, '$1\\$2').replace(/^([#>+-])$/u, '\\$1')}`)

type Token = { kind: 'text' | 'open' | 'close'; value: string }

/** Inline Markdown for runs: delimiters nest properly and never sit next to inner whitespace. */
export const runsToMarkdown = (runs: Run[], note: (id: string) => string) => {
  const tokens: Token[] = []
  const stack: Array<{ mark: InlineMark; link?: string }> = []
  const has = (marks: Marks | undefined, mark: InlineMark) => Boolean(marks?.[mark])
  const close = (entry: { mark: InlineMark; link?: string }) => tokens.push({ kind: 'close', value: entry.mark === 'link' ? `](${entry.link})` : CLOSE[entry.mark] })
  for (const run of runs) {
    const marks = run.m
    // Close from the top of the stack down to the lowest mark that ends (or whose link changes).
    let lowest = stack.length
    stack.forEach((entry, index) => {
      const ends = !has(marks, entry.mark) || (entry.mark === 'link' && entry.link !== marks?.link)
      if (ends && index < lowest) lowest = index
    })
    const reopen: InlineMark[] = []
    while (stack.length > lowest) {
      const entry = stack.pop()!
      close(entry)
      if (has(marks, entry.mark) && !(entry.mark === 'link' && entry.link !== marks?.link)) reopen.unshift(entry.mark)
    }
    const open = new Set(stack.map((entry) => entry.mark))
    for (const mark of ORDER) {
      if (!has(marks, mark) || open.has(mark)) continue
      if (!run.text && !reopen.includes(mark)) continue
      stack.push(mark === 'link' ? { mark, link: marks!.link } : { mark })
      tokens.push({ kind: 'open', value: mark === 'link' ? '[' : OPEN[mark] })
    }
    if (run.text) tokens.push({ kind: 'text', value: escapeMarkdown(run.text).replace(/\n/gu, '\\\n') })
    if (marks?.fn) tokens.push({ kind: 'text', value: note(marks.fn) })
  }
  while (stack.length) close(stack.pop()!)
  // Move whitespace out of the delimiters: `* a*` is not emphasis, ` *a*` is.
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'text') continue
    let start = index
    while (start > 0 && tokens[start - 1].kind === 'open') start -= 1
    const leading = /^[ \t]+/u.exec(token.value)?.[0] ?? ''
    if (leading && start < index) {
      token.value = token.value.slice(leading.length)
      tokens.splice(start, 0, { kind: 'text', value: leading })
      index += 1
    }
    let end = index
    while (end + 1 < tokens.length && tokens[end + 1].kind === 'close') end += 1
    const trailing = /[ \t]+$/u.exec(token.value)?.[0] ?? ''
    if (trailing && end > index && token.value.length > trailing.length) {
      token.value = token.value.slice(0, -trailing.length)
      tokens.splice(end + 1, 0, { kind: 'text', value: trailing })
    }
  }
  // Drop empty pairs left by runs that were only whitespace.
  let out = tokens.map((token) => token.value).join('')
  out = out.replace(/\*\*\*\*|~~~~|<u><\/u>|<sup><\/sup>|<sub><\/sub>/gu, '')
  return out
}

const yaml = (value: string) => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`

const walk = (input: TextInput, emit: {
  heading: (text: string, level: number, block: FlowBlock | null) => void
  paragraph: (block: FlowBlock, index: number) => void
  sceneBreak: (block: FlowBlock) => void
  chapterEnd: (chapterIndex: number) => void
}) => {
  const { prepared } = input
  const base = prepared.hasParts ? 1 : 0
  const starts = input.sceneTitles ? sceneStarts(prepared) : new Map()
  let chapter = -1
  prepared.flow.forEach((block, index) => {
    const kind = titleKind(prepared, block)
    if (block.chapterStart && chapter >= 0) emit.chapterEnd(chapter)
    if (block.chapterStart) chapter += 1
    const scene = starts.get(index)
    if (scene?.title) emit.heading(scene.title, 2 + base, null)
    if (kind) {
      emit.heading(block.runs.map((run) => run.text).join('') || block.chapterTitle, kind === 'part' ? 1 : 1 + base, block)
      return
    }
    if (block.ref.kind === 'break') {
      if (!scene?.title) emit.sceneBreak(block)
      return
    }
    emit.paragraph(block, index)
  })
  if (chapter >= 0) emit.chapterEnd(chapter)
}

export const writeMarkdown = (input: TextInput): string => {
  const { prepared } = input
  const manifest = prepared.manifest
  const notes = input.notes ?? 'footnotes'
  const numbers = numberFootnotes(prepared.flow, notes === 'endnotes-chapter')
  const base = prepared.hasParts ? 1 : 0
  const out: string[] = ['---', `title: ${yaml(manifest.title)}`]
  if (manifest.subtitle) out.push(`subtitle: ${yaml(manifest.subtitle)}`)
  if (manifest.author) out.push(`author: ${yaml(manifest.author)}`)
  out.push(`lang: ${manifest.language}`, '---', '')
  // Labels are unique per chapter when numbering restarts there.
  let chapter = 0
  const label = (id: string) => (notes === 'endnotes-chapter' ? `${chapter}-${numbers.get(id) ?? id}` : numbers.get(id) ?? id)
  const pending: string[] = []
  const flushNotes = () => {
    if (!pending.length) return
    for (const id of pending) out.push(`[^${label(id)}]: ${runsToMarkdown((prepared.footnotes.get(id)?.runs ?? []).filter((run) => !run.m?.fn), () => '')}`, '')
    pending.length = 0
  }
  walk(input, {
    heading: (text, level, block) => {
      if (block?.chapterStart) chapter += 1
      out.push(`${'#'.repeat(Math.min(6, level))} ${escapeMarkdown(text)}`, '')
    },
    sceneBreak: () => out.push('* * *', ''),
    paragraph: (block) => {
      const style = manifest.styles[block.style]
      const text = runsToMarkdown(block.runs, (id) => {
        if (!prepared.footnotes.has(id)) return ''
        pending.push(id)
        return `[^${label(id)}]`
      })
      if (style?.outlineLevel && style.outlineLevel > 1) out.push(`${'#'.repeat(Math.min(6, style.outlineLevel + 1 + base + (input.sceneTitles ? 1 : 0)))} ${text}`, '')
      else if (style?.listMarker) out.push(`- ${text}`, '')
      else if (block.style === 'quote' || block.style === 'letter') out.push(text.split('\n').map((line) => `> ${line}`).join('\n'), '')
      else out.push(text, '')
    },
    chapterEnd: () => { if (notes === 'endnotes-chapter') flushNotes() },
  })
  flushNotes()
  while (out[out.length - 1] === '') out.pop()
  return `${out.join('\n')}\n`
}

export const writeText = (input: TextInput): string => {
  const { prepared } = input
  const manifest = prepared.manifest
  const notes = input.notes ?? 'footnotes'
  const numbers = numberFootnotes(prepared.flow, notes === 'endnotes-chapter')
  const out: string[] = [manifest.title]
  if (manifest.subtitle) out.push(manifest.subtitle)
  if (manifest.author) out.push(manifest.author)
  out.push('', '')
  const pending: string[] = []
  const plain = (runs: Run[]) => runs.map((run) => run.text + (run.m?.fn && prepared.footnotes.has(run.m.fn) ? (pending.push(run.m.fn), `[${numbers.get(run.m.fn)}]`) : '')).join('')
  const flushNotes = () => {
    if (!pending.length) return
    out.push(notesLabel(manifest.language), '')
    for (const id of pending) out.push(`[${numbers.get(id)}] ${(prepared.footnotes.get(id)?.runs ?? []).map((run) => run.text).join('')}`, '')
    out.push('')
    pending.length = 0
  }
  let first = true
  walk(input, {
    heading: (text, _level, block) => {
      if (block?.chapterStart && !first) out.push('')
      first = false
      out.push(text, '')
    },
    sceneBreak: () => out.push(manifest.page.sceneBreak || '* * *', ''),
    paragraph: (block) => {
      first = false
      const style = manifest.styles[block.style]
      out.push(`${style?.listMarker ? `${style.listMarker} ` : ''}${plain(block.runs)}`, '')
    },
    chapterEnd: () => { if (notes === 'endnotes-chapter') flushNotes() },
  })
  flushNotes()
  while (out[out.length - 1] === '') out.pop()
  return `${out.join('\n')}\n`
}
