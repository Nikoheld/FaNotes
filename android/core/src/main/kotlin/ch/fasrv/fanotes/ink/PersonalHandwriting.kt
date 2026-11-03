package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.json.*
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.NoteStore
import ch.fasrv.fanotes.famd.noteInkId
import ch.fasrv.fanotes.famd.parseFamd
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlin.math.*

const val PERSONAL_HANDWRITING_VERSION = 2

data class WritingObservation(
    val height: Double, val slant: Double, val pressure: Double, val pressureSpread: Double,
    val nibRatio: Double, val baseline: Double, val joinRate: Double, val gap: Double,
    val wordGap: Double, val speed: Double,
)
data class JoiningMotion(val points: List<StrokePoint>, val entry: Pair<Double, Double>, val exit: Pair<Double, Double>)
data class WritingContribution(val fingerprint: String, val observations: List<WritingObservation>, val units: List<GlyphSample>, val joins: List<JoiningMotion> = emptyList())
data class PersonalHandwritingModel(val revision: Long = 0, val pages: Map<String, WritingContribution> = emptyMap(), val indexedPageCount: Int? = null, val population: WritingObservation? = null, val validation: StyleValidation? = null) {
    private fun unique() = pages.values.distinctBy { it.fingerprint }
    val pageCount get() = indexedPageCount ?: unique().count { it.observations.isNotEmpty() }
    val joins get() = unique().flatMap { it.joins }.take(128)
    val units get() = unique().flatMap { it.units }.groupBy { it.label }.values.flatMap { it.take(8) }.take(1500)
    val observations: List<WritingObservation> get() {
        val all = unique().flatMap { it.observations }
        val height = writingMedian(all.map { it.height }, 24.0)
        val sized = all.filter { it.height > height * .5 && it.height < height * 2 }
        val joined = sized.count { it.joinRate > .5 } > sized.size / 2
        val group = sized.filter { (it.joinRate > .5) == joined }
        val slant = writingMedian(group.map { it.slant })
        val dominant = group.filter { abs(it.slant - slant) < .2 }
        val stride = max(1, ceil(dominant.size / 2048.0).toInt())
        val empirical = dominant.filterIndexed { index, _ -> index % stride == 0 }
        val center = summarizeWritingObservations(empirical)
        return if (population != null && center != null) empirical.map { adjustWritingObservation(it, center, population) } else empirical
    }
}
data class StyleValidation(val holdoutPages: Int, val previousError: Double?, val candidateError: Double?, val accepted: Boolean)
private fun WritingObservation.values() = listOf(height, slant, pressure, pressureSpread, nibRatio, baseline, joinRate, gap, wordGap, speed)
private fun observation(values: List<Double>) = WritingObservation(values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7], values[8], values[9])
private fun summarizeWritingObservations(observations: List<WritingObservation>): WritingObservation? = if (observations.isEmpty()) null else observation((0 until 10).map { k -> writingMedian(observations.map { it.values()[k] }) })
private fun adjustWritingObservation(value: WritingObservation, center: WritingObservation, population: WritingObservation): WritingObservation {
    val a = value.values(); val b = center.values(); val c = population.values()
    return observation(a.indices.map { k -> if (k == 0) a[k] * c[k] / max(1.0, b[k]) else a[k] + c[k] - b[k] })
}
/** Geometry reconstruction on held-out pages; this is not a text-accuracy score. */
internal fun fitWritingPopulation(records: List<Pair<String, WritingObservation>>, previous: WritingObservation?): Pair<WritingObservation?, StyleValidation?> {
    val unique = records.distinctBy { it.first }
    val joined = unique.count { it.second.joinRate > .5 } > unique.size / 2
    val dominant = unique.filter { (it.second.joinRate > .5) == joined }
    if (dominant.isEmpty()) return null to null
    val holdout = dominant.filter { (it.first.take(2).toIntOrNull(16) ?: 1) % 5 == 0 }
    val enough = holdout.size >= 2 && dominant.size - holdout.size >= 5
    val train = if (enough) dominant.filter { it !in holdout } else dominant
    val candidate = summarizeWritingObservations(train.map { it.second })!!
    val scales = listOf(24.0, .15, .3, .1, .1, .1, 1.0, .1, .5, .5)
    fun error(center: WritingObservation): Double = holdout.sumOf { (_, o) -> o.values().indices.sumOf { i -> abs(o.values()[i] - center.values()[i]) / scales[i] } } / max(1, holdout.size * 10)
    val before = if (enough && previous != null) error(previous) else null
    val after = if (enough) error(candidate) else null
    val accepted = before == null || after!! <= before + 1e-9
    return (if (accepted) candidate else previous) to StyleValidation(if (enough) holdout.size else 0, before, after, accepted)
}
internal fun writingMedian(xs: List<Double>, fallback: Double = 0.0): Double {
    val value = if (xs.isEmpty()) fallback else xs.sorted()[xs.size / 2]
    return if (value == 0.0) 0.0 else value
}
internal fun writingHash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
private data class WritingBox(val x: Double, val y: Double, val width: Double, val height: Double) {
    val right get() = x + width
    val bottom get() = y + height
}
private fun box(strokes: List<InkStroke>): WritingBox {
    var x = Double.POSITIVE_INFINITY; var y = x; var r = -x; var b = -x
    for (s in strokes) for (p in s.points) { x = min(x, p.x); y = min(y, p.y); r = max(r, p.x); b = max(b, p.y) }
    return WritingBox(x, y, r - x, b - y)
}
private fun pathLength(ps: List<StrokePoint>) = ps.zipWithNext().sumOf { (a, b) -> hypot(b.x - a.x, b.y - a.y) }
private fun human(s: InkStroke) = s.extras["synthesis"] == null && s.symbolId == null && s.figurePaths.isEmpty() && s.purpose != "art" &&
    (s.brush == null || s.brush in setOf("fineliner", "pencil", "ballpoint", "fountain")) && s.points.size in 2..20000 &&
    s.points.all { p -> listOf(p.x, p.y, p.t, p.pressure).all { it.isFinite() } && p.x in 0.0..1.0 && p.y in 0.0..1.0 }
private data class WritingWord(val strokes: List<InkStroke>, val box: WritingBox, val baseline: Double, val nextGap: Double?)
private data class WritingItem(val stroke: InkStroke, val box: WritingBox)
private class WritingLine(var cy: Double, var height: Double, val items: MutableList<WritingItem> = mutableListOf())
private fun extract(document: InkDocument): List<WritingWord> {
    val w = document.sourceWidth; val h = document.sourceHeight
    if (!w.isFinite() || !h.isFinite() || w <= 0 || h <= 0) return emptyList()
    val all = document.strokes.filter(::human).take(20000).map { s ->
        val step = max(1, ceil(s.points.size / 2048.0).toInt())
        val ps = s.points.filterIndexed { i, _ -> i % step == 0 || i == s.points.lastIndex }.map { it.copy(x = it.x * w, y = it.y * h) }
        val stroke = s.copy(points = ps)
        WritingItem(stroke, box(listOf(stroke)))
    }.filter { (_, b) -> b.height in 1.0..180.0 && b.width <= 1400 }
        .filter { (s, b) -> pathLength(s.points) > 3 && pathLength(s.points) < max(60.0, hypot(b.width, b.height) * 35) }
    val body = all.filter { it.box.height >= 6 && it.box.width / it.box.height < 25 }
    val typical = writingMedian(body.map { it.box.height }, 24.0)
    val lines = mutableListOf<WritingLine>()
    for (item in body.sortedBy { it.box.y }) {
        val cy = item.box.y + item.box.height / 2
        val line = lines.find { abs(it.cy - cy) < max(typical * .6, min(item.box.height, it.height) * .65) }
            ?: WritingLine(cy, item.box.height).also { lines += it }
        line.items += item
        line.cy = writingMedian(line.items.map { it.box.y + it.box.height / 2 })
        line.height = writingMedian(line.items.map { it.box.height })
    }
    for (item in all.filter { it !in body }) {
        val line = lines.filter { item.box.y > it.cy - typical * 1.4 && item.box.y < it.cy + typical * .8 }.minByOrNull { abs(it.cy - item.box.y) }
        if (line != null && item.box.width < typical * 1.2) line.items += item
    }
    val words = mutableListOf<WritingWord>()
    for (line in lines) {
        val sorted = line.items.sortedBy { it.box.x }
        val gaps = mutableListOf<Double>(); var edge = Double.NEGATIVE_INFINITY
        for (item in sorted) {
            val gap = item.box.x - edge
            if (gap.isFinite() && gap > typical * .025) gaps += gap
            edge = max(edge, item.box.right)
        }
        gaps.sort()
        var wordGap = typical * (if (sorted.count { it.box.width > typical * 1.7 } >= sorted.size / 2.0) .35 else .65)
        var bestRatio = 2.0
        for (i in 1 until gaps.size) {
            val ratio = gaps[i] / gaps[i - 1]
            if (gaps[i] >= typical * .18 && ratio > bestRatio) { bestRatio = ratio; wordGap = sqrt(gaps[i] * gaps[i - 1]) }
        }
        wordGap = wordGap.coerceIn(typical * .18, typical * .65)
        val groups = mutableListOf<MutableList<WritingItem>>()
        var right = Double.NEGATIVE_INFINITY
        for (item in sorted) {
            if (groups.isEmpty() || item.box.x - right > wordGap) { groups += mutableListOf<WritingItem>(); right = Double.NEGATIVE_INFINITY }
            groups.last() += item; right = max(right, item.box.right)
        }
        val baseline = writingMedian(groups.map { group -> group.maxOf { it.box.bottom } })
        for ((i, group) in groups.withIndex()) {
            val strokes = group.map { it.stroke }.sortedBy { it.points.first().t }
            val b = box(strokes)
            if (strokes.size == 1 && b.width < b.height * 1.7) continue
            if (strokes.size == 1 && pathLength(strokes[0].points) < hypot(b.width, b.height) * 1.15) continue
            if (b.height < 6 || b.height > typical * 2.8 || b.width < 3 || b.width / b.height > 25 || strokes.size > 64) continue
            val next = groups.getOrNull(i + 1)?.firstOrNull()
            words += WritingWord(strokes, b, baseline, next?.let { max(0.0, it.box.x - b.right) / typical })
        }
    }
    return words
}
private fun observe(word: WritingWord): WritingObservation {
    val ps = word.strokes.flatMap { it.points }; val slopes = mutableListOf<Double>(); val speeds = mutableListOf<Double>()
    for (stroke in word.strokes) for ((a, p) in stroke.points.zipWithNext()) {
        val dx = p.x - a.x; val dy = p.y - a.y; val dt = p.t - a.t
        if (abs(dy) > 2 * abs(dx) && abs(dy) > .4) slopes += -dx / dy
        if (dt > 0 && dt < 100) speeds += hypot(dx, dy) / dt
    }
    val pressure = writingMedian(ps.map { it.pressure }, .5)
    val sorted = word.strokes.map { box(listOf(it)) }.sortedBy { it.x }
    val gaps = sorted.zipWithNext().map { (a, b) -> (b.x - a.right) / word.box.height }.filter { it >= 0 && it < .65 }
    val connected = word.strokes.any { s -> box(listOf(s)).width > word.box.height * 1.7 && pathLength(s.points) > word.box.height * 3 }
    return WritingObservation(word.box.height, writingMedian(slopes).coerceIn(-.45, .45), pressure.coerceIn(.08, 1.0),
        writingMedian(ps.map { abs(it.pressure - pressure) }).coerceIn(0.0, .3),
        (writingMedian(word.strokes.map { it.baseWidth }) / word.box.height).coerceIn(.01, .25),
        ((word.box.bottom - word.baseline) / word.box.height).coerceIn(-.15, .15),
        if (connected) .85 else .1, writingMedian(gaps, .1).coerceIn(.015, .3),
        (word.nextGap ?: .42).coerceIn(.25, 1.2), writingMedian(speeds, .3).coerceIn(.05, 2.0))
}
private fun resample(ps: List<StrokePoint>, count: Int = 24): List<Pair<Double, Double>> {
    if (ps.size == 1) return List(count) { ps[0].x to ps[0].y }
    val cumulative = mutableListOf(0.0)
    for ((a, b) in ps.zipWithNext()) cumulative += cumulative.last() + hypot(b.x - a.x, b.y - a.y)
    var j = 1
    return List(count) { i ->
        val target = cumulative.last() * i / (count - 1)
        while (j < ps.lastIndex && cumulative[j] < target) j++
        val t = (target - cumulative[j - 1]) / max(1e-9, cumulative[j] - cumulative[j - 1])
        (ps[j - 1].x + (ps[j].x - ps[j - 1].x) * t) to (ps[j - 1].y + (ps[j].y - ps[j - 1].y) * t)
    }
}
private fun signature(strokes: List<InkStroke>): List<List<Pair<Double, Double>>>? {
    val b = box(strokes)
    if (b.width <= 0 || b.height <= 0) return null
    return strokes.map { s -> resample(s.points.map { it.copy(x = (it.x - b.x) / b.width, y = (it.y - b.y) / b.height) }) }
}
private data class WritingHit(val label: String, val strokes: List<InkStroke>)
private fun recognize(word: WritingWord, templates: List<GlyphSample>): List<WritingHit>? {
    val clusters = mutableListOf<MutableList<InkStroke>>(); var right = Double.NEGATIVE_INFINITY
    for (item in word.strokes.map { WritingItem(it, box(listOf(it))) }.sortedBy { it.box.x }) {
        if (clusters.isEmpty() || item.box.x > right + word.box.height * .035) clusters += mutableListOf<InkStroke>()
        clusters.last() += item.stroke; right = max(right, item.box.right)
    }
    val trusted = templates.filter { it.label.codePointCount(0, it.label.length) == 1 && !it.sessionId.contains("context") && !it.sessionId.contains("auto-page") }
    val hits = mutableListOf<WritingHit>()
    for (cluster in clusters) {
        cluster.sortBy { it.points.first().t }
        val sig = signature(cluster) ?: return null
        val scores = mutableMapOf<String, Double>()
        for (sample in trusted) {
            if (sample.strokes.size != cluster.size) continue
            val target = signature(sample.strokes.map { InkStroke(it.points, it.baseWidth, it.pressureEnabled, "") }) ?: continue
            var error = 0.0
            for (j in sig.indices) for (i in 0 until 24) error += (sig[j][i].first - target[j][i].first).pow(2) + (sig[j][i].second - target[j][i].second).pow(2)
            val distance = sqrt(error / (sig.size * 24))
            scores[sample.label] = min(scores[sample.label] ?: Double.POSITIVE_INFINITY, distance)
        }
        val ranked = scores.entries.sortedBy { it.value }
        if (ranked.isEmpty() || ranked[0].value > .035 || (ranked.getOrNull(1)?.value ?: 0.0) - ranked[0].value < .025) return null
        hits += WritingHit(ranked[0].key, cluster)
    }
    return hits.ifEmpty { null }
}
/** Unlabeled joining motions retain natural curvature without assigning letter labels. */
private fun joiningMotions(word: WritingWord): List<JoiningMotion> {
    val h = word.box.height; val motions = mutableListOf<JoiningMotion>()
    fun full(ps: List<StrokePoint>, count: Int): List<StrokePoint> = resample(ps, count).mapIndexed { i, xy ->
        ps[(i.toDouble() * (ps.size - 1) / (count - 1)).roundToInt().coerceIn(ps.indices)].copy(x = xy.first, y = xy.second)
    }
    for (stroke in word.strokes) {
        val ps = full(stroke.points, min(256, max(24, ceil(pathLength(stroke.points) / (h * .035)).toInt())))
        var i = 0
        while (i + 5 < ps.size && motions.size < 12) {
            val a = ps[i]
            if (a.y < word.box.y + h * .52) { i += 3; continue }
            var j = i + 1
            while (j < min(ps.size, i + 18) && ps[j].x >= ps[j - 1].x - h * .008 && ps[j].x - a.x < h * .7) j++
            j--
            val b = ps[j]; val distance = hypot(b.x - a.x, b.y - a.y)
            if (j - i < 4 || b.x - a.x < h * .16 || abs(b.y - a.y) > h * .4 || distance > h * .8) { i += 3; continue }
            val points = full(ps.subList(i, j + 1), 17).map { it.copy(x = (it.x - a.x) / h, y = (it.y - a.y) / h, t = it.t - a.t) }
            val entry = points[1].x to points[1].y
            val exit = (points.last().x - points[15].x) to (points.last().y - points[15].y)
            if (hypot(entry.first, entry.second) >= 1e-6 && hypot(exit.first, exit.second) >= 1e-6) motions += JoiningMotion(points, entry, exit)
            i = j + 2
        }
    }
    return motions
}
fun learnWritingPage(document: InkDocument, templates: List<GlyphSample> = schoolScript()): WritingContribution {
    val words = extract(document); val observations = mutableListOf<WritingObservation>(); val units = mutableListOf<GlyphSample>(); val joins = mutableListOf<JoiningMotion>()
    val stride = max(1, ceil(words.size / 48.0).toInt())
    for (i in words.indices step stride) {
        val word = words[i]; observations += observe(word)
        joins += joiningMotions(word).take(max(0, 32 - joins.size))
        val hits = recognize(word, templates) ?: continue
        val label = hits.joinToString("") { it.label }
        if (label.length > 48 || !Regex("^[\\p{L}\\p{N}.,!?;:'\"()\\-+%=]+$").matches(label)) continue
        val wordId = writingHash(word.strokes.joinToString { it.toJson().stringify() })
        for (start in hits.indices) for (count in listOf(1, 2, 3, hits.size).distinct()) {
            if (start + count > hits.size || (count == hits.size && start > 0) || units.size >= 96) continue
            val part = hits.subList(start, start + count); val text = part.joinToString("") { it.label }
            val strokes = part.flatMap { it.strokes }.sortedBy { it.points.first().t }; val b = box(strokes)
            units += GlyphSample("$wordId-$start-$count", text, text, "auto-page-v2", listOf(0.0, 0.0, 1.0, 1.0), b.width / b.height, 1.0,
                strokes.map { s -> GlyphInk(s.points.map { p -> p.copy(x = (p.x - b.x) / b.width, y = (p.y - b.y) / b.height) }, s.baseWidth / b.height, s.pressureEnabled) },
                baseline = (word.baseline - b.y) / b.height,
                context = "${hits.getOrNull(start - 1)?.label ?: "^"}|${hits.getOrNull(start + count)?.label ?: "$"}")
        }
    }
    val identity = document.strokes.filter(::human).joinToString { it.toJson().stringify() }
    val boundedUnits = units.filter { (it.baseline ?: 0.0) in -.5..2.0 && it.strokes.sumOf { s -> s.points.size } <= 768 }.sortedWith(compareBy<GlyphSample> { if (it.context == "^|$" && it.label.length > 1) 0 else min(it.label.length, 4) }.thenBy { it.id }).take(16)
    return WritingContribution(writingHash(identity), observations, boundedUnits, joins)
}
fun updateWritingPage(model: PersonalHandwritingModel, id: String, contribution: WritingContribution?): PersonalHandwritingModel {
    if (contribution != null && model.pages[id]?.fingerprint == contribution.fingerprint) return model
    val pages = model.pages.toMutableMap()
    if (contribution == null || (contribution.observations.isEmpty() && contribution.units.isEmpty())) pages.remove(id) else pages[id] = contribution
    return PersonalHandwritingModel(model.revision + 1, pages)
}
private val observationKeys = listOf("height", "slant", "pressure", "pressureSpread", "nibRatio", "baseline", "joinRate", "gap", "wordGap", "speed")
private fun WritingContribution.toJson(): JsonValue.Obj = jsonObject(
    "fingerprint" to jsonString(fingerprint),
    "observations" to jsonArray(*observations.map { o -> jsonArray(*listOf(o.height, o.slant, o.pressure, o.pressureSpread, o.nibRatio, o.baseline, o.joinRate, o.gap, o.wordGap, o.speed).map { jsonNumber(it) }.toTypedArray()) }.toTypedArray()),
    "units" to parseJson(encodeGlyphLibrary(units)),
    "joins" to jsonArray(*joins.map { j -> jsonObject("points" to jsonArray(*j.points.map { it.toJson() }.toTypedArray()),
        "entry" to jsonArray(jsonNumber(j.entry.first), jsonNumber(j.entry.second)),
        "exit" to jsonArray(jsonNumber(j.exit.first), jsonNumber(j.exit.second))) }.toTypedArray()),
)
private fun contributionFromJson(obj: JsonValue.Obj): WritingContribution {
    val observations = obj.array("observations")?.items.orEmpty().map { item ->
        val v = (item as? JsonValue.Arr)?.items?.map { (it as JsonValue.Num).value } ?: error("Invalid style observation")
        require(v.size == observationKeys.size && v.all { it.isFinite() })
        WritingObservation(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9])
    }
    require(observations.size <= 48)
    val units = decodeGlyphLibrary(obj.obj("units")?.stringify().orEmpty()); require(units.size <= 96)
    val joins = obj.array("joins")?.items.orEmpty().map { raw ->
        val entry = raw as JsonValue.Obj
        val points = parseStroke(entry)?.points ?: error("Invalid joining motion")
        require(points.size == 17 && points.all { listOf(it.x, it.y, it.t, it.pressure).all(Double::isFinite) })
        fun pair(name: String): Pair<Double, Double> {
            val values = entry.array(name)?.items?.map { (it as JsonValue.Num).value } ?: error("Invalid join tangent")
            require(values.size == 2 && values.all(Double::isFinite))
            return values[0] to values[1]
        }
        JoiningMotion(points, pair("entry"), pair("exit"))
    }
    require(joins.size <= 32)
    return WritingContribution(obj.string("fingerprint") ?: error("Missing fingerprint"), observations, units, joins)
}
fun encodePersonalHandwriting(model: PersonalHandwritingModel): String = jsonObject("version" to jsonNumber(2.0), "revision" to jsonNumber(model.revision.toDouble()), "population" to model.population?.let { o -> jsonArray(*o.values().map { jsonNumber(it) }.toTypedArray()) }, "indexedPageCount" to model.indexedPageCount?.let { jsonNumber(it.toDouble()) },
    "pages" to JsonValue.Obj(linkedMapOf<String, JsonValue>().also { out -> model.pages.forEach { (k, v) -> out[k] = v.toJson() } })).stringify()
fun decodePersonalHandwriting(text: String): PersonalHandwritingModel {
    val obj = parseJson(text) as JsonValue.Obj
    require(obj.double("version") == 2.0)
    return PersonalHandwritingModel(obj.double("revision")?.toLong() ?: 0, obj.obj("pages")?.fields.orEmpty().mapValues { contributionFromJson(it.value as JsonValue.Obj) }, obj.double("indexedPageCount")?.toInt(), obj.array("population")?.items?.map { (it as JsonValue.Num).value }?.also { require(it.size == 10 && it.all(Double::isFinite)) }?.let(::observation))
}

/** App-private, per-vault, page checkpoints. The caller owns the single-writer mutex. */
class WritingLearningStore(private val directory: File) {
    init { directory.mkdirs() }
    private fun atomic(file: File, text: String) {
        if (file.isFile && file.readText() == text) return
        val tmp = File(file.path + ".tmp")
        FileOutputStream(tmp).use { it.write(text.toByteArray()); it.fd.sync() }
        try { Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
        catch (_: java.nio.file.AtomicMoveNotSupportedException) { Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING) }
    }
    private data class Header(val id: String, val stamp: String, val fingerprint: String, val observations: Int, val summary: WritingObservation?)
    private var headers: MutableMap<String, Header>? = null
    private var current = PersonalHandwritingModel()
    var failedPages: Set<String> = emptySet()
        private set
    private fun checkpoint(id: String) = File(directory, writingHash(id) + ".json")
    private fun choose(): PersonalHandwritingModel {
        val unique = headers!!.values.filter { it.observations > 0 }.sortedBy { it.fingerprint }.distinctBy { it.fingerprint }
        val pages = linkedMapOf<String, WritingContribution>()
        for (header in unique.take(48)) {
            val cached = current.pages[header.id]?.takeIf { it.fingerprint == header.fingerprint }
            val contribution = cached ?: runCatching {
                val obj = parseJson(checkpoint(header.id).readText()) as JsonValue.Obj
                contributionFromJson(obj.obj("contribution") ?: error("Missing contribution"))
            }.getOrNull()
            if (contribution != null) pages[header.id] = contribution
        }
        val fit = fitWritingPopulation(headers!!.values.mapNotNull { h -> h.summary?.let { h.fingerprint to it } }, current.population)
        current = current.copy(pages = pages, indexedPageCount = unique.size, population = fit.first, validation = fit.second)
        return current
    }
    fun load(): PersonalHandwritingModel {
        if (headers != null) return current
        headers = linkedMapOf()
        runCatching { current = decodePersonalHandwriting(File(directory, "aggregate.json").readText()) }
        directory.listFiles()?.filter { it.extension == "json" && it.nameWithoutExtension.length == 64 }?.forEach { file ->
            runCatching {
                require(file.length() <= 8 * 1024 * 1024)
                val obj = parseJson(file.readText()) as JsonValue.Obj
                require(obj.double("version") == 2.0)
                val id = obj.string("id") ?: error("Missing page id")
                val contribution = contributionFromJson(obj.obj("contribution") ?: error("Missing contribution"))
                headers!![id] = Header(id, obj.string("stamp").orEmpty(), contribution.fingerprint, contribution.observations.size, summarizeWritingObservations(contribution.observations))
                current = current.copy(revision = current.revision + 1)
            }
        }
        return choose()
    }
    fun scan(vault: VaultIo, templates: List<GlyphSample>, cancelled: () -> Boolean = { false }, onCheckpoint: (PersonalHandwritingModel) -> Unit = {}, forcePages: Set<String> = emptySet()): PersonalHandwritingModel {
        var model = load()
        failedPages = emptySet()
        var processed = 0
        val all = vault.walkFiles().filter { !it.directory && it.path.split('/').none { part -> part.startsWith('.') } }
        val companions = all.filter { it.path.endsWith(".famd", true) }.map { it.path.substringBeforeLast('.') }.toSet()
        val files = all.filter { it.path.endsWith(".famd", true) || ((it.path.endsWith(".md", true) || it.path.endsWith(".markdown", true)) && it.path.substringBeforeLast('.') !in companions) }
        val live = files.map { it.path }.toSet()
        val templateKey = writingHash("segmentation-v3:" + encodeGlyphLibrary(templates))
        for (file in files) {
            if (cancelled()) return choose()
            val checkpoint = File(directory, writingHash(file.path) + ".json")
            var stamp = "${file.mtimeMs}:${file.size}:$templateKey"
            val legacy = !file.path.endsWith(".famd", true)
            val oldNote = if (legacy) runCatching { NoteStore(vault).readNote(file.path) }.getOrNull() else null
            val asset = oldNote?.let { noteInkId(it.markdown) }?.let { ".fanotes/assets/$it.json" }
            if (asset != null) stamp += ":${vault.mtime(asset)}"
            if (headers!![file.path]?.stamp == stamp && file.path !in forcePages) continue
            if (file.size > 32 * 1024 * 1024) continue
            // A malformed or unavailable note keeps its previous contribution and is retried later.
            val document = runCatching {
                if (asset != null) {
                    val bytes = vault.read(asset) ?: error("Legacy ink is unavailable")
                    require(bytes.size <= 32 * 1024 * 1024)
                    parseInkDocument(parseJson(bytes.decodeToString()) as JsonValue.Obj, oldNote!!.title, "dots", "")
                } else if (!legacy) {
                    val bytes = vault.read(file.path) ?: error("Note is unavailable")
                    val payload = parseFamd(bytes.decodeToString()).payload ?: error("Invalid FAMD payload")
                    val ink = payload.obj("ink")
                    require(ink == null || ink.array("strokes") != null)
                    parseInkDocument(ink, "", "dots", "")
                } else oldNote?.document ?: error("Note is unavailable")
            }.getOrNull()
            if (document == null) { failedPages = failedPages + file.path; continue }
            val contribution = learnWritingPage(document, templates)
            if (cancelled()) return choose()
            atomic(checkpoint, jsonObject("version" to jsonNumber(2.0), "id" to jsonString(file.path), "stamp" to jsonString(stamp), "contribution" to contribution.toJson()).stringify())
            // Include empty checkpoints for cheap repeat scans; exclude their observations from inference.
            headers!![file.path] = Header(file.path, stamp, contribution.fingerprint, contribution.observations.size, summarizeWritingObservations(contribution.observations))
            current = current.copy(revision = current.revision + 1, pages = if (file.path in current.pages || current.pages.size < 48) current.pages + (file.path to contribution) else current.pages)
            processed++
            model = if (processed % 16 == 0) choose() else current
            onCheckpoint(model)
        }
        // Sweep only after a complete listing and scan. Cancellation cannot erase unvisited pages.
        if (!cancelled()) for (id in headers!!.keys.filter { it !in live }) {
            checkpoint(id).delete()
            headers!!.remove(id)
            current = current.copy(revision = current.revision + 1, pages = current.pages - id, population = null)
        }
        model = choose()
        if (!cancelled()) atomic(File(directory, "aggregate.json"), encodePersonalHandwriting(model.copy(pages = emptyMap())))
        onCheckpoint(model)
        return model
    }
}
