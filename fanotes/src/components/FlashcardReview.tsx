import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { bindHandGestures } from '../../../src/lib/handGestures'
import { applyReview, cardsFromMarkdown, dueCards, type FlashGrade } from '../lib/flashcards'

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
  const [source, setSource] = useState(markdown)
  const [revealed, setRevealed] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const cards = useMemo(() => cardsFromMarkdown(source), [source])
  const queue = dueCards(cards)
  const card = queue[0]
  const cardRef = useRef(card)
  const revealedRef = useRef(revealed)
  cardRef.current = card
  revealedRef.current = revealed

  const grade = (value: FlashGrade) => {
    if (!card) return
    const next = applyReview(source, card.id, value)
    setSource(next)
    setRevealed(false)
    onSave(next)
  }
  const gradeRef = useRef(grade)
  gradeRef.current = grade

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

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="cards-title" data-hand-gesture-root="" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <div><div><small>Karteikarten</small><h2 id="cards-title">{title}</h2></div></div>
          <button type="button" aria-label="Karteikarten schließen" onClick={onClose}><X size={17} /></button>
        </header>
        {!card && <p className="history-empty">{cards.length ? 'Keine fälligen Karten. Die nächsten liegen an späteren Tagen.' : 'Keine Lernfragen in dieser Notiz. Die KI-Aktion Lernfragen erstellt welche.'}</p>}
        {card && (
          <div style={{ display: 'grid', gap: 12, padding: '4px 4px 12px' }}>
            <strong>{card.front}</strong>
            {revealed ? <p>{card.back || 'Keine Antwort hinterlegt.'}</p> : <button type="button" className="secondary-button" onClick={() => setRevealed(true)}>Antwort zeigen</button>}
            {revealed && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="secondary-button" onClick={() => grade('again')}>Nochmal</button>
                <button type="button" className="secondary-button" onClick={() => grade('hard')}>Schwer</button>
                <button type="button" className="primary-button" onClick={() => grade('good')}>Gut</button>
                <button type="button" className="primary-button" onClick={() => grade('easy')}>Leicht</button>
              </div>
            )}
            <small>{queue.length} fällig · {cards.length} Karten · Wiederholung bleibt in der Notiz.</small>
          </div>
        )}
      </section>
    </div>
  )
}
