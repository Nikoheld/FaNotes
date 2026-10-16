const TASK_LINE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\](.*)$/u
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u
const STRUCTURAL_LINE = /^\s*(?:#{1,6}(?:\s|$)|>(?:\s|$)|[|]|```|~~~|-{3,}\s*$|_{3,}\s*$|\*{3,}\s*$)/u
const FENCE_LINE = /^\s*(?:```|~~~)/u

/**
 * Toggle a task, or turn a normal line into one. Headings, quotes, tables,
 * rules and fences stay as they are so a shortcut in those lines does nothing.
 */
export const toggleTaskLine = (line: string) => {
  const task = TASK_LINE.exec(line)
  if (task) {
    const mark = task[3] === ' ' ? 'x' : ' '
    return `${task[1]}${task[2]} [${mark}]${task[4]}`
  }
  if (STRUCTURAL_LINE.test(line)) return line
  const list = LIST_LINE.exec(line)
  if (list) return `${list[1]}${list[2]} [ ] ${list[3]}`
  if (!line.trim()) return `${line.match(/^\s*/u)?.[0] ?? ''}- [ ] `
  const indent = line.match(/^\s*/u)?.[0] ?? ''
  return `${indent}- [ ] ${line.slice(indent.length)}`
}

export const isFenceLine = (line: string) => FENCE_LINE.test(line)

export const fenceIsOpen = (linesBefore: readonly string[]) => {
  let open = false
  for (const line of linesBefore) if (isFenceLine(line)) open = !open
  return open
}
