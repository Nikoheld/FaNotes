import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link2 } from 'lucide-react'
import {
  noteLinkAppearanceToken,
  noteLinkPointFromRect,
  type NoteLinkRecord,
} from '../lib/noteLink'

type MarkerLayout = {
  id: string
  left: number
  top: number
}

type NoteLinkLayerProps = {
  links: NoteLinkRecord[]
  placing: boolean
  selectedId?: string | null
  pdf: boolean
  onPlace: (point: { page: number; x: number; y: number }) => void
  onActivate: (link: NoteLinkRecord) => void
  onSelect: (link: NoteLinkRecord) => void
}

const pageAtPoint = (clientX: number, clientY: number, root: HTMLElement) => {
  const pages = root.querySelectorAll<HTMLElement>('[data-pdf-page]')
  for (const page of pages) {
    const rect = page.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    const point = noteLinkPointFromRect(clientX, clientY, rect)
    return { page: Number(page.dataset.pdfPage) || 1, ...point }
  }
  const paper = root.closest('.unified-paper') as HTMLElement | null
  const rect = (paper ?? root).getBoundingClientRect()
  return { page: 1, ...noteLinkPointFromRect(clientX, clientY, rect) }
}

export function NoteLinkLayer({
  links,
  placing,
  selectedId,
  pdf,
  onPlace,
  onActivate,
  onSelect,
}: NoteLinkLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<MarkerLayout[]>([])

  const measure = useCallback(() => {
    const layer = layerRef.current
    if (!layer) return
    const layerRect = layer.getBoundingClientRect()
    const paper = layer.closest('.unified-paper') as HTMLElement | null
    const paperRect = (paper ?? layer).getBoundingClientRect()
    setLayout(links.map((link) => {
      if (!pdf) {
        return {
          id: link.id,
          left: link.x * paperRect.width,
          top: link.y * paperRect.height,
        }
      }
      const page = paper?.querySelector<HTMLElement>(`[data-pdf-page="${link.page}"]`)
      if (!page) {
        return { id: link.id, left: link.x * paperRect.width, top: link.y * paperRect.height }
      }
      const rect = page.getBoundingClientRect()
      return {
        id: link.id,
        left: rect.left - layerRect.left + link.x * rect.width,
        top: rect.top - layerRect.top + link.y * rect.height,
      }
    }))
  }, [links, pdf])

  useLayoutEffect(() => {
    measure()
    const layer = layerRef.current
    const paper = layer?.closest('.unified-paper')
    if (!paper || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(paper)
    paper.querySelectorAll('[data-pdf-page]').forEach((page) => observer.observe(page))
    const scroller = paper.closest('.unified-note-view')
    scroller?.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      scroller?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  const handlePlace = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!placing) return
    event.preventDefault()
    event.stopPropagation()
    const layer = layerRef.current
    if (!layer) return
    onPlace(pageAtPoint(event.clientX, event.clientY, layer))
  }

  return (
    <div
      ref={layerRef}
      className={`note-link-layer ${placing ? 'is-placing' : ''}`}
      onPointerDown={placing ? handlePlace : undefined}
    >
      {links.map((link) => {
        const position = layout.find((item) => item.id === link.id)
        const appearance = noteLinkAppearanceToken(link.style)
        const showSymbol = appearance !== 'text'
        const showText = appearance !== 'symbol'
        return (
          <button
            key={link.id}
            type="button"
            className={`note-link-marker is-${appearance} ${selectedId === link.id ? 'is-selected' : ''}`}
            style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
            title={link.label}
            aria-label={link.label}
            data-note-link-style={link.style}
            onPointerDown={(event) => {
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (placing) {
                onSelect(link)
                return
              }
              onActivate(link)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              onSelect(link)
            }}
          >
            {showSymbol ? <Link2 size={14} aria-hidden="true" /> : null}
            {showText ? <span>{link.label}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
