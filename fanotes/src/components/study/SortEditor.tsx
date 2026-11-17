import { ArrowLeftRight, Plus, Shuffle, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  addCards, addGroup, cardRoom, moveCard, parseCardList, removeGroup, restoreCard, setMode, shuffleCards, SORT_LIMITS, takeCard, unsortedCards,
  type RemovedCard, type SortData,
} from '../../lib/study/sortBoard'

type Props = { data: SortData; onChange: (data: SortData) => void }

type Drag = { id: string; x: number; y: number; startX: number; startY: number; moved: boolean; text: string }

/** Where a pointer is over the board: a group (with insert index) or the pool. */
const dropTarget = (x: number, y: number): { group: string | null; index?: number } | null => {
  for (const element of document.elementsFromPoint(x, y)) {
    const zone = (element as HTMLElement).closest?.('[data-drop-zone]') as HTMLElement | null
    if (!zone) continue
    const group = zone.dataset.dropZone === 'pool' ? null : zone.dataset.dropZone ?? null
    const cards = [...zone.querySelectorAll<HTMLElement>('[data-card-id]')]
    let index = cards.length
    for (let at = 0; at < cards.length; at += 1) {
      const box = cards[at].getBoundingClientRect()
      if (y < box.top || (y <= box.bottom && x < box.left + box.width / 2)) { index = at; break }
    }
    return { group, index }
  }
  return null
}

export function SortEditor({ data, onChange }: Props) {
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  /** Where the last keyboard move went (a group title, or null for the pile), announced to screen readers. */
  const [said, setSaid] = useState<{ title: string | null } | null>(null)
  const [removed, setRemoved] = useState<RemovedCard | null>(null)
  const [confirmShuffle, setConfirmShuffle] = useState(false)
  const dataRef = useRef(data)
  dataRef.current = data
  const dragRef = useRef<Drag | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const focusCard = useRef<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pool = unsortedCards(data)
  const text = new Map(data.cards.map((card) => [card.id, card.text]))
  const room = cardRoom(data)

  // A card that moved into another container is a new element; the cursor follows it so the keyboard can go on.
  useEffect(() => {
    const id = focusCard.current
    focusCard.current = null
    if (!id) return
    for (const element of boardRef.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? []) {
      if (element.dataset.cardId === id) { element.focus(); break }
    }
  }, [data])
  useEffect(() => { if (confirmShuffle) cancelRef.current?.focus() }, [confirmShuffle])

  useEffect(() => {
    if (!drag) return undefined
    const move = (event: PointerEvent) => {
      const current = dragRef.current
      if (!current) return
      const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 6
      dragRef.current = { ...current, x: event.clientX, y: event.clientY, moved }
      setDrag(dragRef.current)
    }
    const up = (event: PointerEvent) => {
      const current = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!current) return
      if (!current.moved) { setSelected((value) => (value === current.id ? null : current.id)); return }
      const target = dropTarget(event.clientX, event.clientY)
      if (target) onChange(moveCard(dataRef.current, current.id, target.group, target.index))
    }
    // The browser took the pointer away (a scroll or system gesture started): the card stays where it was.
    const cancel = () => { dragRef.current = null; setDrag(null) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [Boolean(drag), onChange])

  const send = (id: string, groupId: string | null, index?: number) => {
    focusCard.current = id
    setSaid({ title: groupId === null ? null : data.groups.find((group) => group.id === groupId)?.title || 'Gruppe' })
    onChange(moveCard(data, id, groupId, index))
  }

  const card = (id: string, index?: number) => (
    <div
      key={id}
      data-card-id={id}
      role="button"
      tabIndex={0}
      aria-pressed={selected === id}
      className={`lw-card ${selected === id ? 'is-selected' : ''} ${drag?.id === id && drag.moved ? 'is-dragging' : ''}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return
        const next: Drag = { id, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, text: text.get(id) ?? '' }
        dragRef.current = next
        setDrag(next)
      }}
      onKeyDown={(event) => {
        const groupIndex = data.groups.findIndex((group) => group.cards.includes(id))
        const group = data.groups[groupIndex]
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault()
          const nextIndex = groupIndex + (event.key === 'ArrowRight' ? 1 : -1)
          if (nextIndex >= 0 && nextIndex < data.groups.length) send(id, data.groups[nextIndex].id)
          else if (nextIndex < 0) send(id, null)
        } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && group) {
          event.preventDefault()
          const at = group.cards.indexOf(id)
          send(id, group.id, at + (event.key === 'ArrowDown' ? 1 : -1))
        } else if (event.key === 'Enter' || event.key === ' ') {
          // Like a tap: pick the card up, then Enter on a group puts it down there.
          event.preventDefault()
          setSelected((value) => (value === id ? null : id))
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          const taken = takeCard(data, id)
          if (!taken) return
          const neighbour = (event.currentTarget.nextElementSibling ?? event.currentTarget.previousElementSibling) as HTMLElement | null
          focusCard.current = neighbour?.dataset.cardId ?? null
          setRemoved(taken.removed)
          onChange(taken.data)
        }
      }}
    >
      {data.mode === 'sequence' && index !== undefined && <b>{index + 1}.</b>} {text.get(id)}
    </div>
  )

  const place = (groupId: string | null) => {
    if (!selected) return
    send(selected, groupId)
    setSelected(null)
  }
  /** Enter or Space on a group (reachable by Tab while a card is picked up) puts the card down in it. */
  const placeByKey = (groupId: string | null) => (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    place(groupId)
  }

  const addDraft = () => {
    const texts = parseCardList(draft)
    onChange(addCards(data, texts))
    // What does not fit stays in the field instead of being cut.
    setDraft(texts.slice(room).join('\n'))
    setNote(texts.length > room ? 'Das Board fasst höchstens 120 Karten. Der Rest steht noch im Feld.' : '')
  }
  const mix = () => { setConfirmShuffle(false); setRemoved(null); onChange(shuffleCards(data)) }

  return (
    <div className="lw-editor">
      <div className="lw-actions">
        <input className="lw-title-input" aria-label="Titel" placeholder="Titel" maxLength={SORT_LIMITS.title} value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
        <button type="button" className={`secondary-button ${data.mode === 'sequence' ? 'is-active' : ''}`} aria-pressed={data.mode === 'sequence'} onClick={() => onChange(setMode(data, data.mode === 'sequence' ? 'groups' : 'sequence'))}><ArrowLeftRight size={14} /> {data.mode === 'sequence' ? 'Reihenfolge' : 'Gruppen'}</button>
        <button type="button" className="secondary-button" onClick={() => (data.groups.some((group) => group.cards.length) ? setConfirmShuffle(true) : mix())} title="Alle Karten mischen und zurück in den Stapel legen"><Shuffle size={14} /> Mischen</button>
      </div>
      {confirmShuffle && (
        <div
          className="backup-inline-confirm is-danger"
          role="alert"
          data-lw-esc=""
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setConfirmShuffle(false) } }}
        >
          <span>Alle Karten gehen zurück auf den Stapel. Die Gruppen sind danach leer.</span>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={() => setConfirmShuffle(false)}>Abbrechen</button>
          <button type="button" className="danger-button" onClick={mix}>Mischen</button>
        </div>
      )}
      <div className="lw-add">
        <textarea aria-label="Karten hinzufügen" rows={2} placeholder="Karten eingeben oder einfügen, eine pro Zeile (oder mit Komma getrennt)" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" className="primary-button" disabled={!parseCardList(draft).length || room === 0} title={room === 0 ? 'Das Board fasst höchstens 120 Karten.' : undefined} onClick={addDraft}><Plus size={14} /> Hinzufügen</button>
      </div>
      {note && <p className="lw-hint" role="status">{note}</p>}
      <div className="lw-board" ref={boardRef}>
        <div
          className={`lw-pool-zone ${selected ? 'can-drop' : ''}`}
          data-drop-zone="pool"
          role="group"
          aria-label="Stapel"
          tabIndex={selected ? 0 : undefined}
          onClick={() => place(null)}
          onKeyDown={placeByKey(null)}
        >
          <div className="lw-group-title">Stapel ({pool.length})</div>
          <div className="lw-cards">{pool.map((entry) => card(entry.id))}</div>
        </div>
        <div className="lw-groups-zone">
          {data.groups.map((group) => (
            <div
              key={group.id}
              className={`lw-group ${selected ? 'can-drop' : ''}`}
              data-drop-zone={group.id}
              role="group"
              aria-label={group.title || 'Gruppe'}
              tabIndex={selected ? 0 : undefined}
              onClick={() => place(group.id)}
              onKeyDown={placeByKey(group.id)}
            >
              <div className="lw-group-title">
                {data.mode === 'groups'
                  ? <input aria-label="Gruppenname" value={group.title} maxLength={SORT_LIMITS.groupTitle} placeholder="Gruppe" onClick={(event) => event.stopPropagation()} onChange={(event) => onChange({ ...data, groups: data.groups.map((entry) => (entry.id === group.id ? { ...entry, title: event.target.value } : entry)) })} />
                  : <span>{group.title || 'Reihenfolge'}</span>}
                {data.mode === 'groups' && data.groups.length > 1 && <button type="button" className="lw-icon-btn" aria-label="Gruppe löschen" title="Gruppe löschen" onClick={(event) => { event.stopPropagation(); onChange(removeGroup(data, group.id)) }}><X size={12} /></button>}
              </div>
              <div className="lw-cards">{group.cards.map((id, index) => card(id, index))}</div>
            </div>
          ))}
          {data.mode === 'groups' && <button type="button" className="secondary-button lw-add-group" disabled={data.groups.length >= SORT_LIMITS.groups} title={data.groups.length >= SORT_LIMITS.groups ? 'Ein Board fasst höchstens 12 Gruppen.' : undefined} onClick={() => onChange(addGroup(data, `Gruppe ${data.groups.length + 1}`))}><Plus size={14} /> Gruppe</button>}
        </div>
      </div>
      {removed && (
        <p className="lw-hint" role="status">
          Karte gelöscht.{' '}
          <button type="button" className="secondary-button" onClick={() => { onChange(restoreCard(dataRef.current, removed)); setRemoved(null) }}>Rückgängig</button>
        </p>
      )}
      <p className="lw-hint"><Trash2 size={12} /> Karten ziehen oder antippen und dann eine Gruppe antippen. Pfeiltasten verschieben die fokussierte Karte, Entf löscht sie.</p>
      <div className="lw-sr-only" role="status" aria-live="polite">
        {said && (said.title === null ? 'Karte zurück auf den Stapel gelegt.' : <>Karte verschoben nach <b>{said.title}</b></>)}
      </div>
      {drag?.moved && <div className="lw-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>{drag.text}</div>}
    </div>
  )
}
