/**
 * Last sample index to paint.
 *
 * A pen lift often hooks back inside the nib. Each of those samples is
 * stroked with a round cap, so the hook fills a circle on the end of the
 * mark. Samples that keep going forward, and a turn whose legs leave the
 * nib, stay so the curve is still there. Stored points are unchanged; only
 * the paint view uses this.
 */
export const inkQuickTurnKeep = (
  points: readonly { x: number; y: number }[],
  scaleX: number,
  scaleY: number,
  nibPx: number,
): number => {
  let end = points.length - 1
  if (end < 1) return Math.max(0, end)
  const reach = Math.max(nibPx * 0.9, 1.5)
  const at = (index: number) => ({ x: points[index].x * scaleX, y: points[index].y * scaleY })
  const dist = (left: number, right: number) => {
    const a = at(left)
    const b = at(right)
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  let dropped = 0
  while (end >= 1 && dropped < 10 && dist(end, end - 1) < 0.9) {
    end -= 1
    dropped += 1
  }
  dropped = 0
  while (end >= 2 && dropped < 10) {
    const a = at(end - 2)
    const b = at(end - 1)
    const c = at(end)
    const inX = b.x - a.x
    const inY = b.y - a.y
    const outX = c.x - b.x
    const outY = c.y - b.y
    const inLen = Math.hypot(inX, inY)
    const outLen = Math.hypot(outX, outY)
    if (outLen < 0.9) {
      end -= 1
      dropped += 1
      continue
    }
    if (outLen >= reach || inLen < 0.01) break
    const cos = (inX * outX + inY * outY) / (inLen * outLen)
    if (cos > 0.2) break
    end -= 1
    dropped += 1
  }
  if (end >= 2) {
    let anchor = end
    let path = 0
    let steps = 0
    while (anchor >= 1 && steps < 10) {
      const step = dist(anchor, anchor - 1)
      if (step >= reach) break
      path += step
      anchor -= 1
      steps += 1
    }
    if (steps >= 2 && anchor >= 1) {
      const chord = dist(anchor, end)
      const incoming = at(anchor)
      const before = at(anchor - 1)
      const tip = at(end)
      const prev = at(end - 1)
      const inX = incoming.x - before.x
      const inY = incoming.y - before.y
      const outX = tip.x - prev.x
      const outY = tip.y - prev.y
      const inLen = Math.hypot(inX, inY)
      const outLen = Math.hypot(outX, outY)
      const cos = inLen > 0.01 && outLen > 0.01
        ? (inX * outX + inY * outY) / (inLen * outLen)
        : 1
      if (chord <= reach && path > chord * 1.35 && path > chord + 1.25 && cos <= 0.2) end = anchor
    }
  }
  return Math.max(0, end)
}
