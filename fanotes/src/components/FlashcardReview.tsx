import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { bindHandGestures } from '../../../src/lib/handGestures'
import { getUiLanguage } from '../i18n'
import { applyReview, cardsFromMarkdown, dueCards, reviewQueue, type FlashGrade } from '../lib/flashcards'

const COPY = {
  de: {
    kicker: 'Karteikarten',
    close: 'Karteikarten schließen',
    noneDue: 'Keine fälligen Karten. Die nächsten liegen an späteren Tagen.',
    none: 'Keine Lernfragen in dieser Notiz. Die KI-Aktion Lernfragen erstellt welche.',
    show: 'Antwort zeigen',
    showHint: 'Leertaste',
    noAnswer: 'Keine Antwort hinterlegt.',
    again: 'Nochmal',
    hard: 'Schwer',
    good: 'Gut',
    easy: 'Leicht',
    status: (due: number, total: number) => `${due} fällig · ${total} Karten · Wiederholung bleibt in der Notiz.`,
  },
  en: {
    kicker: 'Flashcards',
    close: 'Close flashcards',
    noneDue: 'No cards due. The next ones are on later days.',
    none: 'No study questions in this note. The AI action Study questions creates them.',
    show: 'Show answer',
    showHint: 'Space',
    noAnswer: 'No answer saved.',
    again: 'Again',
    hard: 'Hard',
    good: 'Good',
    easy: 'Easy',
    status: (due: number, total: number) => `${due} due · ${total} cards · The schedule stays in the note.`,
  },
}

const text = () => (getUiLanguage() === 'en' ? COPY.en : COPY.de)

const GRADE_KEYS: Record<string, FlashGrade> = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' }

export function FlashcardReview({
  markdown,
  title,
  onSave,
  onClose,
}: {
  markdown: string
  title: string
  onSave: (markdown: string) => void
  onClose: () => void
}) {
  const copy = text()
  const [source, setSource] = useState(markdown)
  const [revealed, setRevealed] = useState(false)
  const [later, setLater] = useState<string[]>([])
  const dialogRef = useRef<HTMLElement>(null)
  const cards = useMemo(() => cardsFromMarkdown(source), [source])
  const due = useMemo(() => dueCards(cards), [cards])
  const queue = useMemo(() => reviewQueue(due, later), [due, later])
  const card = queue[0]
  const cardRef = useRef(card)
  const revealedRef = useRef(revealed)
  cardRef.current = card
  revealedRef.current = revealed

  const grade = (value: FlashGrade) => {
    if (!card) return
    const id = card.id
    const next = applyReview(source, id, value)
    setSource(next)
    setRevealed(false)
    onSave(next)
    setLater((current) => {
      const without = current.filter((item) => item !== id)
      return value === 'again' ? [...without, id] : without
    })
  }
  const gradeRef = useRef(grade)
  gradeRef.current = grade
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const root = dialogRef.current
    if (!root) return undefined
    return bindHandGestures(root, {
      onSwipe: (direction) => {
        if (!cardRef.current) return
        if (!revealedRef.current) {
          setRevealed(true)
          return
        }
        if (direction === 'left') gradeRef.current('again')
        else if (direction === 'right') gradeRef.current('good')
        else if (direction === 'up') gradeRef.current('easy')
        else gradeRef.current('hard')
      },
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest('textarea, input, [contenteditable="true"]')) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!cardRef.current) return
      if (!revealedRef.current) {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          setRevealed(true)
        }
        return
      }
      const value = GRADE_KEYS[event.key]
      if (!value) return
      event.preventDefault()
      gradeRef.current(value)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="cards-title" tabIndex={-1} data-hand-gesture-root="" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <div><div><small>{copy.kicker}</small><h2 id="cards-title">{title}</h2></div></div>
          <button type="button" aria-label={copy.close} onClick={onClose}><X size={17} /></button>
        </header>
        {!card && <p className="history-empty">{cards.length ? copy.noneDue : copy.none}</p>}
        {card && (
          <div style={{ display: 'grid', gap: 12, padding: '4px 4px 12px' }}>
            <strong>{card.front}</strong>
            {revealed ? <p>{card.back || copy.noAnswer}</p> : <button type="button" className="secondary-button" title={copy.showHint} onClick={() => setRevealed(true)}>{copy.show}</button>}
            {revealed && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="secondary-button" title="1" onClick={() => grade('again')}>{copy.again}</button>
                <button type="button" className="secondary-button" title="2" onClick={() => grade('hard')}>{copy.hard}</button>
                <button type="button" className="primary-button" title="3" onClick={() => grade('good')}>{copy.good}</button>
                <button type="button" className="primary-button" title="4" onClick={() => grade('easy')}>{copy.easy}</button>
              </div>
            )}
            <small>{copy.status(due.length, cards.length)}</small>
          </div>
        )}
      </section>
    </div>
  )
}
