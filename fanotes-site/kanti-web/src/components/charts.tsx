// Small inline-SVG charts for the grade views. No chart library: the geometry lives in lib/charts.ts.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { nearestPoint, ringSegments, scalePercent, trendLayout, trendPoints } from '../lib/charts'
import { markTone, type CourseMark } from '../lib/grades'
import { dateLabel, markLabel, type Language, type Strings } from '../lib/i18n'

/** A slim bar on the 1-6 scale with a tick at 4.0, coloured by the mark's tone. Decorative: the number is text beside it. */
export const ScaleBar = ({ value }: { value: number | null | undefined }) => (
  <span className={`scale-bar tone-${markTone(value)}`} aria-hidden="true">
    <span className="scale-fill" style={{ width: `${scalePercent(value)}%` } as CSSProperties} />
    <span className="scale-tick" />
  </span>
)

const HEIGHT = 208

/** A course's marks over time with the 4.0 line and the running average; hover or arrow keys read single marks. */
export const MarkTrend = ({ marks, label, t, language }: { marks: CourseMark[]; label: string; t: Strings; language: Language }) => {
  const points = useMemo(() => trendPoints(marks), [marks])
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  const [active, setActive] = useState<number | null>(null)
  useEffect(() => {
    const element = box.current
    if (!element) return undefined
    const measure = () => setWidth(Math.max(260, Math.round(element.clientWidth)))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [points.length])
  const layout = useMemo(() => trendLayout(points, width, HEIGHT), [points, width])
  if (!points.length) return null
  const last = layout.points[layout.points.length - 1]
  const shown = layout.points[active ?? layout.points.length - 1]
  const hiddenCount = marks.filter((entry) => entry.hidden).length
  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setActive(nearestPoint(layout.points, event.clientX - rect.left))
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const from = active ?? layout.points.length - 1
    setActive(Math.min(layout.points.length - 1, Math.max(0, from + (event.key === 'ArrowRight' ? 1 : -1))))
  }
  const { plot } = layout
  const first = layout.points[0]
  return (
    <div className="trend">
      <div className="trend-readout" aria-live="off">
        <span className={`trend-mark mark mark-${markTone(shown.mark)} tabular`}>{markLabel(shown.mark)}</span>
        <span className="trend-what">
          <strong>{shown.title || label}</strong>
          <small className="tabular">{dateLabel(shown.date, language, { day: 'numeric', month: 'short', year: 'numeric' })} · {t.weight} {markLabel(shown.weight)}</small>
        </span>
        <span className="trend-avg"><small>{t.runningAverage}</small><strong className="tabular">{markLabel(shown.running)}</strong></span>
      </div>
      <div
        className="trend-plot" ref={box} role="img" tabIndex={0}
        aria-label={t.trendAria(label, points.length, markLabel(last.running))}
        onKeyDown={onKey} onFocus={() => setActive((current) => current ?? layout.points.length - 1)} onBlur={() => setActive(null)}
      >
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} onPointerMove={onPointer} onPointerLeave={() => setActive(null)}>
          <rect className="trend-fail" x={plot.left} y={layout.passY} width={plot.right - plot.left} height={Math.max(0, plot.bottom - layout.passY)} />
          {layout.ticks.map((tick) => (
            <g key={tick.value}>
              <line className="trend-grid" x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} />
              <text className="trend-axis tabular" x={plot.left - 8} y={tick.y} textAnchor="end" dominantBaseline="middle">{tick.value}</text>
            </g>
          ))}
          <line className="trend-pass" x1={plot.left} x2={plot.right} y1={layout.passY} y2={layout.passY} />
          <text className="trend-pass-label" x={plot.right} y={layout.passY - 6} textAnchor="end">{t.passMark}</text>
          {layout.points.length > 1 ? <path className="trend-line" d={layout.markPath} /> : null}
          <path className="trend-running" d={layout.runningPath} />
          {layout.points.length === 1 ? <line className="trend-running" x1={plot.left} x2={plot.right} y1={first.ry} y2={first.ry} /> : null}
          {active != null ? <line className="trend-cursor" x1={shown.x} x2={shown.x} y1={plot.top} y2={plot.bottom} /> : null}
          {layout.points.map((point, index) => (
            <g key={point.id}>
              <circle className={`trend-dot tone-${markTone(point.mark)}${index === (active ?? layout.points.length - 1) ? ' current' : ''}`} cx={point.x} cy={point.y} r={index === (active ?? layout.points.length - 1) ? 6 : 4.5} />
              <title>{`${point.title} · ${markLabel(point.mark)}`}</title>
            </g>
          ))}
          <text className="trend-axis tabular" x={first.x} y={HEIGHT - 6} textAnchor={layout.points.length === 1 ? 'middle' : 'start'}>{dateLabel(first.date, language, { day: 'numeric', month: 'short' })}</text>
          {layout.points.length > 1 ? <text className="trend-axis tabular" x={last.x} y={HEIGHT - 6} textAnchor="end">{dateLabel(last.date, language, { day: 'numeric', month: 'short' })}</text> : null}
        </svg>
      </div>
      <div className="trend-legend">
        <span><i className="key-dot" />{t.mark}</span>
        <span><i className="key-line" />{t.runningAverage}</span>
        <span><i className="key-pass" />{t.passMark}</span>
        {hiddenCount ? <span className="trend-hidden">{t.hiddenCount(hiddenCount)}</span> : null}
      </div>
    </div>
  )
}

/** The quota ring of the absence points: booked in the accent, the estimate hatched in the warning tone. */
export const QuotaRing = ({ booked, estimated, quota, over, children }: { booked: number; estimated: number; quota: number; over: boolean; children: ReactNode }) => {
  const id = `hatch-${useId().replace(/[^a-zA-Z0-9]/gu, '')}`
  const ring = ringSegments(booked, estimated, quota)
  const dash = (length: number) => `${length} ${ring.circumference}`
  return (
    <div className={`quota-ring${over ? ' over' : ''}`}>
      <svg width="124" height="124" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="ring-hatch-bg" width="5" height="5" />
            <rect className="ring-hatch-bar" width="2.4" height="5" />
          </pattern>
        </defs>
        <circle className="ring-track" cx="50" cy="50" r={ring.radius} />
        {ring.estimated > 0 ? <circle className="ring-estimated" cx="50" cy="50" r={ring.radius} stroke={`url(#${id})`} strokeDasharray={dash(ring.estimated)} strokeDashoffset={-ring.booked} /> : null}
        {ring.booked > 0 ? <circle className="ring-booked" cx="50" cy="50" r={ring.radius} strokeDasharray={dash(ring.booked)} /> : null}
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  )
}
