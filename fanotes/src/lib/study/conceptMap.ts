/** Concept map (cause and effect): boxes and labelled arrows with an automatic layered layout. */

import { asArray, asRecord, asText, newId, parseJsonObject } from './blocks'
import { measureBox } from './keyTree'

export type MapNode = { id: string; text: string }
export type MapEdge = { id: string; from: string; to: string; label: string }
export type MapData = { v: 1; title: string; dir: 'TB' | 'LR'; nodes: MapNode[]; edges: MapEdge[] }

/** Caps of the model. The normaliser enforces them; the editor reads them to stop short of a cap instead of being cut. */
export const MAP_LIMITS = { nodes: 80, edges: 160, title: 120, nodeText: 200, edgeLabel: 80 } as const

const MAX_NODES = MAP_LIMITS.nodes
const MAX_EDGES = MAP_LIMITS.edges

export const defaultMapData = (): MapData => ({
  v: 1,
  title: 'Begriffsnetz',
  dir: 'TB',
  nodes: [{ id: 'a', text: 'Ursache' }, { id: 'b', text: 'Wirkung' }],
  edges: [{ id: 'e1', from: 'a', to: 'b', label: 'führt zu' }],
})

/** Two arrows between the same boxes with the same text are one arrow. */
const edgeKey = (edge: Pick<MapEdge, 'from' | 'to' | 'label'>) => `${edge.from}>${edge.to}>${edge.label}`

export const normaliseMapData = (raw: unknown): MapData => {
  const source = asRecord(raw)
  const ids = new Set<string>()
  const nodes: MapNode[] = []
  for (const entry of asArray(source.nodes, MAX_NODES)) {
    const node = asRecord(entry)
    const id = asText(node.id, 40)
    if (!id || ids.has(id)) continue
    ids.add(id)
    nodes.push({ id, text: asText(node.text, MAP_LIMITS.nodeText) })
  }
  const seen = new Set<string>()
  const edges: MapEdge[] = []
  for (const entry of asArray(source.edges, MAX_EDGES)) {
    const edge = asRecord(entry)
    const from = asText(edge.from, 40)
    const to = asText(edge.to, 40)
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    const key = edgeKey({ from, to, label: asText(edge.label, MAP_LIMITS.edgeLabel) })
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ id: asText(edge.id, 40) || newId('e'), from, to, label: asText(edge.label, MAP_LIMITS.edgeLabel) })
  }
  return { v: 1, title: asText(source.title, MAP_LIMITS.title), dir: source.dir === 'LR' ? 'LR' : 'TB', nodes, edges }
}

export const parseMapData = (body: string): MapData => {
  const raw = parseJsonObject(body)
  return Object.keys(raw).length ? normaliseMapData(raw) : defaultMapData()
}

export type PlacedMapNode = { id: string; lines: string[]; x: number; y: number; w: number; h: number }
export type PlacedMapEdge = { id: string; from: string; to: string; label: string; path: string; lx: number; ly: number }
export type MapLayout = { nodes: PlacedMapNode[]; edges: PlacedMapEdge[]; width: number; height: number; layers: string[][] }

/** Layers by longest path after removing back edges (cycles), ordered by barycentre sweeps. */
export const layerMap = (data: MapData): string[][] => {
  const ids = data.nodes.map((node) => node.id)
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const edge of data.edges) out.get(edge.from)?.push(edge.to)
  const state = new Map<string, 0 | 1 | 2>()
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]))
  const visit = (id: string) => {
    state.set(id, 1)
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) continue
      forward.get(id)?.push(to)
      if (!state.get(to)) visit(to)
    }
    state.set(id, 2)
  }
  const incoming = new Set(data.edges.map((edge) => edge.to))
  for (const id of ids.filter((entry) => !incoming.has(entry))) if (!state.get(id)) visit(id)
  for (const id of ids) if (!state.get(id)) visit(id)
  const depth = new Map<string, number>(ids.map((id) => [id, 0]))
  // Longest path: relax in topological order (forward edges form a DAG).
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const targets of forward.values()) for (const to of new Set(targets)) indegree.set(to, (indegree.get(to) ?? 0) + 1)
  const queue = ids.filter((id) => !indegree.get(id))
  while (queue.length) {
    const id = queue.shift() as string
    for (const to of new Set(forward.get(id) ?? [])) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(id) ?? 0) + 1))
      indegree.set(to, (indegree.get(to) ?? 1) - 1)
      if (!indegree.get(to)) queue.push(to)
    }
  }
  const layers: string[][] = []
  for (const id of ids) (layers[depth.get(id) ?? 0] ??= []).push(id)
  const filled = layers.map((layer) => layer ?? [])
  const position = new Map<string, number>()
  const refresh = () => filled.forEach((layer) => layer.forEach((id, index) => position.set(id, index)))
  refresh()
  const neighbours = (id: string, upward: boolean) => data.edges
    .filter((edge) => (upward ? edge.to === id : edge.from === id))
    .map((edge) => (upward ? edge.from : edge.to))
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const upward = sweep % 2 === 0
    const order = upward ? filled.map((_, index) => index) : filled.map((_, index) => filled.length - 1 - index)
    for (const index of order) {
      const layer = filled[index]
      const score = new Map(layer.map((id) => {
        const near = neighbours(id, upward).filter((other) => position.has(other))
        return [id, near.length ? near.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / near.length : position.get(id) ?? 0] as const
      }))
      layer.sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0) || (position.get(a) ?? 0) - (position.get(b) ?? 0))
      layer.forEach((id, order2) => position.set(id, order2))
    }
  }
  return filled
}

const GAP_ALONG = 70
const GAP_ACROSS = 26

export const layoutMap = (data: MapData): MapLayout => {
  const layers = layerMap(data)
  const boxes = new Map(data.nodes.map((node) => [node.id, measureBox(node.text || '…', 22)]))
  const lr = data.dir === 'LR'
  // Extent of a layer along the "across" axis, and thickness along the layer axis.
  const across = (id: string) => (lr ? boxes.get(id)?.h ?? 0 : boxes.get(id)?.w ?? 0)
  const thick = (id: string) => (lr ? boxes.get(id)?.w ?? 0 : boxes.get(id)?.h ?? 0)
  const layerSize = layers.map((layer) => layer.reduce((sum, id) => sum + across(id), 0) + Math.max(0, layer.length - 1) * GAP_ACROSS)
  const widest = Math.max(0, ...layerSize)
  const placed = new Map<string, PlacedMapNode>()
  let along = 12
  layers.forEach((layer, index) => {
    const thickest = Math.max(0, ...layer.map(thick))
    let cursor = 12 + (widest - layerSize[index]) / 2
    for (const id of layer) {
      const box = boxes.get(id)
      if (!box) continue
      const size = across(id)
      const centreAlong = along + thickest / 2
      const x = lr ? centreAlong - box.w / 2 : cursor
      const y = lr ? cursor : centreAlong - box.h / 2
      placed.set(id, { id, lines: box.lines, x: Math.round(x), y: Math.round(y), w: box.w, h: box.h })
      cursor += size + GAP_ACROSS
    }
    along += thickest + GAP_ALONG
  })
  const nodes = [...placed.values()]
  const edges = data.edges.flatMap((edge): PlacedMapEdge[] => {
    const a = placed.get(edge.from)
    const b = placed.get(edge.to)
    if (!a || !b) return []
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    const forward = lr ? bc.x >= ac.x + 1 : bc.y >= ac.y + 1
    let start: { x: number; y: number }
    let end: { x: number; y: number }
    if (lr) {
      start = { x: forward ? a.x + a.w : a.x, y: ac.y }
      end = { x: forward ? b.x : b.x + b.w, y: bc.y }
    } else {
      start = { x: ac.x, y: forward ? a.y + a.h : a.y }
      end = { x: bc.x, y: forward ? b.y : b.y + b.h }
    }
    const bend = lr ? Math.abs(end.x - start.x) / 2 : Math.abs(end.y - start.y) / 2
    const sign = forward ? 1 : -1
    const c1 = lr ? { x: start.x + sign * bend, y: start.y } : { x: start.x, y: start.y + sign * bend }
    const c2 = lr ? { x: end.x - sign * bend, y: end.y } : { x: end.x, y: end.y - sign * bend }
    const mid = { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 }
    const f = (value: number) => Math.round(value * 10) / 10
    return [{ id: edge.id, from: edge.from, to: edge.to, label: edge.label, path: `M${f(start.x)} ${f(start.y)} C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(end.x)} ${f(end.y)}`, lx: f(mid.x), ly: f(mid.y) }]
  })
  const width = Math.max(...nodes.map((node) => node.x + node.w), 100) + 12
  const height = Math.max(...nodes.map((node) => node.y + node.h), 60) + 12
  return { nodes, edges, width, height, layers }
}

// -- editing helpers: they never produce data the normaliser would cut ----------------

/** Appends an empty box unless the map is full. */
export const addMapNode = (data: MapData): MapData => (data.nodes.length >= MAP_LIMITS.nodes ? data : { ...data, nodes: [...data.nodes, { id: newId('n'), text: '' }] })

/** A pair of boxes without an arrow yet (first to last when that is free), or null when the map is full or has no free pair. */
export const freeMapPair = (data: MapData): { from: string; to: string } | null => {
  if (data.edges.length >= MAP_LIMITS.edges || data.nodes.length < 2) return null
  const taken = new Set(data.edges.map((edge) => `${edge.from}>${edge.to}`))
  const first = data.nodes[0].id
  const last = data.nodes[data.nodes.length - 1].id
  if (!taken.has(`${first}>${last}`)) return { from: first, to: last }
  for (const a of data.nodes) for (const b of data.nodes) if (a.id !== b.id && !taken.has(`${a.id}>${b.id}`)) return { from: a.id, to: b.id }
  return null
}

export const addMapEdge = (data: MapData): MapData => {
  const pair = freeMapPair(data)
  return pair ? { ...data, edges: [...data.edges, { id: newId('e'), ...pair, label: '' }] } : data
}

/** Changes one arrow. The model cannot hold an arrow from a box to itself or a copy of another arrow, so those come back as 'loop' and 'copy' instead of data. */
export const patchMapEdge = (data: MapData, id: string, patch: Partial<Pick<MapEdge, 'from' | 'to' | 'label'>>): MapData | 'loop' | 'copy' => {
  const current = data.edges.find((edge) => edge.id === id)
  if (!current) return data
  const next = { ...current, ...patch }
  if (next.from === next.to) return 'loop'
  if (data.edges.some((edge) => edge.id !== id && edgeKey(edge) === edgeKey(next))) return 'copy'
  return { ...data, edges: data.edges.map((edge) => (edge.id === id ? next : edge)) }
}

const slug = (value: string) => value.toLocaleLowerCase('de').replace(/\s+/gu, ' ').trim()

/**
 * Quick entry: one relation per line, "Licht -> verstärkt -> Wachstum", "A -> B", or "A -(label)-> B".
 * Existing boxes with the same text are reused so lines can chain.
 */
export const mapFromText = (data: MapData, input: string): MapData => {
  const nodes = [...data.nodes]
  const edges = [...data.edges]
  const find = (text: string) => {
    const key = slug(text)
    let node = nodes.find((entry) => slug(entry.text) === key)
    if (!node && nodes.length < MAX_NODES) {
      node = { id: newId('n'), text: text.trim().slice(0, MAP_LIMITS.nodeText) }
      nodes.push(node)
    }
    return node
  }
  for (const rawLine of input.replace(/\r/gu, '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const labelled = /^(.+?)\s*-\(([^)]*)\)->\s*(.+)$/u.exec(line)
    const parts = labelled ? [labelled[1], labelled[3]] : line.split(/\s*(?:->|→)\s*/u)
    // "A -> label -> B" is one labelled arrow; a longer chain "A -> B -> C -> D" is one arrow per step.
    const pairs: Array<[string, string, string]> = labelled
      ? [[labelled[1], labelled[3], labelled[2]]]
      : parts.length === 3 ? [[parts[0], parts[2], parts[1]]] : parts.slice(0, -1).map((part, index): [string, string, string] => [part, parts[index + 1], ''])
    for (const [from, to, label] of pairs) {
      if (!from.trim() || !to.trim()) continue
      const a = find(from)
      const b = find(to)
      const text = label.trim().slice(0, MAP_LIMITS.edgeLabel)
      if (a && b && a.id !== b.id && edges.length < MAX_EDGES && !edges.some((edge) => edgeKey(edge) === edgeKey({ from: a.id, to: b.id, label: text }))) edges.push({ id: newId('e'), from: a.id, to: b.id, label: text })
    }
  }
  return normaliseMapData({ ...data, nodes, edges })
}
