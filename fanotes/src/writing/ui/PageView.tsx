import { memo, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { caretX, type LineBox, type ParagraphLayout } from '../layout/linebreak'
import { cssFont, type TextMeasurer } from '../layout/measure'
import type { ManuscriptLayout, Page } from '../layout/paginate'
import type { Doc, Pos } from '../editor/doc'
import { blockLength } from '../editor/doc'
import type { CaretBox } from './navigation'

export type ViewMode = 'page' | 'spread' | 'draft'
export type PageTheme = 'paper' | 'sepia' | 'night' | 'contrast'
export type Highlight = { block: string; from: number; to: number; current?: boolean }
export type Underline = { block: string; from: number; to: number; kind: 'spelling' | 'grammar' | 'style' }

export type PagePointer = { page: number; x: number; y: number; detail: number; shift: boolean; button: number; pointerType: string }

type Props = {
  layout: ManuscriptLayout
  doc: Doc
  measurer: TextMeasurer
  zoom: number
  view: ViewMode
  theme: PageTheme
  caret: CaretBox | null
  caretVisible: boolean
  selection: { from: Pos; to: Pos } | null
  focusBlock: string | null
  highlights: Highlight[]
  /** Assistant underlines for a block, asked for the pages in view only. */
  underlinesFor?: (blockIndex: number) => Underline[]
  /** The scrolling element (set once it is mounted; the view listens to it). */
  scroller: HTMLDivElement | null
  onPointerDown: (pointer: PagePointer) => void
  onPointerMove: (pointer: PagePointer) => void
  onPointerUp: (pointer?: PagePointer) => void
  onContextMenu?: (pointer: PagePointer) => void
}

export const GAP = 28
const SPREAD_GAP = 4

export type PageRect = { left: number; top: number; width: number; height: number }

/** Page positions in the scroll area (zoomed px). */
export const pageRects = (layout: ManuscriptLayout, zoom: number, view: ViewMode, containerWidth: number): { rects: PageRect[]; width: number; height: number } => {
  const width = layout.pageWidth * zoom
  const height = layout.pageHeight * zoom
  const rects: PageRect[] = []
  if (view === 'spread') {
    const rowWidth = width * 2 + SPREAD_GAP
    const left = Math.max(GAP, (containerWidth - rowWidth) / 2)
    layout.pages.forEach((page, index) => {
      // The first page is a right-hand page on its own, like an open book.
      const slot = index + (layout.pages[0]?.side === 'right' ? 1 : 0)
      const row = Math.floor(slot / 2)
      const right = slot % 2 === 1
      rects.push({ left: left + (right ? width + SPREAD_GAP : 0), top: GAP + row * (height + GAP), width, height })
    })
    const rows = Math.ceil((layout.pages.length + 1) / 2)
    return { rects, width: Math.max(containerWidth, rowWidth + GAP * 2), height: GAP + rows * (height + GAP) }
  }
  const gap = view === 'draft' ? 0 : GAP
  const left = Math.max(GAP, (containerWidth - width) / 2)
  layout.pages.forEach((_, index) => rects.push({ left, top: GAP + index * (height + gap), width, height }))
  return { rects, width: Math.max(containerWidth, width + GAP * 2), height: GAP * 2 + layout.pages.length * (height + gap) }
}

/** The rect of one page, without building all of them (used per keystroke for the caret). */
export const caretPageRect = (layout: ManuscriptLayout, index: number, zoom: number, view: ViewMode, containerWidth: number): PageRect | null => {
  if (!layout.pages[index]) return null
  if (view === 'spread') return pageRects(layout, zoom, view, containerWidth).rects[index] ?? null
  const width = layout.pageWidth * zoom
  const height = layout.pageHeight * zoom
  const gap = view === 'draft' ? 0 : GAP
  return { left: Math.max(GAP, (containerWidth - width) / 2), top: GAP + index * (height + gap), width, height }
}

const pieceStyle = (measurer: TextMeasurer, box: LineBox, piece: LineBox['pieces'][number]) => {
  const metrics = measurer.metrics(piece.font)
  const ownBaseline = (box.height - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent
  const top = box.baseline - ownBaseline - piece.shift
  const marks = piece.marks
  const decoration = [marks?.u || marks?.link ? 'underline' : '', marks?.s ? 'line-through' : ''].filter(Boolean).join(' ')
  return {
    left: piece.x,
    top,
    lineHeight: `${box.height}px`,
    font: cssFont(piece.font),
    ...(marks?.color ? { color: marks.color } : {}),
    ...(marks?.hl ? { background: marks.hl } : {}),
    ...(decoration ? { textDecoration: decoration } : {}),
    ...(piece.kind === 'space' ? { width: piece.width } : {}),
  }
}

/** One line; re-renders only when its layout object changes. */
const LineView = memo(function LineView({ box, x, y, measurer, dimmed, conflict }: { box: LineBox; x: number; y: number; measurer: TextMeasurer; dimmed: boolean; conflict: boolean }) {
  return (
    <div className={`wm-line${dimmed ? ' is-dimmed' : ''}${conflict ? ' is-conflict' : ''}`} style={{ left: x, top: y, height: box.height, width: box.available }}>
      {box.pieces.map((piece) => {
        if (piece.kind === 'newline' || piece.hang) return null
        if (piece.kind === 'space' && !(piece.marks?.u || piece.marks?.s || piece.marks?.hl || piece.marks?.link)) return null
        return (
          <span key={piece.from * 4 + (piece.kind === 'anchor' ? 1 : 0)} className={piece.kind === 'anchor' ? 'wm-fn-ref' : undefined} style={pieceStyle(measurer, box, piece)}>
            {piece.kind === 'space' ? ' ' : piece.display}{piece.hyphen ? '-' : ''}
          </span>
        )
      })}
    </div>
  )
})

const HeaderFooter = ({ parts, y, page, layout }: { parts: Page['header']; y: number; page: Page; layout: ManuscriptLayout }) => {
  if (!parts || (!parts.left && !parts.center && !parts.right)) return null
  const font = cssFont({ family: layout.blocks[0] ? 'literata' : 'literata', bold: false, italic: false, size: 12 })
  return (
    <div className="wm-hf" style={{ left: page.content.x, top: y, width: page.content.width, font }}>
      <span>{parts.left}</span><span>{parts.center}</span><span>{parts.right}</span>
    </div>
  )
}

const rangeRects = (layout: ManuscriptLayout, page: Page, doc: Doc, from: Pos, to: Pos, measurer: TextMeasurer) => {
  const start = doc.index.get(from.block) ?? -1
  const end = doc.index.get(to.block) ?? -1
  const rects: Array<{ left: number; top: number; width: number; height: number }> = []
  for (const placed of page.lines) {
    if (placed.blockIndex < start || placed.blockIndex > end) continue
    const paragraph: ParagraphLayout = layout.layouts[placed.blockIndex]
    const box = paragraph.lines[placed.lineIndex]
    const block = layout.blocks[placed.blockIndex]
    const a = placed.blockIndex === start ? from.offset : 0
    const b = placed.blockIndex === end ? to.offset : blockLength(block)
    const lineFrom = Math.max(a, box.from)
    const lineTo = Math.min(b, box.to)
    if (lineFrom > lineTo || (lineFrom === lineTo && !(b > box.to))) continue
    const x1 = caretX(paragraph, placed.lineIndex, lineFrom, measurer)
    // A selection that continues past the line end covers the rest of the line.
    const x2 = b > box.to || (placed.blockIndex < end && box.last) ? Math.max(caretX(paragraph, placed.lineIndex, lineTo, measurer), box.width) + (placed.blockIndex < end && box.last ? 6 : 0) : caretX(paragraph, placed.lineIndex, lineTo, measurer)
    if (x2 - x1 < 0.5) continue
    rects.push({ left: placed.x + x1, top: placed.y, width: x2 - x1, height: box.height })
  }
  return rects
}

const PageBox = memo(function PageBox(props: {
  page: Page
  layout: ManuscriptLayout
  rect: PageRect
  zoom: number
  view: ViewMode
  measurer: TextMeasurer
  doc: Doc
  caret: CaretBox | null
  caretVisible: boolean
  selection: { from: Pos; to: Pos } | null
  focusBlock: string | null
  highlights: Highlight[]
  underlinesFor?: Props['underlinesFor']
  onPointerDown: Props['onPointerDown']
  onContextMenu?: (pointer: PagePointer) => void
  onPointerMove: Props['onPointerMove']
  onPointerUp: Props['onPointerUp']
}) {
  const { page, layout, rect, zoom, measurer } = props
  const pointer = (event: ReactPointerEvent<HTMLDivElement>): PagePointer => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { page: page.index, x: (event.clientX - bounds.left) / zoom, y: (event.clientY - bounds.top) / zoom, detail: event.detail, shift: event.shiftKey, button: event.button, pointerType: event.pointerType }
  }
  const selectionRects = props.selection ? rangeRects(layout, page, props.doc, props.selection.from, props.selection.to, measurer) : []
  const highlightRects = props.highlights.flatMap((highlight) => rangeRects(layout, page, props.doc, { block: highlight.block, offset: highlight.from }, { block: highlight.block, offset: highlight.to }, measurer).map((value) => ({ ...value, current: highlight.current })))
  const pageBlocks = [...new Set(page.lines.map((placed) => placed.blockIndex))]
  const underlines = props.underlinesFor ? pageBlocks.flatMap((blockIndex) => props.underlinesFor!(blockIndex)) : []
  const underlineRects = underlines.flatMap((underline) => rangeRects(layout, page, props.doc, { block: underline.block, offset: underline.from }, { block: underline.block, offset: underline.to }, measurer).map((value) => ({ ...value, kind: underline.kind })))
  const setup = layout
  return (
    <div
      className={`wm-page${page.blank ? ' is-blank' : ''}${props.view === 'draft' ? ' is-draft' : ''}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      data-page={page.index}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); props.onPointerDown(pointer(event)) }}
      onPointerMove={(event) => { if (event.buttons & 1) props.onPointerMove(pointer(event)) }}
      onPointerUp={(event) => props.onPointerUp(pointer(event))}
      onContextMenu={(event) => { if (props.onContextMenu) { event.preventDefault(); props.onContextMenu(pointer(event as unknown as ReactPointerEvent<HTMLDivElement>)) } }}
      // The hidden input keeps the focus; a click on paper must not take it away.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="wm-page-inner" style={{ width: setup.pageWidth, height: setup.pageHeight, transform: `scale(${zoom})` }}>
        {highlightRects.map((value, index) => <div key={`h${index}`} className={`wm-highlight${value.current ? ' is-current' : ''}`} style={value} />)}
        {selectionRects.map((value, index) => <div key={`s${index}`} className="wm-selection" style={value} />)}
        {props.view !== 'draft' && <HeaderFooter parts={page.header} y={Math.max(4, page.content.y - 34)} page={page} layout={layout} />}
        {page.lines.map((placed) => {
          const box = layout.layouts[placed.blockIndex].lines[placed.lineIndex]
          const block = layout.blocks[placed.blockIndex]
          return <LineView key={`${block.key}:${placed.lineIndex}`} box={box} x={placed.x} y={placed.y} measurer={measurer} dimmed={Boolean(props.focusBlock) && block.key !== props.focusBlock} conflict={Boolean(block.conflictOf)} />
        })}
        {page.dropCaps.map((drop) => {
          const cap = layout.layouts[drop.blockIndex].dropCap!
          const metrics = measurer.metrics(cap.font)
          const block = layout.blocks[drop.blockIndex]
          return (
            <span key={`d${drop.blockIndex}`} className={`wm-dropcap${props.focusBlock && block.key !== props.focusBlock ? ' is-dimmed' : ''}`} style={{ left: drop.x, top: drop.y + cap.baseline - metrics.ascent, font: cssFont(cap.font), lineHeight: `${metrics.ascent + metrics.descent}px` }}>
              {cap.text}
            </span>
          )
        })}
        {underlineRects.map((value, index) => <div key={`u${index}`} className={`wm-underline is-${value.kind}`} style={{ left: value.left, top: value.top + value.height - 3, width: value.width }} />)}
        {page.footnotes.length > 0 && (
          <>
            <div className="wm-fn-rule" style={{ left: page.content.x, top: page.footnotes[0].y - 6, width: page.content.width * 0.3 }} />
            {page.footnotes.map((note) => {
              let y = note.y
              return note.layout.lines.map((box, index) => {
                const line = <LineView key={`${note.id}:${index}`} box={box} x={page.content.x + box.x} y={y} measurer={measurer} dimmed={false} conflict={false} />
                y += box.height
                return line
              })
            })}
          </>
        )}
        {props.view !== 'draft' && <HeaderFooter parts={page.footer} y={page.content.y + page.content.height + 14} page={page} layout={layout} />}
        {props.caret && props.caret.page === page.index && (
          <div className={`wm-caret${props.caretVisible ? '' : ' is-hidden'}`} style={{ left: props.caret.x, top: props.caret.y, height: props.caret.height }} />
        )}
      </div>
    </div>
  )
})

/** The pages in view (plus a margin); the rest are not in the DOM. */
export function PageView(props: Props) {
  const { layout, zoom, view, scroller } = props
  const [viewport, setViewport] = useState({ top: 0, height: 900, width: 1000 })
  const frame = useRef(0)
  useLayoutEffect(() => {
    const element = scroller
    if (!element) return
    const update = () => {
      frame.current = 0
      setViewport({ top: element.scrollTop, height: element.clientHeight, width: element.clientWidth })
    }
    update()
    const onScroll = () => { if (!frame.current) frame.current = requestAnimationFrame(update) }
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (frame.current) cancelAnimationFrame(frame.current)
    }
  }, [scroller])
  const geometry = useMemo(() => pageRects(layout, zoom, view, viewport.width), [layout, zoom, view, viewport.width])
  const visible = geometry.rects
    .map((rect, index) => ({ rect, index }))
    .filter(({ rect }) => rect.top + rect.height >= viewport.top - viewport.height && rect.top <= viewport.top + viewport.height * 2)
  return (
    <div className={`wm-pages is-${view} theme-${props.theme}`} style={{ width: geometry.width, height: geometry.height }} data-i18n-ignore>
      {visible.map(({ rect, index }) => (
        <PageBox
          key={index}
          page={layout.pages[index]}
          layout={layout}
          rect={rect}
          zoom={zoom}
          view={view}
          measurer={props.measurer}
          doc={props.doc}
          caret={props.caret?.page === index ? props.caret : null}
          caretVisible={props.caretVisible}
          selection={props.selection}
          focusBlock={props.focusBlock}
          highlights={props.highlights}
          underlinesFor={props.underlinesFor}
          onContextMenu={props.onContextMenu}
          onPointerDown={props.onPointerDown}
          onPointerMove={props.onPointerMove}
          onPointerUp={props.onPointerUp}
        />
      ))}
    </div>
  )
}
