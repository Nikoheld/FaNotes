/**
 * SVG path data (`d` attribute) as PDF path operators, for ink stamps (symbols and figures).
 * Supports M L H V C S Q T A Z, absolute and relative. Arcs become cubic curves.
 */

const COMMAND = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/giu

const num = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

/** Cubic pieces of an SVG elliptical arc (endpoint form to center form, per the SVG spec). */
const arcToCubics = (
  x0: number, y0: number, rxIn: number, ryIn: number, rotation: number, large: boolean, sweep: boolean, x1: number, y1: number,
): number[][] => {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (!rx || !ry || (x0 === x1 && y0 === y1)) return [[x0, y0, x1, y1, x1, y1]]
  const phi = (rotation * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x0 - x1) / 2
  const dy = (y0 - y1) / 2
  const xp = cos * dx + sin * dy
  const yp = -sin * dx + cos * dy
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) {
    const root = Math.sqrt(lambda)
    rx *= root
    ry *= root
  }
  const numerator = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
  const denominator = rx * rx * yp * yp + ry * ry * xp * xp
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator))
  const cxp = (factor * rx * yp) / ry
  const cyp = (-factor * ry * xp) / rx
  const cx = cos * cxp - sin * cyp + (x0 + x1) / 2
  const cy = sin * cxp + cos * cyp + (y0 + y1) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1
    const dot = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
    return sign * Math.acos(Math.max(-1, Math.min(1, dot)))
  }
  const theta = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
  let delta = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9))
  const step = delta / pieces
  const k = (4 / 3) * Math.tan(step / 4)
  const out: number[][] = []
  let a = theta
  for (let piece = 0; piece < pieces; piece += 1) {
    const b = a + step
    const point = (t: number, dxt: number, dyt: number): [number, number, number, number] => {
      const ex = Math.cos(t)
      const ey = Math.sin(t)
      return [
        cx + rx * ex * cos - ry * ey * sin,
        cy + rx * ex * sin + ry * ey * cos,
        dxt,
        dyt,
      ]
    }
    const [sx, sy] = point(a, 0, 0)
    const [ex, ey] = point(b, 0, 0)
    const tangent = (t: number): [number, number] => [
      -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
      -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
    ]
    const [tax, tay] = tangent(a)
    const [tbx, tby] = tangent(b)
    out.push([sx + k * tax, sy + k * tay, ex - k * tbx, ey - k * tby, ex, ey])
    a = b
  }
  return out
}

/** Operators for one path, in the coordinate space of the caller (no flip). */
export const svgPathOperators = (data: string): string => {
  const ops: string[] = []
  let command = ''
  let args: number[] = []
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastCubic: [number, number] | null = null
  let lastQuad: [number, number] | null = null
  const apply = (cmd: string, values: number[]) => {
    const relative = cmd === cmd.toLowerCase()
    const lower = cmd.toLowerCase()
    const ox = relative ? x : 0
    const oy = relative ? y : 0
    let nextCubic: [number, number] | null = null
    let nextQuad: [number, number] | null = null
    switch (lower) {
      case 'm':
        x = values[0] + ox
        y = values[1] + oy
        startX = x
        startY = y
        ops.push(`${num(x)} ${num(y)} m`)
        break
      case 'l':
        x = values[0] + ox
        y = values[1] + oy
        ops.push(`${num(x)} ${num(y)} l`)
        break
      case 'h':
        x = values[0] + ox
        ops.push(`${num(x)} ${num(y)} l`)
        break
      case 'v':
        y = values[0] + oy
        ops.push(`${num(x)} ${num(y)} l`)
        break
      case 'c': {
        const [c1x, c1y, c2x, c2y, ex, ey] = [values[0] + ox, values[1] + oy, values[2] + ox, values[3] + oy, values[4] + ox, values[5] + oy]
        ops.push(`${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(ex)} ${num(ey)} c`)
        nextCubic = [c2x, c2y]
        x = ex
        y = ey
        break
      }
      case 's': {
        const c1x = lastCubic ? 2 * x - lastCubic[0] : x
        const c1y = lastCubic ? 2 * y - lastCubic[1] : y
        const [c2x, c2y, ex, ey] = [values[0] + ox, values[1] + oy, values[2] + ox, values[3] + oy]
        ops.push(`${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(ex)} ${num(ey)} c`)
        nextCubic = [c2x, c2y]
        x = ex
        y = ey
        break
      }
      case 'q':
      case 't': {
        let qx: number
        let qy: number
        let ex: number
        let ey: number
        if (lower === 'q') {
          qx = values[0] + ox
          qy = values[1] + oy
          ex = values[2] + ox
          ey = values[3] + oy
        } else {
          qx = lastQuad ? 2 * x - lastQuad[0] : x
          qy = lastQuad ? 2 * y - lastQuad[1] : y
          ex = values[0] + ox
          ey = values[1] + oy
        }
        ops.push(`${num(x + (2 / 3) * (qx - x))} ${num(y + (2 / 3) * (qy - y))} ${num(ex + (2 / 3) * (qx - ex))} ${num(ey + (2 / 3) * (qy - ey))} ${num(ex)} ${num(ey)} c`)
        nextQuad = [qx, qy]
        x = ex
        y = ey
        break
      }
      case 'a': {
        const ex = values[5] + ox
        const ey = values[6] + oy
        for (const piece of arcToCubics(x, y, values[0], values[1], values[2], values[3] !== 0, values[4] !== 0, ex, ey)) {
          ops.push(`${piece.map(num).join(' ')} c`)
        }
        x = ex
        y = ey
        break
      }
      case 'z':
        ops.push('h')
        x = startX
        y = startY
        break
      default:
        break
    }
    lastCubic = nextCubic
    lastQuad = nextQuad
  }
  for (const match of data.matchAll(COMMAND)) {
    if (match[1]) {
      command = match[1]
      args = []
      if (command.toLowerCase() === 'z') apply(command, [])
      continue
    }
    if (!command) continue
    args.push(Number(match[2]))
    const need = ARGS[command.toLowerCase()]
    if (need && args.length === need) {
      apply(command, args)
      args = []
      // Extra coordinate pairs after M are implicit L.
      if (command === 'M') command = 'L'
      else if (command === 'm') command = 'l'
    }
  }
  return ops.join('\n')
}
