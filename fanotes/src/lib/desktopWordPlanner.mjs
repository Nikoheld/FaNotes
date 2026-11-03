/** Whole-word beam search over observed trajectories. No recognition labels are invented here. */
export function primaryTrajectory(strokes, width = 1, height = 1) {
  let best = -1, longest = -1
  strokes.forEach((s,i) => {
    let length = 0
    for (let j = 1; j < s.points.length; j++) length += Math.hypot((s.points[j].x-s.points[j-1].x)*width, (s.points[j].y-s.points[j-1].y)*height)
    if (length > longest) { longest = length; best = i }
  })
  return best
}
export function trajectoryDescriptor(candidate) {
  const { sample, width, height, top } = candidate
  const index = primaryTrajectory(sample.strokes, sample.sourceCanvas.width, sample.sourceCanvas.height)
  const stroke = sample.strokes[index]
  if (!stroke?.points.length) return null
  const points = stroke.points.map(p => ({ x: (p.x-sample.bbox[0])/sample.bbox[2]*width, y: (p.y-sample.bbox[1])/sample.bbox[3]*height-top }))
  const tangent = end => {
    const p = end ? points.at(-1) : points[0]
    const rest = end ? points.slice(0,-1).reverse() : points.slice(1)
    const q = rest.find(q => Math.hypot(p.x-q.x,p.y-q.y) >= .035) ?? rest.at(-1) ?? p
    const x = end ? p.x-q.x : q.x-p.x, y = end ? p.y-q.y : q.y-p.y, n = Math.hypot(x,y) || 1
    return [x/n,y/n]
  }
  return { entry: points[0], exit: points.at(-1), incoming: tangent(false), outgoing: tangent(true) }
}
export function wordTransitionCost(left, right, connect = true, gap = .05) {
  if (!left || !right || !connect) return 0
  const a = left.geometry, b = right.geometry
  if (!a || !b) return 4
  const dx = left.width+gap+b.entry.x-a.exit.x, dy = b.entry.y-a.exit.y
  if ([...left.text].length !== 1 || [...right.text].length !== 1) return .25
  if (a.outgoing[0] < .1 || b.incoming[0] < .1 || dx < -.06 || dx > .65 || Math.abs(dy) > .4) return 3
  const alignment = a.outgoing[0]*b.incoming[0]+a.outgoing[1]*b.incoming[1]
  return (1-alignment)*.8+Math.abs(dy)*2.5+Math.max(0,-dx)*4+Math.hypot(dx,dy)*.25
}
/** Candidate cost rewards faithful complete words and exact neighboring-letter context. */
export function planDesktopWord(word, candidatesAt, { random, beamWidth = 12, variants = 16, connect = true, gap = .05 } = {}) {
  beamWidth = Math.max(1,Math.min(16,Math.trunc(beamWidth)||12))
  const chars = [...word]
  if (!chars.length || chars.length > 96) return []
  const beams = Array.from({ length: chars.length+1 }, () => [])
  beams[0] = [{ cost: 0, path: [] }]
  const descriptors = new Map()
  for (let position = 0; position < chars.length; position++) {
    const raw = candidatesAt(position).map(candidate => {
      const previous = chars[position-1] ?? '^', next = chars[position+[...candidate.text].length] ?? '$'
      const exactContext = candidate.unit?.context === `${previous}|${next}`
      const fallback = candidate.sample.sessionId === 'school-script'
      const n = [...candidate.text].length
      const cost = (fallback ? 1.4*n : candidate.unit ? 0 : .25*n)-.55*(n-1)+(candidate.unit ? exactContext ? -.3 : .25 : 0)+(random?.() ?? .5)*.035
      const key = `${candidate.sample.id}:${candidate.text}`
      if (!descriptors.has(key)) descriptors.set(key, trajectoryDescriptor(candidate))
      return { ...candidate, cost, geometry: descriptors.get(key) }
    }).sort((a,b) => a.cost-b.cost).slice(0, Math.max(16, Math.min(32, variants*2)))
    const beam = beams[position].sort((a,b) => a.cost-b.cost).slice(0, Math.max(1,Math.min(16,beamWidth)))
    for (const state of beam) for (const candidate of raw) {
      const end = position+[...candidate.text].length
      if (end > chars.length) continue
      const last = state.path.at(-1)
      const repeat = last?.sample.id === candidate.sample.id ? .04 : 0
      const cost = state.cost+candidate.cost+wordTransitionCost(last,candidate,connect,gap)+repeat
      const bucket = beams[end]
      bucket.push({ cost, path: [...state.path, { ...candidate, position }] })
      if (bucket.length > beamWidth*4) { bucket.sort((a,b) => a.cost-b.cost); bucket.length = beamWidth }
    }
  }
  return beams.at(-1).sort((a,b) => a.cost-b.cost)[0]?.path ?? []
}
