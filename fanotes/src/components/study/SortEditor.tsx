import { ArrowLeftRight, Plus, Shuffle, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  addCards, addGroup, moveCard, parseCardList, removeCard, removeGroup, setMode, shuffleCards, unsortedCards,
  type SortData,
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
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const dragRef = useRef<Drag | null>(null)
  const pool = unsortedCards(data)
  const text = new Map(data.cards.map((card) => [card.id, card.text]))

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
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [Boolean(drag), onChange])

  const card = (id: string, index?: number) => (
    <div
      key={id}
      data-card-id={id}
      role="button"
      tabIndex={0}
      aria-pressed={selected === id}
      className={`study-card ${selected === id ? 'is-selected' : ''} ${drag?.id === id && drag.moved ? 'is-dragging' : ''}`}
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
          if (nextIndex >= 0 && nextIndex < data.groups.length) onChange(moveCard(data, id, data.groups[nextIndex].id))
          else if (nextIndex < 0) onChange(moveCard(data, id, null))
        } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && group) {
          event.preventDefault()
          const at = group.cards.indexOf(id)
          onChange(moveCard(data, id, group.id, at + (event.key === 'ArrowDown' ? 1 : -1)))
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          onChange(removeCard(data, id))
        }
      }}
    >
      {data.mode === 'sequence' && index !== undefined && <b>{index + 1}.</b>} {text.get(id)}
    </div>
  )

  const place = (groupId: string | null) => {
    if (!selected) return
    onChange(moveCard(data, selected, groupId))
    setSelected(null)
  }

  return (
    <div className="study-editor">
      <div className="study-actions">
        <input className="study-title-input" aria-label="Titel" placeholder="Titel" value={data.title} onChange={(event) => onChange({ ...data, title: event.target.value })} />
        <button type="button" className={`secondary-button ${data.mode === 'sequence' ? 'is-active' : ''}`} aria-pressed={data.mode === 'sequence'} onClick={() => onChange(setMode(data, data.mode === 'sequence' ? 'groups' : 'sequence'))}><ArrowLeftRight size={14} /> {data.mode === 'sequence' ? 'Reihenfolge' : 'Gruppen'}</button>
        <button type="button" className="secondary-button" onClick={() => onChange(shuffleCards(data))} title="Alle Karten mischen und zurück in den Stapel legen"><Shuffle size={14} /> Mischen</button>
      </div>
      <div className="study-add">
        <textarea aria-label="Karten hinzufügen" rows={2} placeholder="Karten eingeben oder einfügen, eine pro Zeile (oder mit Komma getrennt)" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" className="primary-button" disabled={!parseCardList(draft).length} onClick={() => { onChange(addCards(data, parseCardList(draft))); setDraft('') }}><Plus size={14} /> Hinzufügen</button>
      </div>
      <div className="study-board">
        <div className={`study-pool-zone ${selected ? 'can-drop' : ''}`} data-drop-zone="pool" onClick={() => place(null)}>
          <div className="study-group-title">Stapel ({pool.length})</div>
          <div className="study-cards">{pool.map((entry) => card(entry.id))}</div>
        </div>
        <div className="study-groups-zone">
          {data.groups.map((group) => (
            <div key={group.id} className={`study-group ${selected ? 'can-drop' : ''}`} data-drop-zone={group.id} onClick={() => place(group.id)}>
              <div className="study-group-title">
                {data.mode === 'groups'
                  ? <input aria-label="Gruppenname" value={group.title} placeholder="Gruppe" onClick={(event) => event.stopPropagation()} onChange={(event) => onChange({ ...data, groups: data.groups.map((entry) => (entry.id === group.id ? { ...entry, title: event.target.value } : entry)) })} />
                  : <span>{group.title || 'Reihenfolge'}</span>}
                {data.mode === 'groups' && data.groups.length > 1 && <button type="button" className="study-icon-btn" aria-label="Gruppe löschen" title="Gruppe löschen" onClick={(event) => { event.stopPropagation(); onChange(removeGroup(data, group.id)) }}><X size={12} /></button>}
              </div>
              <div className="study-cards">{group.cards.map((id, index) => card(id, index))}</div>
            </div>
          ))}
          {data.mode === 'groups' && <button type="button" className="secondary-button study-add-group" onClick={() => onChange(addGroup(data, `Gruppe ${data.groups.length + 1}`))}><Plus size={14} /> Gruppe</button>}
        </div>
      </div>
      <p className="study-hint"><Trash2 size={12} /> Karten ziehen oder antippen und dann eine Gruppe antippen. Pfeiltasten verschieben die fokussierte Karte, Entf löscht sie.</p>
      {drag?.moved && <div className="study-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>{drag.text}</div>}
    </div>
  )
}
