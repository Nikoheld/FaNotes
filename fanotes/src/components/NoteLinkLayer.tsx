import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link2, X } from 'lucide-react'
import {
  noteLinkAppearanceToken,
  noteLinkMarkerCss,
  noteLinkPageAtPoint,
  type NoteLinkRecord,
} from '../lib/noteLink'
import { readUsedSheetZoom } from '../lib/paperView'

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
  onRemove?: (link: NoteLinkRecord) => void
}

export function NoteLinkLayer({
  links,
  placing,
  selectedId,
  pdf,
  onPlace,
  onActivate,
  onSelect,
  onRemove,
}: NoteLinkLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<MarkerLayout[]>([])

  const measure = useCallback(() => {
    const layer = layerRef.current
    if (!layer) return
    const layerRect = layer.getBoundingClientRect()
    const paper = layer.closest('.unified-paper') as HTMLElement | null
    const host = paper ?? layer
    const layoutWidth = host.offsetWidth
    const layoutHeight = host.offsetHeight
    const zoom = readUsedSheetZoom(host)
    const paperBox = {
      layoutWidth,
      layoutHeight,
      visualWidth: layoutWidth * zoom,
      visualHeight: layoutHeight * zoom,
    }
    setLayout(links.map((link) => {
      const page = pdf
        ? paper?.querySelector<HTMLElement>(`[data-pdf-page="${link.page}"]`)
        : null
      const pageRect = page?.getBoundingClientRect()
      const css = noteLinkMarkerCss(
        link,
        paperBox,
        pageRect
          ? { left: pageRect.left, top: pageRect.top, width: pageRect.width, height: pageRect.height }
          : null,
        { left: layerRect.left, top: layerRect.top },
      )
      return { id: link.id, left: css.left, top: css.top }
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
    onPlace(noteLinkPageAtPoint(event.clientX, event.clientY, layer))
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
        const selected = selectedId === link.id
        return (
          <div
            key={link.id}
            className={`note-link-wrap ${selected ? 'is-selected' : ''}`}
            style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
          >
            <button
              type="button"
              className={`note-link-marker is-${appearance} ${selected ? 'is-selected' : ''}`}
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
            {onRemove && (
              <button
                type="button"
                className="note-link-remove"
                title="Verlinkung entfernen"
                aria-label="Verlinkung entfernen"
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelect(link)
                  onRemove(link)
                }}
              >
                <X size={11} aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
