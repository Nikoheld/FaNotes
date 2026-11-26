import type { RecognitionModelEntry } from './recognition'

/** Plain-JSON form of a model entry for the Rust fusion (floats travel as their bits). */
const floatBits = (values: Float32Array) => Array.from(new Uint32Array(new Float32Array(values).buffer))

export const wireFusionEntry = (entry: RecognitionModelEntry) => ({
  sampleId: entry.sampleId,
  sessionId: entry.sessionId,
  labelId: entry.labelId,
  raster: floatBits(entry.raster),
  projectionX: floatBits(entry.projectionX),
  projectionY: floatBits(entry.projectionY),
  hog: floatBits(entry.hog),
  shape: floatBits(entry.shape),
  holes: entry.holes,
  strokeCount: entry.strokeCount,
  physicalAspect: entry.physicalAspect,
  geometry: {
    directions: floatBits(entry.geometry.directions),
    normalizedLength: entry.geometry.normalizedLength,
    closedness: entry.geometry.closedness,
    cornerness: entry.geometry.cornerness,
    trajectory: entry.geometry.trajectory.map((path) => floatBits(path)),
  },
  standard: entry.standard,
  trust: entry.trust,
  createdAt: entry.createdAt,
})
