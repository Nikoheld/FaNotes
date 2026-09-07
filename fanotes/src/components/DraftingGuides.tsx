import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  PEN_EDGE_ZONE_MM,
  RULER_HEIGHT_MM,
  angleStepRadians,
  angleToPoint,
  asCompassPose,
  attachSetSquareToRuler,
  clampCompassRadius,
  clampRulerLength,
  distanceToDrawingEdgeMm,
  draftingLocalToNorm,
  formatArcDegrees,
  formatDegrees,
  formatLength,
  magnetThresholdMm,
  normToLocalMm,
  normalizeAngle,
  pxPerMmOnDisplay,
  radiusMmBetween,
  rulerLength,
  scaleTicks,
  setSquareApexSign,
  setSquareSize,
  shortestAngleDelta,
  snapAngle,
  snapRadiusMm,
  snapToDraftingTools,
  type CompassDrawEvent,
  type CompassPose,
  type DraftingKind,
  type DraftingPose,
  type DraftingSettings,
  type DraftingToolState,
  type DraftingUnit,
} from '../lib/draftingTools'

export type DraftingReadout = { text: string; x: number; y: number }

type DraftingGuidesProps = {
  sourceWidth: number
  sourceHeight: number
  ruler: DraftingPose | null
  setSquare: DraftingPose | null
  compass: CompassPose | null
  settings: DraftingSettings
  readout: DraftingReadout | null
  onMove: (kind: DraftingKind, pose: DraftingPose) => void
  onCompassDraw?: (event: CompassDrawEvent) => void
  /** The user grabbed a tool: it becomes the keyboard target. */
  onActivate?: (kind: DraftingKind) => void
}

type DragMode = 'move' | 'rotate' | 'radius' | 'draw' | 'length'

type DragState = {
  kind: DraftingKind
  mode: DragMode
  startX: number
  startY: number
  origin: DraftingPose
  /** Pointer heading at grab time (rotate) or pencil angle at grab time (compass). */
  startAngle?: number
  /** Raw pencil angle followed so far (compass draw). */
  lastRawAngle?: number
  rawSwept?: number
  /** Last angle handed to the ink (after snapping). */
  emittedAngle?: number
}

const upsideDown = (rotation: number) => {
  const turn = normalizeAngle(rotation)
  return turn > Math.PI / 2 && turn < Math.PI * 1.5
}

const flipTransform = (x: number, y: number, flip: boolean) => (flip ? `rotate(180 ${x} ${y})` : undefined)

type BodyPointerHandler = (event: ReactPointerEvent<SVGElement>) => void

type RulerBodyProps = {
  lengthMm: number
  pxPerMm: number
  unit: DraftingUnit
  flipLabels: boolean
  onGrab: BodyPointerHandler
}

/** Static print of the ruler: only re-rendered when its size, unit or reading direction changes. */
const RulerBody = memo(function RulerBody({ lengthMm, pxPerMm, unit, flipLabels, onGrab }: RulerBodyProps) {
  const mm = (value: number) => value * pxPerMm
  const length = mm(lengthMm)
  const height = mm(RULER_HEIGHT_MM)
  const left = -length / 2
  const top = -height / 2
  const bottom = height / 2
  const tickLength = [mm(2), mm(3.4), mm(5)]
  const fontSize = mm(2.7)
  const ticks = scaleTicks(lengthMm, unit)
  return (
    <g>
      <rect className="lw-drafting-body" x={left} y={top} width={length} height={height} rx={mm(1)} onPointerDown={onGrab} />
      <line className="lw-drafting-edge" x1={left} y1={top} x2={left + length} y2={top} />
      <line className="lw-drafting-edge" x1={left} y1={bottom} x2={left + length} y2={bottom} />
      {ticks.map((tick) => {
        const x = left + mm(tick.mm)
        const tickClass = `lw-drafting-tick ${tick.level === 2 ? 'is-major' : ''}`
        const topLabelY = top + tickLength[2] + fontSize * 1.02
        const bottomLabelY = bottom - tickLength[2] - fontSize * 0.28
        return (
          <g key={tick.mm}>
            <line className={tickClass} x1={x} y1={top} x2={x} y2={top + tickLength[tick.level]} />
            <line className={tickClass} x1={x} y1={bottom} x2={x} y2={bottom - tickLength[tick.level]} />
            {tick.label && (
              <>
                <text className="lw-drafting-label" x={x} y={topLabelY} style={{ fontSize }} transform={flipTransform(x, topLabelY, flipLabels)}>{tick.label}</text>
                <text className="lw-drafting-label" x={x} y={bottomLabelY} style={{ fontSize }} transform={flipTransform(x, bottomLabelY, flipLabels)}>{tick.label}</text>
              </>
            )}
          </g>
        )
      })}
      <text
        className="lw-drafting-unit"
        x={left + length - mm(3)}
        y={fontSize * 0.36}
        style={{ fontSize: fontSize * 0.9 }}
        transform={flipTransform(left + length - mm(3), fontSize * 0.36, flipLabels)}
      >
        {unit === 'in' ? 'inch' : 'cm'}
      </text>
    </g>
  )
})

type SetSquareBodyProps = {
  sizeMm: number
  pxPerMm: number
  unit: DraftingUnit
  flipped: boolean
  parallels: boolean
  flipLabels: boolean
  onGrab: BodyPointerHandler
}

/**
 * Geodreieck print: base with a centred scale, protractor around the base centre
 * (outer scale 0° at the right, inner scale 0° at the left), centre line and
 * parallel lines. Local y grows towards the apex when `flipped`.
 */
const SetSquareBody = memo(function SetSquareBody({ sizeMm, pxPerMm, unit, flipped, parallels, flipLabels, onGrab }: SetSquareBodyProps) {
  const mm = (value: number) => value * pxPerMm
  const sign = flipped ? 1 : -1
  const halfMm = sizeMm / 2
  const half = mm(halfMm)
  const apexY = sign * half
  const fontSize = mm(2.6)
  const baseTicks = scaleTicks(halfMm, unit)
  const tickLength = [mm(1.6), mm(2.8), mm(4.2)]
  const protractorOuterMm = sizeMm * 0.305
  const protractorInnerMm = sizeMm * 0.26
  const outer = mm(protractorOuterMm)
  const inner = mm(protractorInnerMm)
  const outerLabel = mm(protractorOuterMm + 3.3)
  const innerLabel = mm(protractorInnerMm - 3.4)
  const protractorPoint = (degrees: number, radius: number) => {
    const angle = degrees * Math.PI / 180
    return { x: Math.cos(angle) * radius, y: sign * Math.sin(angle) * radius }
  }
  const arcPath = (radius: number) => {
    const start = protractorPoint(0, radius)
    const end = protractorPoint(180, radius)
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 ${sign > 0 ? 1 : 0} ${end.x} ${end.y}`
  }
  const parallelRows: number[] = []
  if (parallels) {
    for (let h = 5; h < halfMm - 7; h += 5) parallelRows.push(h)
  }
  const degreeTicks = Array.from({ length: 181 }, (_, degrees) => degrees)
  return (
    <g>
      <path className="lw-drafting-body" d={`M ${-half} 0 L ${half} 0 L 0 ${apexY} Z`} onPointerDown={onGrab} />
      {parallelRows.map((h) => {
        const halfWidth = mm(halfMm - h) - mm(1.5)
        const y = sign * mm(h)
        const labelled = h % 10 === 0
        return (
          <g key={`p${h}`}>
            <line className={`lw-drafting-parallel ${labelled ? 'is-major' : ''}`} x1={-halfWidth} y1={y} x2={halfWidth} y2={y} />
            {labelled && h >= 10 && (
              <text className="lw-drafting-label is-faint" x={mm(1.6)} y={y - sign * mm(0.6) + fontSize * 0.35} style={{ fontSize: fontSize * 0.8, textAnchor: 'start' }}>
                {h / 10}
              </text>
            )}
          </g>
        )
      })}
      <line className="lw-drafting-midline" x1="0" y1="0" x2="0" y2={apexY} />
      <path className="lw-drafting-protractor" d={arcPath(outer)} />
      <path className="lw-drafting-protractor" d={arcPath(inner)} />
      {degreeTicks.map((degrees) => {
        const level = degrees % 10 === 0 ? 2 : degrees % 5 === 0 ? 1 : 0
        const from = protractorPoint(degrees, inner)
        const to = protractorPoint(degrees, level === 2 ? outer : level === 1 ? inner + (outer - inner) * 0.62 : inner + (outer - inner) * 0.38)
        return <line key={`d${degrees}`} className={`lw-drafting-tick ${level === 2 ? 'is-major' : ''}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
      })}
      {degreeTicks.filter((degrees) => degrees % 10 === 0).map((degrees) => {
        const outerPos = protractorPoint(degrees, outerLabel)
        const innerPos = protractorPoint(degrees, innerLabel)
        const tangent = -sign * (90 - degrees)
        return (
          <g key={`l${degrees}`}>
            <text className="lw-drafting-label" x={outerPos.x} y={outerPos.y + fontSize * 0.35} style={{ fontSize }} transform={`rotate(${tangent} ${outerPos.x} ${outerPos.y})`}>
              {degrees}
            </text>
            <text className="lw-drafting-label is-inner" x={innerPos.x} y={innerPos.y + fontSize * 0.35} style={{ fontSize: fontSize * 0.86 }} transform={`rotate(${tangent} ${innerPos.x} ${innerPos.y})`}>
              {180 - degrees}
            </text>
          </g>
        )
      })}
      <line className="lw-drafting-edge" x1={-half} y1="0" x2={half} y2="0" />
      <line className="lw-drafting-edge" x1={-half} y1="0" x2="0" y2={apexY} />
      <line className="lw-drafting-edge" x1={half} y1="0" x2="0" y2={apexY} />
      {baseTicks.map((tick) => {
        const tickClass = `lw-drafting-tick ${tick.level === 2 ? 'is-major' : ''}`
        const x = mm(tick.mm)
        const labelY = sign * (tickLength[2] + fontSize * 1.05) + fontSize * 0.35
        const sides = tick.mm === 0 ? [1] : [1, -1]
        return sides.map((side) => (
          <g key={`b${side}${tick.mm}`}>
            <line className={tickClass} x1={side * x} y1="0" x2={side * x} y2={sign * tickLength[tick.level]} />
            {tick.label && (
              <text className="lw-drafting-label" x={side * x} y={labelY} style={{ fontSize }} transform={flipTransform(side * x, labelY, flipLabels)}>
                {tick.label}
              </text>
            )}
          </g>
        ))
      })}
      <text
        className="lw-drafting-unit"
        x={half - mm(10)}
        y={sign * mm(4.5) + fontSize * 0.35}
        style={{ fontSize: fontSize * 0.9 }}
        transform={flipTransform(half - mm(10), sign * mm(4.5) + fontSize * 0.35, flipLabels)}
      >
        {unit === 'in' ? 'inch' : 'cm'}
      </text>
    </g>
  )
})

const PinGlyph = ({ x, y }: { x: number; y: number }) => (
  <g className="lw-drafting-pin" transform={`translate(${x} ${y})`}>
    <circle className="lw-drafting-pin-bg" r="8" />
    <path className="lw-drafting-pin-icon" d="M -2.6 0 v -2.6 a 2.6 2.6 0 0 1 5.2 0 v 2.6 h 2.2 v 5.6 h -9.6 v -5.6 z" />
    <title>Fixiert: in den Optionen lösen</title>
  </g>
)

export function DraftingGuides({
  sourceWidth,
  sourceHeight,
  ruler,
  setSquare,
  compass,
  settings,
  readout,
  onMove,
  onCompassDraw,
  onActivate,
}: DraftingGuidesProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [drawPreview, setDrawPreview] = useState<{ from: number; to: number } | null>(null)
  const [viewport, setViewport] = useState({ width: sourceWidth, height: sourceHeight })
  const latestRef = useRef({ sourceWidth, sourceHeight, viewport, ruler, setSquare, compass, settings, onMove, onCompassDraw, onActivate })
  latestRef.current = { sourceWidth, sourceHeight, viewport, ruler, setSquare, compass, settings, onMove, onCompassDraw, onActivate }

  useLayoutEffect(() => {
    const node = svgRef.current
    if (!node) return
    const measure = () => {
      const width = Math.max(1, node.clientWidth)
      const height = Math.max(1, node.clientHeight)
      setViewport((current) => (
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height }
      ))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [sourceWidth, sourceHeight])

  const toNormFromClient = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left) / Math.max(1, rect.width),
      y: (clientY - rect.top) / Math.max(1, rect.height),
    }
  }

  const poseFor = (kind: DraftingKind): DraftingPose | null => {
    const { ruler: rulerPose, setSquare: squarePose, compass: compassPose } = latestRef.current
    return kind === 'ruler' ? rulerPose : kind === 'setSquare' ? squarePose : compassPose
  }

  /** Ruler and set square as magnet targets for the compass needle and pencil. */
  const straightTools = (): DraftingToolState[] => {
    const { ruler: rulerPose, setSquare: squarePose } = latestRef.current
    const tools: DraftingToolState[] = []
    if (rulerPose) tools.push({ kind: 'ruler', pose: rulerPose })
    if (squarePose) tools.push({ kind: 'setSquare', pose: squarePose })
    return tools
  }

  const magnetPoint = (x: number, y: number) => {
    const { sourceWidth: width, sourceHeight: height, viewport: box, settings: options } = latestRef.current
    const thresholdMm = magnetThresholdMm(options.magnet)
    if (thresholdMm <= 0) return { x, y }
    const snapped = snapToDraftingTools(x, y, straightTools(), width, height, null, box, { thresholdMm })
    return snapped ? { x: snapped.x, y: snapped.y } : { x, y }
  }

  const applyDrag = (clientX: number, clientY: number, altKey: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    const { sourceWidth: width, sourceHeight: height, viewport: box, settings: options, onMove: move, onCompassDraw: draw } = latestRef.current
    const point = toNormFromClient(clientX, clientY)
    if (drag.mode === 'move') {
      let next: DraftingPose = {
        ...drag.origin,
        x: drag.origin.x + (point.x - drag.startX),
        y: drag.origin.y + (point.y - drag.startY),
      }
      if (drag.kind === 'compass') {
        next = { ...next, ...magnetPoint(next.x, next.y) }
      } else if (drag.kind === 'setSquare' && options.attachToRuler && latestRef.current.ruler && !altKey) {
        next = attachSetSquareToRuler(next, latestRef.current.ruler, width, height) ?? next
      }
      move(drag.kind, next)
      return
    }
    if (drag.mode === 'length' && drag.kind === 'ruler') {
      const current = rulerLength(drag.origin)
      const local = normToLocalMm(point.x, point.y, drag.origin, width, height)
      const raw = clampRulerLength(current / 2 - local.x)
      const lengthMm = altKey ? Math.round(raw) : Math.round(raw / 5) * 5
      // The right end stays where it is; the centre walks with the new length.
      const centre = draftingLocalToNorm(current / 2 - lengthMm / 2, 0, drag.origin, width, height)
      move('ruler', { ...drag.origin, x: centre.x, y: centre.y, lengthMm: clampRulerLength(lengthMm) })
      return
    }
    if (drag.kind === 'compass' && (drag.mode === 'radius' || drag.mode === 'draw')) {
      // The needle stays where the board says it is: a page that grew for the
      // arc remaps every pose, and the grab-time copy would put it back.
      const live = poseFor('compass') ?? drag.origin
      const origin = asCompassPose({ ...drag.origin, x: live.x, y: live.y })
      if (drag.mode === 'radius') {
        const target = magnetPoint(point.x, point.y)
        const angle = angleToPoint(origin.x, origin.y, target.x, target.y, width, height, box)
        const measured = radiusMmBetween(origin.x, origin.y, target.x, target.y, width, height, box)
        const radiusMm = origin.locked ? origin.radiusMm : snapRadiusMm(clampCompassRadius(measured))
        move('compass', { ...origin, rotation: angle, radiusMm })
        return
      }
      const rawAngle = angleToPoint(origin.x, origin.y, point.x, point.y, width, height, box)
      const lastRaw = drag.lastRawAngle ?? origin.rotation
      const delta = shortestAngleDelta(lastRaw, rawAngle)
      const rawSwept = (drag.rawSwept ?? 0) + delta
      drag.lastRawAngle = lastRaw + delta
      drag.rawSwept = rawSwept
      const start = drag.startAngle ?? origin.rotation
      const stepRad = altKey ? 0 : angleStepRadians(options.angleStep)
      const snappedSwept = stepRad > 0 ? Math.round(rawSwept / stepRad) * stepRad : rawSwept
      const emittedFrom = drag.emittedAngle ?? start
      const emittedTo = start + snappedSwept
      if (Math.abs(emittedTo - emittedFrom) > 1e-9) {
        const next = { ...origin, rotation: emittedTo }
        drag.emittedAngle = emittedTo
        move('compass', next)
        draw?.({ type: 'append', pose: next, fromAngle: emittedFrom, toAngle: emittedTo })
      }
      setDrawPreview({ from: start, to: emittedTo })
      if (Math.abs(rawSwept) >= Math.PI * 2 * 0.94) {
        draw?.({ type: 'cancel' })
        draw?.({ type: 'circle', pose: { ...origin, rotation: emittedTo } })
        dragRef.current = null
        setDrawPreview(null)
      }
      return
    }
    if (drag.mode === 'rotate') {
      const live = poseFor(drag.kind) ?? drag.origin
      const heading = angleToPoint(live.x, live.y, point.x, point.y, width, height, box)
      const start = drag.startAngle ?? heading
      const raw = drag.origin.rotation + (heading - start)
      const rotation = altKey ? raw : snapAngle(raw, options.angleStep)
      move(drag.kind, { ...drag.origin, x: live.x, y: live.y, rotation })
    }
  }

  const finishDrag = () => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'compass' && drag.mode === 'draw') {
      const pose = asCompassPose({ ...drag.origin, rotation: drag.emittedAngle ?? drag.startAngle ?? drag.origin.rotation })
      if (Math.abs(drag.rawSwept ?? 0) < 0.045 || drag.emittedAngle === undefined) latestRef.current.onCompassDraw?.({ type: 'cancel' })
      else latestRef.current.onCompassDraw?.({ type: 'commit', pose })
      setDrawPreview(null)
    }
    dragRef.current = null
  }

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return
      event.preventDefault()
      applyDrag(event.clientX, event.clientY, event.altKey)
    }
    const onUp = () => {
      if (!dragRef.current) return
      finishDrag()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  /** Pen on the body but close to a drawing edge: let the ink layer have it, it snaps onto that edge. */
  const penWantsEdge = (kind: DraftingKind, pose: DraftingPose, event: ReactPointerEvent<SVGElement>) => {
    if (event.pointerType !== 'pen' || kind === 'compass') return false
    const { sourceWidth: width, sourceHeight: height } = latestRef.current
    const point = toNormFromClient(event.clientX, event.clientY)
    return distanceToDrawingEdgeMm(kind, pose, point.x, point.y, width, height) <= PEN_EDGE_ZONE_MM
  }

  const beginDrag = (kind: DraftingKind, mode: DragMode, event: ReactPointerEvent<SVGElement>) => {
    const pose = poseFor(kind)
    if (mode === 'move' && pose && penWantsEdge(kind, pose, event)) return
    event.stopPropagation()
    event.preventDefault()
    if (!pose) return
    latestRef.current.onActivate?.(kind)
    if (pose.pinned && mode !== 'draw' && mode !== 'radius') return
    if (event.pointerType === 'mouse') {
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    }
    const { sourceWidth: width, sourceHeight: height, viewport: box } = latestRef.current
    const point = toNormFromClient(event.clientX, event.clientY)
    const angle = angleToPoint(pose.x, pose.y, point.x, point.y, width, height, box)
    dragRef.current = {
      kind,
      mode,
      startX: point.x,
      startY: point.y,
      origin: pose,
      startAngle: angle,
      lastRawAngle: angle,
      rawSwept: 0,
    }
    if (kind === 'compass' && mode === 'draw') {
      const next = { ...asCompassPose(pose), rotation: angle }
      latestRef.current.onMove('compass', next)
      latestRef.current.onCompassDraw?.({ type: 'begin', pose: next })
      setDrawPreview({ from: angle, to: angle })
    }
  }

  const grabRuler = useCallback((event: ReactPointerEvent<SVGElement>) => beginDrag('ruler', 'move', event), [])
  const grabSetSquare = useCallback((event: ReactPointerEvent<SVGElement>) => beginDrag('setSquare', 'move', event), [])

  const tapAction = (event: ReactPointerEvent<SVGElement>, action: () => void) => {
    event.stopPropagation()
    event.preventDefault()
    action()
  }

  const pxPerMm = pxPerMmOnDisplay(sourceWidth, viewport)
  const mm = (value: number) => value * pxPerMm
  const nx = (value: number) => value * viewport.width
  const ny = (value: number) => value * viewport.height
  const degrees = (radians: number) => radians * 180 / Math.PI
  const captionSize = Math.max(9, mm(2.5))
  const compassGeometry = compass ? { radiusPx: mm(compass.radiusMm) } : null
  const rulerLengthMm = ruler ? rulerLength(ruler) : 0
  const squareSizeMm = setSquare ? setSquareSize(setSquare) : 0
  const squareSign = setSquare ? setSquareApexSign(setSquare) : -1

  return (
    <svg
      ref={svgRef}
      className={`lw-drafting-layer ${settings.translucent ? 'is-translucent' : ''}`}
      width={viewport.width}
      height={viewport.height}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {ruler && (
        <g
          className={`lw-drafting-tool is-ruler ${ruler.pinned ? 'is-pinned' : ''}`}
          transform={`translate(${nx(ruler.x)} ${ny(ruler.y)}) rotate(${degrees(ruler.rotation)})`}
        >
          <RulerBody lengthMm={rulerLengthMm} pxPerMm={pxPerMm} unit={settings.unit} flipLabels={upsideDown(ruler.rotation)} onGrab={grabRuler} />
          {!ruler.pinned && (
            <>
              <circle
                className="lw-drafting-rotate"
                cx={mm(rulerLengthMm) / 2 - 12}
                cy="0"
                r="9"
                onPointerDown={(event) => beginDrag('ruler', 'rotate', event)}
              >
                <title>Drehen (Alt: ohne Winkelraster)</title>
              </circle>
              <g
                className="lw-drafting-length"
                transform={`translate(${-mm(rulerLengthMm) / 2 + 12} 0)`}
                onPointerDown={(event) => beginDrag('ruler', 'length', event)}
              >
                <circle className="lw-drafting-length-bg" r="9" />
                <path className="lw-drafting-length-icon" d="M -5 0 h 10 M -5 0 l 2.4 -2.4 M -5 0 l 2.4 2.4 M 5 0 l -2.4 -2.4 M 5 0 l -2.4 2.4" />
                <title>Länge ändern (Alt: millimetergenau)</title>
              </g>
            </>
          )}
          {ruler.pinned && <PinGlyph x={mm(rulerLengthMm) / 2 - 14} y={0} />}
          <text
            className="lw-drafting-caption"
            x="0"
            y={captionSize * 0.36}
            style={{ fontSize: captionSize }}
            transform={flipTransform(0, captionSize * 0.36, upsideDown(ruler.rotation))}
          >
            {`Lineal · ${formatLength(rulerLengthMm, settings.unit)} · ${formatDegrees(ruler.rotation)}`}
          </text>
        </g>
      )}
      {setSquare && (
        <g
          className={`lw-drafting-tool is-setsquare ${setSquare.pinned ? 'is-pinned' : ''}`}
          transform={`translate(${nx(setSquare.x)} ${ny(setSquare.y)}) rotate(${degrees(setSquare.rotation)})`}
        >
          <SetSquareBody
            sizeMm={squareSizeMm}
            pxPerMm={pxPerMm}
            unit={settings.unit}
            flipped={Boolean(setSquare.flipped)}
            parallels={settings.setSquareParallels}
            flipLabels={upsideDown(setSquare.rotation)}
            onGrab={grabSetSquare}
          />
          {!setSquare.pinned && (
            <>
              <circle
                className="lw-drafting-rotate"
                cx="0"
                cy={squareSign * (mm(squareSizeMm) / 2 - 12)}
                r="9"
                onPointerDown={(event) => beginDrag('setSquare', 'rotate', event)}
              >
                <title>Drehen (Alt: ohne Winkelraster)</title>
              </circle>
              <g
                className="lw-drafting-action is-flip"
                transform={`translate(${-mm(16)} ${squareSign * mm(22)})`}
                onPointerDown={(event) => tapAction(event, () => {
                  onActivate?.('setSquare')
                  onMove('setSquare', { ...setSquare, flipped: !setSquare.flipped })
                })}
              >
                <circle className="lw-drafting-action-bg" r="9" />
                <path className="lw-drafting-action-icon-stroke" d="M 0 -5 v 10 M -2 -3.5 l -4 3.5 l 4 3.5 z M 2 -3.5 l 4 3.5 l -4 3.5 z" />
                <title>Spiegeln: Spitze auf die andere Seite</title>
              </g>
            </>
          )}
          {setSquare.pinned && <PinGlyph x={mm(16)} y={squareSign * mm(22)} />}
          <text
            className="lw-drafting-caption"
            x="0"
            y={squareSign * mm(squareSizeMm) * 0.31 + captionSize * 0.36}
            style={{ fontSize: captionSize }}
            transform={flipTransform(0, squareSign * mm(squareSizeMm) * 0.31 + captionSize * 0.36, upsideDown(setSquare.rotation))}
          >
            {`Geodreieck · ${formatLength(squareSizeMm, settings.unit)} · ${formatDegrees(setSquare.rotation)}`}
          </text>
        </g>
      )}
      {compass && compassGeometry && (
        <>
          <circle
            className="lw-drafting-compass-ghost"
            cx={nx(compass.x)}
            cy={ny(compass.y)}
            r={compassGeometry.radiusPx}
          />
          {settings.compassCentreMark && (
            <path
              className="lw-drafting-centre-mark"
              d={`M ${nx(compass.x) - mm(1.6)} ${ny(compass.y)} h ${mm(3.2)} M ${nx(compass.x)} ${ny(compass.y) - mm(1.6)} v ${mm(3.2)}`}
            />
          )}
          {drawPreview && Math.abs(drawPreview.to - drawPreview.from) > 0.02 && (
            <path
              className="lw-drafting-compass-arc"
              d={describePaperArc(
                nx(compass.x),
                ny(compass.y),
                compassGeometry.radiusPx,
                drawPreview.from,
                drawPreview.to,
              )}
            />
          )}
          <g
            className={`lw-drafting-tool is-compass ${compass.pinned ? 'is-pinned' : ''}`}
            transform={`translate(${nx(compass.x)} ${ny(compass.y)})`}
          >
            <g transform={`rotate(${degrees(compass.rotation)})`}>
              <line className="lw-drafting-span" x1="0" y1="0" x2={compassGeometry.radiusPx} y2="0" />
              <rect
                className="lw-drafting-arm"
                x="0"
                y={-5}
                width={compassGeometry.radiusPx}
                height="10"
                rx="1"
                onPointerDown={(event) => beginDrag('compass', 'move', event)}
              />
              {scaleTicks(compass.radiusMm, settings.unit).filter((tick) => tick.level === 2).map((tick) => {
                const x = mm(tick.mm)
                if (x > compassGeometry.radiusPx) return null
                return (
                  <g key={`c${tick.mm}`}>
                    <line className="lw-drafting-tick is-major" x1={x} y1="-8" x2={x} y2="8" />
                    {tick.mm > 0 && (
                      <text className="lw-drafting-label" x={x} y="20" style={{ fontSize: Math.max(8, mm(2.4)) }}>{tick.label}</text>
                    )}
                  </g>
                )
              })}
              <circle className="lw-drafting-needle-dot" cx="0" cy="0" r="4" />
              <circle
                className="lw-drafting-needle"
                cx="0"
                cy="0"
                r="7"
                onPointerDown={(event) => beginDrag('compass', 'move', event)}
              >
                <title>Nadel: Zirkel verschieben (rastet an Lineal und Geodreieck)</title>
              </circle>
              <circle
                className="lw-drafting-draw"
                cx={compassGeometry.radiusPx}
                cy="0"
                r="10"
                onPointerDown={(event) => beginDrag('compass', 'draw', event)}
              >
                <title>Mine drehen: Bogen oder Kreis zeichnen</title>
              </circle>
              <circle
                className="lw-drafting-radius"
                cx={compassGeometry.radiusPx * 0.55}
                cy="0"
                r="8"
                onPointerDown={(event) => beginDrag('compass', 'radius', event)}
              >
                <title>{compass.locked ? 'Radius gesperrt · drehen zum Übertragen' : 'Radius einstellen / abmessen'}</title>
              </circle>
            </g>
            <g
              className={`lw-drafting-action ${compass.locked ? 'is-locked' : ''}`}
              transform="translate(-18 -28)"
              onPointerDown={(event) => tapAction(event, () => onMove('compass', { ...compass, locked: !compass.locked }))}
            >
              <circle className="lw-drafting-action-bg" r="9" />
              <path
                className="lw-drafting-action-icon"
                d={compass.locked
                  ? 'M -3 0 v -3 a 3 3 0 0 1 6 0 v 3 h 3.5 v 7 h -13 v -7 z'
                  : 'M -3 0 v -3 a 3 3 0 0 1 6 0 h -2 a 1 1 0 0 0 -2 0 v 3 h 6.5 v 7 h -13 v -7 z'}
              />
              <title>{compass.locked ? 'Radius entsperren' : 'Radius sperren (Maß übertragen)'}</title>
            </g>
            <g
              className="lw-drafting-action is-circle"
              transform="translate(18 -28)"
              onPointerDown={(event) => tapAction(event, () => onCompassDraw?.({ type: 'circle', pose: compass }))}
            >
              <circle className="lw-drafting-action-bg" r="9" />
              <circle className="lw-drafting-action-icon-ring" r="4.2" />
              <title>Ganzen Kreis zeichnen</title>
            </g>
            {compass.pinned && <PinGlyph x={0} y={-50} />}
            <text className="lw-drafting-caption" x="0" y="-44" style={{ fontSize: captionSize }}>
              {`Zirkel · r ${formatLength(compass.radiusMm, settings.unit)}`}
              {drawPreview ? ` · ${formatArcDegrees(drawPreview.to - drawPreview.from)}` : compass.locked ? ' · gesperrt' : ''}
            </text>
          </g>
        </>
      )}
      {readout && (
        <g className="lw-drafting-readout" transform={`translate(${nx(readout.x)} ${ny(readout.y) - 24})`}>
          <rect className="lw-drafting-readout-bg" x={-(readout.text.length * 7.1 + 18) / 2} y="-13" width={readout.text.length * 7.1 + 18} height="22" rx="7" />
          <text className="lw-drafting-readout-text" x="0" y="3">{readout.text}</text>
        </g>
      )}
    </svg>
  )
}

const describePaperArc = (cx: number, cy: number, radius: number, from: number, to: number) => {
  const delta = to - from
  const sweep = delta >= 0 ? 1 : 0
  const large = Math.abs(delta) > Math.PI ? 1 : 0
  const x1 = cx + Math.cos(from) * radius
  const y1 = cy + Math.sin(from) * radius
  const x2 = cx + Math.cos(to) * radius
  const y2 = cy + Math.sin(to) * radius
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} ${sweep} ${x2} ${y2}`
}
