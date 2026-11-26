import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { uiText } from '../i18n'

export type SharePeople = { editors: string[]; present: string[]; self: string }

const MAX_AVATARS = 4
// Mid-tone fills that keep white initials readable (>= 4.5:1) and stay distinct on light and dark panels.
const PALETTE = ['#b3402f', '#9a5b00', '#52751c', '#1c7a4f', '#0f766e', '#1d6fa5', '#4a55c4', '#7b4bb7', '#a8387c', '#5d6b7a']

export const personColor = (name: string) => {
  let hash = 2166136261
  for (let index = 0; index < name.length; index += 1) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619)
  return PALETTE[(hash >>> 0) % PALETTE.length]
}

export const personInitials = (name: string) => {
  const words = name.trim().split(/[\s._-]+/u).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words[words.length - 1]].map((word) => Array.from(word)[0]) : Array.from(words[0] ?? '?').slice(0, 2)
  return letters.join('').toLocaleUpperCase()
}

const Avatar = ({ name }: { name: string }) => (
  <span className="share-avatar" style={{ background: personColor(name) }} aria-hidden="true" data-i18n-ignore>{personInitials(name)}</span>
)

// Word / Docs style presence: small overlapping circles for the other people editing right now. A click lists everybody.
export const SharePresence = memo(function SharePresence({ people }: { people: SharePeople | null }) {
  const others = useMemo(() => (people ? people.present.filter((name) => name !== people.self) : []), [people])
  const [open, setOpen] = useState(false)
  const [tip, setTip] = useState<{ text: string; top: number; right: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const previous = useRef<string[] | null>(null)

  // Polite announcement of joins and leaves only (not for the initial list), one short sentence per change.
  useEffect(() => {
    const before = previous.current
    previous.current = others
    if (!before) return
    const joined = others.filter((name) => !before.includes(name))
    const left = before.filter((name) => !others.includes(name))
    if (!joined.length && !left.length) return
    setAnnouncement([
      joined.length ? `${joined.join(', ')} ${uiText('bearbeitet jetzt mit', 'is now editing')}` : '',
      left.length ? `${left.join(', ')} ${uiText('hat die Notiz verlassen', 'left the note')}` : '',
    ].filter(Boolean).join('. '))
  }, [others])

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const box = buttonRef.current.getBoundingClientRect()
    setPosition({ top: Math.round(box.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - box.right)) })
  }, [open, others.length])

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // Focus moves into the popover when it opens (it is a read-only list, so the dialog itself takes it); Escape returns it.
  useEffect(() => { if (open && position) popoverRef.current?.focus({ preventScroll: true }) }, [open, position !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!others.length) { setOpen(false); setTip(null) } }, [others.length])

  const showTip = useCallback((text: string) => {
    const box = buttonRef.current?.getBoundingClientRect()
    if (box) setTip({ text, top: Math.round(box.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - box.right)) })
  }, [])
  const toggle = useCallback(() => setOpen((value) => !value), [])
  const shown = others.slice(0, MAX_AVATARS)
  const extra = others.length - shown.length
  const label = others.length === 1
    ? uiText(`${others[0]} bearbeitet gerade`, `${others[0]} is editing now`)
    : uiText(`${others.length} Personen bearbeiten gerade`, `${others.length} people are editing now`)

  return (
    <div className="share-presence">
      <span className="sr-only" role="status" aria-live="polite" data-i18n-ignore>{announcement}</span>
      {people && others.length > 0 && (
        <>
          <button
            ref={buttonRef}
            type="button"
            className="share-presence-button"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={toggle}
            onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showTip(others.join(', ')) }}
            onBlur={() => setTip(null)}
            onMouseLeave={() => setTip(null)}
          >
            {shown.map((name) => (
              <span key={name} className="share-avatar-slot" onMouseEnter={() => showTip(name)}><Avatar name={name} /></span>
            ))}
            {extra > 0 && <span className="share-avatar-slot"><span className="share-avatar share-avatar-more" aria-hidden="true" data-i18n-ignore>+{extra}</span></span>}
          </button>
          {tip && !open && (
            <span className="share-presence-tip" role="tooltip" style={{ top: tip.top, right: tip.right }}>
              <strong data-i18n-ignore>{tip.text}</strong> {tip.text.includes(', ') ? uiText('bearbeiten gerade', 'are editing now') : uiText('bearbeitet gerade', 'is editing now')}
            </span>
          )}
        </>
      )}
      {open && position && people && (
        <div ref={popoverRef} tabIndex={-1} className="ftb-popover share-presence-popover" role="dialog" aria-label={uiText('Wer bearbeitet gerade', 'Who is editing')} style={{ top: position.top, right: position.right, left: 'auto' }}>
          <section>
            <h3>Gerade am Bearbeiten</h3>
            <ul>
              {others.map((name) => <li key={name}><Avatar name={name} /><span data-i18n-ignore>{name}</span></li>)}
            </ul>
          </section>
          <section>
            <h3>Personen, die bearbeiten können</h3>
            <ul>
              {people.editors.map((name) => <li key={name}><Avatar name={name} /><span data-i18n-ignore>{name}{name === people.self ? ` (${uiText('du', 'you')})` : ''}</span></li>)}
            </ul>
          </section>
        </div>
      )}
    </div>
  )
})
