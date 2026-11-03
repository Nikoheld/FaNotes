package ch.fasrv.fanotes.ink

import kotlin.math.*

/** Quintic Hermite trajectory, with directed endpoint velocity and acceleration. */
fun spliceWritingTrajectories(left: List<StrokePoint>, right: List<StrokePoint>, em: Double, motions: List<JoiningMotion> = emptyList()): List<StrokePoint>? {
    if (left.size < 3 || right.size < 3) return null
    val a = left.last(); val b = right.first(); val dx = b.x - a.x; val dy = b.y - a.y; val gap = hypot(dx, dy)
    if (dx < -em * .06 || dx > em * .65 || abs(dy) > em * .4 || gap < .05) return null
    fun tangent(ps: List<StrokePoint>, end: Boolean): Pair<Double, Double> {
        val p = if (end) ps.last() else ps.first()
        val candidates = if (end) ps.dropLast(1).reversed() else ps.drop(1)
        val q = candidates.find { hypot(it.x - p.x, it.y - p.y) >= em * .035 } ?: candidates.last()
        val x = if (end) p.x - q.x else q.x - p.x; val y = if (end) p.y - q.y else q.y - p.y
        val n = hypot(x, y).takeIf { it > 0 } ?: 1.0
        return x / n to y / n
    }
    val u = tangent(left, true); val v = tangent(right, false)
    if (u.first < .1 || v.first < .1 || u.first * v.first + u.second * v.second < -.5) return null
    fun cosine(a: Pair<Double, Double>, b: Pair<Double, Double>) = (a.first * b.first + a.second * b.second) / max(1e-9, hypot(a.first, a.second) * hypot(b.first, b.second))
    val donor = motions.map { it to (cosine(it.entry, u) + cosine(it.exit, v)) }.filter { it.second > 1.65 }.maxByOrNull { it.second }?.first
    val d = min(em * .35, gap * .8)
    fun acceleration(ps: List<StrokePoint>, end: Boolean): Pair<Double, Double> {
        val q = if (end) ps.takeLast(3) else ps.take(3)
        val ta = tangent(q.take(2), true); val tb = tangent(q.drop(1), true)
        val ds = (hypot(q[1].x - q[0].x, q[1].y - q[0].y) + hypot(q[2].x - q[1].x, q[2].y - q[1].y)) / 2
        return ((tb.first - ta.first) / max(ds, .1) * d * d).coerceIn(-em * .3, em * .3) to
            ((tb.second - ta.second) / max(ds, .1) * d * d).coerceIn(-em * .3, em * .3)
    }
    val aa = acceleration(left, true); val ab = acceleration(right, false)
    fun coefficients(p: Double, q: Double, v0: Double, v1: Double, a0: Double, a1: Double): List<Double> {
        val c2 = a0 / 2; val A = q - p - v0 - c2; val B = v1 - v0 - 2 * c2; val C = a1 - 2 * c2
        return listOf(p, v0, c2, 10 * A - 4 * B + C / 2, -15 * A + 7 * B - C, 6 * A - 3 * B + C / 2)
    }
    val cx = coefficients(a.x, b.x, u.first * d, v.first * d, aa.first, ab.first)
    val cy = coefficients(a.y, b.y, u.second * d, v.second * d, aa.second, ab.second)
    fun evaluate(c: List<Double>, t: Double) = c.asReversed().fold(0.0) { s, x -> s * t + x }
    val count = max(12, ceil(gap / .65).toInt()); val bridge = mutableListOf<StrokePoint>()
    for (i in 1 until count) {
        val t = i.toDouble() / count
        var residual = 0.0
        if (donor != null) {
            val position = t * 16; val k = min(15, floor(position).toInt()); val f = position - k
            val weights = listOf((1 - f).pow(3) / 6, (3 * f.pow(3) - 6 * f * f + 4) / 6, (-3 * f.pow(3) + 3 * f * f + 3 * f + 1) / 6, f.pow(3) / 6)
            val neighbors = listOf(-1, 0, 1, 2).map { donor.points[(k + it).coerceIn(0, 16)] }; val end = donor.points[16]
            val px = neighbors.indices.sumOf { weights[it] * neighbors[it].x }; val py = neighbors.indices.sumOf { weights[it] * neighbors[it].y }
            residual = (py * end.x - px * end.y) / max(1e-6, end.x * end.x + end.y * end.y) * gap * .35 * 64 * t.pow(3) * (1 - t).pow(3)
        }
        val x = evaluate(cx, t) - dy / gap * residual; val y = evaluate(cy, t) + dx / gap * residual
        if (x < a.x - em * .08 || x > b.x + em * .08 || y < min(a.y, b.y) - em * .18 || y > max(a.y, b.y) + em * .18) return null
        bridge += a.copy(x = x, y = y, t = a.t + (b.t - a.t) * t, pressure = a.pressure + (b.pressure - a.pressure) * t * t * (3 - 2 * t))
    }
    val length = (listOf(a) + bridge + b).zipWithNext().sumOf { (p, q) -> hypot(q.x - p.x, q.y - p.y) }
    if (length > max(gap * 1.65, em * .12)) return null
    return left + bridge + right
}
