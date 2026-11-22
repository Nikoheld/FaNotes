import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { HAND_GESTURE_CLAIM } from '../../../src/lib/handGestures'
import {
  PEN_EDGE_ZONE_MM,
  angleStepRadians,
  angleToPoint,
  asCompassPose,
  attachSetSquareToRuler,
  clampCompassRadius,
  clampRulerLength,
  distanceToDrawingEdgeMm,
  draftingChrome,
  draftingLocalToNorm,
  formatArcDegrees,
  formatDegrees,
  formatLength,
  magnetThresholdMm,
  normToLocalMm,
  normalizeAngle,
  penEdgeZoneForWidth,
  pxPerMmOnDisplay,
  radiusMmBetween,
  resizeRulerWidth,
  rulerLength,
  rulerWidth,
  scaleTicks,
  setSquareApexSign,
  setSquareSize,
  shortestAngleDelta,
  snapAngle,
  snapRadiusMm,
  snapToDraftingTools,
  visibleTickLevel,
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

type DragMode = 'move' | 'rotate' | 'radius' | 'draw' | 'length' | 'width'

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
  widthMm: number
  pxPerMm: number
  unit: DraftingUnit
  flipLabels: boolean
  onGrab: BodyPointerHandler
}

/** Static print of the ruler: only re-rendered when its size, unit or reading direction changes. */
const RulerBody = memo(function RulerBody({ lengthMm, widthMm, pxPerMm, unit, flipLabels, onGrab }: RulerBodyProps) {
  const mm = (value: number) => value * pxPerMm
  const length = mm(lengthMm)
  const height = mm(widthMm)
  const left = -length / 2
  const top = -height / 2
  const bottom = height / 2
  const maxTick = Math.max(mm(1.2), height / 2 - mm(1))
  const tickLength = [mm(2), mm(3.4), mm(5)].map((value) => Math.min(value, maxTick))
  const fontSize = mm(2.7)
  const minLevel = visibleTickLevel(pxPerMm, unit)
  const ticks = scaleTicks(lengthMm, unit).filter((tick) => tick.level >= minLevel)
  const topLabelY = top + tickLength[2] + fontSize * 1.02
  const bottomLabelY = bottom - tickLength[2] - fontSize * 0.28
  const bothLabels = bottomLabelY - topLabelY >= fontSize
  return (
    <g>
      <rect className="lw-drafting-body" x={left} y={top} width={length} height={height} rx={mm(1)} onPointerDown={onGrab} />
      <line className="lw-drafting-edge" x1={left} y1={top} x2={left + length} y2={top} />
      <line className="lw-drafting-edge" x1={left} y1={bottom} x2={left + length} y2={bottom} />
      {ticks.map((tick) => {
        const x = left + mm(tick.mm)
        const tickClass = `lw-drafting-tick ${tick.level === 2 ? 'is-major' : ''}`
        return (
          <g key={tick.mm}>
            <line className={tickClass} x1={x} y1={top} x2={x} y2={top + tickLength[tick.level]} />
            <line className={tickClass} x1={x} y1={bottom} x2={x} y2={bottom - tickLength[tick.level]} />
            {tick.label && (
              <>
                <text className="lw-drafting-label" x={x} y={topLabelY} style={{ fontSize }} transform={flipTransform(x, topLabelY, flipLabels)}>{tick.label}</text>
                {bothLabels && (
                  <text className="lw-drafting-label" x={x} y={bottomLabelY} style={{ fontSize }} transform={flipTransform(x, bottomLabelY, flipLabels)}>{tick.label}</text>
                )}
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
  const minLevel = visibleTickLevel(pxPerMm, unit)
  const baseTicks = scaleTicks(halfMm, unit).filter((tick) => tick.level >= minLevel)
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
  const pxPerDegree = outer * Math.PI / 180
  const degreeStep = pxPerDegree >= 2.2 ? 1 : pxPerDegree * 5 >= 2.2 ? 5 : 10
  const degreeTicks = Array.from({ length: Math.floor(180 / degreeStep) + 1 }, (_, index) => index * degreeStep)
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

type CompassBodyProps = {
  radiusPx: number
  /** Chrome scale of the page (thickness of legs, strokes). */
  scale: number
  unit: DraftingUnit
  radiusMm: number
  locked: boolean
  /** Layer px per screen px. */
  unit1: number
  onMove: BodyPointerHandler
  onRotate: BodyPointerHandler
  onDraw: BodyPointerHandler
}

/** Smallest touch/pen target the compass hands out, in screen px (radius). */
const COMPASS_HIT_PX = 22

/**
 * Static print of the compass: two legs, hinge, needle point, pencil lead and the three grips.
 * Lives in a frame where the needle is at (0,0) and the lead at (radiusPx,0); the parent
 * moves and turns it, so dragging never re-renders these paths.
 */
const CompassBody = memo(function CompassBody({ radiusPx, scale, unit, radiusMm, locked, unit1, onMove, onRotate, onDraw }: CompassBodyProps) {
  const s = scale
  const hitPx = COMPASS_HIT_PX * unit1
  const R = Math.max(radiusPx, 1)
  const height = Math.min(Math.max(R * 0.62, 56 * s), 230 * s)
  const hx = R / 2
  const hy = -height
  const along = (from: [number, number], to: [number, number], t: number): [number, number] => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
  const normalOf = (from: [number, number], to: [number, number]): [number, number] => {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const len = Math.hypot(dx, dy) || 1
    return [-dy / len, dx / len]
  }
  const hinge: [number, number] = [hx, hy]
  const needleTip: [number, number] = [0, 0]
  const leadTip: [number, number] = [R, 0]
  const strip = (from: [number, number], to: [number, number], t0: number, t1: number, w0: number, w1: number) => {
    const n = normalOf(from, to)
    const a = along(from, to, t0)
    const b = along(from, to, t1)
    const pts = [
      [a[0] + n[0] * w0 / 2, a[1] + n[1] * w0 / 2],
      [b[0] + n[0] * w1 / 2, b[1] + n[1] * w1 / 2],
      [b[0] - n[0] * w1 / 2, b[1] - n[1] * w1 / 2],
      [a[0] - n[0] * w0 / 2, a[1] - n[1] * w0 / 2],
    ]
    return `M ${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`
  }
  const hs = Math.max(0.8, s)
  const hitCap = Math.max(12 * unit1, Math.min(hitPx, R * 0.36))
  const ticks = scaleTicks(radiusMm, unit).filter((tick) => tick.level === 2 && tick.mm > 0)
  const needleTitle = 'Nadel: Zirkel verschieben (rastet an Lineal und Geodreieck)'
  const knob: [number, number] = [hx, hy - 30 * hs]
  return (
    <g className="lw-compass-body">
      <line className="lw-compass-span" x1="0" y1="0" x2={R} y2="0" />
      {ticks.map((tick) => {
        const x = tick.mm * (R / Math.max(radiusMm, 1e-6))
        if (x < 10 * hs || x > R - 10 * hs) return null
        return <line key={tick.mm} className="lw-compass-span-tick" x1={x} y1={-3 * s} x2={x} y2={3 * s} />
      })}
      {/* Needle leg: steel, tapering to the point. */}
      <g className="lw-compass-needle-leg" style={{ strokeWidth: Math.max(0.8, 1.1 * s) }}>
        <path className="lw-compass-steel" d={strip(hinge, needleTip, 0, 0.8, 9 * s, 5 * s)} />
        <path className="lw-compass-steel-dark" d={strip(hinge, needleTip, 0.8, 0.985, 3.2 * s, 1.3 * s)} />
        <line className="lw-compass-sheen" {...lineProps(along(hinge, needleTip, 0.03), along(hinge, needleTip, 0.78), normalOf(hinge, needleTip), 1.6 * s)} />
      </g>
      {/* Pencil leg: body, clamp, wooden cone, lead. */}
      <g className="lw-compass-pencil-leg" style={{ strokeWidth: Math.max(0.8, 1.1 * s) }}>
        <path className="lw-compass-steel" d={strip(hinge, leadTip, 0, 0.64, 11 * s, 9.5 * s)} />
        <path className="lw-compass-clamp" d={strip(hinge, leadTip, 0.64, 0.72, 12.5 * s, 12.5 * s)} />
        <path className="lw-compass-wood" d={strip(hinge, leadTip, 0.72, 0.93, 8 * s, 2.4 * s)} />
        <path className="lw-compass-lead" d={strip(hinge, leadTip, 0.93, 0.995, 2.4 * s, 0.9 * s)} />
        <line className="lw-compass-sheen" {...lineProps(along(hinge, leadTip, 0.03), along(hinge, leadTip, 0.62), normalOf(hinge, leadTip), 1.8 * s)} />
      </g>
      {/* Legs carry the whole compass: grab anywhere along them. */}
      <line className="lw-compass-grab" x1={hx} y1={hy} x2="0" y2="0" style={{ strokeWidth: 2 * hitPx }} onPointerDown={onMove} />
      <line className="lw-compass-grab" x1={hx} y1={hy} x2={R} y2="0" style={{ strokeWidth: 2 * hitPx }} onPointerDown={onMove} />
      {/* Hinge with stem and the rotation grip. */}
      <line className="lw-compass-stem" x1={hx} y1={hy} x2={knob[0]} y2={knob[1]} style={{ strokeWidth: 6 * s }} />
      <circle className="lw-compass-hinge" cx={hx} cy={hy} r={8 * s} />
      <circle className="lw-compass-hinge-dot" cx={hx} cy={hy} r={2.6 * s} />
      <g onPointerDown={onRotate}>
        <circle className="lw-drafting-rotate" cx={knob[0]} cy={knob[1]} r={8.5 * hs} />
        <path className="lw-compass-turn-icon" d={`M ${knob[0] - 3.6 * hs} ${knob[1] + 0.8 * hs} a ${3.8 * hs} ${3.8 * hs} 0 1 1 ${1.2 * hs} ${2.6 * hs}`} />
        <circle className="lw-compass-hit" cx={knob[0]} cy={knob[1]} r={hitPx}>
          <title>Zirkel drehen (ohne zu zeichnen)</title>
        </circle>
      </g>
      {/* Needle grip. */}
      <g onPointerDown={onMove}>
        <circle className="lw-compass-needle-ring" cx="0" cy="0" r={7 * hs} />
        <circle className="lw-compass-needle-dot" cx="0" cy="0" r={2.2 * hs} />
        <circle className="lw-compass-hit" cx="0" cy="0" r={hitCap}>
          <title>{needleTitle}</title>
        </circle>
      </g>
      {/* Pencil grip: starts an arc. */}
      <g onPointerDown={onDraw}>
        <circle className="lw-compass-lead-ring" cx={R} cy="0" r={8 * hs} />
        <circle className="lw-compass-lead-dot" cx={R} cy="0" r={2.4 * hs} />
        <circle className="lw-compass-hit" cx={R} cy="0" r={hitCap}>
          <title>Mine drehen: Bogen oder Kreis zeichnen</title>
        </circle>
      </g>
      <title>{locked ? 'Zirkel (Radius gesperrt)' : 'Zirkel'}</title>
    </g>
  )
})

/** Highlight stripe along a leg, offset to one side. */
const lineProps = (a: [number, number], b: [number, number], n: [number, number], offset: number) => ({
  x1: a[0] + n[0] * offset,
  y1: a[1] + n[1] * offset,
  x2: b[0] + n[0] * offset,
  y2: b[1] + n[1] * offset,
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
  // Screen px per layer px (the sheet is zoomed by a CSS transform): keeps grips >= 44 px on screen.
  const [screenScale, setScreenScale] = useState(1)
  useLayoutEffect(() => {
    if (!compass || dragRef.current) return
    const matrix = svgRef.current?.getScreenCTM()
    const next = matrix ? Math.hypot(matrix.a, matrix.b) : 1
    if (Number.isFinite(next) && next > 0.05) setScreenScale((current) => (Math.abs(current - next) / current < 0.01 ? current : next))
  })
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
    if (drag.mode === 'width' && drag.kind === 'ruler') {
      const local = normToLocalMm(point.x, point.y, drag.origin, width, height)
      move('ruler', resizeRulerWidth(drag.origin, local.y, width, height, altKey))
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
    const onClaim = (event: Event) => {
      const root = (event as CustomEvent<{ root?: Node }>).detail?.root
      const svg = svgRef.current
      if (!svg || !(root instanceof Node) || !root.contains(svg)) return
      finishDrag()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener(HAND_GESTURE_CLAIM, onClaim)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener(HAND_GESTURE_CLAIM, onClaim)
    }
  }, [])

  /** Pen on the body but close to a drawing edge: let the ink layer have it, it snaps onto that edge. */
  const penWantsEdge = (kind: DraftingKind, pose: DraftingPose, event: ReactPointerEvent<SVGElement>) => {
    if (event.pointerType !== 'pen' || kind === 'compass') return false
    const { sourceWidth: width, sourceHeight: height } = latestRef.current
    const point = toNormFromClient(event.clientX, event.clientY)
    const zone = kind === 'ruler' ? penEdgeZoneForWidth(rulerWidth(pose)) : PEN_EDGE_ZONE_MM
    return distanceToDrawingEdgeMm(kind, pose, point.x, point.y, width, height) <= zone
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
  const grabCompass = useCallback((event: ReactPointerEvent<SVGElement>) => beginDrag('compass', 'move', event), [])
  const rotateCompass = useCallback((event: ReactPointerEvent<SVGElement>) => beginDrag('compass', 'rotate', event), [])
  const drawCompass = useCallback((event: ReactPointerEvent<SVGElement>) => beginDrag('compass', 'draw', event), [])
  const radiusCompass = useCallback((event: ReactPointerEvent<SVGElement>) => beginDrag('compass', 'radius', event), [])
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
  const compassGeometry = compass ? { radiusPx: mm(compass.radiusMm) } : null
  const rulerLengthMm = ruler ? rulerLength(ruler) : 0
  const rulerWidthMm = ruler ? rulerWidth(ruler) : 0
  const rulerLengthPx = mm(rulerLengthMm)
  const rulerWidthPx = mm(rulerWidthMm)
  const rulerChrome = draftingChrome(pxPerMm, Math.min(rulerLengthPx, rulerWidthPx) || 1)
  const squareSizeMm = setSquare ? setSquareSize(setSquare) : 0
  const squarePx = mm(squareSizeMm)
  const squareChrome = draftingChrome(pxPerMm, squarePx * 0.5 || 1)
  const compassChrome = draftingChrome(pxPerMm, compassGeometry?.radiusPx ?? 1)
  const unit1 = 1 / Math.min(4, Math.max(0.25, screenScale))
  const chipText = compass
    ? `r ${formatLength(compass.radiusMm, settings.unit)}${drawPreview ? ` · ${formatArcDegrees(drawPreview.to - drawPreview.from)}` : ''}`
    : ''
  // Fixed-width pill (monospaced digits): no layout jump while the reading changes.
  const chipWidth = Math.max(60, chipText.length * 7 + 22)
  const chipHitWidth = Math.max(26, Math.min(chipWidth, ((compassGeometry?.radiusPx ?? 0) / unit1) - 2 * COMPASS_HIT_PX * 0.8))
  const captionSize = (chromeScale: number) => Math.max(7 * chromeScale, mm(2.5))
  // Keep the width grip inside the body, clear of the pen's edge zone, so a
  // stroke along the drawing edge still reaches the ink layer.
  const rulerWidthClearanceMm = penEdgeZoneForWidth(rulerWidthMm) + rulerChrome.handle / Math.max(pxPerMm, 1e-6) + 0.4
  const rulerWidthHandleY = mm(Math.max(0, rulerWidthMm / 2 - rulerWidthClearanceMm))
  const rulerHalfPx = rulerLengthPx / 2
  const rulerEndInset = Math.min(rulerChrome.handle + 3, Math.max(rulerChrome.handle, rulerHalfPx * 0.35))
  const squareSign = setSquare ? setSquareApexSign(setSquare) : -1
  const chromeVars = (scale: number): CSSProperties => ({ '--lw-draft-chrome': String(scale) } as CSSProperties)

  return (
    <svg
      ref={svgRef}
      className={`lw-drafting-layer ${settings.translucent ? 'is-translucent' : ''}`}
      width="100%"
      height="100%"
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {ruler && (
        <g
          className={`lw-drafting-tool is-ruler ${ruler.pinned ? 'is-pinned' : ''}`}
          transform={`translate(${nx(ruler.x)} ${ny(ruler.y)}) rotate(${degrees(ruler.rotation)})`}
        >
          <g style={chromeVars(rulerChrome.scale)}>
            <RulerBody lengthMm={rulerLengthMm} widthMm={rulerWidthMm} pxPerMm={pxPerMm} unit={settings.unit} flipLabels={upsideDown(ruler.rotation)} onGrab={grabRuler} />
          </g>
          {!ruler.pinned && (
            <>
              <g
                transform={`translate(${rulerHalfPx - rulerEndInset} 0) scale(${rulerChrome.scale})`}
                onPointerDown={(event) => beginDrag('ruler', 'rotate', event)}
              >
                <circle className="lw-drafting-rotate" r="9">
                  <title>Drehen (Alt: ohne Winkelraster)</title>
                </circle>
              </g>
              <g
                className="lw-drafting-length"
                transform={`translate(${-rulerHalfPx + rulerEndInset} 0) scale(${rulerChrome.scale})`}
                onPointerDown={(event) => beginDrag('ruler', 'length', event)}
              >
                <circle className="lw-drafting-length-bg" r="9" />
                <path className="lw-drafting-length-icon" d="M -5 0 h 10 M -5 0 l 2.4 -2.4 M -5 0 l 2.4 2.4 M 5 0 l -2.4 -2.4 M 5 0 l -2.4 2.4" />
                <title>Länge ändern (Alt: millimetergenau)</title>
              </g>
              <g
                className="lw-drafting-width"
                transform={`translate(0 ${rulerWidthHandleY}) scale(${rulerChrome.scale})`}
                onPointerDown={(event) => beginDrag('ruler', 'width', event)}
              >
                <circle className="lw-drafting-length-bg" r="9" />
                <path className="lw-drafting-length-icon" d="M 0 -5 v 10 M 0 -5 l -2.4 2.4 M 0 -5 l 2.4 2.4 M 0 5 l -2.4 -2.4 M 0 5 l 2.4 -2.4" />
                <title>Breite ändern (Alt: halbe Millimeter)</title>
              </g>
            </>
          )}
          {ruler.pinned && (
            <g transform={`translate(${rulerHalfPx - rulerEndInset} 0) scale(${rulerChrome.scale})`}>
              <PinGlyph x={0} y={0} />
            </g>
          )}
          <text
            className="lw-drafting-caption"
            x="0"
            y={captionSize(rulerChrome.scale) * 0.36}
            style={{ fontSize: captionSize(rulerChrome.scale) }}
            transform={flipTransform(0, captionSize(rulerChrome.scale) * 0.36, upsideDown(ruler.rotation))}
          >
            {`Lineal · ${formatLength(rulerLengthMm, settings.unit)} × ${formatLength(rulerWidthMm, settings.unit)} · ${formatDegrees(ruler.rotation)}`}
          </text>
        </g>
      )}
      {setSquare && (
        <g
          className={`lw-drafting-tool is-setsquare ${setSquare.pinned ? 'is-pinned' : ''}`}
          transform={`translate(${nx(setSquare.x)} ${ny(setSquare.y)}) rotate(${degrees(setSquare.rotation)})`}
        >
          <g style={chromeVars(squareChrome.scale)}>
            <SetSquareBody
              sizeMm={squareSizeMm}
              pxPerMm={pxPerMm}
              unit={settings.unit}
              flipped={Boolean(setSquare.flipped)}
              parallels={settings.setSquareParallels}
              flipLabels={upsideDown(setSquare.rotation)}
              onGrab={grabSetSquare}
            />
          </g>
          {!setSquare.pinned && (
            <>
              <g
                transform={`translate(0 ${squareSign * (squarePx / 2 - squareChrome.handle - 3)}) scale(${squareChrome.scale})`}
                onPointerDown={(event) => beginDrag('setSquare', 'rotate', event)}
              >
                <circle className="lw-drafting-rotate" r="9">
                  <title>Drehen (Alt: ohne Winkelraster)</title>
                </circle>
              </g>
              <g
                className="lw-drafting-action is-flip"
                transform={`translate(${-mm(16)} ${squareSign * mm(22)}) scale(${squareChrome.scale})`}
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
          {setSquare.pinned && (
            <g transform={`translate(${mm(16)} ${squareSign * mm(22)}) scale(${squareChrome.scale})`}>
              <PinGlyph x={0} y={0} />
            </g>
          )}
          <text
            className="lw-drafting-caption"
            x="0"
            y={squareSign * squarePx * 0.31 + captionSize(squareChrome.scale) * 0.36}
            style={{ fontSize: captionSize(squareChrome.scale) }}
            transform={flipTransform(0, squareSign * squarePx * 0.31 + captionSize(squareChrome.scale) * 0.36, upsideDown(setSquare.rotation))}
          >
            {`Geodreieck · ${formatLength(squareSizeMm, settings.unit)} · ${formatDegrees(setSquare.rotation)}`}
          </text>
        </g>
      )}
      {compass && compassGeometry && (
        <>
          <g style={chromeVars(compassChrome.scale)}>
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
              <>
                <line
                  className="lw-drafting-compass-ray"
                  x1={nx(compass.x)}
                  y1={ny(compass.y)}
                  x2={nx(compass.x) + Math.cos(drawPreview.from) * compassGeometry.radiusPx}
                  y2={ny(compass.y) + Math.sin(drawPreview.from) * compassGeometry.radiusPx}
                />
                <path
                  className="lw-drafting-compass-arc is-halo"
                  d={describePaperArc(nx(compass.x), ny(compass.y), compassGeometry.radiusPx, drawPreview.from, drawPreview.to)}
                />
                <path
                  className="lw-drafting-compass-arc"
                  d={describePaperArc(nx(compass.x), ny(compass.y), compassGeometry.radiusPx, drawPreview.from, drawPreview.to)}
                />
                <circle
                  className="lw-drafting-compass-start"
                  cx={nx(compass.x) + Math.cos(drawPreview.from) * compassGeometry.radiusPx}
                  cy={ny(compass.y) + Math.sin(drawPreview.from) * compassGeometry.radiusPx}
                  r="3.2"
                />
              </>
            )}
          </g>
          <g
            className={`lw-drafting-tool is-compass ${compass.pinned ? 'is-pinned' : ''}`}
            transform={`translate(${nx(compass.x)} ${ny(compass.y)})`}
          >
            <g transform={`rotate(${degrees(compass.rotation)})`}>
              <CompassBody
                radiusPx={compassGeometry.radiusPx}
                scale={compassChrome.scale}
                unit={settings.unit}
                radiusMm={compass.radiusMm}
                locked={Boolean(compass.locked)}
                unit1={unit1}
                onMove={grabCompass}
                onRotate={rotateCompass}
                onDraw={drawCompass}
              />
              <g
                className="lw-compass-readout"
                transform={`translate(${compassGeometry.radiusPx / 2} 0) rotate(${-degrees(compass.rotation)}) scale(${unit1})`}
                onPointerDown={radiusCompass}
              >
                <rect
                  className="lw-compass-chip"
                  x={-chipWidth / 2}
                  y="-12"
                  width={chipWidth}
                  height="24"
                  rx="12"
                />
                <text className="lw-compass-chip-text" x="0" y="4.2">{chipText}</text>
                <rect
                  className="lw-compass-hit"
                  x={-chipHitWidth / 2}
                  y={-COMPASS_HIT_PX}
                  width={chipHitWidth}
                  height={2 * COMPASS_HIT_PX}
                >
                  <title>{compass.locked ? 'Radius gesperrt · drehen zum Übertragen' : 'Radius einstellen / abmessen'}</title>
                </rect>
              </g>
            </g>
            <g
              className={`lw-drafting-action ${compass.locked ? 'is-locked' : ''}`}
              transform={`translate(${-27 * unit1} ${40 * unit1}) scale(${unit1})`}
              onPointerDown={(event) => tapAction(event, () => onMove('compass', { ...compass, locked: !compass.locked }))}
            >
              <circle className="lw-drafting-action-bg" r="12" />
              <path
                className="lw-drafting-action-icon"
                transform="scale(1.15)"
                d={compass.locked
                  ? 'M -3 0 v -3 a 3 3 0 0 1 6 0 v 3 h 3.5 v 7 h -13 v -7 z'
                  : 'M -3 0 v -3 a 3 3 0 0 1 6 0 h -2 a 1 1 0 0 0 -2 0 v 3 h 6.5 v 7 h -13 v -7 z'}
              />
              <circle className="lw-compass-hit" r={COMPASS_HIT_PX} />
              <title>{compass.locked ? 'Radius entsperren' : 'Radius sperren (Maß übertragen)'}</title>
            </g>
            <g
              className="lw-drafting-action is-circle"
              transform={`translate(${27 * unit1} ${40 * unit1}) scale(${unit1})`}
              onPointerDown={(event) => tapAction(event, () => onCompassDraw?.({ type: 'circle', pose: compass }))}
            >
              <circle className="lw-drafting-action-bg" r="12" />
              <circle className="lw-drafting-action-icon-ring" r="5.2" />
              <circle className="lw-compass-hit" r={COMPASS_HIT_PX} />
              <title>Ganzen Kreis zeichnen</title>
            </g>
            {compass.pinned && (
              <g transform={`translate(0 ${40 * unit1}) scale(${unit1})`}>
                <PinGlyph x={0} y={0} />
              </g>
            )}
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
