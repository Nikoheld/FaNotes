/** Small line diff for the note version timeline. */

export type TimelineRow = { kind: 'same' | 'added' | 'removed'; text: string }

export const diffNoteLines = (before: string, after: string): TimelineRow[] => {
  const left = before.replace(/\r\n/gu, '\n').split('\n')
  const right = after.replace(/\r\n/gu, '\n').split('\n')
  const rows: TimelineRow[] = []
  const limit = 400
  const leftSlice = left.slice(0, limit)
  const rightSlice = right.slice(0, limit)
  const seen = new Map<string, number>()
  rightSlice.forEach((line, index) => {
    if (!seen.has(line)) seen.set(line, index)
  })
  const used = new Set<number>()
  for (const line of leftSlice) {
    const match = seen.get(line)
    if (match !== undefined && !used.has(match)) {
      used.add(match)
      rows.push({ kind: 'same', text: line })
    } else {
      rows.push({ kind: 'removed', text: line })
    }
  }
  rightSlice.forEach((line, index) => {
    if (!used.has(index)) rows.push({ kind: 'added', text: line })
  })
  return rows.filter((row) => row.kind !== 'same').slice(0, 80)
}

export const timelineHasInk = (content: string) => /fanotes-ink:|searchTranscript|"strokes"/u.test(content)
