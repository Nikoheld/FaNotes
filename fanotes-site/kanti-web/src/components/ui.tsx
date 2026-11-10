import { useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import mark from '@brand/kanti.svg'

// Outlined 24px glyphs in the app's icon style (Material Symbols outlines), inline so the strict CSP holds.
const PATHS: Record<string, string> = {
  today: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4ZM11.1 1h1.8v3h-1.8zm0 19h1.8v3h-1.8zM1 11.1h3v1.8H1zm19 0h3v1.8h-3zM4.2 5.5l1.3-1.3 2.1 2.1-1.3 1.3zm12.2 12.2 1.3-1.3 2.1 2.1-1.3 1.3zM16.4 6.3l2.1-2.1 1.3 1.3-2.1 2.1zM4.2 18.5l2.1-2.1 1.3 1.3-2.1 2.1z',
  timetable: 'M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zm-2 8v10h14V10zm0-2h14V6H5zm2 4h4v3H7zm6 0h4v3h-4zm-6 4.5h4V19H7z',
  grades: 'M4 20V10h3v10zm6.5 0V4h3v16zM17 20v-7h3v7z',
  agenda: 'M17 12h-5v5h5zM16 1v2H8V1H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1V1zm3 18H5V8h14z',
  absences: 'M12 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 1.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4ZM4 20c0-3.3 3.6-6 8-6 1 0 2 .2 2.9.4l-1.6 1.6A9 9 0 0 0 12 15.8c-3.4 0-6.2 1.9-6.2 4.2H4Zm11.3-3.6 1.3-1.3 1.9 1.9 1.9-1.9 1.3 1.3-1.9 1.9 1.9 1.9-1.3 1.3-1.9-1.9-1.9 1.9-1.3-1.3 1.9-1.9z',
  updates: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 2v.5l-8 5-8-5V6zM4 18V8.8l8 5 8-5V18z',
  settings: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.8 1.7 1L11 21h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-1-3.2a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z',
  search: 'M10 3a7 7 0 0 1 5.6 11.2l5.6 5.6-1.4 1.4-5.6-5.6A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  refresh: 'M17.6 6.4A8 8 0 1 0 19.7 14h-2.1A6 6 0 1 1 12 6c1.7 0 3.1.7 4.2 1.8L13 11h7V4z',
  left: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z',
  right: 'M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z',
  close: 'm19 6.4-1.4-1.4-5.6 5.6L6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  room: 'M14 6v15H3v-2h2V3h9v1h5v15h2v2h-4V6zm-4 5v2h2v-2z',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4Z',
  bell: 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1zm-2 1H8v-6c0-2.5 1.5-4.5 4-4.5s4 2 4 4.5z',
  logout: 'M17 7 15.6 8.4 18.2 11H8v2h10.2l-2.6 2.6L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4z',
  phone: 'M17 1H7a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2Zm0 18H7V5h10zm-5 3.2a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  key: 'M12.6 10a5 5 0 1 0 0 4H17v3h3v-3h2v-4zM7.5 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z',
  play: 'M8 5v14l11-7z',
  eye: 'M12 5c-5 0-9.3 3.1-11 7.5C2.7 16.9 7 20 12 20s9.3-3.1 11-7.5C21.3 8.1 17 5 12 5Zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  eyeOff: 'M12 7a5 5 0 0 1 5 5c0 .6-.1 1.3-.4 1.8l2.9 2.9A11.8 11.8 0 0 0 23 12.5C21.3 8.1 17 5 12 5c-1.4 0-2.7.2-4 .7l2.2 2.1A5 5 0 0 1 12 7ZM2 4.3l2.3 2.3.5.5A11.8 11.8 0 0 0 1 12.5C2.7 16.9 7 20 12 20c1.6 0 3-.3 4.4-.8l.4.4L19.7 22l1.3-1.3L3.3 3zM7.5 9.8 9 11.3a3 3 0 0 0 3.7 3.7l1.5 1.5A5 5 0 0 1 7.5 9.8Z',
  keyboard: 'M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 12H4V7h16zM6 9h2v2H6zm3 0h2v2H9zm3 0h2v2h-2zm3 0h3v2h-3zM6 12h3v2H6zm4 0h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zM8 15h8v1H8z',
  swap: 'M6.99 11 3 15l3.99 4v-3H14v-2H6.99zM21 9l-3.99-4v3H10v2h7.01v3z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  warning: 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z',
  snow: 'M22 11h-4.2l3.2-3.2-1.4-1.4L15 11h-2V9l4.6-4.6-1.4-1.4L13 6.2V2h-2v4.2L7.8 3 6.4 4.4 11 9v2H9L4.4 6.4 3 7.8 6.2 11H2v2h4.2L3 16.2l1.4 1.4L9 13h2v2l-4.6 4.6L7.8 21l3.2-3.2V22h2v-4.2l3.2 3.2 1.4-1.4L13 15v-2h2l4.6 4.6 1.4-1.4-3.2-3.2H22z',
  open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3z',
}

export type IconName = keyof typeof PATHS

export const Icon = ({ name, size = 20, label }: { name: IconName; size?: number; label?: string }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
    <path d={PATHS[name]} fill="currentColor" />
  </svg>
)

/** The K+ mark from the app's brand master (android/companion/docs/brand/kanti.svg). */
export const Logo = ({ size = 32 }: { size?: number }) => <img className="logo" src={mark} width={size} height={size} alt="" />

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'quiet' | 'danger' | 'outline'; icon?: IconName }

export const Button = ({ tone = 'primary', icon, children, className = '', ...rest }: ButtonProps) => (
  <button type="button" className={`button button-${tone} ${className}`} {...rest}>
    {icon ? <Icon name={icon} size={18} /> : null}
    {children ? <span>{children}</span> : null}
  </button>
)

export const IconButton = ({ icon, label, onClick, active = false, disabled = false }: { icon: IconName; label: string; onClick: () => void; active?: boolean; disabled?: boolean }) => (
  <button type="button" className={`icon-button${active ? ' active' : ''}`} onClick={onClick} aria-label={label} title={label} disabled={disabled}>
    <Icon name={icon} />
  </button>
)

export const Tag = ({ tone = 'neutral', children }: { tone?: 'neutral' | 'danger' | 'warning' | 'success' | 'accent'; children: ReactNode }) => <span className={`tag tag-${tone}`}>{children}</span>

export const RoomPill = ({ room, label }: { room: string; label: string }) => (
  <span className="room-pill" aria-label={`${label} ${room}`}><Icon name="room" size={15} /><span className="tabular">{room}</span></span>
)

export const Card = ({ children, className = '', ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) => <section className={`card ${className}`} {...rest}>{children}</section>

export const SectionLabel = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="section-label"><h2>{children}</h2>{action}</div>
)

export const Empty = ({ icon = 'info', children }: { icon?: IconName; children: ReactNode }) => (
  <div className="empty"><Icon name={icon} size={22} /><p>{children}</p></div>
)

export const Banner = ({ tone = 'accent', icon = 'info', children, action }: { tone?: 'accent' | 'warning' | 'danger'; icon?: IconName; children: ReactNode; action?: ReactNode }) => (
  <div className={`banner banner-${tone}`} role="status"><Icon name={icon} /><div className="banner-text">{children}</div>{action}</div>
)

export const Toggle = ({ checked, onChange, label, detail, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail?: string; disabled?: boolean }) => (
  <label className={`toggle-row${disabled ? ' disabled' : ''}`}>
    <span className="toggle-text"><span>{label}</span>{detail ? <small>{detail}</small> : null}</span>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span className="switch" aria-hidden="true" />
  </label>
)

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>

/** A modal dialog: focus moves in, Escape and the backdrop close it, focus returns afterwards. */
export const Dialog = ({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) => {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = box.current?.querySelector<HTMLElement>('input, button, select, textarea, [tabindex]:not([tabindex="-1"])')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab' && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>('input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((item) => !item.hasAttribute('disabled'))
        if (!items.length) return
        const [head, tail] = [items[0], items[items.length - 1]]
        if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus() }
        else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus?.() }
  }, [onClose])
  return (
    <div className="backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <header className="dialog-head"><h2>{title}</h2><IconButton icon="close" label="×" onClick={onClose} /></header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  )
}

/** The day as one measured line: one segment per lesson, past ones muted, the current or next one raised. */
export const DayBand = ({ lessons, clock, focusKey }: { lessons: { key: string; start: string; end: string; cancelled: boolean }[]; clock: number; focusKey: string }) => {
  const minutes = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/u.exec(value)
    return match ? Number(match[1]) * 60 + Number(match[2]) : null
  }
  const sorted = [...lessons].sort((left, right) => left.start.localeCompare(right.start))
  if (sorted.length < 2) return null
  return (
    <div className="day-band" aria-hidden="true">
      <div className="day-band-track">
        {sorted.map((lesson) => {
          const end = minutes(lesson.end) ?? minutes(lesson.start) ?? 0
          const start = minutes(lesson.start) ?? 0
          const focus = lesson.key === focusKey || (start <= clock && clock < end)
          const done = end <= clock
          return <span key={lesson.key} className={`segment${focus ? ' focus' : ''}${done ? ' done' : ''}${lesson.cancelled ? ' cancelled' : ''}`} />
        })}
      </div>
      <div className="day-band-ends tabular"><span>{sorted[0].start}</span><span>{sorted[sorted.length - 1].end || sorted[sorted.length - 1].start}</span></div>
    </div>
  )
}

/** The Snow theme's 14 seconds of snowfall over the Heute card (the app's Snowfall.kt). Off with reduced motion. */
export const Snowfall = () => {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setDone(true); return }
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    let seed = 46
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const flakes = Array.from({ length: 26 }, (_, index) => ({ x: random(), y: random(), radius: 1.4 + random() * 2.2, speed: 0.05 + random() * 0.07, sway: 0.01 + random() * 0.025, phase: random() * 6.28, accent: index % 3 === 0 }))
    const accent = getComputedStyle(element).getPropertyValue('--accent').trim() || '#2766a0'
    const started = performance.now()
    let frame = 0
    const draw = (now: number) => {
      const seconds = (now - started) / 1000
      const fade = Math.min(2, Math.max(0, 14 - seconds)) / 2
      const ratio = window.devicePixelRatio || 1
      const width = element.clientWidth
      const height = element.clientHeight
      if (element.width !== Math.round(width * ratio)) { element.width = Math.round(width * ratio); element.height = Math.round(height * ratio) }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      if (fade <= 0) { setDone(true); return }
      for (const flake of flakes) {
        const travelled = (flake.y + seconds * flake.speed) % 1.15
        const x = (flake.x + Math.sin(seconds * 0.9 + flake.phase) * flake.sway) * width
        const y = (travelled - 0.1) * height
        context.globalAlpha = (flake.accent ? 0.32 : 0.92) * fade
        context.fillStyle = flake.accent ? accent : '#ffffff'
        context.beginPath()
        context.arc(x, y, flake.radius, 0, Math.PI * 2)
        context.fill()
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])
  if (done) return null
  return <canvas className="snowfall" ref={canvas} aria-hidden="true" />
}
