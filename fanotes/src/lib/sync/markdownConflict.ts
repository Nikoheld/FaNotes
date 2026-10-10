/** Line diff and resolution for a Markdown sync conflict. */

export type DiffRow = {
  kind: 'same' | 'added' | 'removed'
  text: string
}

const linesOf = (value: string) => value.replace(/\r\n/gu, '\n').split('\n')

const lcsTable = (left: string[], right: string[]) => {
  const rows = left.length + 1
  const columns = right.length + 1
  const table = Array.from({ length: rows }, () => new Uint16Array(columns))
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      table[row][column] = left[row - 1] === right[column - 1]
        ? table[row - 1][column - 1] + 1
        : Math.max(table[row - 1][column], table[row][column - 1])
    }
  }
  return table
}

/** Unified line diff. Long files fall back to a single replacement block. */
export const diffLines = (before: string, after: string): DiffRow[] => {
  const left = linesOf(before)
  const right = linesOf(after)
  if (left.length * right.length > 250_000) {
    return [
      ...left.map((text) => ({ kind: 'removed' as const, text })),
      ...right.map((text) => ({ kind: 'added' as const, text })),
    ]
  }
  const table = lcsTable(left, right)
  const rows: DiffRow[] = []
  let row = left.length
  let column = right.length
  while (row > 0 && column > 0) {
    if (left[row - 1] === right[column - 1]) {
      rows.push({ kind: 'same', text: left[row - 1] })
      row -= 1
      column -= 1
    } else if (table[row - 1][column] >= table[row][column - 1]) {
      rows.push({ kind: 'removed', text: left[row - 1] })
      row -= 1
    } else {
      rows.push({ kind: 'added', text: right[column - 1] })
      column -= 1
    }
  }
  while (row > 0) {
    rows.push({ kind: 'removed', text: left[row - 1] })
    row -= 1
  }
  while (column > 0) {
    rows.push({ kind: 'added', text: right[column - 1] })
    column -= 1
  }
  return rows.reverse()
}

export const isMarkdownConflictPath = (path: string) => /\.(md|markdown|famd)$/iu.test(path)

const paragraphs = (value: string) => value.replace(/\r\n/gu, '\n').split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean)

/**
 * Keep the server copy, then append local paragraphs that are not already in it.
 * Binary files are not merged; callers leave those as conflict copies.
 */
export const mergeMarkdownKeepingBoth = (remote: string, local: string) => {
  const remoteText = remote.replace(/\r\n/gu, '\n').trimEnd()
  const remoteParts = new Set(paragraphs(remoteText))
  const extras = paragraphs(local).filter((part) => !remoteParts.has(part))
  if (!extras.length) return remoteText ? `${remoteText}\n` : ''
  const divider = '\n\n'
  return `${remoteText}${remoteText ? divider : ''}${extras.join(divider)}\n`
}

export type ConflictChoice = 'remote' | 'local' | 'both'

export const resolveMarkdownConflict = (remote: string, local: string, choice: ConflictChoice) => {
  if (choice === 'remote') return remote.replace(/\r\n/gu, '\n')
  if (choice === 'local') return local.replace(/\r\n/gu, '\n')
  return mergeMarkdownKeepingBoth(remote, local)
}
