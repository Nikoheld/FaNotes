import { createServer } from 'vite'

const server = await createServer({
  root: '/workspace/fanotes',
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const bits = (values) => {
  const copy = new Float32Array(values)
  return Array.from(new Uint32Array(copy.buffer))
}

const floats = (packed) => new Float32Array(Uint32Array.from(packed).buffer)

const vector = (seed, length) => {
  const values = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    values[index] = ((seed * 17 + index * 13) % 97) / 97
  }
  return values
}

const entry = (sampleId, labelId, seed, standard, trust, createdAt, sessionId, strokeCount) => ({
  sampleId,
  sessionId,
  labelId,
  raster: vector(seed, 576),
  projectionX: vector(seed + 3, 24),
  projectionY: vector(seed + 5, 24),
  hog: vector(seed + 7, 54),
  shape: vector(seed + 11, 16),
  holes: seed % 3,
  strokeCount,
  physicalAspect: 0.4 + (seed % 7) * 0.08,
  geometry: {
    directions: vector(seed + 13, 8),
    normalizedLength: 0.2 + (seed % 5) * 0.1,
    closedness: (seed % 4) * 0.2,
    cornerness: (seed % 6) * 0.15,
    trajectory: [vector(seed + 19, 16), vector(seed + 23, 16)],
  },
  variants: [],
  standard,
  trust,
  createdAt,
})

const wire = (entry) => ({
  sampleId: entry.sampleId,
  sessionId: entry.sessionId,
  labelId: entry.labelId,
  raster: bits(entry.raster),
  projectionX: bits(entry.projectionX),
  projectionY: bits(entry.projectionY),
  hog: bits(entry.hog),
  shape: bits(entry.shape),
  holes: entry.holes,
  strokeCount: entry.strokeCount,
  physicalAspect: entry.physicalAspect,
  geometry: {
    directions: bits(entry.geometry.directions),
    normalizedLength: entry.geometry.normalizedLength,
    closedness: entry.geometry.closedness,
    cornerness: entry.geometry.cornerness,
    trajectory: entry.geometry.trajectory.map(bits),
  },
  standard: entry.standard,
  trust: entry.trust,
  createdAt: entry.createdAt,
})

const sameFloats = (left, right, name) => {
  const a = floats(left)
  const b = right
  if (a.length !== b.length) return `${name} length ${a.length} ${b.length}`
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return `${name}[${index}] ${a[index]} ${b[index]}`
  }
  return ''
}

try {
  const { publishRecognitionFusionFromTypeScript } = await server.ssrLoadModule('/../src/lib/recognition.ts')
  const { initSync, fuseRecognitionModel } = await server.ssrLoadModule('/src/lib/recogWasm/fanotes_recog_wasm.js')
  const { RECOG_WASM_BASE64 } = await server.ssrLoadModule('/src/lib/recogWasm/bytes.ts')
  const binary = atob(RECOG_WASM_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  initSync({ module: bytes })
  const entries = [
    entry('p1', 'a', 2, false, 0.88, 1_000, 's1', 1),
    entry('p2', 'a', 4, false, 0.9, 2_000, 's1', 1),
    entry('p3', 'a', 8, false, 1, 80_000, 's2', 2),
    entry('p4', 'b', 3, false, 0.34, 500, 'ctx', 1),
    entry('p5', 'b', 9, false, 0.88, 90_000, 's3', 1),
    entry('p6', 'b', 12, false, 0.2, 100, 'old', 1),
    entry('s1', 'a', 20, true, 0, 0, 'standard', 1),
    entry('s2', 'c', 21, true, 0, 0, 'standard', 1),
    entry('p7', 'c', 15, false, 0.88, 3_000, 's4', 1),
    entry('p8', 'c', 16, false, 0.88, 4_000, 's4', 1),
  ]
  const typescript = publishRecognitionFusionFromTypeScript(entries.map((item) => ({
    ...item,
    raster: new Float32Array(item.raster),
    projectionX: new Float32Array(item.projectionX),
    projectionY: new Float32Array(item.projectionY),
    hog: new Float32Array(item.hog),
    shape: new Float32Array(item.shape),
    geometry: {
      ...item.geometry,
      directions: new Float32Array(item.geometry.directions),
      trajectory: item.geometry.trajectory.map((path) => new Float32Array(path)),
    },
  })))
  const rust = JSON.parse(fuseRecognitionModel(JSON.stringify(entries.map(wire))))
  const problems = []
  const weightKeys = ['raster', 'hog', 'projections', 'shape', 'directions', 'geometry', 'trajectory', 'holes', 'strokes']
  for (const key of weightKeys) {
    if (typescript.weights[key] !== rust.weights[key]) problems.push(`weight ${key} ${typescript.weights[key]} ${rust.weights[key]}`)
  }
  if (typescript.estimatedAccuracy !== rust.estimatedAccuracy) problems.push(`accuracy ${typescript.estimatedAccuracy} ${rust.estimatedAccuracy}`)
  if (typescript.evaluatedSamples !== rust.evaluatedSamples) problems.push(`count ${typescript.evaluatedSamples} ${rust.evaluatedSamples}`)
  const tsIds = typescript.classifierEntries.map((item) => item.sampleId)
  if (JSON.stringify(tsIds) !== JSON.stringify(rust.classifierIds)) problems.push(`classifier ${JSON.stringify(tsIds)} ${JSON.stringify(rust.classifierIds)}`)
  const tsTrusts = entries.map((item) => item.trust)
  // entries were mutated by the typescript call
  const rustTrustById = new Map(rust.trusts.map((item) => [item.sampleId, item.trust]))
  entries.forEach((item) => {
    if (item.trust !== rustTrustById.get(item.sampleId)) problems.push(`trust ${item.sampleId} ${item.trust} ${rustTrustById.get(item.sampleId)}`)
  })
  const tsProto = [...typescript.prototypes.keys()]
  const rustProto = rust.prototypes.map((item) => item.labelId)
  if (JSON.stringify(tsProto) !== JSON.stringify(rustProto)) problems.push(`proto keys ${tsProto} ${rustProto}`)
  for (const prototype of rust.prototypes) {
    const expected = typescript.prototypes.get(prototype.labelId)
    if (!expected) continue
    for (const key of ['raster', 'projectionX', 'projectionY', 'hog', 'shape']) {
      const mismatch = sameFloats(prototype[key], expected[key], `${prototype.labelId}.${key}`)
      if (mismatch) problems.push(mismatch)
    }
    if (expected.holes !== prototype.holes) problems.push(`holes ${prototype.labelId} ${expected.holes} ${prototype.holes}`)
    if (expected.strokeCount !== prototype.strokeCount) problems.push(`strokes ${prototype.labelId}`)
    if (expected.physicalAspect !== prototype.physicalAspect) problems.push(`aspect ${prototype.labelId} ${expected.physicalAspect} ${prototype.physicalAspect}`)
    if (expected.trust !== prototype.trust) problems.push(`proto trust ${prototype.labelId}`)
    if (expected.standard !== prototype.standard) problems.push(`standard ${prototype.labelId}`)
  }
  const tsSets = [...typescript.prototypeSets.entries()].map(([label, group]) => [label, group.map((item) => item.sampleId)])
  const rustSets = rust.prototypeSets.map((group) => [group.labelId, group.sampleIds])
  if (JSON.stringify(tsSets) !== JSON.stringify(rustSets)) problems.push(`sets ${JSON.stringify(tsSets)} ${JSON.stringify(rustSets)}`)
  const near = (left, right) => typeof left === 'number' && typeof right === 'number' && Math.abs(left - right) < 1e-12
  for (const [label, value] of typescript.labelStats) {
    const rustValue = rust.labelStats.find((item) => item.labelId === label)?.value
    for (const key of Object.keys(value)) {
      if (value[key] !== rustValue?.[key] && !near(value[key], rustValue?.[key])) problems.push(`label ${label}.${key} ${value[key]} ${rustValue?.[key]}`)
    }
  }
  for (const [label, value] of typescript.aspectStats) {
    const rustValue = rust.aspectStats.find((item) => item.labelId === label)?.value
    for (const key of Object.keys(value)) {
      if (value[key] !== rustValue?.[key] && !near(value[key], rustValue?.[key])) problems.push(`aspect ${label}.${key} ${value[key]} ${rustValue?.[key]}`)
    }
  }
  console.log(problems.length ? problems.slice(0, 12).join('\n') : 'MATCH')
  const many = []
  for (let index = 0; index < 60; index += 1) {
    const label = String.fromCharCode(97 + (index % 6))
    many.push(entry(`m${index}`, label, index + 1, false, index % 11 === 0 ? 0.2 : 0.88, index * 1000, `session-${index % 4}`, 1 + (index % 3)))
  }
  many.push(entry('std', 'a', 90, true, 0, 0, 'standard', 1))
  many[0].geometry.trajectory = Array.from({ length: 9 }, (_, index) => vector(40 + index, 12))
  const manyTypescript = publishRecognitionFusionFromTypeScript(many.map((item) => ({
    ...item,
    raster: new Float32Array(item.raster),
    projectionX: new Float32Array(item.projectionX),
    projectionY: new Float32Array(item.projectionY),
    hog: new Float32Array(item.hog),
    shape: new Float32Array(item.shape),
    geometry: {
      ...item.geometry,
      directions: new Float32Array(item.geometry.directions),
      trajectory: item.geometry.trajectory.map((path) => new Float32Array(path)),
    },
  })))
  const manyRust = JSON.parse(fuseRecognitionModel(JSON.stringify(many.map(wire))))
  const manyProblems = []
  for (const key of weightKeys) {
    if (manyTypescript.weights[key] !== manyRust.weights[key]) manyProblems.push(`many weight ${key} ${manyTypescript.weights[key]} ${manyRust.weights[key]}`)
  }
  if (manyTypescript.estimatedAccuracy !== manyRust.estimatedAccuracy) manyProblems.push(`many accuracy ${manyTypescript.estimatedAccuracy} ${manyRust.estimatedAccuracy}`)
  if (JSON.stringify(manyTypescript.classifierEntries.map((item) => item.sampleId)) !== JSON.stringify(manyRust.classifierIds)) manyProblems.push('many classifier')
  const manyTrust = new Map(manyRust.trusts.map((item) => [item.sampleId, item.trust]))
  many.forEach((item) => {
    if (item.trust !== manyTrust.get(item.sampleId)) manyProblems.push(`many trust ${item.sampleId} ${item.trust} ${manyTrust.get(item.sampleId)}`)
  })
  for (const [label, value] of manyTypescript.labelStats) {
    const rustValue = manyRust.labelStats.find((item) => item.labelId === label)?.value
    for (const key of Object.keys(value)) {
      const delta = Math.abs(value[key] - rustValue?.[key])
      if (value[key] !== rustValue?.[key] && !(typeof value[key] === 'number' && delta < 1e-12)) {
        manyProblems.push(`${label}.${key} ${value[key]} ${rustValue?.[key]}`)
      }
    }
  }
  console.log(manyProblems.length ? manyProblems.slice(0, 12).join('\n') : 'MANY MATCH')
  if (problems.length || manyProblems.length) process.exitCode = 1
} finally {
  await server.close()
}
