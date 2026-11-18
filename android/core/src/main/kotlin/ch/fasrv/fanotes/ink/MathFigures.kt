package ch.fasrv.fanotes.ink

// Port of fanotes/src/lib/mathFigures.ts. Output paths must stay byte-identical to the desktop.
// JS Math.* is matched with StrictMath (fdlibm) and a V8-style hypot.

data class MathFigureParam(
    val id: String,
    val label: String,
    val min: Double,
    val max: Double,
    val step: Double,
    val value: Double,
)

data class MathFigureDefinition(
    val id: String,
    val label: String,
    /** "plane" or "solid". */
    val group: String,
    val params: List<MathFigureParam>,
)

val MATH_FIGURE_IDS: List<String> = listOf(
    "circle", "ellipse", "semicircle", "ring", "sector", "arc",
    "triangle", "right-triangle", "square", "rectangle", "rhombus", "parallelogram", "trapezoid", "kite",
    "polygon", "star", "arrow", "double-arrow", "angle", "axes", "number-line",
    "parabola", "sine", "grid", "venn", "parallel", "chord", "tangent", "diameter",
    "cube-net", "cross", "vector",
    "cube", "cuboid", "tetrahedron", "octahedron", "icosahedron", "dodecahedron",
    "square-pyramid", "pentagonal-pyramid", "hexagonal-pyramid",
    "triangular-prism", "pentagonal-prism", "hexagonal-prism",
    "cylinder", "cone", "frustum", "sphere", "hemisphere", "torus", "axes-3d", "plane",
)

private val mfIdSet: Set<String> = MATH_FIGURE_IDS.toSet()

fun isMathFigureId(value: String?): Boolean = value != null && value in mfIdSet

const val FIGURE_LINE_MIN = 0.5
const val FIGURE_LINE_MAX = 36.0
const val FIGURE_LINE_STEP = 0.25

/** JS Math.round: halves go toward +infinity. */
private fun mfRound(value: Double): Double = Math.floor(value + 0.5)

private fun mfSnapLine(value: Double): Double =
    mfRound(mfRound(value / FIGURE_LINE_STEP) * FIGURE_LINE_STEP * 100.0) / 100.0

/** The thickness a figure of [size] page units had when the stroke was fixed at 1.75. */
fun figureLineWidthForSize(size: Double): Double = mfSnapLine(FIGURE_ICON_STROKE * size / 24.0)

fun clampFigureLineWidth(value: Double?, fallback: Double): Double {
    val raw = if (value != null && value.isFinite()) value else fallback
    return mfSnapLine(Math.min(FIGURE_LINE_MAX, Math.max(FIGURE_LINE_MIN, raw)))
}

private fun mfParam(id: String, label: String, min: Double, max: Double, step: Double, value: Double) =
    MathFigureParam(id, label, min, max, step, value)

private fun mfYawPitch(): List<MathFigureParam> = listOf(
    mfParam("yaw", "Drehung", 0.0, 360.0, 1.0, 35.0),
    mfParam("pitch", "Neigung", -60.0, 60.0, 1.0, 24.0),
)

private fun mfDefine(
    id: String,
    label: String,
    group: String,
    params: List<MathFigureParam> = emptyList(),
) = MathFigureDefinition(id, label, group, params)

val MATH_FIGURES: List<MathFigureDefinition> = listOf(
    mfDefine("circle", "Kreis", "plane"),
    mfDefine("ellipse", "Ellipse", "plane", listOf(mfParam("aspect", "Verhältnis", 0.35, 1.0, 0.05, 0.62))),
    mfDefine("semicircle", "Halbkreis", "plane"),
    mfDefine("ring", "Ring", "plane", listOf(mfParam("inner", "Innen", 0.25, 0.85, 0.05, 0.55))),
    mfDefine("sector", "Sektor", "plane", listOf(mfParam("degrees", "Winkel", 20.0, 320.0, 1.0, 90.0))),
    mfDefine("arc", "Bogen", "plane", listOf(mfParam("degrees", "Winkel", 20.0, 320.0, 1.0, 120.0))),
    mfDefine("triangle", "Dreieck", "plane"),
    mfDefine("right-triangle", "Rechtwinklig", "plane"),
    mfDefine("square", "Quadrat", "plane"),
    mfDefine("rectangle", "Rechteck", "plane", listOf(mfParam("aspect", "Verhältnis", 0.35, 1.0, 0.05, 0.62))),
    mfDefine("rhombus", "Raute", "plane"),
    mfDefine("parallelogram", "Parallelogramm", "plane", listOf(mfParam("skew", "Schräge", -0.6, 0.6, 0.05, 0.35))),
    mfDefine("trapezoid", "Trapez", "plane", listOf(mfParam("top", "Oberseite", 0.35, 0.9, 0.05, 0.55))),
    mfDefine("kite", "Drachen", "plane"),
    mfDefine("polygon", "Vieleck", "plane", listOf(mfParam("sides", "Ecken", 3.0, 12.0, 1.0, 6.0))),
    mfDefine("star", "Stern", "plane", listOf(mfParam("points", "Zacken", 4.0, 12.0, 1.0, 5.0))),
    mfDefine("arrow", "Pfeil", "plane"),
    mfDefine("double-arrow", "Doppelpfeil", "plane"),
    mfDefine("angle", "Winkel", "plane", listOf(mfParam("degrees", "Winkel", 20.0, 160.0, 1.0, 60.0))),
    mfDefine("axes", "Achsen", "plane", listOf(mfParam("ticks", "Teilung", 0.0, 8.0, 1.0, 4.0))),
    mfDefine("number-line", "Zahlenstrahl", "plane", listOf(mfParam("ticks", "Teilung", 2.0, 12.0, 1.0, 6.0))),
    mfDefine("parabola", "Parabel", "plane"),
    mfDefine(
        "sine", "Sinus", "plane",
        listOf(
            mfParam("waves", "Wellen", 0.5, 4.0, 0.5, 1.5),
            mfParam("amplitude", "Höhe", 0.3, 1.0, 0.05, 0.7),
        ),
    ),
    mfDefine("grid", "Gitter", "plane", listOf(mfParam("cells", "Felder", 2.0, 8.0, 1.0, 4.0))),
    mfDefine("venn", "Venn", "plane"),
    mfDefine("parallel", "Parallelen", "plane"),
    mfDefine("chord", "Sehne", "plane"),
    mfDefine("tangent", "Tangente", "plane"),
    mfDefine("diameter", "Durchmesser", "plane"),
    mfDefine("cube-net", "Würfelnetz", "plane"),
    mfDefine("cross", "Kreuz", "plane"),
    mfDefine("vector", "Vektor", "plane"),
    mfDefine("cube", "Würfel", "solid", mfYawPitch()),
    mfDefine(
        "cuboid", "Quader", "solid",
        listOf(
            mfParam("width", "Breite", 0.4, 2.2, 0.05, 1.4),
            mfParam("height", "Höhe", 0.4, 2.2, 0.05, 0.9),
            mfParam("depth", "Tiefe", 0.4, 2.2, 0.05, 0.7),
        ) + mfYawPitch(),
    ),
    mfDefine("tetrahedron", "Tetraeder", "solid", mfYawPitch()),
    mfDefine("octahedron", "Oktaeder", "solid", mfYawPitch()),
    mfDefine("icosahedron", "Ikosaeder", "solid", mfYawPitch()),
    mfDefine("dodecahedron", "Dodekaeder", "solid", mfYawPitch()),
    mfDefine("square-pyramid", "Pyramide", "solid", mfYawPitch()),
    mfDefine("pentagonal-pyramid", "Fünfeckpyramide", "solid", mfYawPitch()),
    mfDefine("hexagonal-pyramid", "Sechseckpyramide", "solid", mfYawPitch()),
    mfDefine("triangular-prism", "Dreiecksprisma", "solid", mfYawPitch()),
    mfDefine("pentagonal-prism", "Fünfeckprisma", "solid", mfYawPitch()),
    mfDefine("hexagonal-prism", "Sechseckprisma", "solid", mfYawPitch()),
    mfDefine("cylinder", "Zylinder", "solid", listOf(mfParam("segments", "Segmente", 8.0, 24.0, 1.0, 16.0)) + mfYawPitch()),
    mfDefine("cone", "Kegel", "solid", listOf(mfParam("segments", "Segmente", 8.0, 24.0, 1.0, 16.0)) + mfYawPitch()),
    mfDefine(
        "frustum", "Kegelstumpf", "solid",
        listOf(
            mfParam("ratio", "Deckel", 0.2, 0.85, 0.05, 0.45),
            mfParam("segments", "Segmente", 8.0, 24.0, 1.0, 16.0),
        ) + mfYawPitch(),
    ),
    mfDefine(
        "sphere", "Kugel", "solid",
        listOf(
            mfParam("meridians", "Meridiane", 4.0, 16.0, 1.0, 8.0),
            mfParam("parallels", "Breiten", 2.0, 8.0, 1.0, 4.0),
        ) + mfYawPitch(),
    ),
    mfDefine("hemisphere", "Halbkugel", "solid", listOf(mfParam("meridians", "Meridiane", 4.0, 16.0, 1.0, 8.0)) + mfYawPitch()),
    mfDefine(
        "torus", "Torus", "solid",
        listOf(
            mfParam("tube", "Dicke", 0.22, 0.55, 0.01, 0.36),
            mfParam("rings", "Ringe", 8.0, 18.0, 1.0, 12.0),
        ) + mfYawPitch(),
    ),
    mfDefine("axes-3d", "Raumachsen", "solid", mfYawPitch()),
    mfDefine("plane", "Ebene", "solid", listOf(mfParam("cells", "Felder", 2.0, 8.0, 1.0, 4.0)) + mfYawPitch()),
)

private val mfById: Map<String, MathFigureDefinition> = MATH_FIGURES.associateBy { it.id }

fun mathFigureById(id: String): MathFigureDefinition =
    mfById[id] ?: throw IllegalArgumentException("Unknown math figure $id")

private fun mfSnap(value: Double, step: Double): Double {
    if (!(step > 0.0)) return value
    val snapped = mfRound(value / step) * step
    return mfRound(snapped * 10000.0) / 10000.0
}

fun defaultFigureParams(id: String): Map<String, Double> {
    val params = LinkedHashMap<String, Double>()
    for (param in mathFigureById(id).params) params[param.id] = param.value
    return params
}

/** Keeps only this figure's knobs. A missing or non-finite value falls back to the default. */
fun clampFigureParams(id: String, raw: Map<String, Double>?): Map<String, Double> {
    val params = LinkedHashMap<String, Double>()
    for (param in mathFigureById(id).params) {
        val numeric = raw?.get(param.id)
        val value = if (numeric != null && numeric.isFinite()) numeric else param.value
        params[param.id] = Math.max(param.min, Math.min(param.max, mfSnap(value, param.step)))
    }
    return params
}

private class MfPt(val x: Double, val y: Double)
private class MfV3(val x: Double, val y: Double, val z: Double)
private class MfPoly(val pts: List<MfPt>, val dashed: Boolean = false, val close: Boolean = false)
private class MfMesh(val verts: List<MfV3>, val faces: List<List<Int>>)

/** Same text as JS `String(Math.round(v * 100) / 100)` with -0 as "0". */
private fun mfFmt(value: Double): String {
    if (!value.isFinite()) return if (value.isNaN()) "NaN" else if (value > 0) "Infinity" else "-Infinity"
    val cents = mfRound(value * 100.0).toLong()
    if (cents == 0L) return "0"
    val abs = Math.abs(cents)
    val whole = abs / 100
    val frac = (abs % 100).toInt()
    val sb = StringBuilder()
    if (cents < 0) sb.append('-')
    sb.append(whole)
    if (frac != 0) {
        sb.append('.')
        sb.append(if (frac % 10 == 0) (frac / 10).toString() else frac.toString().padStart(2, '0'))
    }
    return sb.toString()
}

/** V8's Math.hypot. */
private fun mfHypot(vararg values: Double): Double {
    var max = 0.0
    for (v in values) {
        val a = Math.abs(v)
        if (a.isInfinite()) return Double.POSITIVE_INFINITY
        if (a.isNaN()) return Double.NaN
        if (a > max) max = a
    }
    if (max == 0.0) return 0.0
    var sum = 0.0
    var compensation = 0.0
    for (v in values) {
        val n = Math.abs(v) / max
        val summand = n * n - compensation
        val preliminary = sum + summand
        compensation = (preliminary - sum) - summand
        sum = preliminary
    }
    return StrictMath.sqrt(sum) * max
}

private fun mfRotate(p: MfV3, yawDeg: Double, pitchDeg: Double): MfV3 {
    val yaw = yawDeg * Math.PI / 180.0
    val pitch = pitchDeg * Math.PI / 180.0
    val cy = StrictMath.cos(yaw)
    val sy = StrictMath.sin(yaw)
    val cp = StrictMath.cos(pitch)
    val sp = StrictMath.sin(pitch)
    val x1 = p.x * cy + p.z * sy
    val y1 = p.y
    val z1 = -p.x * sy + p.z * cy
    val y2 = y1 * cp - z1 * sp
    val z2 = y1 * sp + z1 * cp
    return MfV3(x1, y2, z2)
}

private fun mfScreen(p: MfV3) = MfPt(p.x, -p.y)
private fun mfAdd(a: MfV3, b: MfV3) = MfV3(a.x + b.x, a.y + b.y, a.z + b.z)
private fun mfScale(a: MfV3, k: Double) = MfV3(a.x * k, a.y * k, a.z * k)
private fun mfSub(a: MfV3, b: MfV3) = MfV3(a.x - b.x, a.y - b.y, a.z - b.z)
private fun mfDot(a: MfV3, b: MfV3) = a.x * b.x + a.y * b.y + a.z * b.z
private fun mfCross(a: MfV3, b: MfV3) = MfV3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
)

private fun mfNormalize(a: MfV3): MfV3 {
    val len = mfHypot(a.x, a.y, a.z).let { if (it == 0.0) 1.0 else it }
    return mfScale(a, 1.0 / len)
}

private fun mfDashPath(a: MfPt, b: MfPt): String {
    val dx = b.x - a.x
    val dy = b.y - a.y
    val len = mfHypot(dx, dy)
    if (len < 0.35) return ""
    val ux = dx / len
    val uy = dy / len
    val on = 1.25
    val gap = 0.8
    val parts = ArrayList<String>()
    var t = 0.0
    while (t < len - 0.12 && parts.size < 48) {
        val end = Math.min(len, t + on)
        if (end - t >= 0.2) {
            parts.add("M ${mfFmt(a.x + ux * t)} ${mfFmt(a.y + uy * t)} L ${mfFmt(a.x + ux * end)} ${mfFmt(a.y + uy * end)}")
        }
        t = end + gap
    }
    return parts.joinToString(" ")
}

private fun mfPolyPath(pts: List<MfPt>, close: Boolean): String {
    val sb = StringBuilder("M ${mfFmt(pts[0].x)} ${mfFmt(pts[0].y)}")
    for (index in 1 until pts.size) sb.append(" L ${mfFmt(pts[index].x)} ${mfFmt(pts[index].y)}")
    if (close) sb.append(" Z")
    return sb.toString()
}

/** Fits every polyline into the 24x24 stamp, then breaks hidden edges into dashes. */
private fun mfEmit(polys: List<MfPoly>): List<String> {
    val points = polys.flatMap { it.pts }
    if (points.size < 2) return emptyList()
    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    for (point in points) {
        if (point.x < minX) minX = point.x
        if (point.y < minY) minY = point.y
        if (point.x > maxX) maxX = point.x
        if (point.y > maxY) maxY = point.y
    }
    val width = Math.max(1e-6, maxX - minX)
    val height = Math.max(1e-6, maxY - minY)
    val pad = 1.7
    val avail = 24.0 - pad * 2
    val fit = Math.min(avail / width, avail / height)
    val ox = pad + (avail - width * fit) / 2
    val oy = pad + (avail - height * fit) / 2
    fun map(point: MfPt) = MfPt(ox + (point.x - minX) * fit, oy + (point.y - minY) * fit)
    val solid = ArrayList<String>()
    val hidden = ArrayList<String>()
    for (poly in polys) {
        val mapped = poly.pts.map(::map)
        if (mapped.size < 2) continue
        if (poly.dashed) {
            val seq = if (poly.close) mapped + mapped[0] else mapped
            val parts = ArrayList<String>()
            for (index in 0 until seq.size - 1) {
                val piece = mfDashPath(seq[index], seq[index + 1])
                if (piece.isNotEmpty()) parts.add(piece)
            }
            if (parts.isNotEmpty()) hidden.add(parts.joinToString(" "))
        } else {
            solid.add(mfPolyPath(mapped, poly.close))
        }
    }
    val paths = ArrayList<String>()
    if (solid.isNotEmpty()) paths.add(solid.joinToString(" "))
    if (hidden.isNotEmpty()) paths.add(hidden.joinToString(" "))
    return paths
}

private fun mfLine(pts: List<MfPt>, dashed: Boolean = false) = MfPoly(pts, dashed = dashed)
private fun mfLoop(pts: List<MfPt>) = MfPoly(pts, close = true)
private fun mfPt(x: Double, y: Double) = MfPt(x, y)

private fun mfCirclePts(
    cx: Double,
    cy: Double,
    rx: Double,
    ry: Double = rx,
    from: Double = 0.0,
    to: Double = Math.PI * 2,
    steps: Double = 56.0,
): List<MfPt> {
    val count = Math.max(8.0, mfRound(steps * Math.abs(to - from) / (Math.PI * 2))).toInt()
    val pts = ArrayList<MfPt>()
    for (index in 0..count) {
        val t = from + (to - from) * (index.toDouble() / count)
        pts.add(MfPt(cx + StrictMath.cos(t) * rx, cy + StrictMath.sin(t) * ry))
    }
    return pts
}

private fun mfSamples(count: Int, at: (Double) -> MfPt): List<MfPt> =
    (0..count).map { at(it.toDouble() / count) }

private fun mfArrowHead(tip: MfPt, dir: MfPt, size: Double = 0.28): List<List<MfPt>> {
    val len = mfHypot(dir.x, dir.y).let { if (it == 0.0) 1.0 else it }
    val ux = dir.x / len
    val uy = dir.y / len
    val bx = tip.x - ux * size
    val by = tip.y - uy * size
    val px = -uy * size * 0.55
    val py = ux * size * 0.55
    return listOf(
        listOf(MfPt(tip.x, tip.y), MfPt(bx + px, by + py)),
        listOf(MfPt(tip.x, tip.y), MfPt(bx - px, by - py)),
    )
}

private fun mfFaceFront(cam: List<MfV3>, face: List<Int>): Boolean {
    val a = cam[face[0]]
    val b = cam[face[1]]
    val c = cam[face[2]]
    val ux = b.x - a.x
    val uy = b.y - a.y
    val vx = c.x - a.x
    val vy = c.y - a.y
    return ux * vy - uy * vx > 0.02
}

private fun mfWire(verts: List<MfV3>, faces: List<List<Int>>, yaw: Double, pitch: Double): List<MfPoly> {
    val cam = verts.map { mfRotate(it, yaw, pitch) }
    val front = faces.map { mfFaceFront(cam, it) }
    // Insertion-ordered like the JS Map; key packs the sorted vertex pair.
    val owners = LinkedHashMap<Int, MutableList<Int>>()
    faces.forEachIndexed { faceIndex, face ->
        for (index in face.indices) {
            val i = face[index]
            val j = face[(index + 1) % face.size]
            val key = if (i < j) i * 1000 + j else j * 1000 + i
            owners.getOrPut(key) { ArrayList() }.add(faceIndex)
        }
    }
    val polys = ArrayList<MfPoly>()
    for ((key, faceIndexes) in owners) {
        val i = key / 1000
        val j = key % 1000
        polys.add(MfPoly(listOf(mfScreen(cam[i]), mfScreen(cam[j])), dashed = faceIndexes.none { front[it] }))
    }
    return polys
}

private fun mfRing(count: Int, y: Double, radius: Double): List<MfV3> = (0 until count).map { index ->
    val angle = (index.toDouble() / count) * Math.PI * 2 - Math.PI / 2
    MfV3(StrictMath.cos(angle) * radius, y, StrictMath.sin(angle) * radius)
}

private fun mfPrism(sides: Int, topRadius: Double = 1.0): MfMesh {
    val verts = mfRing(sides, -1.0, 1.0) + mfRing(sides, 1.0, topRadius)
    val faces = ArrayList<List<Int>>()
    for (index in 0 until sides) {
        val next = (index + 1) % sides
        faces.add(listOf(index, sides + index, sides + next, next))
    }
    val top = ArrayList<Int>()
    val bottom = ArrayList<Int>()
    for (index in 0 until sides) {
        top.add(sides + ((sides - index) % sides))
        bottom.add(index)
    }
    faces.add(top)
    faces.add(bottom)
    return MfMesh(verts, faces)
}

private fun mfPyramid(sides: Int, yaw: Double, pitch: Double): List<MfPoly> {
    val verts = mfRing(sides, -0.8, 1.0) + MfV3(0.0, 1.25, 0.0)
    val apex = sides
    val faces = ArrayList<List<Int>>()
    for (index in 0 until sides) faces.add(listOf(index, apex, (index + 1) % sides))
    faces.add((0 until sides).toList())
    return mfWire(verts, faces, yaw, pitch)
}

private fun mfOrientOutward(verts: List<MfV3>, face: List<Int>): List<Int> {
    val a = verts[face[0]]
    val b = verts[face[1]]
    val c = verts[face[2]]
    val normal = mfCross(mfSub(b, a), mfSub(c, a))
    val mid = mfScale(mfAdd(mfAdd(a, b), c), 1.0 / 3)
    return if (mfDot(normal, mid) < 0) face.reversed() else face
}

private fun mfMutualTriangles(verts: List<MfV3>): List<List<Int>> {
    val count = verts.size
    var nearest = Double.POSITIVE_INFINITY
    val dist = Array(count) { DoubleArray(count) }
    for (i in 0 until count) {
        for (j in i + 1 until count) {
            val delta = mfSub(verts[i], verts[j])
            val value = mfDot(delta, delta)
            dist[i][j] = value
            dist[j][i] = value
            if (value > 1e-8 && value < nearest) nearest = value
        }
    }
    val limit = nearest * 1.02
    val neighbors = List(count) { ArrayList<Int>() }
    for (i in 0 until count) {
        for (j in i + 1 until count) {
            if (dist[i][j] <= limit) {
                neighbors[i].add(j)
                neighbors[j].add(i)
            }
        }
    }
    val faces = ArrayList<List<Int>>()
    for (i in 0 until count) {
        for (j in neighbors[i]) {
            if (j < i) continue
            for (k in neighbors[j]) {
                if (k <= j || !neighbors[i].contains(k)) continue
                faces.add(mfOrientOutward(verts, listOf(i, j, k)))
            }
        }
    }
    return faces
}

private val mfIcosa: MfMesh by lazy {
    val phi = (1 + StrictMath.sqrt(5.0)) / 2
    val raw = ArrayList<MfV3>()
    for (sy in listOf(-1.0, 1.0)) for (sz in listOf(-1.0, 1.0)) raw.add(MfV3(0.0, sy, sz * phi))
    for (sx in listOf(-1.0, 1.0)) for (sy in listOf(-1.0, 1.0)) raw.add(MfV3(sx, sy * phi, 0.0))
    for (sz in listOf(-1.0, 1.0)) for (sx in listOf(-1.0, 1.0)) raw.add(MfV3(sx * phi, 0.0, sz))
    val verts = raw.map(::mfNormalize)
    MfMesh(verts, mfMutualTriangles(verts))
}

private val mfDodeca: MfMesh by lazy {
    val verts = mfIcosa.verts
    val faces = mfIcosa.faces
    val centers = faces.map { face ->
        var sum = MfV3(0.0, 0.0, 0.0)
        for (index in face) sum = mfAdd(sum, verts[index])
        mfNormalize(mfScale(sum, 1.0 / face.size))
    }
    val around = List(verts.size) { ArrayList<Int>() }
    faces.forEachIndexed { faceIndex, face -> for (index in face) around[index].add(faceIndex) }
    val pentagons = around.mapIndexed { vertIndex, faceIndexes ->
        val outward = mfNormalize(verts[vertIndex])
        val helper = if (Math.abs(outward.y) < 0.9) MfV3(0.0, 1.0, 0.0) else MfV3(1.0, 0.0, 0.0)
        val xAxis = mfNormalize(mfCross(helper, outward))
        val yAxis = mfCross(outward, xAxis)
        faceIndexes
            .map { it to StrictMath.atan2(mfDot(centers[it], yAxis), mfDot(centers[it], xAxis)) }
            .sortedBy { it.second }
            .map { it.first }
    }
    MfMesh(centers, pentagons)
}

private val mfTetra: MfMesh by lazy {
    val verts = listOf(
        MfV3(1.0, 1.0, 1.0),
        MfV3(1.0, -1.0, -1.0),
        MfV3(-1.0, 1.0, -1.0),
        MfV3(-1.0, -1.0, 1.0),
    ).map(::mfNormalize)
    val faces = listOf(listOf(0, 1, 2), listOf(0, 2, 3), listOf(0, 3, 1), listOf(1, 3, 2))
        .map { mfOrientOutward(verts, it) }
    MfMesh(verts, faces)
}

private val mfOcta: MfMesh by lazy {
    val verts = listOf(
        MfV3(1.0, 0.0, 0.0), MfV3(-1.0, 0.0, 0.0),
        MfV3(0.0, 1.0, 0.0), MfV3(0.0, -1.0, 0.0),
        MfV3(0.0, 0.0, 1.0), MfV3(0.0, 0.0, -1.0),
    )
    val faces = ArrayList<List<Int>>()
    for (x in listOf(0, 1)) for (y in listOf(2, 3)) for (z in listOf(4, 5)) {
        faces.add(mfOrientOutward(verts, listOf(x, y, z)))
    }
    MfMesh(verts, faces)
}

private val mfCubeVerts = listOf(
    MfV3(-1.0, -1.0, -1.0), MfV3(1.0, -1.0, -1.0), MfV3(1.0, 1.0, -1.0), MfV3(-1.0, 1.0, -1.0),
    MfV3(-1.0, -1.0, 1.0), MfV3(1.0, -1.0, 1.0), MfV3(1.0, 1.0, 1.0), MfV3(-1.0, 1.0, 1.0),
)

private val mfCubeFaces = listOf(
    listOf(4, 5, 6, 7), listOf(0, 3, 2, 1), listOf(1, 2, 6, 5),
    listOf(0, 4, 7, 3), listOf(3, 7, 6, 2), listOf(0, 1, 5, 4),
)

private fun mfSplitSegments(points: List<MfPt>, front: List<Boolean>): List<MfPoly> {
    val polys = ArrayList<MfPoly>()
    var start = 0
    for (index in 1..front.size) {
        if (index == front.size || front[index] != front[start]) {
            val pts = points.subList(start, Math.min(points.size, index + 1))
            if (pts.size >= 2) polys.add(MfPoly(pts, dashed = !front[start]))
            start = index
        }
    }
    return polys
}

private fun mfDepthCurves(cam: List<MfV3>): List<MfPoly> {
    val flags = (1 until cam.size).map { (cam[it - 1].z + cam[it].z) * 0.5 > 0.012 }
    return mfSplitSegments(cam.map(::mfScreen), flags)
}

private fun mfNormalCurves(cam: List<MfV3>, normals: List<MfV3>, yaw: Double, pitch: Double): List<MfPoly> {
    val turned = normals.map { mfRotate(it, yaw, pitch) }
    val flags = (1 until turned.size).map { (turned[it - 1].z + turned[it].z) * 0.5 > 0.012 }
    return mfSplitSegments(cam.map(::mfScreen), flags)
}

private fun mfSpherePoint(lat: Double, lon: Double): MfV3 {
    val cosLat = StrictMath.cos(lat)
    return MfV3(cosLat * StrictMath.cos(lon), StrictMath.sin(lat), cosLat * StrictMath.sin(lon))
}

private class MfRow(val pts: List<MfV3>, val dashed: Boolean = false)

private fun mfProjectLines(rows: List<MfRow>, yaw: Double, pitch: Double): List<MfPoly> =
    rows.map { row -> MfPoly(row.pts.map { mfScreen(mfRotate(it, yaw, pitch)) }, dashed = row.dashed) }

private fun mfAxisArrow(from: MfV3, to: MfV3): List<List<MfV3>> {
    val dir = mfNormalize(mfSub(to, from))
    val helper = if (Math.abs(dir.y) < 0.9) MfV3(0.0, 1.0, 0.0) else MfV3(1.0, 0.0, 0.0)
    val side = mfNormalize(mfCross(dir, helper))
    val up = mfCross(side, dir)
    val back = mfAdd(to, mfScale(dir, -0.2))
    return listOf(
        listOf(from, to),
        listOf(to, mfAdd(back, mfScale(side, 0.08))),
        listOf(to, mfAdd(back, mfScale(side, -0.08))),
        listOf(to, mfAdd(back, mfScale(up, 0.08))),
    )
}

private fun mfPlaneOf(id: String, p: Map<String, Double>): List<MfPoly> {
    fun v(key: String) = p.getValue(key)
    val pi = Math.PI
    return when (id) {
        "circle" -> listOf(mfLoop(mfCirclePts(0.0, 0.0, 1.0)))
        "ellipse" -> listOf(mfLoop(mfCirclePts(0.0, 0.0, 1.0, v("aspect"))))
        "semicircle" -> listOf(mfLoop(mfCirclePts(0.0, 0.0, 1.0, 1.0, pi, pi * 2) + mfPt(-1.0, 0.0)))
        "ring" -> listOf(mfLoop(mfCirclePts(0.0, 0.0, 1.0)), mfLoop(mfCirclePts(0.0, 0.0, v("inner"))))
        "sector" -> {
            val span = v("degrees") * pi / 180
            val arc = mfCirclePts(0.0, 0.0, 1.0, 1.0, -pi / 2 - span / 2, -pi / 2 + span / 2)
            listOf(mfLoop(listOf(mfPt(0.0, 0.0)) + arc))
        }
        "arc" -> {
            val span = v("degrees") * pi / 180
            listOf(mfLine(mfCirclePts(0.0, 0.0, 1.0, 1.0, -pi / 2 - span / 2, -pi / 2 + span / 2)))
        }
        "triangle" -> listOf(mfLoop(listOf(mfPt(0.0, -0.95), mfPt(0.9, 0.75), mfPt(-0.9, 0.75))))
        "right-triangle" -> listOf(
            mfLoop(listOf(mfPt(-1.0, 0.8), mfPt(1.0, 0.8), mfPt(-1.0, -0.9))),
            mfLine(listOf(mfPt(-0.62, 0.8), mfPt(-0.62, 0.42), mfPt(-1.0, 0.42))),
        )
        "square" -> listOf(mfLoop(listOf(mfPt(-0.85, -0.85), mfPt(0.85, -0.85), mfPt(0.85, 0.85), mfPt(-0.85, 0.85))))
        "rectangle" -> {
            val a = v("aspect")
            listOf(mfLoop(listOf(mfPt(-1.0, -a), mfPt(1.0, -a), mfPt(1.0, a), mfPt(-1.0, a))))
        }
        "rhombus" -> listOf(mfLoop(listOf(mfPt(0.0, -1.0), mfPt(0.72, 0.0), mfPt(0.0, 1.0), mfPt(-0.72, 0.0))))
        "parallelogram" -> {
            val s = v("skew")
            listOf(mfLoop(listOf(mfPt(-0.85 + s, -0.7), mfPt(0.95 + s, -0.7), mfPt(0.85 - s, 0.7), mfPt(-0.95 - s, 0.7))))
        }
        "trapezoid" -> {
            val t = v("top")
            listOf(mfLoop(listOf(mfPt(-1.0, 0.7), mfPt(1.0, 0.7), mfPt(t, -0.7), mfPt(-t, -0.7))))
        }
        "kite" -> listOf(mfLoop(listOf(mfPt(0.0, -1.0), mfPt(0.62, 0.15), mfPt(0.0, 0.75), mfPt(-0.62, 0.15))))
        "polygon" -> {
            val sides = Math.max(3.0, mfRound(v("sides"))).toInt()
            val pts = (0..sides).map { index ->
                val angle = -pi / 2 + (index.toDouble() / sides) * pi * 2
                mfPt(StrictMath.cos(angle), StrictMath.sin(angle))
            }
            listOf(mfLoop(pts))
        }
        "star" -> {
            val count = mfRound(v("points")).toInt()
            val pts = (0..count * 2).map { index ->
                val radius = if (index % 2 == 0) 1.0 else 0.42
                val angle = -pi / 2 + (index.toDouble() / (count * 2)) * pi * 2
                mfPt(StrictMath.cos(angle) * radius, StrictMath.sin(angle) * radius)
            }
            listOf(mfLoop(pts))
        }
        "arrow" -> listOf(mfLine(listOf(mfPt(-1.0, 0.0), mfPt(0.45, 0.0)))) +
            mfArrowHead(mfPt(1.0, 0.0), mfPt(1.0, 0.0), 0.55).map { mfLine(it) } +
            listOf(mfLine(listOf(mfPt(0.45, -0.32), mfPt(1.0, 0.0), mfPt(0.45, 0.32))))
        "double-arrow" -> listOf(
            mfLine(listOf(mfPt(-0.55, 0.0), mfPt(0.55, 0.0))),
            mfLine(listOf(mfPt(-0.45, -0.28), mfPt(-1.0, 0.0), mfPt(-0.45, 0.28))),
            mfLine(listOf(mfPt(0.45, -0.28), mfPt(1.0, 0.0), mfPt(0.45, 0.28))),
        )
        "angle" -> {
            val turn = v("degrees") * pi / 180
            listOf(
                mfLine(listOf(mfPt(0.0, 0.0), mfPt(1.15, 0.0))),
                mfLine(listOf(mfPt(0.0, 0.0), mfPt(StrictMath.cos(-turn) * 1.15, StrictMath.sin(-turn) * 1.15))),
                mfLine(mfCirclePts(0.0, 0.0, 0.42, 0.42, -turn, 0.0, 24.0)),
            )
        }
        "axes" -> {
            val polys = ArrayList<MfPoly>()
            polys.add(mfLine(listOf(mfPt(-1.15, 0.0), mfPt(1.05, 0.0))))
            polys.add(mfLine(listOf(mfPt(0.0, 1.05), mfPt(0.0, -1.15))))
            mfArrowHead(mfPt(1.2, 0.0), mfPt(1.0, 0.0)).forEach { polys.add(mfLine(it)) }
            mfArrowHead(mfPt(0.0, -1.2), mfPt(0.0, -1.0)).forEach { polys.add(mfLine(it)) }
            val ticks = mfRound(v("ticks")).toInt()
            for (index in 1..ticks) {
                val t = index.toDouble() / (ticks + 1)
                polys.add(mfLine(listOf(mfPt(-1 + t * 2, -0.06), mfPt(-1 + t * 2, 0.06))))
                polys.add(mfLine(listOf(mfPt(-0.06, 0.9 - t * 1.8), mfPt(0.06, 0.9 - t * 1.8))))
            }
            polys
        }
        "number-line" -> {
            val ticks = mfRound(v("ticks")).toInt()
            val polys = ArrayList<MfPoly>()
            polys.add(mfLine(listOf(mfPt(-1.2, 0.0), mfPt(1.05, 0.0))))
            mfArrowHead(mfPt(1.25, 0.0), mfPt(1.0, 0.0)).forEach { polys.add(mfLine(it)) }
            for (index in 0..ticks) {
                val x = -1 + (index.toDouble() / ticks) * 2
                polys.add(mfLine(listOf(mfPt(x, -0.12), mfPt(x, 0.12))))
            }
            polys
        }
        "parabola" -> listOf(mfLine(mfSamples(32) { t ->
            val x = -1 + t * 2
            mfPt(x, -x * x)
        }))
        "sine" -> listOf(
            mfLine(listOf(mfPt(-1.05, 0.0), mfPt(1.05, 0.0))),
            mfLine(mfSamples(72) { t ->
                mfPt(-1 + t * 2, -StrictMath.sin(t * v("waves") * pi * 2) * v("amplitude"))
            }),
        )
        "grid" -> {
            val cells = mfRound(v("cells")).toInt()
            val polys = ArrayList<MfPoly>()
            for (index in 0..cells) {
                val t = -1 + (index.toDouble() / cells) * 2
                polys.add(mfLine(listOf(mfPt(t, -1.0), mfPt(t, 1.0))))
                polys.add(mfLine(listOf(mfPt(-1.0, t), mfPt(1.0, t))))
            }
            polys
        }
        "venn" -> listOf(mfLoop(mfCirclePts(-0.48, 0.0, 0.82)), mfLoop(mfCirclePts(0.48, 0.0, 0.82)))
        "parallel" -> listOf(
            mfLine(listOf(mfPt(-1.2, -0.42), mfPt(1.2, -0.42))),
            mfLine(listOf(mfPt(-1.2, 0.42), mfPt(1.2, 0.42))),
            mfLine(listOf(mfPt(-0.55, 1.05), mfPt(0.4, -1.05))),
        )
        "chord" -> listOf(
            mfLoop(mfCirclePts(0.0, 0.0, 1.0)),
            mfLine(listOf(mfPt(StrictMath.cos(2.4), StrictMath.sin(2.4)), mfPt(StrictMath.cos(0.7), StrictMath.sin(0.7)))),
        )
        "tangent" -> listOf(
            mfLoop(mfCirclePts(0.0, 0.0, 1.0)),
            mfLine(listOf(mfPt(0.0, 0.0), mfPt(1.0, 0.0))),
            mfLine(listOf(mfPt(1.0, -1.25), mfPt(1.0, 1.25))),
        )
        "diameter" -> listOf(mfLoop(mfCirclePts(0.0, 0.0, 1.0)), mfLine(listOf(mfPt(-1.0, 0.0), mfPt(1.0, 0.0))))
        "cube-net" -> listOf(
            mfPt(1.0, 0.0),
            mfPt(0.0, 1.0), mfPt(1.0, 1.0), mfPt(2.0, 1.0), mfPt(3.0, 1.0),
            mfPt(1.0, 2.0),
        ).map { o -> mfLoop(listOf(o, mfPt(o.x + 1, o.y), mfPt(o.x + 1, o.y + 1), mfPt(o.x, o.y + 1))) }
        "cross" -> listOf(mfLoop(listOf(
            mfPt(-0.28, -1.0), mfPt(0.28, -1.0), mfPt(0.28, -0.28), mfPt(1.0, -0.28),
            mfPt(1.0, 0.28), mfPt(0.28, 0.28), mfPt(0.28, 1.0), mfPt(-0.28, 1.0),
            mfPt(-0.28, 0.28), mfPt(-1.0, 0.28), mfPt(-1.0, -0.28), mfPt(-0.28, -0.28),
        )))
        "vector" -> listOf(
            mfLine(listOf(mfPt(-1.0, 0.35), mfPt(0.55, -0.55))),
            mfLine(listOf(mfPt(0.15, -0.72), mfPt(0.85, -0.85), mfPt(0.42, -0.15))),
        )
        else -> emptyList()
    }
}

private fun mfSolidOf(id: String, p: Map<String, Double>): List<MfPoly> {
    fun v(key: String) = p.getValue(key)
    val yaw = p["yaw"] ?: 35.0
    val pitch = p["pitch"] ?: 24.0
    val pi = Math.PI
    return when (id) {
        "cube" -> mfWire(mfCubeVerts, mfCubeFaces, yaw, pitch)
        "cuboid" -> mfWire(
            mfCubeVerts.map { MfV3(it.x * v("width"), it.y * v("height"), it.z * v("depth")) },
            mfCubeFaces, yaw, pitch,
        )
        "tetrahedron" -> mfWire(mfTetra.verts, mfTetra.faces, yaw, pitch)
        "octahedron" -> mfWire(mfOcta.verts, mfOcta.faces, yaw, pitch)
        "icosahedron" -> mfWire(mfIcosa.verts, mfIcosa.faces, yaw, pitch)
        "dodecahedron" -> mfWire(mfDodeca.verts, mfDodeca.faces, yaw, pitch)
        "square-pyramid" -> mfPyramid(4, yaw, pitch)
        "pentagonal-pyramid" -> mfPyramid(5, yaw, pitch)
        "hexagonal-pyramid" -> mfPyramid(6, yaw, pitch)
        "triangular-prism" -> mfPrism(3).let { mfWire(it.verts, it.faces, yaw, pitch) }
        "pentagonal-prism" -> mfPrism(5).let { mfWire(it.verts, it.faces, yaw, pitch) }
        "hexagonal-prism" -> mfPrism(6).let { mfWire(it.verts, it.faces, yaw, pitch) }
        "cylinder" -> mfPrism(mfRound(v("segments")).toInt()).let { mfWire(it.verts, it.faces, yaw, pitch) }
        "cone" -> mfPyramid(mfRound(v("segments")).toInt(), yaw, pitch)
        "frustum" -> mfPrism(mfRound(v("segments")).toInt(), v("ratio")).let { mfWire(it.verts, it.faces, yaw, pitch) }
        "sphere", "hemisphere" -> {
            val meridians = mfRound(v("meridians")).toInt()
            val upper = id == "hemisphere"
            val polys = ArrayList<MfPoly>()
            for (index in 0 until meridians) {
                val lon = (index.toDouble() / meridians) * pi * 2
                val steps = 28
                val cam = (0..steps).map { step ->
                    val lat = if (upper) (step.toDouble() / steps) * (pi / 2)
                    else -pi / 2 + (step.toDouble() / steps) * pi
                    mfRotate(mfSpherePoint(lat, lon), yaw, pitch)
                }
                polys.addAll(mfDepthCurves(cam))
            }
            val parallelCount = if (upper) 2 else mfRound(p["parallels"] ?: 4.0).toInt()
            for (band in 1 until parallelCount) {
                val lat = if (upper) (band.toDouble() / parallelCount) * (pi / 2)
                else -pi / 2 + (band.toDouble() / parallelCount) * pi
                val cam = (0..48).map { step ->
                    mfRotate(mfSpherePoint(lat, (step / 48.0) * pi * 2), yaw, pitch)
                }
                polys.addAll(mfDepthCurves(cam))
            }
            if (upper) {
                val equator = (0..56).map { step ->
                    mfRotate(mfSpherePoint(0.0, (step / 56.0) * pi * 2), yaw, pitch)
                }
                polys.add(MfPoly(equator.map(::mfScreen)))
            } else {
                val silhouette = (0..64).map { step ->
                    val t = (step / 64.0) * pi * 2
                    mfPt(StrictMath.cos(t), -StrictMath.sin(t))
                }
                polys.add(mfLoop(silhouette))
            }
            polys
        }
        "torus" -> {
            val rings = mfRound(v("rings")).toInt()
            val tubeSteps = 10
            val minor = v("tube")
            val polys = ArrayList<MfPoly>()
            fun at(theta: Double, phi: Double): MfV3 {
                val radius = 1.0 + minor * StrictMath.cos(phi)
                return MfV3(radius * StrictMath.cos(theta), minor * StrictMath.sin(phi), radius * StrictMath.sin(theta))
            }
            fun normalAt(theta: Double, phi: Double) = MfV3(
                StrictMath.cos(phi) * StrictMath.cos(theta),
                StrictMath.sin(phi),
                StrictMath.cos(phi) * StrictMath.sin(theta),
            )
            for (index in 0 until rings) {
                val theta = (index.toDouble() / rings) * pi * 2
                val cam = ArrayList<MfV3>()
                val normals = ArrayList<MfV3>()
                for (step in 0..tubeSteps) {
                    val phi = (step.toDouble() / tubeSteps) * pi * 2
                    cam.add(mfRotate(at(theta, phi), yaw, pitch))
                    normals.add(normalAt(theta, phi))
                }
                polys.addAll(mfNormalCurves(cam, normals, yaw, pitch))
            }
            for (step in 0 until tubeSteps) {
                val phi = (step.toDouble() / tubeSteps) * pi * 2
                val cam = ArrayList<MfV3>()
                val normals = ArrayList<MfV3>()
                for (index in 0..rings) {
                    val theta = (index.toDouble() / rings) * pi * 2
                    cam.add(mfRotate(at(theta, phi), yaw, pitch))
                    normals.add(normalAt(theta, phi))
                }
                polys.addAll(mfNormalCurves(cam, normals, yaw, pitch))
            }
            polys
        }
        "axes-3d" -> {
            val rows = ArrayList<MfRow>()
            val origin = MfV3(0.0, 0.0, 0.0)
            val tips = listOf(MfV3(1.25, 0.0, 0.0), MfV3(0.0, 1.25, 0.0), MfV3(0.0, 0.0, 1.25))
            for (tip in tips) {
                for (pts in mfAxisArrow(origin, tip)) rows.add(MfRow(pts))
                rows.add(MfRow(listOf(mfScale(tip, -0.45), origin), dashed = true))
            }
            mfProjectLines(rows, yaw, pitch)
        }
        "plane" -> {
            val cells = mfRound(v("cells")).toInt()
            val rows = ArrayList<MfRow>()
            for (index in 0..cells) {
                val t = -1 + (index.toDouble() / cells) * 2
                rows.add(MfRow(listOf(MfV3(t, 0.0, -1.0), MfV3(t, 0.0, 1.0))))
                rows.add(MfRow(listOf(MfV3(-1.0, 0.0, t), MfV3(1.0, 0.0, t))))
            }
            for (pts in mfAxisArrow(MfV3(0.0, 0.0, 0.0), MfV3(0.0, 0.85, 0.0))) rows.add(MfRow(pts))
            mfProjectLines(rows, yaw, pitch)
        }
        else -> emptyList()
    }
}

/** Builds the SVG path strings (24x24 box) for a figure, clamping [params] first. */
fun mathFigurePaths(id: String, params: Map<String, Double>?): List<String> {
    if (!isMathFigureId(id)) return emptyList()
    val values = clampFigureParams(id, params)
    val polys = if (mathFigureById(id).group == "solid") mfSolidOf(id, values) else mfPlaneOf(id, values)
    return mfEmit(polys)
}
