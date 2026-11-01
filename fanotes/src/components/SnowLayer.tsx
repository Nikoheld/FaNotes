import { useEffect, useRef, useState } from 'react'
import { createSnowField, dragSnowField, stepSnowField, type SnowField } from '../lib/snowTheme'

const viewportField = (): SnowField => createSnowField(
  typeof window === 'undefined' ? 1280 : Math.max(1, window.innerWidth),
  typeof window === 'undefined' ? 800 : Math.max(1, window.innerHeight),
)

/** Full-shell snow. The layer ignores hits; a pointer drag anywhere still moves the flakes. */
export function SnowLayer({ reduceMotion }: { reduceMotion: boolean }) {
  const [field, setField] = useState(viewportField)
  const reduceMotionRef = useRef(reduceMotion)
  reduceMotionRef.current = reduceMotion

  useEffect(() => {
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      setField((current) => stepSnowField(current, dt, reduceMotionRef.current))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const onResize = () => {
      setField((current) => ({ ...current, width: window.innerWidth, height: window.innerHeight }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let origin: { x: number; y: number } | null = null
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      origin = { x: event.clientX, y: event.clientY }
    }
    const onMove = (event: PointerEvent) => {
      if (!origin) return
      const dx = event.clientX - origin.x
      const dy = event.clientY - origin.y
      origin = { x: event.clientX, y: event.clientY }
      if (dx === 0 && dy === 0) return
      setField((current) => dragSnowField(current, dx, dy))
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
    <div className="snow-layer" aria-hidden="true">
      {field.flakes.map((flake, index) => (
        <span
          key={index}
          className="snow-flake"
          data-x={flake.x}
          data-y={flake.y}
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
