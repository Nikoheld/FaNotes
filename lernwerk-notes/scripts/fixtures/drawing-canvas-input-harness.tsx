import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import DrawingCanvas from '../../../src/components/DrawingCanvas'
import '../../../src/styles.css'

const Harness = () => {
  const [state, setState] = useState({ hasInk: false, canUndo: false, canRedo: false, pointCount: 0 })
  return <>
    <main style={{ minHeight: 2200, padding: 32 }}>
      <h1>DrawingCanvas input regression</h1>
      <div className="canvas-stage" style={{ width: 720, height: 448, margin: 0 }}>
        <DrawingCanvas
          brushSize={6}
          pressureEnabled
          onStateChange={setState}
        />
      </div>
      <output id="state">{JSON.stringify(state)}</output>
      <div style={{ height: 1500 }} />
    </main>
    <span id="ready">ready</span>
  </>
}

createRoot(document.getElementById('root')!).render(<Harness />)
