// Markdown and plain-text import.
import type { Marks, Run } from '../model/types'
import { CHAPTER_HEADING, PART_HEADING, SCENE_BREAK, normalizeLanguage, type StoryBuilder } from './build'

/** UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252. */
export const decodeText = (bytes: Uint8Array) => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/u, '')
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

// ── Markdown inline ──────────────────────────────────────────────────────

type Flag = 'b' | 'i' | 's' | 'u' | 'sup' | 'sub'

/** Inline Markdown to runs: emphasis, strike, <u>/<sup>/<sub>, links, footnote references, escapes. */
export const parseInline = (source: string, footnote: (label: string) => string | null): Run[] => {
  const runs: Run[] = []
  const flags = new Set<Flag>()
  let link: string | null = null
  let text = ''
  const flush = () => {
    if (!text) return
    const marks: Marks = {}
    for (const flag of flags) marks[flag] = true
    if (link) marks.link = link
    runs.push(Object.keys(marks).length ? { text, m: marks } : { text })
    text = ''
  }
  // Delimiter runs that have a partner later on (so a lone '*' stays a character).
  const closes = (from: number, delimiter: string) => {
    const at = source.indexOf(delimiter, from)
    return at > from && !/\s/u.test(source[at - 1])
  }
  const linkEnds: number[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const rest = source.slice(index)
    if (char === '\\' && index + 1 < source.length) {
      if (source[index + 1] === '\n') { text += '\n'; index += 2; continue }
      if (/[\\`*_[\]<>~#+\-.!()|{}]/u.test(source[index + 1])) { text += source[index + 1]; index += 2; continue }
    }
    const note = /^\[\^([^\]\s]+)\]/u.exec(rest)
    if (note) {
      const id = footnote(note[1])
      if (id) {
        flush()
        runs.push({ text: '', m: { fn: id } })
        index += note[0].length
        continue
      }
    }
    const tag = /^<(\/?)(u|sup|sub|ins|s|del|b|strong|i|em)>/iu.exec(rest)
    if (tag) {
      flush()
      const name = tag[2].toLowerCase()
      const flag: Flag = name === 'ins' ? 'u' : name === 'del' ? 's' : name === 'strong' ? 'b' : name === 'em' ? 'i' : name as Flag
      if (tag[1]) flags.delete(flag)
      else flags.add(flag)
      index += tag[0].length
      continue
    }
    if (char === '[' && !link) {
      // [text](url): find the matching ']' and '('.
      let depth = 0
      let end = -1
      for (let at = index; at < source.length; at += 1) {
        if (source[at] === '\\') { at += 1; continue }
        if (source[at] === '[') depth += 1
        else if (source[at] === ']') { depth -= 1; if (depth === 0) { end = at; break } }
      }
      const target = end > 0 ? /^\(([^)\s]+)(?:\s+"[^"]*")?\)/u.exec(source.slice(end + 1)) : null
      if (target) {
        flush()
        link = /^(https?:|mailto:)/iu.test(target[1]) ? target[1] : null
        linkEnds.push(end)
        source = `${source.slice(0, end)}\u0000${source.slice(end + 1 + target[0].length)}`
        index += 1
        continue
      }
    }
    if (char === '\u0000') {
      flush()
      link = null
      index += 1
      continue
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1)
      if (end > index) { text += source.slice(index + 1, end); index = end + 1; continue }
    }
    const delimiter = /^(\*\*\*|___|\*\*|__|\*|_|~~)/u.exec(rest)?.[0]
    if (delimiter) {
      const kinds: Flag[] = delimiter.length === 3 ? ['b', 'i'] : delimiter === '~~' ? ['s'] : delimiter.length === 2 ? ['b'] : ['i']
      const before = source[index - 1] ?? ' '
      const after = source[index + delimiter.length] ?? ' '
      const open = kinds.every((kind) => !flags.has(kind))
      // '_' inside a word is a character, not emphasis.
      const intraword = delimiter[0] === '_' && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)
      if (!intraword && open && !/\s/u.test(after) && closes(index + delimiter.length, delimiter)) {
        flush()
        kinds.forEach((kind) => flags.add(kind))
        index += delimiter.length
        continue
      }
      if (!intraword && !open && !/\s/u.test(before)) {
        flush()
        kinds.forEach((kind) => flags.delete(kind))
        index += delimiter.length
        continue
      }
    }
    text += char
    index += 1
  }
  flush()
  void linkEnds
  return runs
}

// ── Markdown blocks ──────────────────────────────────────────────────────

export const importMarkdown = (source: string, builder: StoryBuilder) => {
  let text = source.replace(/\r\n?/gu, '\n')
  const front = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\n/u.exec(text)
  if (front) {
    for (const line of front[1].split('\n')) {
      const match = /^([a-z-]+):\s*(.*)$/iu.exec(line)
      if (!match) continue
      const value = match[2].trim().replace(/^"(.*)"$/u, '$1').replace(/^'(.*)'$/u, '$1').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\')
      const key = match[1].toLowerCase()
      if (key === 'title') builder.title = value
      else if (key === 'subtitle') builder.subtitle = value
      else if (key === 'author') builder.author = value
      else if (key === 'lang' || key === 'language') builder.language = normalizeLanguage(value)
    }
    text = text.slice(front[0].length)
  }
  // Footnote definitions (with indented continuation lines).
  const definitions = new Map<string, string>()
  const lines: string[] = []
  const all = text.split('\n')
  for (let index = 0; index < all.length; index += 1) {
    const match = /^\[\^([^\]\s]+)\]:\s?(.*)$/u.exec(all[index])
    if (!match) {
      lines.push(all[index])
      continue
    }
    let body = match[2]
    while (index + 1 < all.length && /^( {2,}|\t)\S/u.test(all[index + 1])) body += `\n${all[++index].trim()}`
    definitions.set(match[1], body)
  }
  const noteIds = new Map<string, string>()
  const footnote = (label: string) => {
    const body = definitions.get(label)
    if (body === undefined) return null
    let id = noteIds.get(label)
    if (!id) {
      id = builder.footnote(parseInline(body.replace(/\n/gu, ' '), () => null))
      noteIds.set(label, id)
    }
    return id
  }
  // Blocks.
  type Block = { kind: 'heading'; level: number; text: string } | { kind: 'break' } | { kind: 'para'; style: string; text: string }
  const blocks: Block[] = []
  let paragraph: string[] = []
  let quote = false
  const flush = () => {
    if (paragraph.length) {
      // A line ending in a backslash or two spaces is a hard line break.
      const joined = paragraph.map((line, index) => (index < paragraph.length - 1 ? (/\\$/u.test(line) ? `${line.slice(0, -1)}\\\n` : / {2,}$/u.test(line) ? `${line.trimEnd()}\\\n` : `${line} `) : line)).join('')
      blocks.push({ kind: 'para', style: quote ? 'quote' : 'body', text: joined.trim() })
    }
    paragraph = []
    quote = false
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line)
    if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue }
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/u.test(line) && !(paragraph.length && /^\s{0,3}-+\s*$/u.test(line))) { flush(); blocks.push({ kind: 'break' }); continue }
    if (paragraph.length && /^=+\s*$/u.test(line)) { const title = paragraph.join(' '); paragraph = []; blocks.push({ kind: 'heading', level: 1, text: title }); continue }
    if (paragraph.length && /^-+\s*$/u.test(line)) { const title = paragraph.join(' '); paragraph = []; blocks.push({ kind: 'heading', level: 2, text: title }); continue }
    if (!line.trim()) { flush(); continue }
    const list = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line)
    if (list) { flush(); blocks.push({ kind: 'para', style: 'list', text: list[1] }); continue }
    const quoted = /^\s{0,3}>\s?(.*)$/u.exec(line)
    if (quoted) {
      if (!quote) flush()
      quote = true
      paragraph.push(quoted[1])
      continue
    }
    if (quote) flush()
    if (line.trim() === '#' || SCENE_BREAK.test(line)) { flush(); blocks.push({ kind: 'break' }); continue }
    paragraph.push(line.replace(/^\s+/u, ''))
  }
  flush()
  // Heading levels: the top level holds chapters (or parts, or the book title).
  const levels = blocks.filter((block): block is Extract<Block, { kind: 'heading' }> => block.kind === 'heading')
  let top = Math.min(...levels.map((block) => block.level), 7)
  const topHeadings = levels.filter((block) => block.level === top)
  if (topHeadings.length === 1 && levels.length > 1 && blocks[0]?.kind === 'heading' && blocks[0].level === top && levels.some((block) => block.level > top)) {
    if (!builder.title) builder.title = topHeadings[0].text
    blocks.shift()
    top += 1
  }
  const deeper = levels.filter((block) => block.level > top)
  // Parts: top-level headings that each open straight into a deeper heading, or are named so.
  const opensDeeper = (block: Block) => {
    const next = blocks[blocks.indexOf(block) + 1]
    return next?.kind === 'heading' && next.level > top
  }
  const parts = topHeadings.length > 0 && deeper.length > 0 && topHeadings.every((block) => opensDeeper(block) || PART_HEADING.test(block.text))
  const chapterLevel = parts ? top + 1 : top
  for (const block of blocks) {
    if (block.kind === 'break') builder.sceneBreak()
    else if (block.kind === 'heading') {
      const title = parseInline(block.text, () => null).map((run) => run.text).join('')
      if (parts && block.level === top) builder.addPart(title)
      else if (block.level <= chapterLevel) builder.addChapter(title)
      else if (block.level === chapterLevel + 1) builder.addScene(title)
      else builder.paragraph({ style: block.level === chapterLevel + 2 ? 'heading' : 'subheading', runs: [{ text: title }] })
    } else builder.paragraph({ style: block.style, runs: parseInline(block.text, footnote) })
  }
}

// ── Plain text ───────────────────────────────────────────────────────────

export const importText = (source: string, builder: StoryBuilder) => {
  const text = source.replace(/\r\n?/gu, '\n').replace(/\f/gu, '\n\n')
  const rawBlocks = text.split(/\n[ \t]*\n+/u).map((block) => block.replace(/^\n+|\s+$/gu, '')).filter((block) => block.trim())
  const lines = text.split('\n').filter((line) => line.trim())
  // No blank lines: one paragraph per line.
  const blocks = rawBlocks.length <= 1 && lines.length > 1 ? lines : rawBlocks
  const isHeading = (block: string) => !block.includes('\n') && block.trim().length <= 80 && CHAPTER_HEADING.test(block.trim())
  let start = 0
  // A short first line before the first chapter heading is the title (and "von/by X" the author).
  if (blocks.length > 2 && !isHeading(blocks[0]) && !blocks[0].includes('\n') && blocks[0].length <= 100 && blocks.slice(1, 3).some(isHeading)) {
    builder.title = blocks[0].trim()
    start = 1
    const author = /^(?:von|by)\s+(.{2,80})$/iu.exec(blocks[1]?.trim() ?? '')
    if (author) {
      builder.author = author[1]
      start = 2
    }
  }
  for (const block of blocks.slice(start)) {
    const trimmed = block.trim()
    if (SCENE_BREAK.test(trimmed)) { builder.sceneBreak(); continue }
    if (isHeading(block)) {
      if (PART_HEADING.test(trimmed)) builder.addPart(trimmed)
      else builder.addChapter(trimmed)
      continue
    }
    const rows = block.split('\n')
    // Hard-wrapped prose (Project Gutenberg style) is joined; short lines (poems) keep their breaks.
    const wrapped = rows.length > 1 && rows.slice(0, -1).every((row) => row.trim().length >= 45 && row.length <= 100)
    const content = (wrapped ? rows.map((row) => row.trim()).join(' ') : rows.map((row) => row.trimEnd()).join('\n')).replace(/^[ \t]+/u, '')
    const list = /^[•\-–*]\s+(.*)$/su.exec(content)
    builder.paragraph(list ? { style: 'list', runs: [{ text: list[1] }] } : { style: 'body', runs: [{ text: content }] })
  }
}
