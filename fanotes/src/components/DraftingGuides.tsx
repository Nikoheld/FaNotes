import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  RULER_HEIGHT_MM,
  RULER_LENGTH_MM,
  SET_SQUARE_LEG_MM,
  asCompassPose,
  angleToPoint,
  clampCompassRadius,
  formatArcDegrees,
  formatDegrees,
  formatMillimetres,
  mmToSourcePx,
  radiusMmBetween,
  shortestAngleDelta,
  snapRadiusMm,
  type CompassDrawEvent,
  type CompassPose,
  type DraftingKind,
  type DraftingPose,
} from '../lib/draftingTools'

type DraftingGuidesProps = {
  sourceWidth: number
  sourceHeight: number
  ruler: DraftingPose | null
  setSquare: DraftingPose | null
  compass: CompassPose | null
  readout: string | null
  onMove: (kind: DraftingKind, pose: DraftingPose) => void
  onCompassDraw?: (event: CompassDrawEvent) => void
}

type DragState = {
  kind: DraftingKind
  mode: 'move' | 'rotate' | 'radius' | 'draw'
  startX: number
  startY: number
  origin: DraftingPose
  lastAngle?: number
  startAngle?: number
  swept?: number
}

export function DraftingGuides({
  sourceWidth,
  sourceHeight,
  ruler,
  setSquare,
  compass,
  readout,
  onMove,
  onCompassDraw,
}: DraftingGuidesProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [drawPreview, setDrawPreview] = useState<{ from: number; to: number } | null>(null)
  const latestRef = useRef({ sourceWidth, sourceHeight, onMove, onCompassDraw })
  latestRef.current = { sourceWidth, sourceHeight, onMove, onCompassDraw }

  const toNormFromClient = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left) / Math.max(1, rect.width),
      y: (clientY - rect.top) / Math.max(1, rect.height),
    }
  }

  const applyDrag = (clientX: number, clientY: number) => {
    const drag = dragRef.current
    if (!drag) return
    const { sourceWidth: width, sourceHeight: height, onMove: move, onCompassDraw: draw } = latestRef.current
    const point = toNormFromClient(clientX, clientY)
    if (drag.mode === 'move') {
      move(drag.kind, {
        ...drag.origin,
        x: drag.origin.x + (point.x - drag.startX),
        y: drag.origin.y + (point.y - drag.startY),
      })
      return
    }
    if (drag.kind === 'compass' && (drag.mode === 'radius' || drag.mode === 'draw' || drag.mode === 'rotate')) {
      const origin = asCompassPose(drag.origin)
      const angle = angleToPoint(origin.x, origin.y, point.x, point.y, width, height)
      if (drag.mode === 'radius') {
        const measured = radiusMmBetween(origin.x, origin.y, point.x, point.y, width, height)
        const radiusMm = origin.locked ? origin.radiusMm : snapRadiusMm(clampCompassRadius(measured))
        move('compass', { ...origin, rotation: angle, radiusMm })
        return
      }
      const last = drag.lastAngle ?? origin.rotation
      const delta = shortestAngleDelta(last, angle)
      const nextRotation = last + delta
      const swept = (drag.swept ?? 0) + delta
      drag.lastAngle = nextRotation
      drag.swept = swept
      const next = { ...origin, rotation: nextRotation }
      move('compass', next)
      if (drag.mode === 'draw') {
        draw?.({ type: 'append', pose: next, fromAngle: last, toAngle: nextRotation })
        const start = drag.startAngle ?? last
        setDrawPreview({ from: start, to: start + swept })
        if (Math.abs(swept) >= Math.PI * 2 * 0.94) {
          draw?.({ type: 'cancel' })
          draw?.({ type: 'circle', pose: next })
          dragRef.current = null
          setDrawPreview(null)
        }
      }
      return
    }
    const heading = Math.atan2(point.y - drag.origin.y, point.x - drag.origin.x)
    const start = Math.atan2(drag.startY - drag.origin.y, drag.startX - drag.origin.x)
    move(drag.kind, { ...drag.origin, rotation: drag.origin.rotation + (heading - start) })
  }

  const finishDrag = () => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'compass' && drag.mode === 'draw') {
      const pose = asCompassPose({ ...drag.origin, rotation: drag.lastAngle ?? drag.origin.rotation })
      if (Math.abs(drag.swept ?? 0) < 0.045) latestRef.current.onCompassDraw?.({ type: 'cancel' })
      else latestRef.current.onCompassDraw?.({ type: 'commit', pose })
      setDrawPreview(null)
    }
    dragRef.current = null
  }

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return
      event.preventDefault()
      applyDrag(event.clientX, event.clientY)
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

  const beginDrag = (kind: DraftingKind, mode: DragState['mode'], pose: DraftingPose, event: ReactPointerEvent<SVGElement>) => {
    event.stopPropagation()
    event.preventDefault()
    if (event.pointerType === 'mouse') {
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    }
    const point = toNormFromClient(event.clientX, event.clientY)
    const angle = kind === 'compass'
      ? angleToPoint(pose.x, pose.y, point.x, point.y, latestRef.current.sourceWidth, latestRef.current.sourceHeight)
      : undefined
    dragRef.current = {
      kind,
      mode,
      startX: point.x,
      startY: point.y,
      origin: pose,
      lastAngle: angle,
      startAngle: angle,
      swept: 0,
    }
    if (kind === 'compass' && mode === 'draw' && angle !== undefined) {
      const next = { ...asCompassPose(pose), rotation: angle }
      latestRef.current.onMove('compass', next)
      latestRef.current.onCompassDraw?.({ type: 'begin', pose: next })
      setDrawPreview({ from: angle, to: angle })
    }
  }

  const toggleCompassLock = (event: ReactPointerEvent<SVGElement>, pose: CompassPose) => {
    event.stopPropagation()
    event.preventDefault()
    onMove('compass', { ...pose, locked: !pose.locked })
  }

  const drawFullCircle = (event: ReactPointerEvent<SVGElement>, pose: CompassPose) => {
    event.stopPropagation()
    event.preventDefault()
    onCompassDraw?.({ type: 'circle', pose })
  }

  const rulerPx = {
    length: mmToSourcePx(RULER_LENGTH_MM),
    height: mmToSourcePx(RULER_HEIGHT_MM),
  }
  const legPx = mmToSourcePx(SET_SQUARE_LEG_MM)
  const compassGeometry = compass ? describeCompass(compass) : null
  const upright = (x: number, y: number, rotation: number) => (
    `rotate(${-rotation * 180 / Math.PI} ${x} ${y})`
  )

  return (
    <svg
      ref={svgRef}
      className="lw-drafting-layer"
      viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {ruler && (
        <g
          className="lw-drafting-tool is-ruler"
          transform={`translate(${ruler.x * sourceWidth} ${ruler.y * sourceHeight}) rotate(${ruler.rotation * 180 / Math.PI})`}
        >
          <rect
            className="lw-drafting-body"
            x={-rulerPx.length / 2}
            y={-rulerPx.height / 2 + 6}
            width={rulerPx.length}
            height={rulerPx.height - 6}
            rx="2"
            onPointerDown={(event) => beginDrag('ruler', 'move', ruler, event)}
          />
          <line className="lw-drafting-edge" x1={-rulerPx.length / 2} y1={-rulerPx.height / 2} x2={rulerPx.length / 2} y2={-rulerPx.height / 2} />
          {Array.from({ length: RULER_LENGTH_MM + 1 }, (_, mm) => {
            const x = -rulerPx.length / 2 + mmToSourcePx(mm)
            const major = mm % 10 === 0
            const mid = mm % 5 === 0
            const tick = major ? 14 : mid ? 9 : 5
            const labelY = -rulerPx.height / 2 + 22
            return (
              <g key={mm}>
                <line className={`lw-drafting-tick ${major ? 'is-major' : ''}`} x1={x} y1={-rulerPx.height / 2} x2={x} y2={-rulerPx.height / 2 + tick} />
                {major && (
                  <text className="lw-drafting-label" x={x} y={labelY} transform={upright(x, labelY, ruler.rotation)}>
                    {mm / 10}
                  </text>
                )}
              </g>
            )
          })}
          <circle
            className="lw-drafting-rotate"
            cx={rulerPx.length / 2}
            cy="0"
            r="9"
            onPointerDown={(event) => beginDrag('ruler', 'rotate', ruler, event)}
          />
          <text
            className="lw-drafting-caption"
            x="0"
            y={rulerPx.height / 2 - 6}
            transform={upright(0, rulerPx.height / 2 - 6, ruler.rotation)}
          >
            Lineal · {formatDegrees(ruler.rotation)}
          </text>
        </g>
      )}
      {setSquare && (
        <g
          className="lw-drafting-tool is-setsquare"
          transform={`translate(${setSquare.x * sourceWidth} ${setSquare.y * sourceHeight}) rotate(${setSquare.rotation * 180 / Math.PI})`}
        >
          <path
            className="lw-drafting-body"
            d={`M 0 0 L ${legPx} 0 L 0 ${-legPx} Z`}
            onPointerDown={(event) => beginDrag('setSquare', 'move', setSquare, event)}
          />
          <path className="lw-drafting-window" d={`M ${legPx * 0.22} ${-legPx * 0.18} L ${legPx * 0.58} ${-legPx * 0.18} L ${legPx * 0.22} ${-legPx * 0.54} Z`} />
          {Array.from({ length: 15 }, (_, cm) => {
            const x = mmToSourcePx(cm * 10)
            return (
              <g key={`h${cm}`}>
                <line className="lw-drafting-tick is-major" x1={x} y1="0" x2={x} y2="10" />
                <text className="lw-drafting-label" x={x} y="20" transform={upright(x, 20, setSquare.rotation)}>{cm}</text>
              </g>
            )
          })}
          {Array.from({ length: 15 }, (_, cm) => {
            const y = -mmToSourcePx(cm * 10)
            return (
              <g key={`v${cm}`}>
                <line className="lw-drafting-tick is-major" x1="0" y1={y} x2="10" y2={y} />
                {cm > 0 && (
                  <text className="lw-drafting-label" x="18" y={y + 3} transform={upright(18, y + 3, setSquare.rotation)}>{cm}</text>
                )}
              </g>
            )
          })}
          {Array.from({ length: 7 }, (_, index) => {
            const degrees = index * 15
            const angle = degrees * Math.PI / 180
            const inner = legPx * 0.62
            const outer = legPx * 0.78
            const tx = Math.cos(angle) * (outer + 10)
            const ty = -Math.sin(angle) * (outer + 10) + 3
            return (
              <g key={`deg${degrees}`}>
                <line
                  className="lw-drafting-tick"
                  x1={Math.cos(angle) * inner}
                  y1={-Math.sin(angle) * inner}
                  x2={Math.cos(angle) * outer}
                  y2={-Math.sin(angle) * outer}
                />
                <text className="lw-drafting-label" x={tx} y={ty} transform={upright(tx, ty, setSquare.rotation)}>
                  {degrees}°
                </text>
              </g>
            )
          })}
          <circle
            className="lw-drafting-rotate"
            cx={legPx * 0.18}
            cy={-legPx * 0.18}
            r="9"
            onPointerDown={(event) => beginDrag('setSquare', 'rotate', setSquare, event)}
          />
          <text
            className="lw-drafting-caption"
            x={legPx * 0.28}
            y={-6}
            transform={upright(legPx * 0.28, -6, setSquare.rotation)}
          >
            Geodreieck · {formatDegrees(setSquare.rotation)}
          </text>
        </g>
      )}
      {compass && compassGeometry && (
        <>
          <ellipse
            className="lw-drafting-compass-ghost"
            cx={compass.x * sourceWidth}
            cy={compass.y * sourceHeight}
            rx={compassGeometry.radiusPx}
            ry={compassGeometry.radiusPx}
          />
          {drawPreview && Math.abs(drawPreview.to - drawPreview.from) > 0.02 && (
            <path
              className="lw-drafting-compass-arc"
              d={describePaperArc(
                compass.x * sourceWidth,
                compass.y * sourceHeight,
                compassGeometry.radiusPx,
                drawPreview.from,
                drawPreview.to,
              )}
            />
          )}
          <g
            className="lw-drafting-tool is-compass"
            transform={`translate(${compass.x * sourceWidth} ${compass.y * sourceHeight})`}
          >
            <g transform={`rotate(${compass.rotation * 180 / Math.PI})`}>
              <line className="lw-drafting-span" x1="0" y1="0" x2={compassGeometry.radiusPx} y2="0" />
              <rect
                className="lw-drafting-arm"
                x="0"
                y={-5}
                width={compassGeometry.radiusPx}
                height="10"
                rx="1"
                onPointerDown={(event) => beginDrag('compass', 'move', compass, event)}
              />
              {Array.from({ length: Math.floor(compass.radiusMm / 10) + 1 }, (_, cm) => {
                const x = mmToSourcePx(cm * 10)
                if (x > compassGeometry.radiusPx) return null
                return (
                  <g key={`c${cm}`}>
                    <line className="lw-drafting-tick is-major" x1={x} y1="-8" x2={x} y2="8" />
                    {cm > 0 && (
                      <text className="lw-drafting-label" x={x} y="20" transform={upright(x, 20, compass.rotation)}>{cm}</text>
                    )}
                  </g>
                )
              })}
              <circle
                className="lw-drafting-needle-dot"
                cx="0"
                cy="0"
                r="4"
                onPointerDown={(event) => beginDrag('compass', 'move', compass, event)}
              />
              <circle
                className="lw-drafting-needle"
                cx="0"
                cy="0"
                r="7"
                onPointerDown={(event) => beginDrag('compass', 'move', compass, event)}
              >
                <title>Nadel: Zirkel verschieben</title>
              </circle>
              <circle
                className="lw-drafting-draw"
                cx={compassGeometry.radiusPx}
                cy="0"
                r="10"
                onPointerDown={(event) => beginDrag('compass', 'draw', compass, event)}
              >
                <title>Mine drehen: Bogen oder Kreis zeichnen</title>
              </circle>
              <circle
                className="lw-drafting-radius"
                cx={compassGeometry.radiusPx * 0.55}
                cy="0"
                r="8"
                onPointerDown={(event) => beginDrag('compass', 'radius', compass, event)}
              >
                <title>{compass.locked ? 'Radius gesperrt · drehen zum Übertragen' : 'Radius einstellen / abmessen'}</title>
              </circle>
            </g>
            <g className={`lw-drafting-action ${compass.locked ? 'is-locked' : ''}`} transform="translate(-18 -28)" onPointerDown={(event) => toggleCompassLock(event, compass)}>
              <circle className="lw-drafting-action-bg" r="9" />
              <path
                className="lw-drafting-action-icon"
                d={compass.locked
                  ? 'M -3 0 v -3 a 3 3 0 0 1 6 0 v 3 h 3.5 v 7 h -13 v -7 z'
                  : 'M -3 0 v -3 a 3 3 0 0 1 6 0 h -2 a 1 1 0 0 0 -2 0 v 3 h 6.5 v 7 h -13 v -7 z'}
              />
              <title>{compass.locked ? 'Radius entsperren' : 'Radius sperren (Maß übertragen)'}</title>
            </g>
            <g className="lw-drafting-action is-circle" transform="translate(18 -28)" onPointerDown={(event) => drawFullCircle(event, compass)}>
              <circle className="lw-drafting-action-bg" r="9" />
              <circle className="lw-drafting-action-icon-ring" r="4.2" />
              <title>Ganzen Kreis zeichnen</title>
            </g>
            <text className="lw-drafting-caption" x="0" y="-44">
              Zirkel · {formatMillimetres(compass.radiusMm)}
              {drawPreview ? ` · ${formatArcDegrees(drawPreview.to - drawPreview.from)}` : compass.locked ? ' · gesperrt' : ''}
            </text>
          </g>
        </>
      )}
      {readout && (
        <text className="lw-drafting-readout" x={sourceWidth * 0.5} y="28">{readout}</text>
      )}
    </svg>
  )
}

const describeCompass = (pose: CompassPose) => ({
  radiusPx: mmToSourcePx(pose.radiusMm),
})

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
