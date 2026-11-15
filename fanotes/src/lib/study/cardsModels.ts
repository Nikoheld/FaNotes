/** Identification sheet (Bildtafel) and definition cards, plus the flashcards they feed. */

import { asArray, asImage, asRecord, asText, findStudyBlocks, newId, parseJsonObject } from './blocks'

export type PlateItem = { id: string; label: string; note: string; img: string }
export type PlateData = { v: 1; title: string; cols: number; showLabels: boolean; items: PlateItem[] }
export type TermEntry = { id: string; term: string; definition: string; example: string; source: string }
export type TermData = { v: 1; terms: TermEntry[] }

const MAX_ITEMS = 40
const MAX_TERMS = 30

export const defaultPlateData = (): PlateData => ({ v: 1, title: 'Bildtafel', cols: 4, showLabels: true, items: [] })
export const defaultTermData = (): TermData => ({ v: 1, terms: [{ id: newId('t'), term: '', definition: '', example: '', source: '' }] })

export const normalisePlateData = (raw: unknown): PlateData => {
  const source = asRecord(raw)
  const ids = new Set<string>()
  const items = asArray(source.items, MAX_ITEMS).map((entry): PlateItem => {
    const item = asRecord(entry)
    let id = asText(item.id, 40)
    if (!id || ids.has(id)) id = newId('p')
    ids.add(id)
    return { id, label: asText(item.label, 120), note: asText(item.note, 300), img: asImage(item.img) }
  })
  const cols = Number(source.cols)
  return {
    v: 1,
    title: asText(source.title, 120),
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
  const terms = asArray(asRecord(raw).terms, MAX_TERMS).map((entry): TermEntry => {
    const term = asRecord(entry)
    let id = asText(term.id, 40)
    if (!id || ids.has(id)) id = newId('t')
    ids.add(id)
    return { id, term: asText(term.term, 160), definition: asText(term.definition, 2000), example: asText(term.example, 1000), source: asText(term.source, 300) }
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
  const ids = new Set<string>()
  for (const block of findStudyBlocks(markdown)) {
    if (block.kind === 'term') {
      for (const entry of parseTermData(block.body).terms) {
        const front = entry.term.trim()
        const definition = entry.definition.trim()
        if (!front || !definition || ids.has(`term:${entry.id}`)) continue
        ids.add(`term:${entry.id}`)
        const extra = [entry.example.trim() && `Beispiel: ${entry.example.trim()}`, entry.source.trim() && `Quelle: ${entry.source.trim()}`].filter(Boolean)
        cards.push({ id: `term:${entry.id}`, front, back: [definition, ...extra].join('\n') })
      }
    } else if (block.kind === 'plate') {
      const plate = parsePlateData(block.body)
      for (const item of plate.items) {
        if (!item.img || !item.label.trim() || ids.has(`plate:${item.id}`)) continue
        ids.add(`plate:${item.id}`)
        cards.push({ id: `plate:${item.id}`, front: plate.title ? `${plate.title}: ${PLATE_PROMPT}` : PLATE_PROMPT, back: [item.label.trim(), item.note.trim()].filter(Boolean).join('\n'), frontImage: item.img })
      }
    }
  }
  return cards
}
