import { createRoot } from 'react-dom/client'
import { TextToHandwritingDialog } from '../../src/components/TextToHandwritingDialog'
import {
  drawingChromeFromHit,
  drawingPointerStartsInk,
} from '../../src/lib/overlayInteract'
import type { Sample } from '../../../src/types'

const point = (x: number, y: number, t: number) => ({
  x,
  y,
  t,
  pressure: 0.42,
  tiltX: 2,
  tiltY: -1,
  pointerType: 'pen' as const,
})

const sample = (char: string, variant = 1): Sample => ({
  id: `${char}-${variant}`,
  labelId: `label-${char}`,
  label: char,
  labelName: char,
  latex: char,
  category: char.toUpperCase() === char && char.toLowerCase() !== char ? 'uppercase' : 'lowercase',
  writerId: 'writer-test',
  sessionId: 'manual-test',
  createdAt: '2026-01-01T00:00:00.000Z',
  imageData: '',
  imageWidth: 100,
  imageHeight: 100,
  sourceCanvas: { width: 900, height: 1273, devicePixelRatio: 1 },
  bbox: [0.1, 0.1, 0.11 + variant * 0.004, 0.17],
  strokes: [{
    points: [
      point(0.105, 0.22, 0),
      point(0.13 + variant * 0.002, 0.12, 8),
      point(0.18 + variant * 0.003, 0.19, 16),
      point(0.205 + variant * 0.004, 0.215, 24),
    ],
    baseWidth: 4,
    pressureEnabled: true,
  }],
  strokeCount: 1,
  pointCount: 4,
  schemaVersion: 1,
})

const samples = [...new Set('Test einer langen Zeile')].filter((char) => char !== ' ')
  .flatMap((char) => [sample(char, 1), sample(char, 2)])

const Harness = () => (
  <section className="lw-drawing-board is-inline is-input-active" data-tth-board="inline">
    <div className="lw-canvas-surface" style={{ width: 320, height: 240, background: '#eee' }} />
    <TextToHandwritingDialog
      open
      samples={samples}
      pageWidth={400}
      pageHeight={420}
      suggestedStartY={96}
      color="#18202d"
      baseWidth={4}
      pressureEnabled
      paperStyle="blank"
      onClose={() => undefined}
      onInsert={() => undefined}
      onRequestTraining={() => undefined}
    />
  </section>
)

const record = { chrome: false, ink: false, prevented: false }
window.addEventListener('pointerdown', (event) => {
  const chrome = drawingChromeFromHit(event.target)
  if (chrome) {
    record.chrome = true
    record.ink = false
    record.prevented = event.defaultPrevented
    return
  }
  event.preventDefault()
  record.chrome = false
  record.ink = true
  record.prevented = true
}, true)

Object.assign(window, {
  __tthChrome: drawingChromeFromHit,
  __tthStartsInk: drawingPointerStartsInk,
  __tthPointerRecord: record,
})

createRoot(document.getElementById('root')!).render(<Harness />)
const ready = document.createElement('span')
ready.id = 'ready'
ready.textContent = 'ready'
document.body.append(ready)
