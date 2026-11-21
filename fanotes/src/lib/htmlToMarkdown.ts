/**
 * Converts clipboard HTML (Word, LibreOffice, web pages) into Markdown: bold, italic, strike,
 * links, lists, headings, code, quotes and rules. Scripts, styles and event handlers never
 * reach the output because only text and a fixed set of elements are read.
 */
import { htmlTableToMarkdown } from './markdownTableDom'

const SKIPPED = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas', 'o:p', 'xml'])
const STRUCTURAL = /<(?:b|strong|i|em|s|del|strike|u|a|code|kbd|pre|ul|ol|li|h[1-6]|blockquote|hr)[\s>/]|font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic|line-through|mso-list/iu

const escapeText = (text: string) => text
  .replace(/\\/gu, '\\\\')
  .replace(/([*`[\]])/gu, '\\$1')
  .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
  .replace(/~~/gu, '\\~\\~')

const safeHref = (href: string) => (/^(?:https?:|mailto:)/iu.test(href.trim()) ? href.trim().replace(/ /gu, '%20').replace(/\)/gu, '%29').replace(/\(/gu, '%28') : '')

const WORD_ITEM = '\u0001'
type Ctx = { listDepth: number }

const styleOf = (element: Element) => element.getAttribute('style') ?? ''

function inline(node: Node, inHeading: boolean): string {
  if (node.nodeType === 3) return escapeText((node.textContent ?? '').replace(/[\s ]+/gu, ' '))
  if (node.nodeType !== 1) return ''
  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (SKIPPED.has(tag)) return ''
  if (/mso-list\s*:\s*ignore/iu.test(styleOf(element))) return ''
  if (tag === 'br') return '  \n'
  if (tag === 'img') return ''
  if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') {
    const text = (element.textContent ?? '').replace(/\s+/gu, ' ')
    if (!text.trim()) return text
    const fence = text.includes('`') ? '``' : '`'
    return `${fence}${fence === '``' ? ` ${text.trim()} ` : text.trim()}${fence}`
  }
  const inner = Array.from(element.childNodes).map((child) => inline(child, inHeading)).join('')
  if (!inner.trim()) return inner
  const style = styleOf(element)
  const normalWeight = /font-weight\s*:\s*(?:normal|[1-4]00)/iu.test(style)
  const bold = !inHeading && !normalWeight && (tag === 'b' || tag === 'strong' || /font-weight\s*:\s*(?:bold|[6-9]00)/iu.test(style))
  const italic = tag === 'i' || tag === 'em' || tag === 'cite' || /font-style\s*:\s*italic/iu.test(style)
  const strike = tag === 's' || tag === 'del' || tag === 'strike' || /line-through/iu.test(style)
  const pad = /^(\s*)([\s\S]*?)(\s*)$/u.exec(inner)!
  let out = pad[2]
  if (tag === 'a') {
    const href = safeHref(element.getAttribute('href') ?? '')
    if (href) out = `[${out}](${href})`
  }
  if (strike) out = `~~${out}~~`
  if (italic) out = `*${out}*`
  if (bold) out = `**${out}**`
  return `${pad[1]}${out}${pad[3]}`
}

const inlineChildren = (element: Element, inHeading = false) => Array.from(element.childNodes).map((child) => inline(child, inHeading)).join('')
  .replace(/ *\n */gu, '\n').replace(/[ \t]{2,}(?!\n)/gu, ' ').replace(/^\s+|\s+$/gu, '')

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'address', 'center', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'fieldset'])
const isBlock = (node: Node) => node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName.toLowerCase())

const indentBlock = (text: string, first: string, rest: string) => text.split('\n').map((line, index) => (index === 0 ? `${first}${line}` : (line ? `${rest}${line}` : ''))).join('\n')

function listItems(list: Element, ctx: Ctx): string[] {
  const ordered = list.tagName.toLowerCase() === 'ol'
  let number = Number(list.getAttribute('start')) || 1
  const lines: string[] = []
  for (const child of Array.from(list.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue
    const marker = ordered ? `${number}. ` : '- '
    number += 1
    const body = blocks(child, { listDepth: ctx.listDepth + 1 }).join('\n')
    lines.push(indentBlock(body || '', marker, ' '.repeat(marker.length)).replace(/\s+$/u, ''))
  }
  return lines
}

/** Word writes list entries as paragraphs tagged `mso-list`; the bullet text is wrapped in an "Ignore" span. */
function wordListEntry(element: Element) {
  const match = /mso-list\s*:\s*[^;"']*?level(\d+)/iu.exec(styleOf(element))
  if (!match) return null
  const marker = (element.querySelector('[style*="mso-list:Ignore" i], [style*="mso-list: Ignore" i]')?.textContent ?? '').trim()
  return { level: Math.min(6, Number(match[1]) || 1), ordered: /^[0-9a-z]+[.)]$/iu.test(marker) && !/^[·•o§]$/u.test(marker) }
}

function blocks(parent: Element, ctx: Ctx): string[] {
  const out: string[] = []
  let run: Node[] = []
  const flush = () => {
    if (!run.length) return
    const holder = parent.ownerDocument.createElement('span')
    holder.append(...run.map((node) => node.cloneNode(true)))
    const text = inlineChildren(holder)
    if (text) out.push(text)
    run = []
  }
  for (const node of Array.from(parent.childNodes)) {
    if (!isBlock(node)) { run.push(node); continue }
    flush()
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (/^h[1-6]$/u.test(tag)) {
      const text = inlineChildren(element, true).replace(/\s*\n\s*/gu, ' ')
      if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
    } else if (tag === 'ul' || tag === 'ol') {
      const items = listItems(element, ctx)
      if (items.length) out.push(items.join('\n'))
    } else if (tag === 'li') {
      const inner = blocks(element, ctx).join('\n\n')
      if (inner) out.push(`- ${inner}`)
    } else if (tag === 'blockquote') {
      const inner = blocks(element, ctx).join('\n\n')
      if (inner) out.push(inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'))
    } else if (tag === 'pre') {
      const text = (element.textContent ?? '').replace(/\r\n?/gu, '\n').replace(/^\n+|\s+$/gu, '')
      if (text) out.push(`\`\`\`\n${text}\n\`\`\``)
    } else if (tag === 'hr') {
      out.push('---')
    } else if (tag === 'table') {
      const markdown = htmlTableToMarkdown(element.outerHTML)
      const text = markdown ?? inlineChildren(element)
      if (text) out.push(text)
    } else {
      const entry = tag === 'p' ? wordListEntry(element) : null
      if (entry) {
        const text = inlineChildren(element).replace(/\s*\n\s*/gu, ' ')
        if (text) out.push(`${WORD_ITEM}${'  '.repeat(entry.level - 1)}${entry.ordered ? '1.' : '-'} ${text}`)
      } else if (Array.from(element.childNodes).some(isBlock)) {
        out.push(...blocks(element, ctx))
      } else {
        const text = inlineChildren(element)
        if (text) out.push(text)
      }
    }
  }
  flush()
  // Consecutive Word list paragraphs (marked with WORD_ITEM) belong to one list: no blank line between them.
  return out.reduce<string[]>((merged, block) => {
    const last = merged[merged.length - 1]
    if (block.startsWith(WORD_ITEM) && last?.startsWith(WORD_ITEM)) merged[merged.length - 1] = `${last}\n${block.slice(1)}`
    else merged.push(block)
    return merged
  }, [])
}

/**
 * Markdown for rich clipboard HTML, or null when the HTML carries no formatting worth converting
 * (then the plain-text flavour is pasted as before).
 */
export function htmlToMarkdown(html: string): string | null {
  if (!html || !STRUCTURAL.test(html)) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc.body) return null
  const text = blocks(doc.body, { listDepth: 0 }).map((block) => block.replaceAll(WORD_ITEM, '')).join('\n\n').replace(/\n{3,}/gu, '\n\n').trim()
  if (!text) return null
  return text
}
