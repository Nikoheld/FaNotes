/** Comparison table and dichotomous key (Bestimmungsschluessel): model, skeleton, layout. */

import { asArray, asImage, asRecord, asText, newId, parseJsonObject } from './blocks'

export type KeyItem = { id: string; name: string; values: string[] }
export type KeyTable = { features: string[]; items: KeyItem[] }
export type KeyNode = { id: string; kind: 'question' | 'leaf'; text: string; branches: Array<{ label: string; to: string }> }
export type KeyTree = { root: string; nodes: KeyNode[] }
export type KeyData = {
  v: 1
  title: string
  table: KeyTable
  tree: KeyTree
  /** Another tree, e.g. a figure from the book, shown next to the key. */
  compareImage: string
  compareLabel: string
}

/** Caps of the model. The normaliser enforces them; the editor reads them to stop short of a cap instead of being cut. */
export const KEY_LIMITS = {
  items: 60, features: 24, nodes: 200, branches: 8,
  title: 120, featureName: 80, itemName: 120, cell: 200, nodeText: 300, branchLabel: 80, compareLabel: 120,
} as const

const MAX_ITEMS = KEY_LIMITS.items
const MAX_FEATURES = KEY_LIMITS.features
const MAX_NODES = KEY_LIMITS.nodes

export const emptyKeyTree = (): KeyTree => ({ root: 'n1', nodes: [{ id: 'n1', kind: 'question', text: 'Erste Frage?', branches: [{ label: 'ja', to: 'n2' }, { label: 'nein', to: 'n3' }] }, { id: 'n2', kind: 'leaf', text: 'Art A', branches: [] }, { id: 'n3', kind: 'leaf', text: 'Art B', branches: [] }] })

export const defaultKeyData = (): KeyData => ({
  v: 1,
  title: 'Vergleichstabelle',
  table: {
    features: ['Merkmal 1', 'Merkmal 2'],
    items: [
      { id: 'i1', name: 'Art A', values: ['ja', 'nein'] },
      { id: 'i2', name: 'Art B', values: ['nein', 'ja'] },
    ],
  },
  tree: emptyKeyTree(),
  compareImage: '',
  compareLabel: '',
})

/** Keeps only nodes reachable from the root, once each, with branches that point at real nodes. */
export const normaliseKeyTree = (raw: unknown): KeyTree => {
  const source = asRecord(raw)
  const byId = new Map<string, KeyNode>()
  for (const entry of asArray(source.nodes, MAX_NODES * 2)) {
    const node = asRecord(entry)
    const id = asText(node.id, 40)
    if (!id || byId.has(id)) continue
    const kind = node.kind === 'leaf' ? 'leaf' : 'question'
    byId.set(id, {
      id,
      kind,
      text: asText(node.text, KEY_LIMITS.nodeText),
      branches: kind === 'leaf' ? [] : asArray(node.branches, KEY_LIMITS.branches).map((branch) => ({ label: asText(asRecord(branch).label, KEY_LIMITS.branchLabel), to: asText(asRecord(branch).to, 40) })),
    })
  }
  const rootId = asText(source.root, 40)
  const root = byId.has(rootId) ? rootId : [...byId.keys()][0]
  if (!root) return emptyKeyTree()
  const seen = new Set<string>()
  const ordered: KeyNode[] = []
  const walk = (id: string) => {
    const node = byId.get(id)
    if (!node || seen.has(id) || ordered.length >= MAX_NODES) return
    seen.add(id)
    ordered.push(node)
    for (const branch of node.branches) walk(branch.to)
  }
  walk(root)
  const keep = new Set(ordered.map((node) => node.id))
  // A branch to an already used node would make a cycle or a shared leaf: drop it.
  const parents = new Map<string, number>()
  for (const node of ordered) {
    node.branches = node.branches.filter((branch) => {
      if (!keep.has(branch.to) || branch.to === root) return false
      const count = (parents.get(branch.to) ?? 0) + 1
      parents.set(branch.to, count)
      return count === 1
    })
  }
  return { root, nodes: ordered }
}

export const normaliseKeyData = (raw: unknown): KeyData => {
  const source = asRecord(raw)
  const table = asRecord(source.table)
  const features = asArray(table.features, MAX_FEATURES).map((value) => asText(value, KEY_LIMITS.featureName))
  const items = asArray(table.items, MAX_ITEMS).map((entry, index): KeyItem => {
    const item = asRecord(entry)
    const values = asArray(item.values, MAX_FEATURES).map((value) => asText(value, KEY_LIMITS.cell))
    while (values.length < features.length) values.push('')
    return { id: asText(item.id, 40) || `i${index + 1}`, name: asText(item.name, KEY_LIMITS.itemName), values: values.slice(0, features.length) }
  })
  const hasTree = Object.keys(asRecord(source.tree)).length > 0
  return {
    v: 1,
    title: asText(source.title, KEY_LIMITS.title),
    table: { features, items },
    tree: hasTree ? normaliseKeyTree(source.tree) : emptyKeyTree(),
    compareImage: asImage(source.compareImage),
    compareLabel: asText(source.compareLabel, KEY_LIMITS.compareLabel),
  }
}

export const parseKeyData = (body: string): KeyData => {
  const raw = parseJsonObject(body)
  return Object.keys(raw).length ? normaliseKeyData(raw) : defaultKeyData()
}

// -- skeleton from the table ---------------------------------------------------

const YES = new Set(['ja', 'j', 'yes', 'y', '+', 'x', '✓', '✔', 'vorhanden', 'true'])
const NO = new Set(['nein', 'n', 'no', '-', '–', '—', 'nicht vorhanden', 'fehlt', 'false', '0'])
const valueKey = (value: string) => {
  const key = value.trim().toLocaleLowerCase('de')
  return YES.has(key) ? 'ja' : NO.has(key) ? 'nein' : key
}

/** A split has at most this many branches; a feature with more distinct values (free text) cannot be a question. */
export const MAX_SPLIT = 4
const MAX_DEPTH = 12

type Split = { feature: number; groups: Array<{ key: string; label: string; items: KeyItem[] }> }

const bestSplit = (items: readonly KeyItem[], features: readonly number[]): Split | null => {
  let best: { split: Split; score: number } | null = null
  for (const feature of features) {
    const groups = new Map<string, { key: string; label: string; items: KeyItem[] }>()
    for (const item of items) {
      const label = (item.values[feature] ?? '').trim()
      const key = valueKey(label)
      const group = groups.get(key) ?? { key, label: key === 'ja' ? 'ja' : key === 'nein' ? 'nein' : label || '–', items: [] }
      group.items.push(item)
      groups.set(key, group)
    }
    if (groups.size < 2 || groups.size > MAX_SPLIT) continue
    const largest = Math.max(...[...groups.values()].map((group) => group.items.length))
    const score = largest * 10 + groups.size
    if (!best || score < best.score) {
      const ordered = [...groups.values()].sort((a, b) => (a.key === 'ja' ? -1 : b.key === 'ja' ? 1 : 0))
      best = { split: { feature, groups: ordered }, score }
    }
  }
  return best?.split ?? null
}

/** What the skeleton could not do with a table: features it had to skip, and items it could not tell apart. */
export type SkeletonReport = { tree: KeyTree; unusable: string[]; merged: string[][] }

/** A starting key from the table: each question splits the remaining items by the most separating feature. */
export const skeletonReport = (table: KeyTable): SkeletonReport => {
  const nodes: KeyNode[] = []
  const used = new Set<number>()
  const merged: string[][] = []
  let counter = 0
  const next = () => `n${++counter}`
  const build = (items: readonly KeyItem[], features: readonly number[], depth: number): string => {
    const id = next()
    const split = items.length > 1 && depth < MAX_DEPTH ? bestSplit(items, features) : null
    if (!split) {
      const names = items.map((item) => item.name.trim() || '?')
      if (names.length > 1) merged.push(names)
      nodes.push({ id, kind: 'leaf', text: names.join(', ') || '?', branches: [] })
      return id
    }
    used.add(split.feature)
    const feature = table.features[split.feature]?.trim() || `Merkmal ${split.feature + 1}`
    const node: KeyNode = { id, kind: 'question', text: split.groups.length === 2 && split.groups[0].key === 'ja' ? `${feature}?` : feature, branches: [] }
    nodes.push(node)
    const remaining = features.filter((entry) => entry !== split.feature)
    for (const group of split.groups) node.branches.push({ label: group.label, to: build(group.items, remaining, depth + 1) })
    return id
  }
  const items = table.items.filter((item) => item.name.trim())
  if (!items.length) return { tree: emptyKeyTree(), unusable: [], merged: [] }
  const root = build(items, table.features.map((_, index) => index), 0)
  const unusable = table.features
    .map((name, index) => ({ name: name.trim() || `Merkmal ${index + 1}`, index }))
    .filter(({ index }) => !used.has(index) && new Set(items.map((item) => valueKey(item.values[index] ?? ''))).size > MAX_SPLIT)
    .map(({ name }) => name)
  return { tree: { root, nodes: nodes.slice(0, MAX_NODES) }, unusable, merged }
}

export const skeletonFromTable = (table: KeyTable): KeyTree => skeletonReport(table).tree

// -- layout --------------------------------------------------------------------

export type PlacedNode = { id: string; kind: 'question' | 'leaf'; lines: string[]; x: number; y: number; w: number; h: number }
/** A branch label: wrapped text in a box that sits centred on the drop line of its child. */
export type PlacedLabel = { lines: string[]; x: number; y: number; w: number; h: number }
export type PlacedEdge = {
  from: string
  to: string
  label: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** Height of the horizontal run that joins the branches of one parent (the same for all of them). */
  busY: number
  /** Null for a branch without a label. */
  labelBox: PlacedLabel | null
}
export type TreeLayout = { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number }

const CHAR = 7.3
const LINE_H = 16
const PAD = 20

/** Breaks text into lines of at most `max` characters, splitting only at spaces and hyphens. */
export const wrapText = (value: string, max: number): string[] => {
  const words = value.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= max) line += ` ${word}`
    else { lines.push(line); line = word }
    while (line.length > max + 6) { lines.push(`${line.slice(0, max)}-`); line = line.slice(max) }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

export const measureBox = (text: string, max = 20) => {
  const lines = wrapText(text, max)
  const w = Math.max(56, Math.round(Math.max(...lines.map((line) => line.length)) * CHAR + PAD))
  return { lines, w, h: lines.length * LINE_H + 12 }
}

/** Branch labels: small text, wrapped to narrow lines, so a descriptive couplet text takes height, not width. */
export const LABEL_METRICS = { font: 11, lineHeight: 13, padX: 5, padY: 3, ascent: 10, wrap: 18 } as const

const WIDE_GLYPH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|\p{Extended_Pictographic}/u

/**
 * Width of a text in em, estimated per glyph class with DejaVu Sans, the widest common fallback for system-ui, as the
 * yardstick: text that fits that estimate also fits Segoe UI, Roboto or San Francisco. Capitals and wide glyphs
 * (CJK, emoji) count more than lower-case letters, so an all-caps label does not spill out of its box.
 */
export const estimateEm = (text: string) => {
  let em = 0
  for (const char of text) em += WIDE_GLYPH.test(char) ? 1.05 : /\d/u.test(char) ? 0.64 : char !== char.toLocaleLowerCase() ? 0.7 : 0.58
  return em
}

const measureLabel = (text: string) => {
  const lines = wrapText(text, LABEL_METRICS.wrap)
  const width = Math.ceil(Math.max(...lines.map((line) => estimateEm(line))) * LABEL_METRICS.font) + 2 * LABEL_METRICS.padX
  return { lines, w: width, h: lines.length * LABEL_METRICS.lineHeight + 2 * LABEL_METRICS.padY }
}

const H_GAP = 18
const V_GAP = 54
/** From the bottom of a row to the horizontal run, from the run to its labels, and the line that stays visible below a label. */
const BUS_DROP = 14
const LABEL_GAP = 4
const STEM_MIN = 8

type Item = {
  id: string
  node: KeyNode
  box: ReturnType<typeof measureBox>
  label: { text: string; lines: string[]; w: number; h: number } | null
  depth: number
  kids: Item[]
  /** Width the node must keep to itself: its box or its incoming label, whichever is wider. */
  own: number
  /** Width of the whole subtree, at least `own`. */
  span: number
}

/**
 * Top-down tidy tree: each subtree owns a horizontal span, the parent centres above its children.
 * A branch label hangs on the drop line of its child, so its width is reserved in the span of that child
 * (next to the child's own box); two labels, or a label and a box, can therefore never meet, however long
 * the descriptive text is. Rows grow in height where the labels need room.
 */
export const layoutKeyTree = (tree: KeyTree): TreeLayout => {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]))
  const used = new Set<string>()
  const rows: Item[][] = []
  const build = (id: string, depth: number, label: string): Item | null => {
    const node = byId.get(id)
    if (!node || used.has(id)) return null
    used.add(id)
    const box = measureBox(node.text || (node.kind === 'leaf' ? '?' : '…'))
    const text = label.trim()
    const block = text ? { text: label, ...measureLabel(text) } : null
    const item: Item = { id, node, box, label: block, depth, kids: [], own: Math.max(box.w, block?.w ?? 0), span: 0 }
    ;(rows[depth] ??= []).push(item)
    if (node.kind === 'question') {
      for (const branch of node.branches) {
        const kid = build(branch.to, depth + 1, branch.label)
        if (kid) item.kids.push(kid)
      }
    }
    item.span = Math.max(item.own, item.kids.reduce((sum, kid) => sum + kid.span, 0) + Math.max(0, item.kids.length - 1) * H_GAP)
    return item
  }
  const root = build(tree.root, 0, '')
  if (!root) return { nodes: [], edges: [], width: 120, height: 16 }

  const rowHeight = rows.map((row) => Math.max(...row.map((item) => item.box.h)))
  const labelHeight = rows.map((row) => Math.max(0, ...row.map((item) => item.label?.h ?? 0)))
  const rowTop: number[] = []
  let top = 8
  rows.forEach((_, depth) => {
    rowTop[depth] = top
    const below = labelHeight[depth + 1] ?? 0
    top += rowHeight[depth] + (below ? Math.max(V_GAP, BUS_DROP + LABEL_GAP + below + STEM_MIN) : V_GAP)
  })
  const last = rows.length - 1

  const nodes: PlacedNode[] = []
  const edges: PlacedEdge[] = []
  /** Places a subtree inside the span starting at `left` and returns the x of its centre. */
  const place = (item: Item, left: number): number => {
    const childrenWidth = item.kids.reduce((sum, kid) => sum + kid.span, 0) + Math.max(0, item.kids.length - 1) * H_GAP
    let cursor = left + (item.span - childrenWidth) / 2
    const centres = item.kids.map((kid) => {
      const centre = place(kid, cursor)
      cursor += kid.span + H_GAP
      return centre
    })
    const wanted = centres.length ? (centres[0] + centres[centres.length - 1]) / 2 : left + item.span / 2
    // The box and the label above it stay inside the span, so both are centred on the same line.
    const half = item.own / 2
    const x = Math.round(Math.max(left + half, Math.min(left + item.span - half, wanted)) - item.box.w / 2)
    const centre = x + item.box.w / 2
    const y = rowTop[item.depth]
    nodes.push({ id: item.id, kind: item.node.kind, lines: item.box.lines, x, y, w: item.box.w, h: item.box.h })
    const busY = y + rowHeight[item.depth] + BUS_DROP
    item.kids.forEach((kid, index) => {
      const block = kid.label
      edges.push({
        from: item.id,
        to: kid.id,
        label: block?.text ?? '',
        x1: centre,
        y1: y + item.box.h,
        x2: centres[index],
        y2: rowTop[kid.depth],
        busY,
        labelBox: block ? { lines: block.lines, x: Math.round(centres[index] - block.w / 2), y: busY + LABEL_GAP, w: block.w, h: block.h } : null,
      })
    })
    return centre
  }
  place(root, 8)
  return { nodes, edges, width: Math.max(root.span + 16, 120), height: rowTop[last] + rowHeight[last] + 8 }
}

// -- table helpers ---------------------------------------------------------------

const cell = (value: string) => value.replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ').trim()

export const keyTableToMarkdown = (table: KeyTable) => {
  const head = ['Art', ...table.features.map((feature, index) => feature || `Merkmal ${index + 1}`)]
  const rows = table.items.map((item) => [item.name, ...item.values])
  return [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
}

/** The key as numbered couplets: each question is numbered in reading order, each branch has a letter and says where it leads. */
export const keyToCoupletsMarkdown = (tree: KeyTree): string => {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]))
  const one = (value: string, fallback: string) => value.replace(/\s+/gu, ' ').trim() || fallback
  const questions: KeyNode[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    const node = byId.get(id)
    if (!node || seen.has(id)) return
    seen.add(id)
    if (node.kind !== 'question') return
    questions.push(node)
    for (const branch of node.branches) visit(branch.to)
  }
  visit(tree.root)
  if (!questions.length) return one(byId.get(tree.root)?.text ?? '', '?')
  const number = new Map(questions.map((node, index) => [node.id, index + 1]))
  const target = (id: string) => {
    const node = byId.get(id)
    return !node ? '?' : node.kind === 'question' ? String(number.get(id)) : one(node.text, '?')
  }
  return questions
    .flatMap((node, index) => [
      `${index + 1}. ${one(node.text, '…')}`,
      ...node.branches.map((branch, at) => `   - ${String.fromCharCode(97 + at)}) ${one(branch.label, '–')} → ${target(branch.to)}`),
    ])
    .join('\n')
}

/** Splits delimited text into rows of cells. A cell in double quotes may hold the delimiter, line breaks and "" for a quote. */
const splitDelimited = (text: string, delimiter: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let atStart = true
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') cell += char
      else if (text[index + 1] === '"') { cell += '"'; index += 1 } else quoted = false
    } else if (char === '"' && atStart) {
      quoted = true
      atStart = false
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
      atStart = true
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      atStart = true
    } else {
      cell += char
      atStart = false
    }
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/**
 * Spreadsheet or Markdown table paste: first row = features. Excel and Sheets copy tab separated cells (an empty top-left
 * cell stays empty, a cell with line breaks comes in quotes); "|" separates a Markdown table, ";" a CSV export.
 */
export const parseTablePaste = (textValue: string): string[][] => {
  const text = textValue.replace(/\r\n?/gu, '\n')
  let rows: string[][]
  if (text.includes('\t')) rows = splitDelimited(text, '\t')
  else if (/^\s*\|/mu.test(text) || text.includes(' | ')) {
    rows = text.split('\n')
      .filter((line) => line.trim() && !/^\s*\|?\s*:?-{2,}/u.test(line))
      .map((line) => line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).map((value) => value.replace(/\\\|/gu, '|')))
  } else rows = splitDelimited(text, ';')
  const grid = rows.map((row) => row.map((value) => value.trim())).filter((row) => row.some(Boolean))
  // Spreadsheets pad ranges with empty columns on the right.
  let width = Math.max(0, ...grid.map((row) => row.length))
  while (width > 1 && grid.every((row) => !row[width - 1])) width -= 1
  return grid.map((row) => row.slice(0, width))
}

export const tableFromGrid = (grid: readonly (readonly string[])[]): KeyTable => {
  if (!grid.length) return { features: [], items: [] }
  const header = grid[0]
  const features = header.slice(1, MAX_FEATURES + 1).map((value) => value.slice(0, 80))
  const items = grid.slice(1, MAX_ITEMS + 1).map((row, index): KeyItem => ({
    id: newId('i') + index,
    name: (row[0] ?? '').slice(0, 120),
    values: features.map((_, column) => (row[column + 1] ?? '').slice(0, 200)),
  }))
  return { features, items }
}

/** Mutation helpers used by the editor (all return new objects, and never a tree the normaliser would cut). */
export const nextNodeId = (tree: KeyTree): string => {
  const used = new Set(tree.nodes.map((node) => node.id))
  let index = tree.nodes.length + 1
  while (used.has(`n${index}`)) index += 1
  return `n${index}`
}

/** The question that has `id` as a branch. */
export const parentOf = (tree: KeyTree, id: string): KeyNode | undefined => tree.nodes.find((node) => node.branches.some((branch) => branch.to === id))

/** Ids of everything below `id`, not including it. */
export const descendantIds = (tree: KeyTree, id: string): string[] => {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]))
  const found: string[] = []
  const seen = new Set([id])
  const walk = (current: string) => {
    for (const branch of byId.get(current)?.branches ?? []) {
      if (seen.has(branch.to) || !byId.has(branch.to)) continue
      seen.add(branch.to)
      found.push(branch.to)
      walk(branch.to)
    }
  }
  walk(id)
  return found
}

/** A branch fits when the parent is a question with room and the key is below its node cap. */
export const canAddChild = (tree: KeyTree, parentId: string): boolean => {
  const parent = tree.nodes.find((node) => node.id === parentId)
  return parent?.kind === 'question' && parent.branches.length < KEY_LIMITS.branches && tree.nodes.length < KEY_LIMITS.nodes
}

/** Appends an empty node as a branch of `parentId` (right after the branch to `afterId`, if given). */
export const addChild = (tree: KeyTree, parentId: string, kind: 'question' | 'leaf', label: string, afterId?: string): KeyTree => {
  if (!canAddChild(tree, parentId)) return tree
  const id = nextNodeId(tree)
  return {
    root: tree.root,
    nodes: [
      ...tree.nodes.map((node) => {
        if (node.id !== parentId) return node
        const at = afterId ? node.branches.findIndex((branch) => branch.to === afterId) : -1
        const branch = { label, to: id }
        return { ...node, branches: at < 0 ? [...node.branches, branch] : [...node.branches.slice(0, at + 1), branch, ...node.branches.slice(at + 1)] }
      }),
      { id, kind, text: '', branches: [] },
    ],
  }
}

/** A new empty result next to `id` under the same question. The root has no sibling. */
export const addSibling = (tree: KeyTree, id: string): KeyTree => {
  const parent = parentOf(tree, id)
  return parent ? addChild(tree, parent.id, 'leaf', '', id) : tree
}

/**
 * Turns a node into a question or a result. A result has no branches, so everything below the node goes
 * with it: the tree stays what the normaliser would make of it and the block can be read back whole.
 */
export const setNodeKind = (tree: KeyTree, id: string, kind: 'question' | 'leaf'): KeyTree => {
  const node = tree.nodes.find((entry) => entry.id === id)
  if (!node || node.kind === kind) return tree
  if (kind === 'question') return { ...tree, nodes: tree.nodes.map((entry) => (entry.id === id ? { ...entry, kind } : entry)) }
  const doomed = new Set(descendantIds(tree, id))
  return normaliseKeyTree({
    root: tree.root,
    nodes: tree.nodes.filter((entry) => !doomed.has(entry.id)).map((entry) => (entry.id === id ? { ...entry, kind, branches: [] } : entry)),
  })
}

/** Moves a branch (label and subtree) one place up or down among its siblings. */
export const moveNode = (tree: KeyTree, id: string, delta: -1 | 1): KeyTree => {
  const parent = parentOf(tree, id)
  if (!parent) return tree
  const at = parent.branches.findIndex((branch) => branch.to === id)
  const target = at + delta
  if (at < 0 || target < 0 || target >= parent.branches.length) return tree
  const branches = [...parent.branches]
  ;[branches[at], branches[target]] = [branches[target], branches[at]]
  return { ...tree, nodes: tree.nodes.map((node) => (node.id === parent.id ? { ...node, branches } : node)) }
}

/** Puts a new, still empty question in place of `id`; the node moves below it, next to a new empty result. */
export const wrapInQuestion = (tree: KeyTree, id: string): KeyTree => {
  if (!tree.nodes.some((node) => node.id === id) || tree.nodes.length + 2 > KEY_LIMITS.nodes) return tree
  const questionId = nextNodeId(tree)
  const leafId = nextNodeId({ ...tree, nodes: [...tree.nodes, { id: questionId, kind: 'question', text: '', branches: [] }] })
  return normaliseKeyTree({
    root: id === tree.root ? questionId : tree.root,
    nodes: [
      ...tree.nodes.map((node) => ({ ...node, branches: node.branches.map((branch) => (branch.to === id ? { ...branch, to: questionId } : branch)) })),
      { id: questionId, kind: 'question', text: '', branches: [{ label: '', to: id }, { label: '', to: leafId }] },
      { id: leafId, kind: 'leaf', text: '', branches: [] },
    ],
  })
}

export const removeSubtree = (tree: KeyTree, id: string): KeyTree => {
  if (id === tree.root) return tree
  const doomed = new Set<string>()
  const walk = (current: string) => {
    if (doomed.has(current)) return
    doomed.add(current)
    for (const branch of tree.nodes.find((node) => node.id === current)?.branches ?? []) walk(branch.to)
  }
  walk(id)
  return normaliseKeyTree({
    root: tree.root,
    nodes: tree.nodes.filter((node) => !doomed.has(node.id)).map((node) => ({ ...node, branches: node.branches.filter((branch) => !doomed.has(branch.to)) })),
  })
}
