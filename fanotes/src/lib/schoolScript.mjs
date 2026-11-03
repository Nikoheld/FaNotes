import paths from './schoolScriptPaths.json' with { type: 'json' }
/** Native trajectories, shared with the tablet school script. Used only for missing letters. */
export const schoolScript = Object.entries(paths).map(([label, raw]) => {
  const points = raw.flat(), left = Math.min(...points.map(p => p[0])), top = Math.min(...points.map(p => p[1]))
  const width = Math.max(.04, Math.max(...points.map(p => p[0])) - left), height = Math.max(.04, Math.max(...points.map(p => p[1])) - top)
  const strokes = raw.map(path => {
    const sampled = []
    const append = (x, y) => sampled.push({ x: .04 + (x - left) / width * .92, y: .04 + (y - top) / height * .92, t: sampled.length * 4, pressure: .55, tiltX: 0, tiltY: 0, pointerType: 'pen' })
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1], n = Math.max(1, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) * 28))
      for (let j = 0; j < n; j++) append(a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n)
    }
    append(path.at(-1)[0], path.at(-1)[1])
    return { points: sampled, baseWidth: 3.2, pressureEnabled: true }
  })
  const placed = strokes.flatMap(s => s.points), x0 = Math.min(...placed.map(p => p.x)), y0 = Math.min(...placed.map(p => p.y))
  const bbox = [x0, y0, Math.max(.04, Math.max(...placed.map(p => p.x)) - x0), Math.max(.04, Math.max(...placed.map(p => p.y)) - y0)]
  return { id: `school-${label}`, label, labelId: `school-${label}`, sessionId: 'school-script', bbox, sourceCanvas: { width: 100 * width / height, height: 100, devicePixelRatio: 1 }, strokes,
    schemaVersion: 1, writerId: 'fallback', createdAt: '', category: 'custom', labelName: label, latex: label, imageData: '', imageWidth: 0, imageHeight: 0, strokeCount: strokes.length, pointCount: strokes.reduce((n, s) => n + s.points.length, 0) }
})
