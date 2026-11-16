import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { isDrawingInkSurfaceTarget } from '../lib/overlayInteract'
import {
  QUICK_MENU_COLOR_RADIUS,
  QUICK_MENU_EXTENT,
  QUICK_MENU_ITEM_SIZE,
  QUICK_MENU_TOOL_RADIUS,
  clampQuickMenuCenter,
  pointerTipDown,
  ringPositions,
} from '../lib/penQuickMenu'

export type PenQuickMenuTool = {
  id: string
  label: string
  icon: ReactNode
  active: boolean
}

type PenQuickMenuProps = {
  x: number
  y: number
  /** Pointer whose tip opened the menu. Lifting it over an option picks that option. */
  pointerId: number
  tools: readonly PenQuickMenuTool[]
  colors: readonly string[]
  activeColor: string
  onTool: (id: string) => void
  onColor: (color: string) => void
  onClose: () => void
}

const ITEM_SELECTOR = '[data-pen-quick-item]'

/**
 * Radial quick menu at the pen: tools on the inner ring, colours on the outer
 * ring. Tap an option, or keep the tip down, slide onto one and lift.
 */
export function PenQuickMenu({
  x,
  y,
  pointerId,
  tools,
  colors,
  activeColor,
  onTool,
  onColor,
  onClose,
}: PenQuickMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const center = clampQuickMenuCenter(
    x,
    y,
    typeof window === 'undefined' ? x * 2 : window.innerWidth,
    typeof window === 'undefined' ? y * 2 : window.innerHeight,
  )

  useEffect(() => {
    // The tip that opened the menu is still down: lifting it over an option picks it.
    let armed = true
    const pickAt = (clientX: number, clientY: number) => {
      const root = rootRef.current
      const hit = document.elementFromPoint(clientX, clientY)
      const item = hit instanceof Element ? hit.closest(ITEM_SELECTOR) : null
      if (root && item instanceof HTMLElement && root.contains(item)) item.click()
    }
    const onMove = (event: PointerEvent) => {
      if (!armed || event.pointerId !== pointerId) return
      if (pointerTipDown(event)) return
      armed = false
      pickAt(event.clientX, event.clientY)
    }
    const onUp = (event: PointerEvent) => {
      if (!armed || event.pointerId !== pointerId) return
      armed = false
      if (event.type === 'pointerup') pickAt(event.clientX, event.clientY)
    }
    const onDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root && event.target instanceof Node && root.contains(event.target)) return
      // A tap on the page only dismisses the menu: it must not leave a dot of ink.
      if (isDrawingInkSurfaceTarget(event.target)) {
        if (event.cancelable) event.preventDefault()
        event.stopPropagation()
      }
      closeRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    const onBlur = () => closeRef.current()
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [pointerId])

  const toolSpots = ringPositions(tools.length, QUICK_MENU_TOOL_RADIUS)
  const colorSpots = ringPositions(colors.length, QUICK_MENU_COLOR_RADIUS, 0.5)
  const current = activeColor.toLowerCase()
  const place = (spot: { x: number; y: number }) => ({
    '--pqm-x': `${spot.x}px`,
    '--pqm-y': `${spot.y}px`,
  }) as CSSProperties

  return (
    <div
      ref={rootRef}
      className="lw-pen-quick-menu"
      role="menu"
      aria-label="Schnellauswahl Stift und Farbe"
      data-fanotes-drawing-chrome="quick-menu"
      style={{
        left: `${center.x}px`,
        top: `${center.y}px`,
        '--pqm-extent': `${QUICK_MENU_EXTENT}px`,
        '--pqm-item': `${QUICK_MENU_ITEM_SIZE}px`,
      } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <style>{penQuickMenuStyles}</style>
      <div className="lw-pqm-disc" aria-hidden="true" />
      <button
        type="button"
        className="lw-pqm-hub"
        aria-label="Schnellauswahl schliessen"
        title="Schliessen"
        onClick={() => closeRef.current()}
      ><X size={16} /></button>
      {tools.map((tool, index) => (
        <button
          key={tool.id}
          type="button"
          role="menuitemradio"
          aria-checked={tool.active}
          aria-label={tool.label}
          title={tool.label}
          data-pen-quick-item={`tool:${tool.id}`}
          className={`lw-pqm-item lw-pqm-tool${tool.active ? ' is-active' : ''}`}
          style={place(toolSpots[index])}
          onClick={() => onTool(tool.id)}
        >{tool.icon}</button>
      ))}
      {colors.map((color, index) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          aria-checked={current === color.toLowerCase()}
          aria-label={`Farbe ${color}`}
          title={`Farbe ${color}`}
          data-pen-quick-item={`color:${color}`}
          className={`lw-pqm-item lw-pqm-color${current === color.toLowerCase() ? ' is-active' : ''}`}
          style={{ ...place(colorSpots[index]), '--pqm-color': color } as CSSProperties}
          onClick={() => onColor(color)}
        />
      ))}
    </div>
  )
}

const penQuickMenuStyles = `
.lw-pen-quick-menu{position:fixed;z-index:1200;width:0;height:0;touch-action:none;user-select:none;-webkit-user-select:none}
.lw-pqm-disc{position:absolute;left:calc(var(--pqm-extent) * -1);top:calc(var(--pqm-extent) * -1);width:calc(var(--pqm-extent) * 2);height:calc(var(--pqm-extent) * 2);border:1px solid var(--border-strong,var(--border,#4446));border-radius:50%;background:color-mix(in srgb,var(--panel,#1d1f26) 92%,transparent);box-shadow:var(--shadow,0 18px 50px rgba(0,0,0,.28));backdrop-filter:blur(10px);animation:lw-pqm-in .14s cubic-bezier(.2,.8,.2,1)}
.lw-pqm-hub,.lw-pqm-item{position:absolute;display:grid;place-items:center;padding:0;border-radius:50%;cursor:pointer;touch-action:none;animation:lw-pqm-in .14s cubic-bezier(.2,.8,.2,1)}
.lw-pqm-hub{left:-17px;top:-17px;width:34px;height:34px;border:1px solid var(--border,#4446);color:var(--text-muted,#999);background:var(--panel-strong,var(--panel,#25272f))}
.lw-pqm-hub:hover{color:var(--text,#eee)}
.lw-pqm-item{left:calc(var(--pqm-x) - var(--pqm-item) / 2);top:calc(var(--pqm-y) - var(--pqm-item) / 2);width:var(--pqm-item);height:var(--pqm-item)}
.lw-pqm-tool{border:1px solid var(--border,#4446);color:var(--text,#eee);background:var(--panel-strong,var(--panel,#25272f))}
.lw-pqm-tool:hover{border-color:var(--accent,#7c8cff);transform:scale(1.08)}
.lw-pqm-tool.is-active{border-color:var(--accent,#7c8cff);color:var(--on-accent,#fff);background:var(--accent,#7c8cff)}
.lw-pqm-color{border:2px solid var(--panel,#1d1f26);background:var(--pqm-color);box-shadow:0 0 0 1px var(--border-strong,var(--border,#4446))}
.lw-pqm-color:hover{transform:scale(1.12)}
.lw-pqm-color.is-active{box-shadow:0 0 0 2px var(--panel,#1d1f26),0 0 0 4px var(--accent,#7c8cff)}
.lw-pqm-hub:focus-visible,.lw-pqm-item:focus-visible{outline:2px solid var(--accent,#7c8cff);outline-offset:2px}
@keyframes lw-pqm-in{from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.lw-pqm-disc,.lw-pqm-hub,.lw-pqm-item{animation:none}.lw-pqm-tool:hover,.lw-pqm-color:hover{transform:none}}
`
