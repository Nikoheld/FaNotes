export type CategoryId =
  | 'math'
  | 'digits'
  | 'uppercase'
  | 'lowercase'
  | 'greek'
  | 'german'
  | 'custom'

export type LabelDefinition = {
  id: string
  char: string
  name: string
  latex: string
  category: CategoryId
}

export type StrokePoint = {
  x: number
  y: number
  t: number
  pressure: number
  tiltX: number
  tiltY: number
  pointerType: string
}

export type Stroke = {
  points: StrokePoint[]
  baseWidth: number
  pressureEnabled: boolean
}

export type Sample = {
  id: string
  labelId: string
  label: string
  labelName: string
  latex: string
  category: CategoryId
  writerId: string
  sessionId: string
  createdAt: string
  imageData: string
  imageWidth: number
  imageHeight: number
  sourceCanvas: {
    width: number
    height: number
    devicePixelRatio: number
  }
  bbox: [number, number, number, number]
  strokes: Stroke[]
  strokeCount: number
  pointCount: number
  schemaVersion: 1
}

export type CanvasState = {
  hasInk: boolean
  canUndo: boolean
  canRedo: boolean
  pointCount: number
}

export type CanvasExport = {
  imageData: string
  bbox: [number, number, number, number]
  strokes: Stroke[]
  sourceWidth: number
  sourceHeight: number
  devicePixelRatio: number
}
