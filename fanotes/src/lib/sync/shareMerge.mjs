// Merge for an editable share. Copy and live shares never call this.
// A line one person changed is kept. When both change the same line, both
// copies stay, so neither edit is dropped. Ink and text fields follow the
// same rule: an untouched side keeps the base, and additions from either side stay.

const linesOf = (value) => String(value ?? '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n')

const lcsTable = (left, right) => {
  if (left.length * right.length > 250_000) return null
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

const alignment = (before, after) => {
  const table = lcsTable(before, after)
  if (!table) return null
  const pairs = []
  let row = before.length
  let column = after.length
  while (row > 0 && column > 0) {
    if (before[row - 1] === after[column - 1]) {
      pairs.push([row - 1, column - 1])
      row -= 1
      column -= 1
    } else if (table[row - 1][column] >= table[row][column - 1]) {
      row -= 1
    } else {
      column -= 1
    }
  }
  pairs.reverse()
  return pairs
}

const hunksOf = (baseLines, editLines) => {
  const pairs = alignment(baseLines, editLines)
  if (!pairs) return null
  const anchors = [[-1, -1], ...pairs, [baseLines.length, editLines.length]]
  const hunks = []
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const baseStart = anchors[index][0] + 1
    const editStart = anchors[index][1] + 1
    const baseEnd = anchors[index + 1][0]
    const editEnd = anchors[index + 1][1]
    const baseSlice = baseLines.slice(baseStart, baseEnd)
    const editSlice = editLines.slice(editStart, editEnd)
    if (baseSlice.join('\n') !== editSlice.join('\n')) {
      hunks.push({ baseStart, baseEnd, lines: editSlice })
    }
  }
  return hunks
}

const applyHunks = (baseLines, leftHunks, rightHunks) => {
  const events = [
    ...leftHunks.map((hunk) => ({ ...hunk, side: 'left' })),
    ...rightHunks.map((hunk) => ({ ...hunk, side: 'right' })),
  ].sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd)
  const out = []
  let cursor = 0
  let index = 0
  while (index < events.length) {
    const start = events[index].baseStart
    let end = events[index].baseEnd
    const group = [events[index]]
    index += 1
    while (index < events.length && (events[index].baseStart < end || (events[index].baseStart === start && start === end))) {
      end = Math.max(end, events[index].baseEnd)
      group.push(events[index])
      index += 1
    }
    out.push(...baseLines.slice(cursor, start))
    const leftLines = group.filter((hunk) => hunk.side === 'left').flatMap((hunk) => hunk.lines)
    const rightLines = group.filter((hunk) => hunk.side === 'right').flatMap((hunk) => hunk.lines)
    const leftOnly = group.every((hunk) => hunk.side === 'left')
    const rightOnly = group.every((hunk) => hunk.side === 'right')
    if (leftOnly) out.push(...leftLines)
    else if (rightOnly) out.push(...rightLines)
    else if (leftLines.join('\n') === rightLines.join('\n')) out.push(...leftLines)
    else {
      out.push(...leftLines)
      for (const line of rightLines) {
        if (!leftLines.includes(line)) out.push(line)
      }
    }
    cursor = end
  }
  out.push(...baseLines.slice(cursor))
  return out.join('\n')
}

/** Three-way line merge. `current` is the server copy, `incoming` is the other writer. */
export const mergeShareText = (base, current, incoming) => {
  const baseText = String(base ?? '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  const currentText = String(current ?? '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  const incomingText = String(incoming ?? '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  if (incomingText === currentText || incomingText === baseText) return currentText
  if (currentText === baseText) return incomingText
  const baseLines = linesOf(baseText)
  const currentHunks = hunksOf(baseLines, linesOf(currentText))
  const incomingHunks = hunksOf(baseLines, linesOf(incomingText))
  if (!currentHunks || !incomingHunks) return `${currentText}\n${incomingText}`
  return applyHunks(baseLines, currentHunks, incomingHunks)
}

const strokeKey = (stroke) => JSON.stringify([
  stroke?.color ?? '',
  stroke?.width ?? 0,
  stroke?.opacity ?? 1,
  Array.isArray(stroke?.points) ? stroke.points.map((point) => [point?.x, point?.y]) : [],
])

const mergeStrokes = (base, current, incoming) => {
  const baseKeys = new Set((base || []).map(strokeKey))
  const currentKeys = new Set((current || []).map(strokeKey))
  const seen = new Set()
  const result = []
  for (const stroke of [...(current || []), ...(incoming || [])]) {
    const key = strokeKey(stroke)
    if (seen.has(key)) continue
    seen.add(key)
    const inCurrent = currentKeys.has(key)
    const inIncoming = (incoming || []).some((item) => strokeKey(item) === key)
    if (inCurrent && inIncoming) {
      result.push(stroke)
      continue
    }
    if (!baseKeys.has(key)) {
      result.push(stroke)
      continue
    }
    // Present on the base and only one side: the other side deleted it.
  }
  return result
}

const fieldKey = (field) => [
  field?.page ?? 1,
  Math.round((Number(field?.x) || 0) * 1000),
  Math.round((Number(field?.y) || 0) * 1000),
].join(':')

const mergeFields = (base, current, incoming) => {
  const lists = [base || [], current || [], incoming || []]
  const keys = []
  for (const list of lists) {
    for (const field of list) {
      const key = fieldKey(field)
      if (!keys.includes(key)) keys.push(key)
    }
  }
  const find = (list, key) => (list || []).find((field) => fieldKey(field) === key)
  const result = []
  for (const key of keys) {
    const baseField = find(base, key)
    const currentField = find(current, key)
    const incomingField = find(incoming, key)
    if (!currentField && !incomingField) continue
    if (currentField && !incomingField) {
      if (!baseField || JSON.stringify(currentField) !== JSON.stringify(baseField)) result.push(currentField)
      continue
    }
    if (incomingField && !currentField) {
      if (!baseField || JSON.stringify(incomingField) !== JSON.stringify(baseField)) result.push(incomingField)
      continue
    }
    result.push({
      ...currentField,
      text: mergeShareText(baseField?.text ?? '', currentField.text ?? '', incomingField.text ?? ''),
    })
  }
  return result
}

const sectionKey = (section) => String(section?.id || '')

const mergeSections = (base, current, incoming) => {
  const lists = [base || [], current || [], incoming || []]
  const keys = []
  for (const list of lists) {
    for (const section of list) {
      const key = sectionKey(section)
      if (key && !keys.includes(key)) keys.push(key)
    }
  }
  const find = (list, key) => (list || []).find((section) => sectionKey(section) === key)
  const result = []
  for (const key of keys) {
    const baseSection = find(base, key)
    const currentSection = find(current, key)
    const incomingSection = find(incoming, key)
    if (!currentSection && !incomingSection) continue
    if (currentSection && !incomingSection) {
      result.push(currentSection)
      continue
    }
    if (incomingSection && !currentSection) {
      result.push(incomingSection)
      continue
    }
    const currentJson = JSON.stringify(currentSection)
    const incomingJson = JSON.stringify(incomingSection)
    const baseJson = JSON.stringify(baseSection ?? null)
    if (incomingJson === baseJson) result.push(currentSection)
    else if (currentJson === baseJson) result.push(incomingSection)
    else {
      result.push({
        ...incomingSection,
        ...currentSection,
        title: mergeShareText(baseSection?.title ?? '', currentSection.title ?? '', incomingSection.title ?? ''),
      })
    }
  }
  return result
}

const mergeInk = (base, current, incoming) => {
  const strokes = mergeStrokes(base?.strokes, current?.strokes, incoming?.strokes)
  const sections = mergeSections(base?.sections, current?.sections, incoming?.sections)
  if (!strokes.length && !sections.length) return undefined
  const width = current?.width || incoming?.width || base?.width || 900
  const height = current?.height || incoming?.height || base?.height || 1273
  return {
    width,
    height,
    strokes,
    ...(sections.length ? { sections } : {}),
  }
}

const byPath = (notes, path) => (Array.isArray(notes) ? notes.find((note) => note && note.path === path) : undefined)

const noteOrBase = (note, base, path) => note || base || { path, title: '', content: '' }

/** Merge every note on the share. A missing note on one side means that side did not change it. */
export const mergeShareNotes = (base, current, incoming) => {
  const paths = []
  for (const list of [base, current, incoming]) {
    if (!Array.isArray(list)) continue
    for (const note of list) {
      if (note && typeof note.path === 'string' && !paths.includes(note.path)) paths.push(note.path)
    }
  }
  paths.sort((left, right) => left.localeCompare(right, 'de'))
  return paths.map((path) => {
    const baseNote = byPath(base, path)
    const currentNote = noteOrBase(byPath(current, path), baseNote, path)
    const incomingNote = noteOrBase(byPath(incoming, path), baseNote, path)
    const ink = mergeInk(baseNote?.ink, currentNote.ink, incomingNote.ink)
    const textFields = mergeFields(baseNote?.textFields, currentNote.textFields, incomingNote.textFields)
    const textColumn = currentNote.textColumn || incomingNote.textColumn || baseNote?.textColumn
    return {
      path,
      title: mergeShareText(baseNote?.title ?? '', currentNote.title ?? '', incomingNote.title ?? ''),
      content: mergeShareText(baseNote?.content ?? '', currentNote.content ?? '', incomingNote.content ?? ''),
      ...(ink ? { ink } : {}),
      ...(textFields.length ? { textFields } : {}),
      ...(textColumn ? { textColumn } : {}),
    }
  })
}

export const sanitizeSharePersonName = (value) => {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80)
}
