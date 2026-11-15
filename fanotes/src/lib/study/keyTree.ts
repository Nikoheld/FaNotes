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

const MAX_ITEMS = 60
const MAX_FEATURES = 24
const MAX_NODES = 200

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
      text: asText(node.text, 300),
      branches: kind === 'leaf' ? [] : asArray(node.branches, 8).map((branch) => ({ label: asText(asRecord(branch).label, 80), to: asText(asRecord(branch).to, 40) })),
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
  const features = asArray(table.features, MAX_FEATURES).map((value) => asText(value, 80))
  const items = asArray(table.items, MAX_ITEMS).map((entry, index): KeyItem => {
    const item = asRecord(entry)
    const values = asArray(item.values, MAX_FEATURES).map((value) => asText(value, 200))
    while (values.length < features.length) values.push('')
    return { id: asText(item.id, 40) || `i${index + 1}`, name: asText(item.name, 120), values: values.slice(0, features.length) }
  })
  const hasTree = Object.keys(asRecord(source.tree)).length > 0
  return {
    v: 1,
    title: asText(source.title, 120),
    table: { features, items },
    tree: hasTree ? normaliseKeyTree(source.tree) : emptyKeyTree(),
    compareImage: asImage(source.compareImage),
    compareLabel: asText(source.compareLabel, 120),
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
    if (groups.size < 2 || groups.size > 4) continue
    const largest = Math.max(...[...groups.values()].map((group) => group.items.length))
    const score = largest * 10 + groups.size
    if (!best || score < best.score) {
      const ordered = [...groups.values()].sort((a, b) => (a.key === 'ja' ? -1 : b.key === 'ja' ? 1 : 0))
      best = { split: { feature, groups: ordered }, score }
    }
  }
  return best?.split ?? null
}

/** A starting key from the table: each question splits the remaining items by the most separating feature. */
export const skeletonFromTable = (table: KeyTable): KeyTree => {
  const nodes: KeyNode[] = []
  let counter = 0
  const next = () => `n${++counter}`
  const build = (items: readonly KeyItem[], features: readonly number[], depth: number): string => {
    const id = next()
    const split = items.length > 1 && depth < 12 ? bestSplit(items, features) : null
    if (!split) {
      const names = items.map((item) => item.name.trim() || '?').join(', ')
      nodes.push({ id, kind: 'leaf', text: names || '?', branches: [] })
      return id
    }
    const feature = table.features[split.feature]?.trim() || `Merkmal ${split.feature + 1}`
    const node: KeyNode = { id, kind: 'question', text: split.groups.length === 2 && split.groups[0].key === 'ja' ? `${feature}?` : feature, branches: [] }
    nodes.push(node)
    const remaining = features.filter((entry) => entry !== split.feature)
    for (const group of split.groups) node.branches.push({ label: group.label, to: build(group.items, remaining, depth + 1) })
    return id
  }
  const items = table.items.filter((item) => item.name.trim())
  if (!items.length) return emptyKeyTree()
  const root = build(items, table.features.map((_, index) => index), 0)
  return { root, nodes: nodes.slice(0, MAX_NODES) }
}

// -- layout --------------------------------------------------------------------

export type PlacedNode = { id: string; kind: 'question' | 'leaf'; lines: string[]; x: number; y: number; w: number; h: number }
export type PlacedEdge = { from: string; to: string; label: string; x1: number; y1: number; x2: number; y2: number }
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

const H_GAP = 18
const V_GAP = 54

/** Top-down tidy tree: each subtree owns a horizontal span, the parent centres above its children. */
export const layoutKeyTree = (tree: KeyTree): TreeLayout => {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]))
  const boxes = new Map(tree.nodes.map((node) => [node.id, measureBox(node.text || (node.kind === 'leaf' ? '?' : '…'))]))
  const span = new Map<string, number>()
  const measure = (id: string): number => {
    const node = byId.get(id)
    const box = boxes.get(id)
    if (!node || !box) return 0
    const kids = node.branches.map((branch) => branch.to).filter((to) => byId.has(to))
    const children = kids.reduce((sum, kid) => sum + measure(kid), 0) + Math.max(0, kids.length - 1) * H_GAP
    const own = Math.max(box.w, ...node.branches.map((branch) => branch.label.length * 5.6 + 8))
    const total = Math.max(own, children)
    span.set(id, total)
    return total
  }
  measure(tree.root)
  const placed: PlacedNode[] = []
  const edges: PlacedEdge[] = []
  const rowHeights: number[] = []
  const depthOf = new Map<string, number>()
  const assignDepth = (id: string, depth: number) => {
    depthOf.set(id, depth)
    const box = boxes.get(id)
    rowHeights[depth] = Math.max(rowHeights[depth] ?? 0, box?.h ?? 0)
    for (const branch of byId.get(id)?.branches ?? []) if (byId.has(branch.to)) assignDepth(branch.to, depth + 1)
  }
  if (byId.has(tree.root)) assignDepth(tree.root, 0)
  const rowTop: number[] = []
  let top = 8
  rowHeights.forEach((height, depth) => { rowTop[depth] = top; top += height + V_GAP })
  /** Places a subtree inside the span starting at `left` and returns the x of its centre. */
  const place = (id: string, left: number): number => {
    const node = byId.get(id)
    const box = boxes.get(id)
    if (!node || !box) return left
    const width = span.get(id) ?? box.w
    const kids = node.branches.filter((branch) => byId.has(branch.to))
    const childrenWidth = kids.reduce((sum, branch) => sum + (span.get(branch.to) ?? 0), 0) + Math.max(0, kids.length - 1) * H_GAP
    const depth = depthOf.get(id) ?? 0
    const y = rowTop[depth] ?? 8
    let cursor = left + (width - childrenWidth) / 2
    const centres: number[] = []
    for (const branch of kids) {
      centres.push(place(branch.to, cursor))
      cursor += (span.get(branch.to) ?? 0) + H_GAP
    }
    const wanted = centres.length ? (centres[0] + centres[centres.length - 1]) / 2 : left + width / 2
    const x = Math.round(Math.max(left, Math.min(left + width - box.w, wanted - box.w / 2)))
    const centre = x + box.w / 2
    placed.push({ id, kind: node.kind, lines: box.lines, x, y, w: box.w, h: box.h })
    kids.forEach((branch, index) => {
      edges.push({ from: id, to: branch.to, label: branch.label, x1: centre, y1: y + box.h, x2: centres[index], y2: rowTop[depth + 1] ?? y + V_GAP })
    })
    return centre
  }
  place(tree.root, 8)
  const width = (span.get(tree.root) ?? 0) + 16
  return { nodes: placed, edges, width: Math.max(width, 120), height: top - V_GAP + 8 }
}

// -- table helpers ---------------------------------------------------------------

const cell = (value: string) => value.replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ').trim()

export const keyTableToMarkdown = (table: KeyTable) => {
  const head = ['Art', ...table.features.map((feature, index) => feature || `Merkmal ${index + 1}`)]
  const rows = table.items.map((item) => [item.name, ...item.values])
  return [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
}

/** Spreadsheet/Markdown-table paste: tab or "|" separated rows, first row = features. */
export const parseTablePaste = (textValue: string): string[][] => {
  const rows = textValue.replace(/\r/gu, '').split('\n').map((row) => row.trim()).filter((row) => row && !/^\|?\s*:?-{2,}/u.test(row))
  return rows.map((row) => (row.includes('\t') ? row.split('\t') : row.startsWith('|') || row.includes(' | ') ? row.replace(/^\||\|$/gu, '').split('|') : row.split(/;/u)).map((value) => value.trim()))
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

/** Mutation helpers used by the editor (all return new objects). */
export const addChild = (tree: KeyTree, parentId: string, kind: 'question' | 'leaf', label: string): KeyTree => {
  const used = new Set(tree.nodes.map((node) => node.id))
  let index = tree.nodes.length + 1
  while (used.has(`n${index}`)) index += 1
  const id = `n${index}`
  return {
    root: tree.root,
    nodes: [
      ...tree.nodes.map((node) => (node.id === parentId && node.kind === 'question' ? { ...node, branches: [...node.branches, { label, to: id }] } : node)),
      { id, kind, text: '', branches: [] },
    ],
  }
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
