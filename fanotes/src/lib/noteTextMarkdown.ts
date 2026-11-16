import type { Root as MdRoot, Nodes as MdNodes, PhrasingContent } from 'mdast'

/**
 * Markdown for keyboard text boxes on notes and PDFs.
 *
 * A box keeps its raw Markdown in `NoteTextField.text`; it is rendered when
 * the box is not being edited. Text written before Markdown support must look
 * the same, so the dialect is a little stricter than plain GFM:
 * - a single line break stays a line break (as typed in the old textarea),
 * - indentation never turns a line into a code block,
 * - HTML is never interpreted; `<b>` stays the literal text `<b>`.
 */

type MicromarkData = { micromarkExtensions?: unknown[] }

/** remark plugin: no indented code blocks and no raw HTML in text boxes. */
export function remarkNoteTextDialect(this: unknown) {
  const data = (this as { data: () => MicromarkData }).data()
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  extensions.push({ disable: { null: ['codeIndented', 'htmlFlow', 'htmlText'] } })
}

const splitSoftBreaks = (node: MdNodes) => {
  if (!('children' in node)) return
  const next: MdNodes[] = []
  let changed = false
  for (const child of node.children as MdNodes[]) {
    if (child.type === 'text' && child.value.includes('\n')) {
      changed = true
      child.value.split(/\r?\n/u).forEach((part, index) => {
        if (index > 0) next.push({ type: 'break' })
        if (part) next.push({ type: 'text', value: part })
      })
      continue
    }
    splitSoftBreaks(child)
    next.push(child)
  }
  if (changed) (node as { children: PhrasingContent[] }).children = next as PhrasingContent[]
}

/** remark plugin: every typed line break is shown, like in the editor. */
export function remarkNoteTextSoftBreaks() {
  return (tree: MdRoot) => splitSoftBreaks(tree)
}

const TASK_MARKER = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/u

/**
 * Flip the task checkbox on a 1-based source line. Returns the text unchanged
 * when that line holds no task marker (e.g. the text changed meanwhile).
 */
export function toggleNoteTextTask(text: string, line: number): string {
  if (!Number.isSafeInteger(line) || line < 1) return text
  const lines = text.split('\n')
  const index = line - 1
  if (index >= lines.length) return text
  const source = lines[index]
  const match = TASK_MARKER.exec(source)
  if (!match) return text
  const mark = match[2] === ' ' ? 'x' : ' '
  lines[index] = `${match[1]}${mark}${match[3]}${source.slice(match[0].length)}`
  return lines.join('\n')
}

/** Only web and mail links leave the app; anything else stays inert. */
export function openableNoteTextLink(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null
  const value = href.trim()
  if (!/^(?:https?:\/\/|mailto:)/iu.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null
  } catch {
    return null
  }
}
