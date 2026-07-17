import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import type { CanvasExport, CanvasState, Stroke, StrokePoint } from '../types'

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const OUTPUT_SIZE = 256
const OUTPUT_MARGIN = 26

export type DrawingCanvasHandle = {
  undo: () => void
  redo: () => void
  clear: () => void
  exportSample: () => CanvasExport | null
}

type Props = {
  brushSize: number
  pressureEnabled: boolean
  onStateChange: (state: CanvasState) => void
  onStrokesChange?: (strokes: Stroke[]) => void
}

const cloneStrokes = (strokes: Stroke[]): Stroke[] =>
  strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  }))

const pressureWidth = (stroke: Stroke, pressure: number) => {
  if (!stroke.pressureEnabled) return stroke.baseWidth
  return stroke.baseWidth * (0.45 + Math.max(0.08, pressure) * 1.05)
}

const DrawingCanvas = forwardRef<DrawingCanvasHandle, Props>(
  ({ brushSize, pressureEnabled, onStateChange, onStrokesChange }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const strokesRef = useRef<Stroke[]>([])
    const redoRef = useRef<Stroke[]>([])
    const activeStrokeRef = useRef<Stroke | null>(null)
    const activePointerRef = useRef<number | null>(null)

    const getContext = useCallback(() => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const context = canvas.getContext('2d')
      if (!context) return null
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.strokeStyle = '#142b2a'
      context.fillStyle = '#142b2a'
      return context
    }, [])

    const notify = useCallback(() => {
      onStateChange({
        hasInk: strokesRef.current.length > 0 || activeStrokeRef.current !== null,
        canUndo: strokesRef.current.length > 0,
        canRedo: redoRef.current.length > 0,
        pointCount: strokesRef.current.reduce((sum, stroke) => sum + stroke.points.length, 0),
      })
    }, [onStateChange])

    const notifyStrokes = useCallback(() => {
      onStrokesChange?.(cloneStrokes(strokesRef.current))
    }, [onStrokesChange])

    const drawStroke = useCallback(
      (context: CanvasRenderingContext2D, stroke: Stroke) => {
        if (stroke.points.length === 0) return
        const first = stroke.points[0]

        if (stroke.points.length === 1) {
          context.beginPath()
          context.arc(
            first.x * SOURCE_WIDTH,
            first.y * SOURCE_HEIGHT,
            pressureWidth(stroke, first.pressure) / 2,
            0,
            Math.PI * 2,
          )
          context.fill()
          return
        }

        for (let index = 1; index < stroke.points.length; index += 1) {
          const previous = stroke.points[index - 1]
          const point = stroke.points[index]
          context.beginPath()
          context.moveTo(previous.x * SOURCE_WIDTH, previous.y * SOURCE_HEIGHT)
          context.lineTo(point.x * SOURCE_WIDTH, point.y * SOURCE_HEIGHT)
          context.lineWidth = pressureWidth(stroke, (previous.pressure + point.pressure) / 2)
          context.stroke()
        }
      },
      [],
    )

    const redraw = useCallback(() => {
      const canvas = canvasRef.current
      const context = getContext()
      if (!canvas || !context) return
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const pixelWidth = Math.round(SOURCE_WIDTH * dpr)
      const pixelHeight = Math.round(SOURCE_HEIGHT * dpr)

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT)
      strokesRef.current.forEach((stroke) => drawStroke(context, stroke))
    }, [drawStroke, getContext])

    useEffect(() => {
      redraw()
      notify()
      const handleResize = () => redraw()
      window.addEventListener('resize', handleResize)
      return () => window.removeEventListener('resize', handleResize)
    }, [notify, redraw])

    const pointFromEvent = useCallback((event: PointerEvent): StrokePoint => {
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const eventPressure = event.pressure > 0 ? event.pressure : 0.5
      return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        t: Math.round(event.timeStamp * 100) / 100,
        pressure: Math.round(eventPressure * 1_000) / 1_000,
        tiltX: event.tiltX ?? 0,
        tiltY: event.tiltY ?? 0,
        pointerType: event.pointerType || 'mouse',
      }
    }, [])

    const appendPoint = useCallback(
      (event: PointerEvent) => {
        const stroke = activeStrokeRef.current
        const context = getContext()
        if (!stroke || !context) return
        const point = pointFromEvent(event)
        const previous = stroke.points.at(-1)
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.00025) return
        stroke.points.push(point)

        if (!previous) {
          drawStroke(context, stroke)
          return
        }

        context.beginPath()
        context.moveTo(previous.x * SOURCE_WIDTH, previous.y * SOURCE_HEIGHT)
        context.lineTo(point.x * SOURCE_WIDTH, point.y * SOURCE_HEIGHT)
        context.lineWidth = pressureWidth(stroke, (previous.pressure + point.pressure) / 2)
        context.stroke()
      },
      [drawStroke, getContext, pointFromEvent],
    )

    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (activePointerRef.current !== null) return
        // Touch pointers are navigation input here. In particular, several
        // Linux/Wacom combinations expose a trackpad gesture as touch pointer
        // events after the pen has been used. Capturing that pointer (or
        // cancelling its default action) makes two-finger scrolling appear to
        // stop for the rest of the GlyphenWerk session.
        if (event.pointerType === 'touch') return
        if (!event.isPrimary || (event.button !== 0 && event.pointerType !== 'pen')) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        activePointerRef.current = event.pointerId
        activeStrokeRef.current = {
          points: [],
          baseWidth: brushSize,
          pressureEnabled,
        }
        redoRef.current = []
        appendPoint(event.nativeEvent)
        notify()
      },
      [appendPoint, brushSize, notify, pressureEnabled],
    )

    const handlePointerMove = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (activePointerRef.current !== event.pointerId) return
        event.preventDefault()
        const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
        events.forEach(appendPoint)
      },
      [appendPoint],
    )

    const finishStroke = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (activePointerRef.current !== event.pointerId) return
        event.preventDefault()
        appendPoint(event.nativeEvent)
        const stroke = activeStrokeRef.current
        if (stroke && stroke.points.length > 0) strokesRef.current.push(stroke)
        activeStrokeRef.current = null
        activePointerRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        redraw()
        notify()
        notifyStrokes()
      },
      [appendPoint, notify, notifyStrokes, redraw],
    )

    const handleLostPointerCapture = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (activePointerRef.current !== event.pointerId) return
        const stroke = activeStrokeRef.current
        if (stroke?.points.length) strokesRef.current.push(stroke)
        activeStrokeRef.current = null
        activePointerRef.current = null
        redraw()
        notify()
        notifyStrokes()
      },
      [notify, notifyStrokes, redraw],
    )

    useEffect(() => {
      const releaseStalePointer = () => {
        if (activePointerRef.current === null) return
        const stroke = activeStrokeRef.current
        if (stroke?.points.length) strokesRef.current.push(stroke)
        activeStrokeRef.current = null
        activePointerRef.current = null
        redraw()
        notify()
        notifyStrokes()
      }
      window.addEventListener('blur', releaseStalePointer)
      return () => window.removeEventListener('blur', releaseStalePointer)
    }, [notify, notifyStrokes, redraw])

    const undo = useCallback(() => {
      const stroke = strokesRef.current.pop()
      if (stroke) redoRef.current.push(stroke)
      redraw()
      notify()
      notifyStrokes()
    }, [notify, notifyStrokes, redraw])

    const redo = useCallback(() => {
      const stroke = redoRef.current.pop()
      if (stroke) strokesRef.current.push(stroke)
      redraw()
      notify()
      notifyStrokes()
    }, [notify, notifyStrokes, redraw])

    const clear = useCallback(() => {
      strokesRef.current = []
      redoRef.current = []
      activeStrokeRef.current = null
      activePointerRef.current = null
      redraw()
      notify()
      notifyStrokes()
    }, [notify, notifyStrokes, redraw])

    const exportSample = useCallback((): CanvasExport | null => {
      const strokes = strokesRef.current.filter((stroke) => stroke.points.length > 0)
      if (strokes.length === 0) return null
      const points = strokes.flatMap((stroke) => stroke.points)
      const widestStroke = Math.max(...strokes.map((stroke) => stroke.baseWidth * 1.5), 1)

      const minPointX = Math.min(...points.map((point) => point.x * SOURCE_WIDTH))
      const maxPointX = Math.max(...points.map((point) => point.x * SOURCE_WIDTH))
      const minPointY = Math.min(...points.map((point) => point.y * SOURCE_HEIGHT))
      const maxPointY = Math.max(...points.map((point) => point.y * SOURCE_HEIGHT))
      const minX = Math.max(0, minPointX - widestStroke)
      const maxX = Math.min(SOURCE_WIDTH, maxPointX + widestStroke)
      const minY = Math.max(0, minPointY - widestStroke)
      const maxY = Math.min(SOURCE_HEIGHT, maxPointY + widestStroke)
      const boxWidth = Math.max(maxX - minX, widestStroke * 2)
      const boxHeight = Math.max(maxY - minY, widestStroke * 2)
      const scale = Math.min(
        (OUTPUT_SIZE - OUTPUT_MARGIN * 2) / boxWidth,
        (OUTPUT_SIZE - OUTPUT_MARGIN * 2) / boxHeight,
      )
      const offsetX = (OUTPUT_SIZE - boxWidth * scale) / 2
      const offsetY = (OUTPUT_SIZE - boxHeight * scale) / 2

      const output = document.createElement('canvas')
      output.width = OUTPUT_SIZE
      output.height = OUTPUT_SIZE
      const context = output.getContext('2d')!
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
      context.strokeStyle = '#142b2a'
      context.fillStyle = '#142b2a'
      context.lineCap = 'round'
      context.lineJoin = 'round'

      strokes.forEach((stroke) => {
        if (stroke.points.length === 1) {
          const point = stroke.points[0]
          context.beginPath()
          context.arc(
            offsetX + (point.x * SOURCE_WIDTH - minX) * scale,
            offsetY + (point.y * SOURCE_HEIGHT - minY) * scale,
            (pressureWidth(stroke, point.pressure) * scale) / 2,
            0,
            Math.PI * 2,
          )
          context.fill()
          return
        }

        for (let index = 1; index < stroke.points.length; index += 1) {
          const previous = stroke.points[index - 1]
          const point = stroke.points[index]
          context.beginPath()
          context.moveTo(
            offsetX + (previous.x * SOURCE_WIDTH - minX) * scale,
            offsetY + (previous.y * SOURCE_HEIGHT - minY) * scale,
          )
          context.lineTo(
            offsetX + (point.x * SOURCE_WIDTH - minX) * scale,
            offsetY + (point.y * SOURCE_HEIGHT - minY) * scale,
          )
          context.lineWidth = pressureWidth(stroke, (previous.pressure + point.pressure) / 2) * scale
          context.stroke()
        }
      })

      return {
        imageData: output.toDataURL('image/png'),
        bbox: [
          minX / SOURCE_WIDTH,
          minY / SOURCE_HEIGHT,
          boxWidth / SOURCE_WIDTH,
          boxHeight / SOURCE_HEIGHT,
        ].map((value) => Math.round(value * 100_000) / 100_000) as [number, number, number, number],
        strokes: cloneStrokes(strokes),
        sourceWidth: SOURCE_WIDTH,
        sourceHeight: SOURCE_HEIGHT,
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 3),
      }
    }, [])

    useImperativeHandle(ref, () => ({ undo, redo, clear, exportSample }), [
      clear,
      exportSample,
      redo,
      undo,
    ])

    return (
      <canvas
        ref={canvasRef}
        className="drawing-canvas"
        aria-label="Zeichenfläche für Handschrift"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onLostPointerCapture={handleLostPointerCapture}
        onContextMenu={(event) => event.preventDefault()}
      />
    )
  },
)

DrawingCanvas.displayName = 'DrawingCanvas'

export default DrawingCanvas
