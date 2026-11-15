/** Sorting board: cards dragged into groups (hemi / holo / ametabol) or into an ordered sequence. */

import { asArray, asRecord, asText, newId, parseJsonObject } from './blocks'

export type SortCard = { id: string; text: string }
export type SortGroup = { id: string; title: string; cards: string[] }
export type SortData = {
  v: 1
  title: string
  mode: 'groups' | 'sequence'
  cards: SortCard[]
  groups: SortGroup[]
}

const MAX_CARDS = 120
const MAX_GROUPS = 12

export const defaultSortData = (): SortData => ({
  v: 1,
  title: 'Sortieren',
  mode: 'groups',
  cards: [],
  groups: [{ id: 'g1', title: 'Gruppe 1', cards: [] }, { id: 'g2', title: 'Gruppe 2', cards: [] }],
})

export const normaliseSortData = (raw: unknown): SortData => {
  const source = asRecord(raw)
  const cards: SortCard[] = []
  const ids = new Set<string>()
  for (const entry of asArray(source.cards, MAX_CARDS)) {
    const card = asRecord(entry)
    const text = asText(card.text, 200).trim()
    let id = asText(card.id, 40)
    if (!text) continue
    if (!id || ids.has(id)) id = newId('c')
    ids.add(id)
    cards.push({ id, text })
  }
  const placed = new Set<string>()
  const groups = asArray(source.groups, MAX_GROUPS).map((entry, index): SortGroup => {
    const group = asRecord(entry)
    const list = asArray(group.cards, MAX_CARDS).filter((id): id is string => typeof id === 'string' && ids.has(id) && !placed.has(id))
    list.forEach((id) => placed.add(id))
    return { id: asText(group.id, 40) || `g${index + 1}`, title: asText(group.title, 80), cards: list }
  })
  const mode = source.mode === 'sequence' ? 'sequence' : 'groups'
  if (!groups.length) groups.push({ id: 'g1', title: mode === 'sequence' ? 'Reihenfolge' : 'Gruppe 1', cards: [] })
  return { v: 1, title: asText(source.title, 120), mode, cards, groups: mode === 'sequence' ? groups.slice(0, 1) : groups }
}

export const parseSortData = (body: string): SortData => {
  const raw = parseJsonObject(body)
  return Object.keys(raw).length ? normaliseSortData(raw) : defaultSortData()
}

/** Card texts from pasted lines or comma lists; list markers and numbers are removed. */
export const parseCardList = (value: string): string[] => {
  const lines = value.replace(/\r/gu, '').split('\n')
  const parts = lines.length > 1 ? lines : value.split(/[;,]/u)
  return parts
    .map((part) => part.replace(/^\s*(?:[-*•·–]|\d{1,3}[.)])\s+/u, '').trim())
    .filter(Boolean)
    .slice(0, MAX_CARDS)
}

export const addCards = (data: SortData, texts: readonly string[]): SortData => {
  const room = MAX_CARDS - data.cards.length
  const added = texts.slice(0, Math.max(0, room)).map((text): SortCard => ({ id: newId('c'), text: text.slice(0, 200) }))
  return { ...data, cards: [...data.cards, ...added] }
}

export const unsortedCards = (data: SortData): SortCard[] => {
  const placed = new Set(data.groups.flatMap((group) => group.cards))
  return data.cards.filter((card) => !placed.has(card.id))
}

/** Moves a card to `groupId` at `index`; `null` puts it back into the unsorted pool. */
export const moveCard = (data: SortData, cardId: string, groupId: string | null, index?: number): SortData => {
  if (!data.cards.some((card) => card.id === cardId)) return data
  const groups = data.groups.map((group) => ({ ...group, cards: group.cards.filter((id) => id !== cardId) }))
  if (groupId !== null) {
    const target = groups.find((group) => group.id === groupId)
    if (!target) return data
    const at = index === undefined ? target.cards.length : Math.max(0, Math.min(target.cards.length, index))
    target.cards.splice(at, 0, cardId)
  }
  return { ...data, groups }
}

export const removeCard = (data: SortData, cardId: string): SortData => ({
  ...data,
  cards: data.cards.filter((card) => card.id !== cardId),
  groups: data.groups.map((group) => ({ ...group, cards: group.cards.filter((id) => id !== cardId) })),
})

export const addGroup = (data: SortData, title: string): SortData => {
  if (data.groups.length >= MAX_GROUPS || data.mode === 'sequence') return data
  const used = new Set(data.groups.map((group) => group.id))
  let index = data.groups.length + 1
  while (used.has(`g${index}`)) index += 1
  return { ...data, groups: [...data.groups, { id: `g${index}`, title, cards: [] }] }
}

export const removeGroup = (data: SortData, groupId: string): SortData => (
  data.groups.length <= 1 ? data : { ...data, groups: data.groups.filter((group) => group.id !== groupId) }
)

export const setMode = (data: SortData, mode: SortData['mode']): SortData => {
  if (mode === data.mode) return data
  if (mode === 'sequence') {
    const first = data.groups[0] ?? { id: 'g1', title: 'Reihenfolge', cards: [] }
    const all = data.groups.flatMap((group) => group.cards)
    return { ...data, mode, groups: [{ ...first, title: first.title || 'Reihenfolge', cards: all }] }
  }
  return { ...data, mode, groups: data.groups.length > 1 ? data.groups : [...data.groups, { id: 'g2', title: 'Gruppe 2', cards: [] }] }
}

export const shuffleCards = (data: SortData, random: () => number = Math.random): SortData => {
  const cards = [...data.cards]
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[cards[index], cards[other]] = [cards[other], cards[index]]
  }
  return { ...data, cards, groups: data.groups.map((group) => ({ ...group, cards: [] })) }
}

const cellText = (value: string) => value.replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').trim()

/** The result as Markdown: a table with one column per group, or a numbered list for a sequence. */
export const sortToMarkdown = (data: SortData, style: 'table' | 'list' = data.mode === 'sequence' ? 'list' : 'table'): string => {
  const text = new Map(data.cards.map((card) => [card.id, card.text]))
  if (data.mode === 'sequence' || style === 'list') {
    const lines: string[] = []
    for (const group of data.groups) {
      if (data.mode !== 'sequence') lines.push(`**${group.title || 'Gruppe'}**`)
      group.cards.forEach((id, index) => lines.push(data.mode === 'sequence' ? `${index + 1}. ${text.get(id) ?? ''}` : `- ${text.get(id) ?? ''}`))
      if (data.mode !== 'sequence') lines.push('')
    }
    return lines.join('\n').trim()
  }
  const rows = Math.max(1, ...data.groups.map((group) => group.cards.length))
  const head = data.groups.map((group, index) => cellText(group.title || `Gruppe ${index + 1}`))
  const body = Array.from({ length: rows }, (_, row) => `| ${data.groups.map((group) => cellText(text.get(group.cards[row] ?? '') ?? '')).join(' | ')} |`)
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body].join('\n')
}
