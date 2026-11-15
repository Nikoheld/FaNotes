// Binder operations: moving nodes by drag and drop, the trash folder, and
// walking the tree. Pure functions over `BinderNode[]`; the caller wraps the
// result in a new manifest (scenes and their files are never deleted here).
import { newId } from './ids'
import type { BinderKind, BinderNode } from './types'

// Binder ids are 6–40 lower-case letters and digits (see ids.ts); a shorter id would be dropped on load.
export const TRASH_ID = 'trashbin'

export type DropPosition = 'before' | 'after' | 'inside'

export const walkBinder = (nodes: BinderNode[], visit: (node: BinderNode, parent: BinderNode | null, depth: number) => void, parent: BinderNode | null = null, depth = 0) => {
  for (const node of nodes) {
    visit(node, parent, depth)
    if (node.children) walkBinder(node.children, visit, node, depth + 1)
  }
}

export const flattenBinder = (nodes: BinderNode[]) => {
  const out: Array<{ node: BinderNode; parent: BinderNode | null; depth: number }> = []
  walkBinder(nodes, (node, parent, depth) => out.push({ node, parent, depth }))
  return out
}

const contains = (node: BinderNode, id: string): boolean => node.id === id || (node.children ?? []).some((child) => contains(child, id))

export const findIn = (nodes: BinderNode[], id: string): BinderNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = node.children ? findIn(node.children, id) : null
    if (found) return found
  }
  return null
}

/** Ids of the trash folder and everything in it. */
export const trashedIds = (nodes: BinderNode[]) => {
  const trash = findIn(nodes, TRASH_ID)
  const out = new Set<string>()
  if (trash) walkBinder([trash], (node) => out.add(node.id))
  return out
}

/** What a node of each kind may hold. */
const ACCEPTS: Record<BinderKind, BinderKind[]> = {
  part: ['chapter', 'scene', 'folder'],
  chapter: ['scene', 'folder'],
  folder: ['part', 'chapter', 'scene', 'folder'],
  scene: [],
}

/** Whether `id` may be dropped at `targetId`/`position` (no cycles, kinds fit). */
export const canDrop = (nodes: BinderNode[], id: string, targetId: string, position: DropPosition) => {
  if (id === targetId || id === TRASH_ID) return false
  const moving = findIn(nodes, id)
  const target = findIn(nodes, targetId)
  if (!moving || !target || contains(moving, targetId)) return false
  if (position === 'inside') return ACCEPTS[target.kind].includes(moving.kind)
  if (targetId === TRASH_ID) return false
  const parent = parentOf(nodes, targetId)
  // The top level holds anything (a short story may have scenes without chapters).
  if (!parent) return true
  return ACCEPTS[parent.kind].includes(moving.kind)
}

export const parentOf = (nodes: BinderNode[], id: string, parent: BinderNode | null = null): BinderNode | null => {
  for (const node of nodes) {
    if (node.id === id) return parent
    const found = node.children ? parentOf(node.children, id, node) : null
    if (found) return found
  }
  return null
}

const without = (nodes: BinderNode[], id: string): BinderNode[] => {
  let changed = false
  const out: BinderNode[] = []
  for (const node of nodes) {
    if (node.id === id) { changed = true; continue }
    if (node.children) {
      const children = without(node.children, id)
      if (children !== node.children) { changed = true; out.push({ ...node, children }); continue }
    }
    out.push(node)
  }
  return changed ? out : nodes
}

const insertAt = (nodes: BinderNode[], moving: BinderNode, targetId: string, position: DropPosition): BinderNode[] | null => {
  const index = nodes.findIndex((node) => node.id === targetId)
  if (index >= 0) {
    if (position === 'inside') {
      const target = nodes[index]
      return [...nodes.slice(0, index), { ...target, children: [...(target.children ?? []), moving] }, ...nodes.slice(index + 1)]
    }
    const at = position === 'before' ? index : index + 1
    return [...nodes.slice(0, at), moving, ...nodes.slice(at)]
  }
  for (let position_ = 0; position_ < nodes.length; position_ += 1) {
    const node = nodes[position_]
    if (!node.children) continue
    const children = insertAt(node.children, moving, targetId, position)
    if (children) return [...nodes.slice(0, position_), { ...node, children }, ...nodes.slice(position_ + 1)]
  }
  return null
}

/** Moves a node (with its children). Returns the same array when the move is not allowed. */
export const moveNode = (nodes: BinderNode[], id: string, targetId: string, position: DropPosition): BinderNode[] => {
  if (!canDrop(nodes, id, targetId, position)) return nodes
  const moving = findIn(nodes, id)!
  return insertAt(without(nodes, id), moving, targetId, position) ?? nodes
}

/** Moves a node into the trash folder (created on first use). Its scene files stay. */
export const moveToTrash = (nodes: BinderNode[], id: string, title: string): BinderNode[] => {
  if (id === TRASH_ID || !findIn(nodes, id)) return nodes
  const withTrash = findIn(nodes, TRASH_ID) ? nodes : [...nodes, { id: TRASH_ID, kind: 'folder' as const, title, exclude: true, children: [] }]
  const moving = findIn(withTrash, id)!
  return insertAt(without(withTrash, id), moving, TRASH_ID, 'inside') ?? nodes
}

export const updateNode = (nodes: BinderNode[], id: string, patch: (node: BinderNode) => BinderNode): BinderNode[] => {
  let changed = false
  const out = nodes.map((node) => {
    if (node.id === id) { changed = true; return patch(node) }
    if (!node.children) return node
    const children = updateNode(node.children, id, patch)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  return changed ? out : nodes
}

/** A new node of a kind, appended inside `parentId` (or at the top level before the trash). */
export const addNode = (nodes: BinderNode[], kind: BinderKind, title: string, parentId: string | null): { nodes: BinderNode[]; node: BinderNode } => {
  const node: BinderNode = { id: newId(), kind, title, ...(kind === 'scene' ? {} : { children: [] }) }
  if (parentId && findIn(nodes, parentId)) {
    const next = insertAt(nodes, node, parentId, 'inside')
    if (next) return { nodes: next, node }
  }
  const trash = nodes.findIndex((entry) => entry.id === TRASH_ID)
  return { nodes: trash >= 0 ? [...nodes.slice(0, trash), node, ...nodes.slice(trash)] : [...nodes, node], node }
}

/** Scenes in reading order with the chapter that holds them (trash left out). */
export const scenesInOrder = (nodes: BinderNode[]) => {
  const trash = trashedIds(nodes)
  const out: Array<{ scene: BinderNode; chapter: BinderNode | null }> = []
  const walk = (list: BinderNode[], chapter: BinderNode | null) => {
    for (const node of list) {
      if (trash.has(node.id)) continue
      if (node.kind === 'scene') out.push({ scene: node, chapter })
      else walk(node.children ?? [], node.kind === 'chapter' || node.kind === 'part' ? node : chapter)
    }
  }
  walk(nodes, null)
  return out
}
