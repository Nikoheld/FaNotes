import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  ATTACH_DISTANCE_MM,
  DEFAULT_DRAFTING_SETTINGS,
  PEN_EDGE_ZONE_MM,
  RULER_HEIGHT_MM,
  RULER_LENGTH_MM,
  SET_SQUARE_LEG_MM,
  SET_SQUARE_PROTRACTOR_DEGREES,
  SET_SQUARE_SIZE_MM,
  SOURCE_A4_PX,
  attachSetSquareToRuler,
  compassCentreMarkSegments,
  defaultCompassPose,
  defaultRulerPose,
  defaultSetSquarePose,
  distanceToDrawingEdgeMm,
  draftingLocalToNorm,
  edgeAngle,
  formatDegrees,
  formatHeading,
  formatLength,
  formatMillimetres,
  keepPoseOnSheet,
  magnetThresholdMm,
  millimetresAlongEdge,
  mmToNorm,
  normToLocalMm,
  normalizeDraftingSettings,
  nudgePose,
  presetArcSweep,
  rulerDrawingEdges,
  sampleCompassArc,
  scaleTicks,
  setSquareDrawingEdges,
  snapAngle,
  snapToDraftingTools,
  toolExtentMm,
} = await server.ssrLoadModule('/src/lib/draftingTools.ts')

const W = SOURCE_A4_PX
const H = 1273
const near = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ± ${tolerance}, got ${actual}`)
}

const snapNear = (kind, pose, localX, localY, options) => {
  const point = draftingLocalToNorm(localX, localY, pose, W, H)
  return snapToDraftingTools(point.x, point.y, [{ kind, pose }], W, H, null, undefined, options)
}

try {
  // ---- Ruler ---------------------------------------------------------------
  const ruler = defaultRulerPose()
  const rulerEdges = rulerDrawingEdges(ruler, W, H)
  assert.equal(rulerEdges.length, 2, 'ruler has two long drawing edges')

  const topSnap = snapNear('ruler', ruler, 0, -RULER_HEIGHT_MM / 2 - 1)
  assert.ok(topSnap, 'live sample next to the top edge must snap')
  assert.equal(topSnap.kind, 'ruler')
  assert.equal(topSnap.edgeIndex, 0, 'top sample must land on the top edge, not the opposite one')
  near(topSnap.angle, 0, 1e-6, 'edge angle of a level ruler')

  const bottomSnap = snapNear('ruler', ruler, 0, RULER_HEIGHT_MM / 2 + 1)
  assert.ok(bottomSnap, 'live sample next to the bottom edge must snap')
  assert.equal(bottomSnap.edgeIndex, 1, 'bottom sample must land on the bottom edge, not the opposite one')

  const tenMm = snapNear('ruler', ruler, -RULER_LENGTH_MM / 2 + 10, -RULER_HEIGHT_MM / 2)
  assert.ok(tenMm)
  near(tenMm.millimetres, 10, 0.5, '10 mm along the ruler reads 10')
  near(millimetresAlongEdge(rulerEdges[0], 10 / RULER_LENGTH_MM, W, H), 10, 0.5, 'millimetresAlongEdge from the zero end')

  const longRuler = { ...ruler, lengthMm: 200 }
  const longEdges = rulerDrawingEdges(longRuler, W, H)
  near(millimetresAlongEdge(longEdges[0], 1, W, H), 200, 0.5, 'a 20 cm ruler has 20 cm edges')
  const at150 = snapNear('ruler', longRuler, -100 + 150, -RULER_HEIGHT_MM / 2)
  near(at150.millimetres, 150, 0.5, 'reading 15 cm on the long ruler')

  // The sheet is 900 × 1273: a turned tool must keep its angle and length on the
  // paper, otherwise the snap edges shear away from the SVG that draws the tool.
  const turnedRuler = { ...ruler, rotation: Math.PI / 4 }
  const turnedEdge = rulerDrawingEdges(turnedRuler, W, H)[0]
  near(edgeAngle(turnedEdge, W, H), Math.PI / 4, 1e-9, 'a ruler turned by 45° has 45° edges on the sheet')
  near(millimetresAlongEdge(turnedEdge, 1, W, H), RULER_LENGTH_MM, 1e-6, 'turning keeps the edge 16 cm long')
  const turnedLocal = normToLocalMm(turnedEdge.bx, turnedEdge.by, turnedRuler, W, H)
  near(turnedLocal.x, RULER_LENGTH_MM / 2, 1e-6, 'edge end maps back to local +8 cm')
  near(turnedLocal.y, -RULER_HEIGHT_MM / 2, 1e-6, 'edge end maps back to the top edge')

  // Magnet reach: off → no snapping at all, strong → farther samples still land.
  const farSample = snapNear('ruler', ruler, 0, -RULER_HEIGHT_MM / 2 - 5)
  assert.equal(farSample, null, '5 mm away is beyond the normal magnet')
  const strongSample = snapNear('ruler', ruler, 0, -RULER_HEIGHT_MM / 2 - 5, { thresholdMm: magnetThresholdMm('strong') })
  assert.ok(strongSample, 'strong magnet reaches 5 mm')
  assert.equal(snapNear('ruler', ruler, 0, -RULER_HEIGHT_MM / 2 - 0.5, { thresholdMm: magnetThresholdMm('off') }), null, 'magnet off never snaps')
  assert.equal(magnetThresholdMm('off'), 0)
  const underBody = snapNear('ruler', ruler, 20, 3, { thresholdMm: magnetThresholdMm('soft') })
  assert.ok(underBody, 'a pen under the ruler body always comes out on an edge')
  assert.equal(underBody.edgeIndex, 1, 'below the centre line it comes out on the bottom edge')

  // Locked edge keeps the stroke on it even when the pen wanders off.
  const lockedFar = snapToDraftingTools(
    ...Object.values(draftingLocalToNorm(0, -RULER_HEIGHT_MM / 2 - 12, ruler, W, H)),
    [{ kind: 'ruler', pose: ruler }], W, H, { kind: 'ruler', edgeIndex: 0 },
  )
  assert.ok(lockedFar && lockedFar.edgeIndex === 0, 'locked edge follows the pen 12 mm away')

  // Scales in both units.
  const cmTicks = scaleTicks(160, 'cm')
  assert.equal(cmTicks.length, 161, 'one tick per millimetre plus the zero')
  assert.equal(cmTicks.filter((tick) => tick.label).length, 17, 'a centimetre label every 10 mm')
  assert.equal(cmTicks[150].label, '15')
  const inchTicks = scaleTicks(160, 'in')
  assert.equal(inchTicks.filter((tick) => tick.label).length, 7, 'inch labels 0–6 on a 16 cm edge')
  assert.equal(inchTicks[16].label, '1')
  assert.equal(inchTicks[4].level, 1, 'quarter inch is a mid tick')

  // ---- Geodreieck ---------------------------------------------------------------
  const square = defaultSetSquarePose()
  assert.equal(square.sizeMm, SET_SQUARE_SIZE_MM)
  const squareEdges = setSquareDrawingEdges(square, W, H)
  assert.equal(squareEdges.length, 3, 'set square has three drawing edges')
  near(millimetresAlongEdge(squareEdges[0], 1, W, H), SET_SQUARE_SIZE_MM / 2, 0.5, 'base reads +8 cm at its right end')
  near(millimetresAlongEdge(squareEdges[0], 0, W, H), -SET_SQUARE_SIZE_MM / 2, 0.5, 'base reads −8 cm at its left end')
  near(millimetresAlongEdge(squareEdges[1], 1, W, H), SET_SQUARE_LEG_MM, 0.5, 'a leg is 16 cm / √2 long')

  const rightOfCentre = snapNear('setSquare', square, 30, 1)
  assert.ok(rightOfCentre)
  assert.equal(rightOfCentre.edgeIndex, 0, 'sample under the base snaps to the base')
  near(rightOfCentre.millimetres, 30, 0.5, 'base scale reads from the centre mark')
  const leftOfCentre = snapNear('setSquare', square, -30, 1)
  near(leftOfCentre.millimetres, -30, 0.5, 'left of the centre mark the reading is negative')

  const half = SET_SQUARE_SIZE_MM / 2
  const onLeftLeg = snapNear('setSquare', square, -half / 2 - 0.7, -half / 2 - 0.7)
  assert.ok(onLeftLeg)
  assert.equal(onLeftLeg.edgeIndex, 1, 'sample outside the left leg snaps to the left leg')
  near(onLeftLeg.millimetres, SET_SQUARE_LEG_MM / 2, 0.6, 'leg scale starts at the base corner')
  near(Math.abs(onLeftLeg.angle), Math.PI / 4, 1e-6, 'the legs run at 45°')
  const onRightLeg = snapNear('setSquare', square, half / 2 + 0.7, -half / 2 - 0.7)
  assert.ok(onRightLeg)
  assert.equal(onRightLeg.edgeIndex, 2, 'sample outside the right leg snaps to the right leg')

  const insideNearBase = snapNear('setSquare', square, 0, -10)
  assert.ok(insideNearBase)
  assert.equal(insideNearBase.edgeIndex, 0, 'a pen under the body comes out on the nearest edge')
  near(insideNearBase.millimetres, 0, 0.5, 'centre mark reads 0')

  const flipped = { ...square, flipped: true }
  const flippedBase = snapNear('setSquare', flipped, 30, -1)
  assert.ok(flippedBase && flippedBase.edgeIndex === 0, 'flipped: the free side of the base is above it')
  const flippedLeg = snapNear('setSquare', flipped, -half / 2 - 0.7, half / 2 + 0.7)
  assert.ok(flippedLeg && flippedLeg.edgeIndex === 1, 'flipped: legs point the other way')

  const bigSquare = { ...square, sizeMm: 200 }
  near(millimetresAlongEdge(setSquareDrawingEdges(bigSquare, W, H)[0], 1, W, H), 100, 0.5, 'a 20 cm Geodreieck reads +10 cm at the end')

  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.includes(0))
  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.includes(90))
  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.includes(180), 'protractor must reach 180°, not stop at 90°')
  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.some((degree) => degree > 90))
  assert.equal(formatDegrees(Math.PI / 2), '90°')
  assert.equal(formatDegrees(Math.PI), '180°')
  assert.equal(formatDegrees(Math.PI * 190 / 180), '170°', 'line angles fold to 0–180°')
  assert.equal(formatHeading(-Math.PI / 2), '270°', 'headings run 0–359°')

  // ---- Set square lies down against the ruler ------------------------------------
  const levelRuler = { ...ruler, x: 0.5, y: 0.5, rotation: 0 }
  const rulerTop = rulerDrawingEdges(levelRuler, W, H)[0]
  const aboveTop = (mmAbove) => rulerTop.ay - mmToNorm(mmAbove, H)
  const tilted = { ...square, x: 0.5, y: aboveTop(4), rotation: 5 * Math.PI / 180 }
  const attached = attachSetSquareToRuler(tilted, levelRuler, W, H)
  assert.ok(attached, 'a set square 4 mm above the ruler, 5° off, lies down')
  near(attached.rotation, 0, 1e-9, 'attached base is parallel to the ruler')
  const attachedBase = setSquareDrawingEdges(attached, W, H)[0]
  near(attachedBase.ay, rulerTop.ay, 1e-9, 'attached base sits exactly on the ruler edge')
  near(attachedBase.by, rulerTop.ay, 1e-9, 'both ends of the base on the edge')
  near(attached.x, 0.5, 1e-9, 'attaching never slides the square along the ruler')

  const farAway = attachSetSquareToRuler({ ...tilted, y: aboveTop(ATTACH_DISTANCE_MM * 3) }, levelRuler, W, H)
  assert.equal(farAway, null, 'out of reach nothing attaches')
  const wayOff = attachSetSquareToRuler({ ...tilted, rotation: 20 * Math.PI / 180 }, levelRuler, W, H)
  assert.equal(wayOff, null, 'a clearly turned square is not forced flat')
  const pointingIn = attachSetSquareToRuler({ ...tilted, flipped: true }, levelRuler, W, H)
  assert.equal(pointingIn, null, 'a square whose body would overlap the ruler does not attach')

  // Midline on the ruler edge: perpendicular through a point of the ruler.
  const upright = { ...square, x: 0.5, y: aboveTop(3), rotation: Math.PI / 2 + 4 * Math.PI / 180 }
  const perpendicular = attachSetSquareToRuler(upright, levelRuler, W, H)
  assert.ok(perpendicular, 'upright square with its centre line near the ruler attaches')
  near(perpendicular.rotation, Math.PI / 2, 1e-9, 'centre line ends up perpendicular to the ruler')
  const centreLocal = normToLocalMm(perpendicular.x, perpendicular.y, levelRuler, W, H)
  near(centreLocal.y, -RULER_HEIGHT_MM / 2, 1e-6, 'the base centre sits on the ruler edge')

  // Leg on the ruler edge (apex pointing down at 135°): the other leg stands
  // perpendicular on the ruler, and sliding along gives parallel perpendiculars.
  const legDown = { ...square, x: 0.5, y: aboveTop(3 + SET_SQUARE_LEG_MM / 2), rotation: Math.PI * 3 / 4 + 3 * Math.PI / 180 }
  const legAttached = attachSetSquareToRuler(legDown, levelRuler, W, H)
  assert.ok(legAttached, 'a leg near the ruler attaches')
  near(legAttached.rotation, Math.PI * 3 / 4, 1e-9, 'leg becomes parallel to the ruler')
  const legEdge = setSquareDrawingEdges(legAttached, W, H)[2]
  near(legEdge.ay, rulerTop.ay, 1e-9, 'the leg lies on the ruler edge')
  near(legEdge.by, rulerTop.ay, 1e-9, 'the whole leg lies on the ruler edge')
  // A leg that would put the body across the ruler (apex up, at −45°) does not attach to the top edge.
  const legAcross = attachSetSquareToRuler({ ...square, x: 0.5, y: rulerTop.ay + mmToNorm(SET_SQUARE_LEG_MM / 2 - 3, H), rotation: -Math.PI / 4 }, levelRuler, W, H)
  assert.equal(legAcross, null, 'a leg on the wrong side of the ruler edge is not attached')

  // ---- Angle snapping ------------------------------------------------------------
  near(snapAngle(31 * Math.PI / 180, 15), 30 * Math.PI / 180, 1e-9, '31° rasters to 30° in 15° steps')
  near(snapAngle(44 * Math.PI / 180, 45), 45 * Math.PI / 180, 1e-9, '44° rasters to 45°')
  near(snapAngle(31.3 * Math.PI / 180, 0), 31.3 * Math.PI / 180, 1e-12, 'step 0 leaves the angle alone')
  near(snapAngle(31.3 * Math.PI / 180, 1), 31 * Math.PI / 180, 1e-9, '1° raster')

  // ---- Compass ---------------------------------------------------------------------
  const compass = defaultCompassPose()
  near(presetArcSweep(90, 'cw'), Math.PI / 2, 1e-12, 'clockwise sweep is positive on screen')
  near(presetArcSweep(90, 'ccw'), -Math.PI / 2, 1e-12, 'counter-clockwise sweep is negative')
  const quarter = sampleCompassArc(compass, 0, Math.PI / 2, W, H)
  assert.ok(quarter.length >= 40, 'a quarter circle is densely sampled')
  const marks = compassCentreMarkSegments(compass, W, H)
  assert.equal(marks.length, 2, 'centre mark is a cross of two strokes')
  near(marks[0][1].x - marks[0][0].x, mmToNorm(3.2, W), 1e-9, 'cross spans 3.2 mm')
  const pencil = { x: compass.x + mmToNorm(compass.radiusMm, W), y: compass.y }
  const onCircle = snapToDraftingTools(pencil.x, pencil.y + mmToNorm(1, H), [{ kind: 'compass', pose: compass }], W, H)
  assert.ok(onCircle && onCircle.kind === 'compass', 'pen next to the circle snaps onto it')
  near(onCircle.millimetres, compass.radiusMm, 1e-9, 'compass reading is the radius')
  assert.equal(
    snapToDraftingTools(pencil.x, pencil.y, [{ kind: 'compass', pose: compass }], W, H, null, undefined, { thresholdMm: 0 }),
    null,
    'magnet off also releases the compass circle',
  )

  // ---- Settings & formatting -----------------------------------------------------
  assert.deepEqual(normalizeDraftingSettings(null), DEFAULT_DRAFTING_SETTINGS, 'garbage settings fall back to the defaults')
  const custom = normalizeDraftingSettings({ unit: 'in', angleStep: 15, magnet: 'strong', rulerLengthMm: 9999, setSquareSizeMm: 200, arcDirection: 'ccw' })
  assert.equal(custom.unit, 'in')
  assert.equal(custom.angleStep, 15)
  assert.equal(custom.magnet, 'strong')
  assert.equal(custom.rulerLengthMm, 500, 'ruler length is clamped')
  assert.equal(custom.setSquareSizeMm, 200)
  assert.equal(custom.arcDirection, 'ccw')
  assert.equal(normalizeDraftingSettings({ angleStep: 7 }).angleStep, DEFAULT_DRAFTING_SETTINGS.angleStep, 'unknown steps fall back')
  assert.equal(defaultRulerPose({ rulerLengthMm: 300 }).lengthMm, 300, 'new rulers take the remembered length')

  assert.equal(formatMillimetres(160), '16 cm')
  assert.equal(formatMillimetres(35), '3,5 cm')
  assert.equal(formatMillimetres(7), '7 mm')
  assert.equal(formatLength(-30, 'cm', true), '−3 cm', 'centred readings carry their sign')
  assert.equal(formatLength(30, 'cm', true), '+3 cm')
  assert.equal(formatLength(25.4, 'in'), '1,00″')
  assert.equal(formatLength(0.02, 'cm', true), '0 mm', 'the centre mark reads plain zero')

  const nudged = nudgePose(ruler, 10, 0, W, H)
  near(nudged.x - ruler.x, mmToNorm(10, W), 1e-12, 'arrow keys move by sheet millimetres')

  // ---- Placement on the sheet -------------------------------------------------------
  const levelExtent = toolExtentMm('ruler', ruler)
  near(levelExtent.maxX - levelExtent.minX, RULER_LENGTH_MM, 1e-9, 'a level ruler is as wide as it is long')
  near(levelExtent.maxY - levelExtent.minY, RULER_HEIGHT_MM, 1e-9, 'and as high as its body')
  const uprightExtent = toolExtentMm('ruler', { ...ruler, rotation: Math.PI / 2 })
  near(uprightExtent.maxY - uprightExtent.minY, RULER_LENGTH_MM, 1e-9, 'an upright ruler is as high as it is long')
  const sheetWidthMm = RULER_LENGTH_MM / mmToNorm(RULER_LENGTH_MM, W)
  const nearRightEdge = keepPoseOnSheet('ruler', { ...ruler, x: 0.98, y: 0.5 }, W, H)
  near(
    nearRightEdge.x + mmToNorm(RULER_LENGTH_MM / 2, W),
    1 - mmToNorm(2, W),
    1e-9,
    'a ruler dropped at the right edge is pulled back onto the sheet with a 2 mm margin',
  )
  assert.equal(keepPoseOnSheet('ruler', ruler, W, H).x, ruler.x, 'a ruler that fits stays where it is')
  const shortSheetHeight = Math.round(H * 0.15)
  const tall = keepPoseOnSheet('ruler', { ...ruler, x: 0.5, y: 0.9, rotation: Math.PI / 2 }, W, shortSheetHeight)
  assert.ok(tall.y > 0 && tall.y < 1, 'a tool taller than the sheet keeps its origin on the sheet')
  assert.ok(sheetWidthMm > RULER_LENGTH_MM, 'the A4 sheet is wider than the default ruler')

  // ---- Pen on the body: edge zone vs. handle --------------------------------------------
  const onEdge = draftingLocalToNorm(20, -RULER_HEIGHT_MM / 2 + 2, ruler, W, H)
  near(distanceToDrawingEdgeMm('ruler', ruler, onEdge.x, onEdge.y, W, H), 2, 1e-6, 'two millimetres inside the top edge')
  const inMiddle = draftingLocalToNorm(20, 0, ruler, W, H)
  near(distanceToDrawingEdgeMm('ruler', ruler, inMiddle.x, inMiddle.y, W, H), RULER_HEIGHT_MM / 2, 1e-6, 'the body centre is half a body away')
  assert.ok(PEN_EDGE_ZONE_MM < RULER_HEIGHT_MM / 2, 'the ruler keeps a grab zone between the two pen edge zones')
  const squareCentre = draftingLocalToNorm(0, -20, square, W, H)
  const squareBase = draftingLocalToNorm(0, -1, square, W, H)
  assert.ok(distanceToDrawingEdgeMm('setSquare', square, squareCentre.x, squareCentre.y, W, H) > PEN_EDGE_ZONE_MM, 'the set square interior is a handle')
  near(distanceToDrawingEdgeMm('setSquare', square, squareBase.x, squareBase.y, W, H), 1, 1e-6, 'one millimetre above the base')
  assert.equal(distanceToDrawingEdgeMm('compass', compass, compass.x, compass.y, W, H), Number.POSITIVE_INFINITY, 'the compass has no straight edges')

  // ---- Wiring ----------------------------------------------------------------------
  const boardSource = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
  assert.match(
    boardSource,
    /\.lw-drawing-board\.is-inline \.lw-drafting-layer\s*\{[^}]*inset:\s*var\(--paper-scroll-room, 0px\)[^}]*width:\s*calc\(100% - 2 \* var\(--paper-scroll-room, 0px\)\)/u,
    'the inline tool layer shares the paper box, not the scroll room around it',
  )
  assert.match(boardSource, /keepPoseOnSheet\(\s*kind,/u, 'tools are shown inside the sheet')
  const guidesSource = readFileSync(new URL('../src/components/DraftingGuides.tsx', import.meta.url), 'utf8')
  assert.match(guidesSource, /if \(mode === 'move' && pose && penWantsEdge\(kind, pose, event\)\) return/u, 'a pen near an edge draws instead of dragging the body')

  console.log(JSON.stringify({
    rulerEdges: rulerEdges.length,
    tenMm: tenMm.millimetres,
    baseReadings: [rightOfCentre.millimetres, leftOfCentre.millimetres],
    legReading: onLeftLeg.millimetres,
    attachedRotation: attached.rotation,
    perpendicular: perpendicular.rotation,
    protractor: SET_SQUARE_PROTRACTOR_DEGREES.length,
  }))
  console.log('drafting-tools ok')
} finally {
  await server.close()
}
