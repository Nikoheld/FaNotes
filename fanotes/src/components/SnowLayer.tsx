import { useEffect, useRef } from 'react'
import {
  burstSnow,
  createSnowWorld,
  interactSnow,
  obstaclesFromRects,
  resizeSnowWorld,
  stepSnowWorld,
  syncSnowObstacles,
  SNOW_COLUMN,
  SNOW_OBSTACLE_SELECTOR,
  type SnowObstacle,
  type SnowWorld,
} from '../lib/snowTheme'

const CONTROL_SELECTOR = 'button, a, input, textarea, select, summary, label, [role="button"], [contenteditable="true"], .cm-editor, .cm-content, canvas:not(.snow-canvas)'

const controlTarget = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(CONTROL_SELECTOR))

const obstacleKey = (obstacles: readonly SnowObstacle[]) => obstacles
  .map((obstacle) => `${Math.round(obstacle.left)}:${Math.round(obstacle.right)}:${Math.round(obstacle.top)}`)
  .sort()
  .join('|')

const FLAKE_SPRITE = 32

/** A soft white flake with a pale blue rim, so it reads on the light theme. */
const makeSprite = () => {
  const canvas = document.createElement('canvas')
  canvas.width = FLAKE_SPRITE
  canvas.height = FLAKE_SPRITE
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const half = FLAKE_SPRITE / 2
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.55, 'rgba(255,255,255,.95)')
  gradient.addColorStop(0.8, 'rgba(214,232,247,.9)')
  gradient.addColorStop(1, 'rgba(160,196,225,0)')
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(half, half, half, 0, Math.PI * 2)
  ctx.fill()
  return canvas
}

const drawPiles = (ctx: CanvasRenderingContext2D, world: SnowWorld) => {
  for (const pile of world.piles.values()) {
    const heights = pile.heights
    let any = false
    for (let index = 0; index < heights.length; index += 1) if (heights[index] > 0.25) { any = true; break }
    if (!any) continue
    const path = new Path2D()
    path.moveTo(pile.left, pile.top + 1)
    for (let index = 0; index < heights.length; index += 1) {
      path.lineTo(pile.left + (index + 0.5) * SNOW_COLUMN, pile.top - heights[index])
    }
    path.lineTo(pile.right, pile.top + 1)
    path.closePath()
    const deepest = Math.max(...heights, 1)
    const gradient = ctx.createLinearGradient(0, pile.top - deepest, 0, pile.top)
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(1, '#d6e6f4')
    ctx.fillStyle = gradient
    ctx.fill(path)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(120,160,195,.55)'
    ctx.stroke(path)
  }
}

/**
 * Full-shell snow on one canvas. Flakes drift in changing wind and pile up on
 * ledges. Moving the pointer stirs the flakes, pressing and dragging plows the
 * piles and throws snow, a click on empty space makes a burst. The canvas never
 * takes pointer events, so the app stays fully usable.
 */
export function SnowLayer({ reduceMotion }: { reduceMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return undefined
    const sprite = makeSprite()
    const world = createSnowWorld(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight))
    let obstacles: SnowObstacle[] = []
    let obstaclesKey = ''
    let dpr = 1

    const fit = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(window.innerWidth * dpr))
      canvas.height = Math.max(1, Math.round(window.innerHeight * dpr))
      resizeSnowWorld(world, window.innerWidth, window.innerHeight)
    }
    fit()

    const measure = () => {
      const rects = [...document.body.querySelectorAll(SNOW_OBSTACLE_SELECTOR)]
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, top: rect.top, right: rect.right, width: rect.width, height: rect.height }
        })
      const next = obstaclesFromRects(rects, window.innerWidth, window.innerHeight)
      const key = obstacleKey(next)
      if (key === obstaclesKey) return
      obstaclesKey = key
      obstacles = next
      syncSnowObstacles(world, next)
    }
    let measureFrame = 0
    const scheduleMeasure = () => {
      if (measureFrame) return
      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = 0
        measure()
      })
    }
    measure()
    const timer = window.setInterval(scheduleMeasure, 250)
    const observer = new MutationObserver(scheduleMeasure)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] })
    const onResize = () => {
      fit()
      scheduleMeasure()
    }
    window.addEventListener('resize', onResize)

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
      drawPiles(ctx, world)
      for (const flake of world.flakes) {
        const size = flake.radius * 2.6
        ctx.globalAlpha = Math.min(1, 0.55 + flake.radius * 0.18)
        ctx.drawImage(sprite, flake.x - size / 2, flake.y - size / 2, size, size)
      }
      ctx.globalAlpha = 1
    }

    // Pointer: stir on move, plow while pressed. Nothing here blocks the event.
    let last: { x: number; y: number; t: number } | null = null
    let pressed = false
    let pressedOnControl = false
    const onMove = (event: PointerEvent) => {
      const now = performance.now()
      if (last && !reduceMotion) {
        const dt = Math.max(8, now - last.t) / 1000
        const vx = Math.max(-1800, Math.min(1800, (event.clientX - last.x) / dt))
        const vy = Math.max(-1800, Math.min(1800, (event.clientY - last.y) / dt))
        interactSnow(world, event.clientX, event.clientY, vx, vy, pressed && !pressedOnControl)
      }
      last = { x: event.clientX, y: event.clientY, t: now }
    }
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      pressed = true
      pressedOnControl = controlTarget(event.target)
      last = { x: event.clientX, y: event.clientY, t: performance.now() }
      if (!pressedOnControl && !reduceMotion) burstSnow(world, event.clientX, event.clientY, 14)
    }
    const onUp = () => {
      pressed = false
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)

    let frame = 0
    let lastTime = performance.now()
    const tick = (now: number) => {
      const dt = now - lastTime
      lastTime = now
      if (!reduceMotion && !document.hidden) {
        stepSnowWorld(world, dt)
        draw()
      }
      frame = requestAnimationFrame(tick)
    }
    if (reduceMotion) draw()
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      if (measureFrame) cancelAnimationFrame(measureFrame)
      window.clearInterval(timer)
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [reduceMotion])

  return (
    <div className="snow-layer" aria-hidden="true">
      <canvas ref={canvasRef} className="snow-canvas" />
    </div>
  )
}
