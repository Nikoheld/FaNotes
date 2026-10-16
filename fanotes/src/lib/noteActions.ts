/**
 * Turning the line under the cursor into a task. Fenced code, tables, rules
 * and headings stay as they are; a heading gets the task on the next line.
 */

const CODE_FENCE = /^\s*(```+|~~~+)/u
const MATH_FENCE = /^\s*\$\$\s*$/u
const TABLE_ROW = /^\s*\|/u
const RULE = /^\s*([-*_])\1{2,}\s*$/u
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u
const QUOTE = /^(\s*>\s?)(.*)$/u
const TASK = /^(\s*)([-+*]|\d+[.)])(\s+)\[([ xX])\](.*)$/u
const LIST = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/u

export const isStructuralLine = (line: string) => (
  CODE_FENCE.test(line) || MATH_FENCE.test(line) || TABLE_ROW.test(line) || RULE.test(line) || HEADING.test(line)
)

/** True when a line sits inside a fenced code block or a $$ math block. */
export const lineInsideFence = (lines: readonly string[], index: number) => {
  let code = false
  let math = false
  const last = Math.min(index, lines.length)
  for (let i = 0; i < last; i += 1) {
    const line = lines[i]
    if (!math && CODE_FENCE.test(line)) code = !code
    else if (!code && MATH_FENCE.test(line)) math = !math
  }
  return code || math
}

/** A heading stays a heading. Ctrl+Enter inserts the task on the following line. */
export const taskAfterHeading = (line: string) => (HEADING.test(line) ? '- [ ] ' : null)

export const toggleTaskLine = (line: string): string => {
  const quote = QUOTE.exec(line)
  if (quote) {
    const inner = toggleTaskLine(quote[2])
    return inner === quote[2] ? line : `${quote[1]}${inner}`
  }
  if (isStructuralLine(line)) return line
  const task = TASK.exec(line)
  if (task) {
    const mark = task[4].toLowerCase() === 'x' ? ' ' : 'x'
    return `${task[1]}${task[2]}${task[3]}[${mark}]${task[5]}`
  }
  const list = LIST.exec(line)
  if (list) return `${list[1]}${list[2]}${list[3]}[ ] ${list[4]}`
  if (!line.trim()) return '- [ ] '
  return `- [ ] ${line}`
}

export type TaskLineChange = { line: number; insert: string }

/**
 * Replacements for the inclusive 1-based line range. Lines inside fences and
 * lines that would not change are omitted. A lone heading asks for a new
 * task line after itself (`insert` starts with a newline).
 */
export const taskToggleChanges = (
  lines: readonly string[],
  fromLine: number,
  toLine: number,
): TaskLineChange[] => {
  const start = Math.max(1, fromLine)
  const end = Math.min(lines.length, Math.max(start, toLine))
  if (start === end) {
    const heading = taskAfterHeading(lines[start - 1] ?? '')
    if (heading && !lineInsideFence(lines, start - 1)) return [{ line: start, insert: `\n${heading}` }]
  }
  const changes: TaskLineChange[] = []
  for (let line = start; line <= end; line += 1) {
    if (lineInsideFence(lines, line - 1)) continue
    const current = lines[line - 1] ?? ''
    const next = toggleTaskLine(current)
    if (next !== current) changes.push({ line, insert: next })
  }
  return changes
}
