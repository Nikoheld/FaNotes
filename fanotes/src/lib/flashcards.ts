/** Spaced repetition for the Lernfragen an AI preview already produces. */

export type FlashCard = {
  id: string
  front: string
  back: string
  ease: number
  intervalDays: number
  due: string
  reps: number
  lapses: number
}

export type FlashGrade = 'again' | 'hard' | 'good' | 'easy'

const MARKER_START = '<!-- fanotes-cards-v1'
const MARKER_END = '-->'
const DAY = 86_400_000

const dayKey = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const clean = (value: string) => value.replace(/\s+/gu, ' ').trim().slice(0, 600)

const questionBlocks = (markdown: string) => {
  const section = markdown.split(/^##\s+Lernfragen\s*$/imu)[1] ?? ''
  const body = section.split(/^##\s+/mu)[0] ?? ''
  const cards: Array<{ front: string; back: string }> = []
  const details = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/giu
  for (const match of body.matchAll(details)) {
    const front = clean(match[1] ?? '')
    const back = clean(match[2] ?? '')
    if (front && back) cards.push({ front, back })
  }
  if (cards.length) return cards
  const numbered = /^(?:\d+\.\s+)(.+)$/gmu
  for (const match of body.matchAll(numbered)) {
    const front = clean(match[1] ?? '')
    if (front) cards.push({ front, back: '' })
  }
  return cards
}

export const parseStoredCards = (markdown: string): FlashCard[] => {
  const start = markdown.indexOf(MARKER_START)
  if (start < 0) return []
  const end = markdown.indexOf(MARKER_END, start + MARKER_START.length)
  if (end < 0) return []
  try {
    const parsed = JSON.parse(markdown.slice(start + MARKER_START.length, end)) as { cards?: unknown }
    if (!Array.isArray(parsed.cards)) return []
    return parsed.cards.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const card = entry as Partial<FlashCard>
      const front = typeof card.front === 'string' ? clean(card.front) : ''
      if (!front) return []
      return [{
        id: typeof card.id === 'string' ? card.id.slice(0, 80) : `card-${front.slice(0, 12)}`,
        front,
        back: typeof card.back === 'string' ? clean(card.back) : '',
        ease: typeof card.ease === 'number' && card.ease > 1 ? card.ease : 2.5,
        intervalDays: typeof card.intervalDays === 'number' && card.intervalDays > 0 ? card.intervalDays : 0,
        due: typeof card.due === 'string' ? card.due : dayKey(new Date()),
        reps: typeof card.reps === 'number' ? card.reps : 0,
        lapses: typeof card.lapses === 'number' ? card.lapses : 0,
      }]
    }).slice(0, 400)
  } catch {
    return []
  }
}

/** Questions in the note, merged with a schedule already stored beside them. */
export const cardsFromMarkdown = (markdown: string, now = new Date()): FlashCard[] => {
  const stored = parseStoredCards(markdown)
  const byFront = new Map(stored.map((card) => [card.front, card]))
  const due = dayKey(now)
  return questionBlocks(markdown).map((question, index) => {
    const existing = byFront.get(question.front)
    if (existing) return { ...existing, back: question.back || existing.back }
    return {
      id: `card-${index + 1}`,
      front: question.front,
      back: question.back,
      ease: 2.5,
      intervalDays: 0,
      due,
      reps: 0,
      lapses: 0,
    }
  })
}

export const dueCards = (cards: readonly FlashCard[], now = new Date()) => {
  const today = dayKey(now)
  return cards.filter((card) => card.due <= today)
}

export const reviewCard = (card: FlashCard, grade: FlashGrade, now = new Date()): FlashCard => {
  const next = { ...card, reps: card.reps + 1 }
  if (grade === 'again') {
    next.lapses += 1
    next.reps = 0
    next.intervalDays = 0
    next.ease = Math.max(1.3, card.ease - 0.2)
    next.due = dayKey(now)
    return next
  }
  const factor = grade === 'hard' ? 1.2 : grade === 'easy' ? card.ease * 1.3 : card.ease
  next.ease = grade === 'hard' ? Math.max(1.3, card.ease - 0.15) : grade === 'easy' ? card.ease + 0.15 : card.ease
  next.intervalDays = card.intervalDays <= 0 ? (grade === 'hard' ? 1 : grade === 'easy' ? 4 : 2) : Math.max(1, Math.round(card.intervalDays * factor))
  next.due = dayKey(new Date(now.getTime() + next.intervalDays * DAY))
  return next
}

export const embedCards = (markdown: string, cards: readonly FlashCard[]) => {
  const start = markdown.indexOf(MARKER_START)
  const end = start >= 0 ? markdown.indexOf(MARKER_END, start) : -1
  const without = start >= 0 && end >= 0
    ? `${markdown.slice(0, start)}${markdown.slice(end + MARKER_END.length)}`
    : markdown
  const block = `\n${MARKER_START}\n${JSON.stringify({ cards }, null, 2)}\n${MARKER_END}\n`
  return `${without.replace(/\s*$/u, '')}${block}`
}

export const applyReview = (markdown: string, cardId: string, grade: FlashGrade, now = new Date()) => {
  const cards = cardsFromMarkdown(markdown, now).map((card) => card.id === cardId ? reviewCard(card, grade, now) : card)
  return embedCards(markdown, cards)
}
