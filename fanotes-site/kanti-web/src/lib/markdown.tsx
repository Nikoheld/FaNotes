// A small, safe Markdown renderer for notes. It builds React elements only: raw HTML in a note is shown as
// text, never interpreted, and nothing here can produce a script, an event handler or a javascript: link.
// Images and wiki links are resolved through callbacks, so the vault's files are fetched and decrypted by the page.
import { Fragment, type ReactNode } from 'react'

export interface MarkdownHooks {
  /** An image of the vault (path as written in the note) or null when it is not there. Rendered by the caller. */
  image: (src: string, alt: string) => ReactNode
  /** Opens another note by its link text or path. */
  openNote: (target: string) => void
  /** Whether a wiki link target exists (shown differently when not). */
  noteExists: (target: string) => boolean
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/iu

/** The text of the note without the front matter, HTML comments (the app's embedded data markers) and block comments. */
export const readableMarkdown = (source: string): string =>
  source.replace(/\r\n?/gu, '\n').replace(/^---\n[\s\S]*?\n---\n?/u, '').replace(/<!--[\s\S]*?-->/gu, '').replace(/%%[\s\S]*?%%/gu, '')

const safeDecode = (value: string) => { try { return decodeURI(value) } catch { return value } }

let keyCounter = 0
const key = () => { keyCounter += 1; return keyCounter }

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(<?([^)]+?)>?(?:\s+"[^"]*")?\)|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(<?([^)]+?)>?(?:\s+"[^"]*")?\)|(\*\*|__)(?=\S)([\s\S]*?\S)\9|(~~)(?=\S)([\s\S]*?\S)\11|(\*|_)(?=\S)([\s\S]*?\S)\13|(https?:\/\/[^\s<>)]+)/gu

export const renderInline = (text: string, hooks: MarkdownHooks): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    last = at + match[0].length
    const k = key()
    if (match[2] !== undefined) out.push(<code key={k}>{match[2]}</code>)
    else if (match[3] !== undefined) out.push(<Fragment key={k}>{hooks.image(match[3].split('|')[0].trim(), match[3])}</Fragment>)
    else if (match[5] !== undefined) out.push(<Fragment key={k}>{hooks.image(safeDecode(match[5]), match[4])}</Fragment>)
    else if (match[6] !== undefined) {
      const [target, label] = match[6].split('|')
      const clean = target.split('#')[0].trim()
      out.push(<a key={k} href="#" className={`wikilink${hooks.noteExists(clean) ? '' : ' missing'}`} onClick={(event) => { event.preventDefault(); hooks.openNote(clean) }}>{(label || target).trim()}</a>)
    } else if (match[7] !== undefined) {
      const href = match[8]
      out.push(SAFE_LINK.test(href)
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{renderInline(match[7], hooks)}</a>
        : <a key={k} href="#" className="wikilink" onClick={(event) => { event.preventDefault(); hooks.openNote(safeDecode(href).replace(/#.*$/u, '')) }}>{renderInline(match[7], hooks)}</a>)
    } else if (match[10] !== undefined) out.push(<strong key={k}>{renderInline(match[10], hooks)}</strong>)
    else if (match[12] !== undefined) out.push(<del key={k}>{renderInline(match[12], hooks)}</del>)
    else if (match[14] !== undefined) out.push(<em key={k}>{renderInline(match[14], hooks)}</em>)
    else if (match[15] !== undefined) out.push(<a key={k} href={match[15]} target="_blank" rel="noopener noreferrer">{match[15]}</a>)
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

interface ListItem { text: string; task: boolean | null; children: string[] }

const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u.test(line) && line.includes('-')
const splitRow = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())

/** Renders Markdown as React elements. */
export const renderMarkdown = (source: string, hooks: MarkdownHooks): ReactNode[] => {
  const lines = readableMarkdown(source).split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/u.exec(line)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { body.push(lines[i]); i += 1 }
      i += 1
      blocks.push(<pre key={key()}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line)
    if (heading) {
      const level = heading[1].length
      const Tag = `h${level}` as 'h1'
      blocks.push(<Tag key={key()}>{renderInline(heading[2], hooks)}</Tag>)
      i += 1
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) { blocks.push(<hr key={key()} />); i += 1; continue }
    if (/^\s*>/u.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/u.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/u, '')); i += 1 }
      blocks.push(<blockquote key={key()}>{renderMarkdown(body.join('\n'), hooks)}</blockquote>)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1 }
      blocks.push(
        <div className="md-table" key={key()}><table>
          <thead><tr>{head.map((cell, at) => <th key={at}>{renderInline(cell, hooks)}</th>)}</tr></thead>
          <tbody>{rows.map((row, at) => <tr key={at}>{head.map((_, column) => <td key={column}>{renderInline(row[column] || '', hooks)}</td>)}</tr>)}</tbody>
        </table></div>,
      )
      continue
    }
    const listStart = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line)
    if (listStart) {
      const ordered = /\d/u.test(listStart[2])
      const items: ListItem[] = []
      while (i < lines.length) {
        const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(lines[i])
        if (item && item[1].length <= listStart[1].length + 1) {
          const task = /^\[([ xX])\]\s+(.*)$/u.exec(item[3])
          items.push({ text: task ? task[2] : item[3], task: task ? task[1] !== ' ' : null, children: [] })
          i += 1
        } else if (item && items.length) { items[items.length - 1].children.push(lines[i].slice(Math.min(2, item[1].length))); i += 1 }
        else if (lines[i].trim() && /^\s{2,}/u.test(lines[i]) && items.length) { items[items.length - 1].text += ` ${lines[i].trim()}`; i += 1 }
        else break
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List key={key()}>{items.map((item, at) => (
          <li key={at} className={item.task === null ? undefined : 'md-task'}>
            {item.task === null ? null : <input type="checkbox" checked={item.task} readOnly disabled aria-label={item.task ? 'x' : ''} />}
            {renderInline(item.text, hooks)}
            {item.children.length ? renderMarkdown(item.children.join('\n'), hooks) : null}
          </li>
        ))}</List>,
      )
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s)/u.test(lines[i])) { paragraph.push(lines[i]); i += 1 }
    if (!paragraph.length) { paragraph.push(line); i += 1 }
    blocks.push(<p key={key()}>{paragraph.map((text, at) => <Fragment key={at}>{at ? <br /> : null}{renderInline(text.replace(/\s{2,}$/u, ''), hooks)}</Fragment>)}</p>)
  }
  return blocks
}

/** Plain text of a note for searching: no markers, no syntax characters. */
export const plainText = (source: string): string =>
  readableMarkdown(source).replace(/```[\s\S]*?```/gu, ' ').replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/[#>*_`~|[\]]/gu, ' ').replace(/\s+/gu, ' ').trim()
