import { newTableText } from './markdownTable'
import type { MarkdownFormatAction } from '../components/MarkdownEditor'

/** Result of a formatting action on a plain text box: the new text and the selection to restore. */
export type TextFieldEdit = { text: string; start: number; end: number }

const stripBlockPrefix = (line: string) =>
  line.replace(/^(\s*)(?:#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u, '$1')

const wrap = (text: string, start: number, end: number, before: string, after: string, placeholder: string): TextFieldEdit => {
  const selected = text.slice(start, end) || placeholder
  const next = `${text.slice(0, start)}${before}${selected}${after}${text.slice(end)}`
  return { text: next, start: start + before.length, end: start + before.length + selected.length }
}

const mapLines = (text: string, start: number, end: number, fn: (line: string, index: number) => string): TextFieldEdit => {
  const from = text.lastIndexOf('\n', Math.max(0, start) - 1) + 1
  const lineEnd = text.indexOf('\n', end)
  const to = lineEnd === -1 ? text.length : lineEnd
  const block = text.slice(from, to).split('\n').map(fn).join('\n')
  return { text: `${text.slice(0, from)}${block}${text.slice(to)}`, start: from, end: from + block.length }
}

const template = (text: string, start: number, end: number, tpl: string, placeholder: string): TextFieldEdit => {
  const selected = text.slice(start, end) || placeholder
  const at = tpl.indexOf('{{selection}}')
  const insert = tpl.replace('{{selection}}', selected)
  return { text: `${text.slice(0, start)}${insert}${text.slice(end)}`, start: start + at, end: start + at + selected.length }
}

/** Applies a markdown toolbar action to the text of a placed text box (same actions as the note editor). */
export function formatTextFieldText(text: string, start: number, end: number, action: MarkdownFormatAction): TextFieldEdit {
  const prefixed = (prefix: (index: number) => string) => mapLines(text, start, end, (line, index) => `${prefix(index)}${stripBlockPrefix(line).trimStart()}`)
  const sized = /^table:(\d+)x(\d+)$/u.exec(action)
  if (sized) return template(text, start, end, `\n${newTableText(Number(sized[1]), Number(sized[2]), '{{selection}}')}\n`, 'Eintrag')
  switch (action) {
    case 'heading1': return prefixed(() => '# ')
    case 'heading2': return prefixed(() => '## ')
    case 'heading3': return prefixed(() => '### ')
    case 'heading4': return prefixed(() => '#### ')
    case 'heading5': return prefixed(() => '##### ')
    case 'heading6': return prefixed(() => '###### ')
    case 'quote': return prefixed(() => '> ')
    case 'bulletList': return prefixed(() => '- ')
    case 'numberedList': return prefixed((index) => `${index + 1}. `)
    case 'checklist': return prefixed(() => '- [ ] ')
    case 'bold': return wrap(text, start, end, '**', '**', 'fetter Text')
    case 'italic': return wrap(text, start, end, '*', '*', 'kursiver Text')
    case 'strike': return wrap(text, start, end, '~~', '~~', 'durchgestrichener Text')
    case 'subscript': return wrap(text, start, end, '<sub>', '</sub>', 'tiefgestellt')
    case 'superscript': return wrap(text, start, end, '<sup>', '</sup>', 'hochgestellt')
    case 'inlineCode':
      return text.slice(start, end).includes('\n')
        ? template(text, start, end, '\n```\n{{selection}}\n```\n', 'Code')
        : wrap(text, start, end, '`', '`', 'Code')
    case 'link': {
      const label = text.slice(start, end) || 'Linktext'
      const insert = `[${label}](https://)`
      const urlStart = start + label.length + 3
      return { text: `${text.slice(0, start)}${insert}${text.slice(end)}`, start: urlStart, end: urlStart + 8 }
    }
    case 'codeBlock': return template(text, start, end, '\n```\n{{selection}}\n```\n', 'Code')
    case 'table': return template(text, start, end, `\n${newTableText(3, 3, '{{selection}}')}\n`, 'Eintrag')
    case 'mathBlock': return template(text, start, end, '\n$$\n{{selection}}\n$$\n', 'f(x) = x^2')
    case 'details': return template(text, start, end, '\n<details>\n<summary>Titel</summary>\n\n{{selection}}\n\n</details>\n', 'Einklappbarer Inhalt')
    case 'horizontalRule': return template(text, start, end, '\n\n---\n\n{{selection}}', '')
    default: return { text, start, end }
  }
}
