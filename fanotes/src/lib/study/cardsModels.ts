/** Identification sheet (Bildtafel) and definition cards, plus the flashcards they feed. */

import { asArray, asImage, asRecord, asText, findStudyBlocks, newId, parseJsonObject, stableId } from './blocks'

export type PlateItem = { id: string; label: string; note: string; img: string }
export type PlateData = { v: 1; title: string; cols: number; showLabels: boolean; items: PlateItem[] }
export type TermEntry = { id: string; term: string; definition: string; example: string; source: string }
export type TermData = { v: 1; terms: TermEntry[] }

/** Caps of the model. The normalisers enforce them; the editors read them to stop short of a cap instead of being cut. */
export const PLATE_LIMITS = { items: 40, title: 120, label: 120, note: 300 } as const
export const TERM_LIMITS = { terms: 30, term: 160, definition: 2000, example: 1000, source: 300 } as const

const MAX_ITEMS = PLATE_LIMITS.items
const MAX_TERMS = TERM_LIMITS.terms

export const defaultPlateData = (): PlateData => ({ v: 1, title: 'Bildtafel', cols: 4, showLabels: true, items: [] })
export const defaultTermData = (): TermData => ({ v: 1, terms: [{ id: newId('t'), term: '', definition: '', example: '', source: '' }] })

export const normalisePlateData = (raw: unknown): PlateData => {
  const source = asRecord(raw)
  const ids = new Set<string>()
  const items = asArray(source.items, MAX_ITEMS).map((entry, index): PlateItem => {
    const item = asRecord(entry)
    const label = asText(item.label, PLATE_LIMITS.label)
    let id = asText(item.id, 40)
    // A missing or repeated id is replaced by one made from the position and name, so it is the same on every read.
    if (!id || ids.has(id)) id = stableId('p', `${index}\u0000${label}`)
    while (ids.has(id)) id = newId('p')
    ids.add(id)
    return { id, label, note: asText(item.note, PLATE_LIMITS.note), img: asImage(item.img) }
  })
  const cols = Number(source.cols)
  return {
    v: 1,
    title: asText(source.title, PLATE_LIMITS.title),
    cols: Number.isInteger(cols) && cols >= 1 && cols <= 8 ? cols : 4,
    showLabels: source.showLabels !== false,
    items,
  }
}

export const parsePlateData = (body: string): PlateData => {
  const raw = parseJsonObject(body)
  return Object.keys(raw).length ? normalisePlateData(raw) : defaultPlateData()
}

export const normaliseTermData = (raw: unknown): TermData => {
  const ids = new Set<string>()
  const terms = asArray(asRecord(raw).terms, MAX_TERMS).map((entry, index): TermEntry => {
    const term = asRecord(entry)
    const name = asText(term.term, TERM_LIMITS.term)
    let id = asText(term.id, 40)
    // A missing or repeated id is replaced by one made from the position and term, so it is the same on every read.
    if (!id || ids.has(id)) id = stableId('t', `${index}\u0000${name}`)
    while (ids.has(id)) id = newId('t')
    ids.add(id)
    return { id, term: name, definition: asText(term.definition, TERM_LIMITS.definition), example: asText(term.example, TERM_LIMITS.example), source: asText(term.source, TERM_LIMITS.source) }
  })
  return { v: 1, terms }
}

export const parseTermData = (body: string): TermData => {
  const raw = parseJsonObject(body)
  return Object.keys(raw).length ? normaliseTermData(raw) : defaultTermData()
}

/** A card derived from a study block. Not stored: the schedule is kept by id in the note's card store. */
export type StudyCardSource = { id: string; front: string; back: string; frontImage?: string }

export const PLATE_PROMPT = 'Wie heisst das?'

export const studyCardSources = (markdown: string): StudyCardSource[] => {
  const cards: StudyCardSource[] = []
  /** Card id -> content it was taken for. */
  const taken = new Map<string, string>()
  /**
   * The card id for `id`, or null for an exact copy of a card already taken. A block copied within a note shares its
   * ids: the first one keeps the plain id (and with it its schedule); a copy that was edited gets an id of its own.
   */
  const claim = (id: string, content: string): string | null => {
    const owner = taken.get(id)
    if (owner === undefined) { taken.set(id, content); return id }
    if (owner === content) return null
    const own = `${id}~${stableId('', content)}`
    if (taken.has(own)) return null
    taken.set(own, content)
    return own
  }
  for (const block of findStudyBlocks(markdown)) {
    if (block.kind === 'term') {
      for (const entry of parseTermData(block.body).terms) {
        const front = entry.term.trim()
        const definition = entry.definition.trim()
        if (!front || !definition) continue
        const extra = [entry.example.trim() && `Beispiel: ${entry.example.trim()}`, entry.source.trim() && `Quelle: ${entry.source.trim()}`].filter(Boolean)
        const back = [definition, ...extra].join('\n')
        const id = claim(`term:${entry.id}`, `${front}\u0000${back}`)
        if (id) cards.push({ id, front, back })
      }
    } else if (block.kind === 'plate') {
      const plate = parsePlateData(block.body)
      for (const item of plate.items) {
        if (!item.img || !item.label.trim()) continue
        const back = [item.label.trim(), item.note.trim()].filter(Boolean).join('\n')
        const id = claim(`plate:${item.id}`, `${item.img}\u0000${back}`)
        if (id) cards.push({ id, front: plate.title ? `${plate.title}: ${PLATE_PROMPT}` : PLATE_PROMPT, back, frontImage: item.img })
      }
    }
  }
  return cards
}
