import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { createInkReadbackContext, drawInkStroke, inkInteriorPull } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { collectPreviewInkPoints } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

const alphaAt = (image, x, y) => {
  const px = Math.round(x)
  const py = Math.round(y)
  return image.data[(py * image.width + px) * 4 + 3]
}

const pen = (points) => ({
  points,
  baseWidth: 3.5,
  pressureEnabled: true,
  color: '#202333',
  purpose: 'handwriting',
  brush: 'fineliner',
  colorEffect: 'solid',
  opacity: 1,
})

const paint = (points, smoothing, startSegment = 1, endSegment = points.length) => {
  const surface = createInkReadbackContext(400, 400)
  drawInkStroke(surface.context, pen(points), 400, 400, smoothing, startSegment, 400, 400, endSegment)
  return surface.getImageData()
}

const covered = (image, x, y) => alphaAt(image, x, y) >= 24
const clear = (image, x, y) => alphaAt(image, x, y) < 24

const writePng = async (image, file) => {
  const { deflateSync } = await import('node:zlib')
  const rows = []
  for (let y = 0; y < image.height; y += 1) {
    const row = Buffer.alloc(1 + image.width * 3)
    row[0] = 0
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4
      const alpha = image.data[i + 3] / 255
      row[1 + x * 3] = Math.round(255 * (1 - alpha) + image.data[i] * alpha)
      row[2 + x * 3] = Math.round(255 * (1 - alpha) + image.data[i + 1] * alpha)
      row[3 + x * 3] = Math.round(255 * (1 - alpha) + image.data[i + 2] * alpha)
    }
    rows.push(row)
  }
  const raw = Buffer.concat(rows)
  const compressed = deflateSync(raw)
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length - 4)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(image.width, 0)
  ihdr.writeUInt32BE(image.height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(file, png)
}

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  crcTable[n] = c >>> 0
}
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

try {
  assert.equal(inkInteriorPull(0, 12, 4), 0)
  assert.equal(inkInteriorPull(1, 4, 20), 0.85)
  assert.ok(inkInteriorPull(1, 200, 3.5) < 0.02, 'a long leg stays close to the polyline')
  const densePull = inkInteriorPull(0.68, 4, 3.5)
  assert.ok(densePull > 0.2, 'dense handwriting still rounds')
  assert.ok((densePull * 4) / 2 < 3.5 / 2, 'a rounded joint stays inside the nib')

  const turnPoints = [
    { x: 0.2, y: 0.5, pressure: 0.55 },
    { x: 0.5, y: 0.5, pressure: 0.55 },
    { x: 0.5, y: 0.8, pressure: 0.55 },
  ]
  const turn = paint(turnPoints, 1)
  assert.ok(covered(turn, 200, 200), 'the corner the pen reached stays covered')
  assert.ok(covered(turn, 120, 200), 'the incoming leg stays covered')
  assert.ok(covered(turn, 200, 280), 'the outgoing leg stays covered')
  assert.ok(clear(turn, 216, 220), 'a turn must not hook onward in the previous direction')
  assert.ok(clear(turn, 214, 200), 'the incoming heading stops at the corner')

  // The live board paints the newest segment on its own. That frame used to
  // be the hook, then the next sample replaced it.
  const liveTip = paint(turnPoints, 1, 2, 3)
  assert.ok(covered(liveTip, 200, 260), 'the open tip follows the newest sample')
  assert.ok(clear(liveTip, 216, 220), 'the open tip does not flash sideways')
  assert.ok(clear(liveTip, 230, 200), 'the open tip does not continue the old heading')

  const reverse = paint([
    { x: 0.2, y: 0.45, pressure: 0.5 },
    { x: 0.55, y: 0.45, pressure: 0.5 },
    { x: 0.2, y: 0.45, pressure: 0.5 },
  ], 1)
  assert.ok(covered(reverse, 220, 180), 'a reversal still covers the turn')
  assert.ok(clear(reverse, 248, 180), 'a reversal must not loop past the tip')

  const wave = []
  for (let i = 0; i < 48; i += 1) {
    const t = i / 47
    wave.push({
      x: 0.08 + 0.84 * t,
      y: 0.55 + Math.sin(t * Math.PI * 3) * 0.22,
      pressure: 0.35 + 0.4 * Math.abs(Math.sin(t * 6)),
    })
  }
  const smooth = paint(wave, 1)
  for (const point of wave) {
    assert.ok(
      covered(smooth, point.x * 400, point.y * 400),
      `a smoothed stroke must keep the pen on the sample (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
    )
  }
  assert.ok(clear(smooth, 200, 40), 'smoothing must not throw ink off the wave')

  const forward = collectPreviewInkPoints(
    [{ x: 0.4, y: 0.4 }, { x: 0.42, y: 0.4 }],
    [{ x: 0.435, y: 0.401 }],
  )
  assert.equal(forward.length, 1, 'a short continuation may preview')
  assert.ok(Math.abs(forward[0].x - 0.435) < 1e-6)

  const sideways = collectPreviewInkPoints(
    [{ x: 0.4, y: 0.4 }, { x: 0.42, y: 0.4 }],
    [{ x: 0.42, y: 0.45 }],
  )
  assert.equal(sideways.length, 0, 'a sideways prediction must not paint a spike')

  const shortened = collectPreviewInkPoints(
    [{ x: 0.4, y: 0.4 }, { x: 0.41, y: 0.4 }],
    [{ x: 0.5, y: 0.4 }],
  )
  assert.equal(shortened.length, 1)
  assert.ok(shortened[0].x > 0.41 && shortened[0].x < 0.44, 'a long prediction is shortened onto the heading')

  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  await writePng(turn, '/opt/cursor/artifacts/handwriting-turn.png')
  await writePng(smooth, '/opt/cursor/artifacts/handwriting-wave.png')
  console.log(JSON.stringify({
    turnHook: alphaAt(turn, 216, 220),
    turnCorner: alphaAt(turn, 200, 200),
    liveHook: alphaAt(liveTip, 216, 220),
    waveSamples: wave.length,
  }))
  console.log('ink-smooth ok')
} finally {
  await server.close()
}
