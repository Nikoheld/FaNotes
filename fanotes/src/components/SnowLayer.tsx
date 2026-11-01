import { useEffect, useRef, useState } from 'react'
import {
  createSnowField,
  dragSnowField,
  obstaclesFromRects,
  snowDragHitsSettled,
  stepSnowField,
  SNOW_OBSTACLE_SELECTOR,
  type SnowField,
  type SnowObstacle,
} from '../lib/snowTheme'

const CONTROL_SELECTOR = 'button, a, input, textarea, select, summary, label, [role="button"], [contenteditable="true"], .cm-editor, .cm-content, canvas'

const viewportField = (): SnowField => createSnowField(
  typeof window === 'undefined' ? 1280 : Math.max(1, window.innerWidth),
  typeof window === 'undefined' ? 800 : Math.max(1, window.innerHeight),
)

const controlTarget = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(CONTROL_SELECTOR))

/** Full-shell snow. Hits pass through; a drag that starts on settled snow pushes that pile. */
export function SnowLayer({ reduceMotion }: { reduceMotion: boolean }) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [field, setField] = useState(viewportField)
  const fieldRef = useRef(field)
  fieldRef.current = field
  const reduceMotionRef = useRef(reduceMotion)
  reduceMotionRef.current = reduceMotion
  const obstaclesRef = useRef<SnowObstacle[]>([])

  useEffect(() => {
    const measure = () => {
      const shell = layerRef.current?.closest('.app-shell')
      if (!shell) {
        obstaclesRef.current = []
        return
      }
      const rects = [...shell.querySelectorAll(SNOW_OBSTACLE_SELECTOR)]
        .filter((node) => !node.closest('.snow-layer'))
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, top: rect.top, right: rect.right, width: rect.width, height: rect.height }
        })
      obstaclesRef.current = obstaclesFromRects(rects, window.innerWidth, window.innerHeight)
    }
    measure()
    const timer = window.setInterval(measure, 200)
    window.addEventListener('resize', measure)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      setField((current) => {
        const next = stepSnowField(current, dt, reduceMotionRef.current, obstaclesRef.current)
        fieldRef.current = next
        return next
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const onResize = () => {
      setField((current) => {
        const next = { ...current, width: window.innerWidth, height: window.innerHeight }
        fieldRef.current = next
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let origin: { x: number; y: number } | null = null
    const onDown = (event: PointerEvent) => {
      origin = null
      if (event.button !== 0 || controlTarget(event.target)) return
      if (!snowDragHitsSettled(fieldRef.current, event.clientX, event.clientY)) return
      origin = { x: event.clientX, y: event.clientY }
    }
    const onMove = (event: PointerEvent) => {
      if (!origin) return
      const dx = event.clientX - origin.x
      const dy = event.clientY - origin.y
      origin = { x: event.clientX, y: event.clientY }
      if (dx === 0 && dy === 0) return
      setField((current) => {
        const next = dragSnowField(current, event.clientX, event.clientY, dx, dy)
        fieldRef.current = next
        return next
      })
    }
    const onUp = () => {
      origin = null
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [])

  return (
    <div ref={layerRef} className="snow-layer" aria-hidden="true">
      {field.flakes.map((flake, index) => (
        <span
          key={index}
          className="snow-flake"
          data-x={flake.x}
          data-y={flake.y}
          data-settled={flake.settled ? 'true' : 'false'}
          style={{
            width: flake.radius * 2,
            height: flake.radius * 2,
            transform: `translate3d(${flake.x}px, ${flake.y}px, 0)`,
          }}
        />
      ))}
    </div>
  )
}
