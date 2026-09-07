/**
 * Drafting tools (ruler, Geodreieck set square, compass) in real millimetres.
 *
 * Every pose lives in the sheet's normalised 0–1 space, so the tools follow the
 * ink when the page grows. Geometry is computed in "paper millimetres" where the
 * 900 source px paper column equals the 210 mm of an A4 sheet.
 */

/** A4 width in millimetres. The original paper column (900 source px) is 210 mm. */
export const A4_WIDTH_MM = 210
export const SOURCE_A4_PX = 900
export const MM_PER_INCH = 25.4
const MM_PER_SOURCE_PX = A4_WIDTH_MM / SOURCE_A4_PX

export const RULER_LENGTH_MM = 160
export const RULER_MIN_LENGTH_MM = 50
export const RULER_MAX_LENGTH_MM = 500
export const RULER_LENGTH_PRESETS_MM = [100, 150, 160, 200, 300]
export const RULER_HEIGHT_MM = 26

/** Geodreieck: the hypotenuse is the base with the centred scale and the protractor. */
export const SET_SQUARE_SIZE_MM = 160
export const SET_SQUARE_MIN_SIZE_MM = 80
export const SET_SQUARE_MAX_SIZE_MM = 400
export const SET_SQUARE_SIZE_PRESETS_MM = [160, 200, 250]
/** Leg of the default 45° set square (the base is the hypotenuse). */
export const SET_SQUARE_LEG_MM = SET_SQUARE_SIZE_MM / Math.SQRT2
/** Degree labels at the set-square protractor: a full 0–180° half circle around the base centre. */
export const SET_SQUARE_PROTRACTOR_DEGREES = Array.from({ length: 19 }, (_, index) => index * 10)

export const SNAP_MM = 3.2
/** A set square within this reach of a ruler edge lies down flush against it. */
export const ATTACH_DISTANCE_MM = 7
export const ATTACH_ANGLE_RAD = 10 * Math.PI / 180

export const COMPASS_MIN_RADIUS_MM = 3
export const COMPASS_MAX_RADIUS_MM = 200
export const COMPASS_DEFAULT_RADIUS_MM = 35
export const COMPASS_ARC_PRESETS_DEG = [30, 45, 60, 90, 180, 270]
export const COMPASS_CENTRE_MARK_MM = 1.6

export type DraftingKind = 'ruler' | 'setSquare' | 'compass'
export type DraftingUnit = 'cm' | 'in'
export type DraftingAngleStep = 0 | 1 | 5 | 15 | 45
export type DraftingMagnet = 'off' | 'soft' | 'normal' | 'strong'
export type ArcDirection = 'cw' | 'ccw'

export const DRAFTING_ANGLE_STEPS: DraftingAngleStep[] = [0, 1, 5, 15, 45]
export const DRAFTING_MAGNETS: DraftingMagnet[] = ['off', 'soft', 'normal', 'strong']

export type DraftingPose = {
  x: number
  y: number
  rotation: number
  /** Ruler: length of both drawing edges. */
  lengthMm?: number
  /** Set square: length of the base (hypotenuse). */
  sizeMm?: number
  /** Set square: apex on the other side of the base. */
  flipped?: boolean
  /** Compass radius. */
  radiusMm?: number
  /** Compass: radius locked to transfer a measure. */
  locked?: boolean
  /** Dragging neither moves nor rotates the tool; drawing along it still works. */
  pinned?: boolean
}

export type CompassPose = DraftingPose & {
  radiusMm: number
}

export type DraftingSettings = {
  unit: DraftingUnit
  /** Rotation handles and compass arcs snap to this step; 0 = free. */
  angleStep: DraftingAngleStep
  /** How far the pen may be from an edge and still land on it. */
  magnet: DraftingMagnet
  /** See-through tool bodies. */
  translucent: boolean
  rulerLengthMm: number
  setSquareSizeMm: number
  /** Parallel lines inside the set square (for drawing parallels). */
  setSquareParallels: boolean
  /** Set square lies down flush against a nearby ruler edge and slides along it. */
  attachToRuler: boolean
  /** Circles and arcs also mark their centre with a small cross. */
  compassCentreMark: boolean
  /** Sweep direction of the preset arcs. */
  arcDirection: ArcDirection
  /** Options panel shown while a tool is out. */
  panelOpen: boolean
}

export const DEFAULT_DRAFTING_SETTINGS: DraftingSettings = {
  unit: 'cm',
  angleStep: 1,
  magnet: 'normal',
  translucent: true,
  rulerLengthMm: RULER_LENGTH_MM,
  setSquareSizeMm: SET_SQUARE_SIZE_MM,
  setSquareParallels: true,
  attachToRuler: true,
  compassCentreMark: false,
  arcDirection: 'cw',
  panelOpen: true,
}

export const DRAFTING_SETTINGS_STORAGE_KEY = 'fanotes.drafting.v1'

const clampNumber = (value: unknown, min: number, max: number, fallback: number) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export const clampRulerLength = (mm: number) => clampNumber(mm, RULER_MIN_LENGTH_MM, RULER_MAX_LENGTH_MM, RULER_LENGTH_MM)

export const clampSetSquareSize = (mm: number) => clampNumber(mm, SET_SQUARE_MIN_SIZE_MM, SET_SQUARE_MAX_SIZE_MM, SET_SQUARE_SIZE_MM)

export const normalizeDraftingSettings = (raw: unknown): DraftingSettings => {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const defaults = DEFAULT_DRAFTING_SETTINGS
  const angleStep = Number(source.angleStep)
  return {
    unit: source.unit === 'in' ? 'in' : 'cm',
    angleStep: (DRAFTING_ANGLE_STEPS as number[]).includes(angleStep) ? angleStep as DraftingAngleStep : defaults.angleStep,
    magnet: DRAFTING_MAGNETS.includes(source.magnet as DraftingMagnet) ? source.magnet as DraftingMagnet : defaults.magnet,
    translucent: typeof source.translucent === 'boolean' ? source.translucent : defaults.translucent,
    rulerLengthMm: clampRulerLength(Number(source.rulerLengthMm)),
    setSquareSizeMm: clampSetSquareSize(Number(source.setSquareSizeMm)),
    setSquareParallels: typeof source.setSquareParallels === 'boolean' ? source.setSquareParallels : defaults.setSquareParallels,
    attachToRuler: typeof source.attachToRuler === 'boolean' ? source.attachToRuler : defaults.attachToRuler,
    compassCentreMark: typeof source.compassCentreMark === 'boolean' ? source.compassCentreMark : defaults.compassCentreMark,
    arcDirection: source.arcDirection === 'ccw' ? 'ccw' : 'cw',
    panelOpen: typeof source.panelOpen === 'boolean' ? source.panelOpen : defaults.panelOpen,
  }
}

export const loadDraftingSettings = (): DraftingSettings => {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_DRAFTING_SETTINGS }
    const raw = localStorage.getItem(DRAFTING_SETTINGS_STORAGE_KEY)
    return normalizeDraftingSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_DRAFTING_SETTINGS }
  }
}

export const saveDraftingSettings = (settings: DraftingSettings) => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(DRAFTING_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Private mode or full storage: the session keeps working without memory.
  }
}

export const magnetThresholdMm = (magnet: DraftingMagnet) => {
  if (magnet === 'off') return 0
  if (magnet === 'soft') return 1.6
  if (magnet === 'strong') return 6.5
  return SNAP_MM
}

export const angleStepRadians = (step: DraftingAngleStep) => step * Math.PI / 180

/** Rounds an angle to the configured step; 0 keeps it free. */
export const snapAngle = (radians: number, step: DraftingAngleStep) => {
  const stepRad = angleStepRadians(step)
  if (stepRad <= 0) return radians
  return Math.round(radians / stepRad) * stepRad
}

export const normalizeAngle = (radians: number) => {
  const turn = Math.PI * 2
  return ((radians % turn) + turn) % turn
}

export const degreesToRadians = (degrees: number) => degrees * Math.PI / 180

export const radiansToDegrees = (radians: number) => radians * 180 / Math.PI

export type DraftingEdge = {
  ax: number
  ay: number
  bx: number
  by: number
  /** Where the printed scale reads zero along the edge (0 = start, 0.5 = centre). */
  originT?: number
}

export type DraftingDisplay = {
  width: number
  height: number
}

export const mmToSourcePx = (mm: number) => mm * SOURCE_A4_PX / A4_WIDTH_MM

export const mmToNorm = (mm: number, sourceSize: number) => mmToSourcePx(mm) / Math.max(1, sourceSize)

/** Sheet millimetres per normalised unit, per axis. */
export const normToMm = (value: number, sourceSize: number) => value * Math.max(1, sourceSize) * MM_PER_SOURCE_PX

const displaySize = (
  sourceWidth: number,
  sourceHeight: number,
  display?: DraftingDisplay,
) => ({
  width: Math.max(1, display?.width ?? sourceWidth),
  height: Math.max(1, display?.height ?? sourceHeight),
})

/** Screen pixels per millimetre, using the sheet width as the 210 mm A4 column. */
export const pxPerMmOnDisplay = (
  sourceWidth: number,
  display?: DraftingDisplay,
) => displaySize(sourceWidth, sourceWidth, display).width / Math.max(1, sourceWidth) * SOURCE_A4_PX / A4_WIDTH_MM

export const rulerLength = (pose: DraftingPose) => clampRulerLength(pose.lengthMm ?? RULER_LENGTH_MM)

export const setSquareSize = (pose: DraftingPose) => clampSetSquareSize(pose.sizeMm ?? SET_SQUARE_SIZE_MM)

/** −1: apex above the base (local −y), +1: flipped, apex below. */
export const setSquareApexSign = (pose: DraftingPose) => (pose.flipped ? 1 : -1)

export const defaultRulerPose = (settings?: Partial<DraftingSettings>): DraftingPose => ({
  x: 0.5,
  y: 0.22,
  rotation: 0,
  lengthMm: clampRulerLength(settings?.rulerLengthMm ?? RULER_LENGTH_MM),
  pinned: false,
})

export const defaultSetSquarePose = (settings?: Partial<DraftingSettings>): DraftingPose => ({
  x: 0.5,
  y: 0.5,
  rotation: 0,
  sizeMm: clampSetSquareSize(settings?.setSquareSizeMm ?? SET_SQUARE_SIZE_MM),
  flipped: false,
  pinned: false,
})

export const defaultCompassPose = (): CompassPose => ({
  x: 0.44,
  y: 0.36,
  rotation: -Math.PI / 5,
  radiusMm: COMPASS_DEFAULT_RADIUS_MM,
  locked: false,
  pinned: false,
})

export const defaultPoseFor = (kind: DraftingKind, settings?: Partial<DraftingSettings>): DraftingPose => {
  if (kind === 'ruler') return defaultRulerPose(settings)
  if (kind === 'setSquare') return defaultSetSquarePose(settings)
  return defaultCompassPose()
}

export const clampCompassRadius = (mm: number) => (
  Math.min(COMPASS_MAX_RADIUS_MM, Math.max(COMPASS_MIN_RADIUS_MM, Number.isFinite(mm) ? mm : COMPASS_DEFAULT_RADIUS_MM))
)

export const asCompassPose = (pose: DraftingPose): CompassPose => ({
  ...pose,
  radiusMm: clampCompassRadius(pose.radiusMm ?? COMPASS_DEFAULT_RADIUS_MM),
  locked: Boolean(pose.locked),
})

export const compassRadiiNorm = (
  radiusMm: number,
  sourceWidth: number,
  sourceHeight: number,
  display?: DraftingDisplay,
) => {
  const rx = mmToNorm(radiusMm, sourceWidth)
  const { width, height } = displaySize(sourceWidth, sourceHeight, display)
  // Screen circle: rx * displayWidth === ry * displayHeight. Without this
  // correction a square millimetre becomes an ellipse as soon as the sheet
  // is wider or taller than the 900×1273 source page.
  return { rx, ry: rx * (width / height) }
}

export const compassPencilPoint = (
  pose: CompassPose,
  sourceWidth: number,
  sourceHeight: number,
  display?: DraftingDisplay,
) => {
  const { rx, ry } = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight, display)
  return {
    x: pose.x + Math.cos(pose.rotation) * rx,
    y: pose.y + Math.sin(pose.rotation) * ry,
  }
}

export const radiusMmBetween = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  sourceWidth: number,
  sourceHeight: number,
  display?: DraftingDisplay,
) => {
  const { width, height } = displaySize(sourceWidth, sourceHeight, display)
  const pixels = Math.hypot((bx - ax) * width, (by - ay) * height)
  return pixels / Math.max(1e-6, pxPerMmOnDisplay(sourceWidth, { width, height }))
}

export const angleToPoint = (
  originX: number,
  originY: number,
  x: number,
  y: number,
  sourceWidth: number,
  sourceHeight: number,
  display?: DraftingDisplay,
) => {
  const { width, height } = displaySize(sourceWidth, sourceHeight, display)
  return Math.atan2((y - originY) * height, (x - originX) * width)
}

export const snapRadiusMm = (mm: number) => {
  const rounded = Math.round(mm)
  return Math.abs(mm - rounded) < 0.35 ? rounded : mm
}

export const shortestAngleDelta = (from: number, to: number) => {
  let delta = to - from
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

export type CompassSample = { x: number; y: number }

export const sampleCompassArc = (
  pose: CompassPose,
  fromAngle: number,
  toAngle: number,
  sourceWidth: number,
  sourceHeight: number,
  stepRad = 0.035,
  display?: DraftingDisplay,
): CompassSample[] => {
  const { rx, ry } = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight, display)
  const delta = toAngle - fromAngle
  if (Math.abs(delta) < 1e-8) {
    return [{
      x: pose.x + Math.cos(toAngle) * rx,
      y: pose.y + Math.sin(toAngle) * ry,
    }]
  }
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / stepRad))
  const points: CompassSample[] = []
  for (let index = 1; index <= steps; index += 1) {
    const angle = fromAngle + delta * (index / steps)
    points.push({
      x: pose.x + Math.cos(angle) * rx,
      y: pose.y + Math.sin(angle) * ry,
    })
  }
  return points
}

export const sampleCompassCircle = (
  pose: CompassPose,
  sourceWidth: number,
  sourceHeight: number,
  display?: DraftingDisplay,
): CompassSample[] => {
  const points = sampleCompassArc(
    pose,
    pose.rotation,
    pose.rotation + Math.PI * 2,
    sourceWidth,
    sourceHeight,
    0.028,
    display,
  )
  const first = points[0]
  if (first) points.push({ x: first.x, y: first.y })
  return points
}

/** Two short strokes crossing at the needle: the centre mark of a construction. */
export const compassCentreMarkSegments = (
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
  display?: DraftingDisplay,
): CompassSample[][] => {
  const { rx, ry } = compassRadiiNorm(COMPASS_CENTRE_MARK_MM, sourceWidth, sourceHeight, display)
  return [
    [{ x: pose.x - rx, y: pose.y }, { x: pose.x + rx, y: pose.y }],
    [{ x: pose.x, y: pose.y - ry }, { x: pose.x, y: pose.y + ry }],
  ]
}

/** Signed sweep of a preset arc in the configured direction (screen y points down, so cw is positive). */
export const presetArcSweep = (degrees: number, direction: ArcDirection) => (
  degreesToRadians(Math.abs(degrees)) * (direction === 'ccw' ? -1 : 1)
)

export type CompassDrawEvent =
  | { type: 'begin'; pose: CompassPose }
  | { type: 'append'; pose: CompassPose; fromAngle: number; toAngle: number }
  | { type: 'commit'; pose: CompassPose }
  | { type: 'cancel' }
  | { type: 'circle'; pose: CompassPose }
  | { type: 'arc'; pose: CompassPose; sweep: number }

const rotateAround = (x: number, y: number, cx: number, cy: number, rotation: number) => {
  const dx = x - cx
  const dy = y - cy
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

/**
 * Tool-local millimetres → sheet point. The turn happens in millimetres: the
 * normalised sheet is not square, so rotating there would shear the tool
 * against its own drawing on screen.
 */
export const draftingLocalToNorm = (
  localX: number,
  localY: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const turned = rotateAround(localX, localY, 0, 0, pose.rotation)
  return {
    x: pose.x + mmToNorm(turned.x, sourceWidth),
    y: pose.y + mmToNorm(turned.y, sourceHeight),
  }
}

/** Sheet point → tool-local millimetres (x along the tool, y across it). */
export const normToLocalMm = (
  x: number,
  y: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => rotateAround(
  normToMm(x - pose.x, sourceWidth),
  normToMm(y - pose.y, sourceHeight),
  0,
  0,
  -pose.rotation,
)

/** Axis-aligned extent of a tool around its pose origin, in sheet millimetres, rotation applied. */
export const toolExtentMm = (kind: DraftingKind, pose: DraftingPose) => {
  let corners: Array<{ x: number; y: number }>
  if (kind === 'compass') {
    const radius = clampCompassRadius(pose.radiusMm ?? COMPASS_DEFAULT_RADIUS_MM)
    return { minX: -radius, maxX: radius, minY: -radius, maxY: radius }
  }
  if (kind === 'ruler') {
    const half = rulerLength(pose) / 2
    const across = RULER_HEIGHT_MM / 2
    corners = [{ x: -half, y: -across }, { x: half, y: -across }, { x: half, y: across }, { x: -half, y: across }]
  } else {
    const half = setSquareSize(pose) / 2
    corners = [{ x: -half, y: 0 }, { x: half, y: 0 }, { x: 0, y: setSquareApexSign(pose) * half }]
  }
  const turned = corners.map((corner) => rotateAround(corner.x, corner.y, 0, 0, pose.rotation))
  return {
    minX: Math.min(...turned.map((corner) => corner.x)),
    maxX: Math.max(...turned.map((corner) => corner.x)),
    minY: Math.min(...turned.map((corner) => corner.y)),
    maxY: Math.max(...turned.map((corner) => corner.y)),
  }
}

/**
 * Moves a pose so the whole tool lies on the sheet where it fits. A tool larger
 * than the sheet keeps its origin (ruler centre, set-square base centre, compass
 * needle) on the sheet instead, so its drawing edge stays reachable.
 */
export const keepPoseOnSheet = <T extends DraftingPose>(
  kind: DraftingKind,
  pose: T,
  sourceWidth: number,
  sourceHeight: number,
  marginMm = 2,
): T => {
  const extent = toolExtentMm(kind, pose)
  const fit = (centre: number, min: number, max: number, size: number) => {
    const low = marginMm - min
    const high = size - marginMm - max
    if (low <= high) return Math.min(high, Math.max(low, centre))
    return Math.min(size - marginMm, Math.max(marginMm, centre))
  }
  const x = fit(normToMm(pose.x, sourceWidth), extent.minX, extent.maxX, normToMm(1, sourceWidth))
  const y = fit(normToMm(pose.y, sourceHeight), extent.minY, extent.maxY, normToMm(1, sourceHeight))
  return { ...pose, x: mmToNorm(x, sourceWidth), y: mmToNorm(y, sourceHeight) }
}

/** Moves a pose by sheet millimetres along the screen axes. */
export const nudgePose = <T extends DraftingPose>(
  pose: T,
  dxMm: number,
  dyMm: number,
  sourceWidth: number,
  sourceHeight: number,
): T => ({
  ...pose,
  x: pose.x + mmToNorm(dxMm, sourceWidth),
  y: pose.y + mmToNorm(dyMm, sourceHeight),
})

const pointInsideRuler = (
  x: number,
  y: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const local = normToLocalMm(x, y, pose, sourceWidth, sourceHeight)
  const half = rulerLength(pose) / 2
  const top = -RULER_HEIGHT_MM / 2
  const bottom = RULER_HEIGHT_MM / 2
  return local.x >= -half && local.x <= half && local.y >= top - 0.6 && local.y <= bottom + 0.6
}

const pointInsideSetSquare = (
  x: number,
  y: number,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const local = normToLocalMm(x, y, pose, sourceWidth, sourceHeight)
  const half = setSquareSize(pose) / 2
  const pad = 0.8
  const towardApex = local.y * setSquareApexSign(pose)
  return towardApex >= -pad && Math.abs(local.x) + Math.abs(local.y) <= half + pad
}

export const millimetresAlongEdge = (
  edge: DraftingEdge,
  t: number,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const dxPx = (edge.bx - edge.ax) * sourceWidth
  const dyPx = (edge.by - edge.ay) * sourceHeight
  return (t - (edge.originT ?? 0)) * Math.hypot(dxPx, dyPx) * MM_PER_SOURCE_PX
}

/** Direction of an edge in sheet millimetres (isotropic), radians. */
export const edgeAngle = (edge: DraftingEdge, sourceWidth: number, sourceHeight: number) => (
  Math.atan2((edge.by - edge.ay) * sourceHeight, (edge.bx - edge.ax) * sourceWidth)
)

type LocalLine = {
  ax: number
  ay: number
  bx: number
  by: number
  originT: number
  /** Unit normal pointing away from the tool body; `null` for lines inside the body. */
  outward: { x: number; y: number } | null
}

const rulerLocalLines = (pose: DraftingPose): LocalLine[] => {
  const half = rulerLength(pose) / 2
  const top = -RULER_HEIGHT_MM / 2
  const bottom = RULER_HEIGHT_MM / 2
  return [
    { ax: -half, ay: top, bx: half, by: top, originT: 0, outward: { x: 0, y: -1 } },
    { ax: -half, ay: bottom, bx: half, by: bottom, originT: 0, outward: { x: 0, y: 1 } },
  ]
}

/**
 * Geodreieck in local millimetres: base from −S/2 to +S/2 on the x axis with the
 * scale zero at the centre, apex at (0, sign·S/2). Legs run from the base
 * corners to the apex so their scales start at the corner.
 */
const setSquareLocalLines = (pose: DraftingPose): LocalLine[] => {
  const half = setSquareSize(pose) / 2
  const sign = setSquareApexSign(pose)
  const diagonal = 1 / Math.SQRT2
  return [
    { ax: -half, ay: 0, bx: half, by: 0, originT: 0.5, outward: { x: 0, y: -sign } },
    { ax: -half, ay: 0, bx: 0, by: sign * half, originT: 0, outward: { x: -diagonal, y: sign * diagonal } },
    { ax: half, ay: 0, bx: 0, by: sign * half, originT: 0, outward: { x: diagonal, y: sign * diagonal } },
  ]
}

/** Centre line of the set square (base centre → apex): an alignment guide, not a drawing edge. */
const setSquareMidline = (pose: DraftingPose): LocalLine => {
  const half = setSquareSize(pose) / 2
  return { ax: 0, ay: 0, bx: 0, by: setSquareApexSign(pose) * half, originT: 0, outward: null }
}

const localLineToEdge = (line: LocalLine, pose: DraftingPose, sourceWidth: number, sourceHeight: number): DraftingEdge => {
  const a = draftingLocalToNorm(line.ax, line.ay, pose, sourceWidth, sourceHeight)
  const b = draftingLocalToNorm(line.bx, line.by, pose, sourceWidth, sourceHeight)
  return { ax: a.x, ay: a.y, bx: b.x, by: b.y, originT: line.originT }
}

const pointToLocalLineMm = (x: number, y: number, line: LocalLine) => {
  const vx = line.bx - line.ax
  const vy = line.by - line.ay
  const length2 = vx * vx + vy * vy
  const t = length2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - line.ax) * vx + (y - line.ay) * vy) / length2))
  return Math.hypot(x - (line.ax + t * vx), y - (line.ay + t * vy))
}

/** Distance from a sheet point to the nearest drawing edge of a ruler or set square, in millimetres. */
export const distanceToDrawingEdgeMm = (
  kind: DraftingKind,
  pose: DraftingPose,
  x: number,
  y: number,
  sourceWidth: number,
  sourceHeight: number,
) => {
  if (kind === 'compass') return Number.POSITIVE_INFINITY
  const local = normToLocalMm(x, y, pose, sourceWidth, sourceHeight)
  const lines = kind === 'ruler' ? rulerLocalLines(pose) : setSquareLocalLines(pose)
  return Math.min(...lines.map((line) => pointToLocalLineMm(local.x, local.y, line)))
}

/**
 * A pen landing on the tool body this close to a drawing edge is meant to draw
 * along it, not to move the tool; further inside, the body is a handle.
 */
export const PEN_EDGE_ZONE_MM = 6

export const rulerDrawingEdges = (pose: DraftingPose, sourceWidth: number, sourceHeight: number): DraftingEdge[] => (
  rulerLocalLines(pose).map((line) => localLineToEdge(line, pose, sourceWidth, sourceHeight))
)

export const setSquareDrawingEdges = (pose: DraftingPose, sourceWidth: number, sourceHeight: number): DraftingEdge[] => (
  setSquareLocalLines(pose).map((line) => localLineToEdge(line, pose, sourceWidth, sourceHeight))
)

export const draftingEdges = (
  kind: DraftingKind,
  pose: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
) => {
  if (kind === 'compass') return []
  return (kind === 'ruler' ? rulerDrawingEdges : setSquareDrawingEdges)(pose, sourceWidth, sourceHeight)
}

export type SnapResult = {
  x: number
  y: number
  kind: DraftingKind
  edgeIndex: number
  /** Reading on the printed scale; negative left of a centred zero. */
  millimetres: number
  /** Direction of the edge (or of the compass pencil) in sheet millimetres, radians. */
  angle: number
}

const projectOnCompass = (
  x: number,
  y: number,
  pose: CompassPose,
  sourceWidth: number,
  sourceHeight: number,
  thresholdMm: number,
  display?: DraftingDisplay,
): SnapResult | null => {
  const { rx, ry } = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight, display)
  if (rx < 1e-6 || ry < 1e-6) return null
  const distMm = radiusMmBetween(pose.x, pose.y, x, y, sourceWidth, sourceHeight, display)
  if (Number.isFinite(thresholdMm) && Math.abs(distMm - pose.radiusMm) > thresholdMm) return null
  const angle = angleToPoint(pose.x, pose.y, x, y, sourceWidth, sourceHeight, display)
  return {
    x: pose.x + Math.cos(angle) * rx,
    y: pose.y + Math.sin(angle) * ry,
    kind: 'compass',
    edgeIndex: 0,
    millimetres: pose.radiusMm,
    angle,
  }
}

const projectOnEdge = (x: number, y: number, edge: DraftingEdge) => {
  const vx = edge.bx - edge.ax
  const vy = edge.by - edge.ay
  const length2 = vx * vx + vy * vy
  if (length2 < 1e-12) return { x: edge.ax, y: edge.ay, t: 0, distance: Math.hypot(x - edge.ax, y - edge.ay) }
  const t = Math.max(0, Math.min(1, ((x - edge.ax) * vx + (y - edge.ay) * vy) / length2))
  const px = edge.ax + t * vx
  const py = edge.ay + t * vy
  return { x: px, y: py, t, distance: Math.hypot(x - px, y - py) }
}

/** Distance between two sheet points in millimetres. */
const distanceMm = (ax: number, ay: number, bx: number, by: number, sourceWidth: number, sourceHeight: number) => (
  Math.hypot(normToMm(bx - ax, sourceWidth), normToMm(by - ay, sourceHeight))
)

const edgeSnap = (
  x: number,
  y: number,
  kind: DraftingKind,
  edge: DraftingEdge,
  edgeIndex: number,
  sourceWidth: number,
  sourceHeight: number,
): SnapResult & { distanceMm: number } => {
  const projected = projectOnEdge(x, y, edge)
  return {
    x: projected.x,
    y: projected.y,
    kind,
    edgeIndex,
    millimetres: millimetresAlongEdge(edge, projected.t, sourceWidth, sourceHeight),
    angle: edgeAngle(edge, sourceWidth, sourceHeight),
    distanceMm: distanceMm(x, y, projected.x, projected.y, sourceWidth, sourceHeight),
  }
}

const nearestOnEdges = (
  x: number,
  y: number,
  kind: DraftingKind,
  edges: DraftingEdge[],
  sourceWidth: number,
  sourceHeight: number,
  thresholdMm: number,
): (SnapResult & { distanceMm: number }) | null => {
  let best: (SnapResult & { distanceMm: number }) | null = null
  edges.forEach((edge, edgeIndex) => {
    const candidate = edgeSnap(x, y, kind, edge, edgeIndex, sourceWidth, sourceHeight)
    if (candidate.distanceMm > thresholdMm) return
    if (!best || candidate.distanceMm < best.distanceMm) best = candidate
  })
  return best
}

export type DraftingToolState = { kind: DraftingKind; pose: DraftingPose }

export type SnapOptions = {
  /** Reach of the magnet in millimetres; 0 disables snapping entirely. */
  thresholdMm?: number
  /** Skip these tools (e.g. the compass while its own needle is being placed). */
  exclude?: DraftingKind[]
}

/**
 * Pulls a pen sample onto the nearest drawing edge (or compass circle). A pen
 * inside a ruler or set-square body always lands on that body's nearest edge —
 * on paper you cannot draw underneath the instrument either.
 */
export const snapToDraftingTools = (
  x: number,
  y: number,
  tools: DraftingToolState[],
  sourceWidth: number,
  sourceHeight: number,
  locked?: { kind: DraftingKind; edgeIndex: number } | null,
  display?: DraftingDisplay,
  options?: SnapOptions,
): SnapResult | null => {
  const thresholdMm = options?.thresholdMm ?? SNAP_MM
  const excluded = options?.exclude ?? []
  if (locked) {
    const tool = tools.find((item) => item.kind === locked.kind)
    if (tool && !excluded.includes(tool.kind)) {
      if (tool.kind === 'compass') {
        return projectOnCompass(x, y, asCompassPose(tool.pose), sourceWidth, sourceHeight, Number.POSITIVE_INFINITY, display)
      }
      const edges = draftingEdges(tool.kind, tool.pose, sourceWidth, sourceHeight)
      const edge = edges[locked.edgeIndex]
      if (edge) return edgeSnap(x, y, tool.kind, edge, locked.edgeIndex, sourceWidth, sourceHeight)
    }
  }
  if (thresholdMm <= 0) return null
  let best: SnapResult | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const tool of tools) {
    if (excluded.includes(tool.kind)) continue
    if (tool.kind === 'compass') {
      const candidate = projectOnCompass(x, y, asCompassPose(tool.pose), sourceWidth, sourceHeight, thresholdMm, display)
      if (!candidate) continue
      const distance = distanceMm(x, y, candidate.x, candidate.y, sourceWidth, sourceHeight)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
      continue
    }
    const edges = draftingEdges(tool.kind, tool.pose, sourceWidth, sourceHeight)
    const inside = tool.kind === 'ruler'
      ? pointInsideRuler(x, y, tool.pose, sourceWidth, sourceHeight)
      : pointInsideSetSquare(x, y, tool.pose, sourceWidth, sourceHeight)
    const candidate = nearestOnEdges(x, y, tool.kind, edges, sourceWidth, sourceHeight, inside ? Number.POSITIVE_INFINITY : thresholdMm)
    if (!candidate) continue
    // Under the body the pen must always come out on an edge, however far.
    const distance = inside ? -1 : candidate.distanceMm
    if (distance < bestDistance) {
      best = {
        x: candidate.x,
        y: candidate.y,
        kind: candidate.kind,
        edgeIndex: candidate.edgeIndex,
        millimetres: candidate.millimetres,
        angle: candidate.angle,
      }
      bestDistance = distance
    }
  }
  return best
}

/**
 * Lays the set square flush against the nearest ruler edge: base or a leg (for
 * parallels and perpendiculars sliding along the ruler) or the centre line (for
 * a perpendicular through a point on the ruler). `null` when nothing is in reach.
 */
export const attachSetSquareToRuler = (
  square: DraftingPose,
  ruler: DraftingPose,
  sourceWidth: number,
  sourceHeight: number,
  reach: { distanceMm?: number; angleRad?: number } = {},
): DraftingPose | null => {
  const maxDistance = reach.distanceMm ?? ATTACH_DISTANCE_MM
  const maxAngle = reach.angleRad ?? ATTACH_ANGLE_RAD
  const toMm = (x: number, y: number) => ({ x: normToMm(x, sourceWidth), y: normToMm(y, sourceHeight) })
  const origin = toMm(square.x, square.y)
  const rulerLines = rulerLocalLines(ruler)
  const candidates = [...setSquareLocalLines(square), setSquareMidline(square)]
  let best: { rotation: number; shiftX: number; shiftY: number; score: number } | null = null
  for (const rulerLine of rulerLines) {
    if (!rulerLine.outward) continue
    const edge = localLineToEdge(rulerLine, ruler, sourceWidth, sourceHeight)
    const a = toMm(edge.ax, edge.ay)
    const b = toMm(edge.bx, edge.by)
    const edgeLength = Math.hypot(b.x - a.x, b.y - a.y)
    if (edgeLength < 1e-6) continue
    const edgeDirection = Math.atan2(b.y - a.y, b.x - a.x)
    const outward = rotateAround(rulerLine.outward.x, rulerLine.outward.y, 0, 0, ruler.rotation)
    for (const line of candidates) {
      const localDirection = Math.atan2(line.by - line.ay, line.bx - line.ax)
      const worldDirection = square.rotation + localDirection
      // Lines have no head: the smallest turn that makes them parallel, in (−90°, 90°].
      let delta = edgeDirection - worldDirection
      delta = ((delta + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2
      if (Math.abs(delta) > maxAngle) continue
      const rotation = square.rotation + delta
      const midLocal = { x: (line.ax + line.bx) / 2, y: (line.ay + line.by) / 2 }
      const midRotated = rotateAround(midLocal.x, midLocal.y, 0, 0, rotation)
      const mid = { x: origin.x + midRotated.x, y: origin.y + midRotated.y }
      const signedDistance = (mid.x - a.x) * outward.x + (mid.y - a.y) * outward.y
      if (Math.abs(signedDistance) > maxDistance) continue
      const along = ((mid.x - a.x) * (b.x - a.x) + (mid.y - a.y) * (b.y - a.y)) / (edgeLength * edgeLength)
      if (along < -0.15 || along > 1.15) continue
      if (line.outward) {
        const squareOutward = rotateAround(line.outward.x, line.outward.y, 0, 0, rotation)
        // Flush means the square's outside faces the ruler body, never overlaps it.
        if (squareOutward.x * outward.x + squareOutward.y * outward.y > -0.5) continue
      }
      const score = Math.abs(signedDistance) + Math.abs(delta) * 25
      if (!best || score < best.score) {
        best = {
          rotation,
          shiftX: -signedDistance * outward.x,
          shiftY: -signedDistance * outward.y,
          score,
        }
      }
    }
  }
  if (!best) return null
  return {
    ...square,
    rotation: best.rotation,
    x: square.x + mmToNorm(best.shiftX, sourceWidth),
    y: square.y + mmToNorm(best.shiftY, sourceHeight),
  }
}

export const formatMillimetres = (mm: number) => {
  if (Math.abs(mm) >= 10) {
    const cm = Math.round(mm) / 10
    return `${(Number.isInteger(cm) ? cm.toFixed(0) : cm.toFixed(1)).replace('.', ',')} cm`
  }
  return `${Math.round(mm)} mm`
}

export const formatInches = (mm: number) => `${(mm / MM_PER_INCH).toFixed(2).replace('.', ',')}″`

/** Length in the configured unit; `signed` prints a centred scale reading with its sign. */
export const formatLength = (mm: number, unit: DraftingUnit = 'cm', signed = false) => {
  const magnitude = unit === 'in' ? formatInches(Math.abs(mm)) : formatMillimetres(Math.abs(mm))
  if (!signed || Math.abs(mm) < 0.05) return magnitude
  return `${mm < 0 ? '−' : '+'}${magnitude}`
}

/** Angle of a line, folded to 0–180°: a ruler turned by 190° draws the same line as one at 10°. */
export const formatDegrees = (radians: number) => {
  const degrees = ((radians * 180 / Math.PI) % 360 + 360) % 360
  const folded = degrees > 180 ? 360 - degrees : degrees
  return `${folded.toFixed(0)}°`
}

/** Heading of a tool, 0–359° (as typed into the options panel). */
export const formatHeading = (radians: number) => {
  const degrees = Math.round(radiansToDegrees(normalizeAngle(radians)) * 10) / 10
  return `${(degrees >= 360 ? 0 : degrees).toFixed(degrees % 1 ? 1 : 0)}°`
}

export const formatArcDegrees = (radians: number) => {
  const degrees = Math.abs(radians) * 180 / Math.PI
  if (degrees >= 359.2) return '360°'
  return `${degrees.toFixed(0)}°`
}

export const draftingToolLabel = (kind: DraftingKind) => {
  if (kind === 'ruler') return 'Lineal'
  if (kind === 'setSquare') return 'Geodreieck'
  return 'Zirkel'
}

/** Tick marks along a scale of `lengthMm`, in millimetres from the zero mark. */
export type ScaleTick = { mm: number; level: 0 | 1 | 2; label: string | null }

export const scaleTicks = (lengthMm: number, unit: DraftingUnit, startMm = 0): ScaleTick[] => {
  const ticks: ScaleTick[] = []
  if (unit === 'in') {
    const sixteenth = MM_PER_INCH / 16
    const count = Math.floor((lengthMm - startMm) / sixteenth + 1e-6)
    for (let index = 0; index <= count; index += 1) {
      const mm = startMm + index * sixteenth
      const level = index % 16 === 0 ? 2 : index % 4 === 0 ? 1 : 0
      ticks.push({ mm, level, label: level === 2 ? String(index / 16) : null })
    }
    return ticks
  }
  const count = Math.floor(lengthMm - startMm + 1e-6)
  for (let index = 0; index <= count; index += 1) {
    const mm = startMm + index
    const level = mm % 10 === 0 ? 2 : mm % 5 === 0 ? 1 : 0
    ticks.push({ mm, level, label: level === 2 ? String(Math.round(mm / 10)) : null })
  }
  return ticks
}
