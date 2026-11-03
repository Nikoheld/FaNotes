package ch.fasrv.fanotes.ink

import java.security.SecureRandom
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.JsonValue
import java.text.Normalizer
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Local trajectory synthesis: longest learned fragments, empirical writer style,
 * and directed continuous joins. Layout stays in native page coordinates.
 */

data class GlyphInk(
    val points: List<StrokePoint>,
    val baseWidth: Double,
    val pressureEnabled: Boolean,
)

data class GlyphSample(
    val id: String,
    val label: String,
    val labelId: String,
    val sessionId: String,
    val bbox: List<Double>,
    val sourceWidth: Double,
    val sourceHeight: Double,
    val strokes: List<GlyphInk>,
    val baseline: Double? = null,
    val context: String? = null,
)

data class HandwritingSynthesisOptions(
    val fontSize: Double,
    val lineSpacing: Double,
    val variation: Double,
    val connectLetters: Boolean,
    val color: String,
    val baseWidth: Double,
    val pressureEnabled: Boolean,
    val seed: Int,
    val marginLeft: Double? = null,
    val marginRight: Double? = null,
    val marginTop: Double? = null,
    val marginBottom: Double? = null,
    val startY: Double? = null,
    val model: PersonalHandwritingModel? = null,
)

data class HandwritingPage(val width: Double, val height: Double)

data class HandwritingSynthesisResult(
    val strokes: List<InkStroke>,
    val normalizedText: String,
    val missingCharacters: List<String>,
    val overflow: Boolean,
    val overflowCharacters: Int,
    val glyphCount: Int,
    val lineCount: Int,
    val connectionCount: Int,
    val usedSampleIds: List<String>,
    val fontSizeUsed: Double,
    val bounds: List<Double>?,
    val pageWidth: Double,
    val pageHeight: Double,
)

private data class GlyphProfile(val top: Double, val bottom: Double, val widthScale: Double)

private data class GlyphPlan(
    val char: String,
    val sample: GlyphSample,
    val diacritic: String?,
    val width: Double,
    var advance: Double,
    val height: Double,
    val top: Double,
    val bottom: Double,
    val scaleY: Double,
    val slant: Double,
    val baselineJitter: Double,
    val observation: WritingObservation? = null,
)

private data class SpacePlan(val width: Double)
private data class MissingPlan(val char: String, val width: Double)

private sealed class Plan {
    data class Glyph(val plan: GlyphPlan) : Plan()
    data class Space(val plan: SpacePlan) : Plan()
    data object Newline : Plan()
    data class Missing(val plan: MissingPlan) : Plan()
}

private data class LayoutSlot(
    val plan: Plan,
    val x: Double,
    val baseline: Double,
    val line: Int,
    val bottom: Double,
)

private val UPPER = Regex("^\\p{Lu}$")
private val DIGIT = Regex("^[0-9]$")
private val ASCENDER = Regex("^[bdfhkltß]$")
private val DESCENDER = Regex("^[gjpqy]$")
private val LOWER = Regex("^\\p{Ll}$")
private val WIDE = Regex("^[MWmw]$")
private val JOINABLE = Regex("^[\\p{L}]+$")

private fun clamp(value: Double, minValue: Double, maxValue: Double) = min(maxValue, max(minValue, value))

/** JavaScript `Math.imul`: signed 32-bit multiply. */
private fun imul(left: Int, right: Int): Int = (left.toLong() * right.toLong()).toInt()

/**
 * The desktop seed generator. [seed] is treated as a uint32, matching `>>> 0`.
 */
internal fun handwritingRandom(seed: Int): () -> Double {
    var value = seed.toLong() and 0xffffffffL
    return {
        value = (value + 0x6d2b79f5L) and 0xffffffffL
        var next = value.toInt()
        next = imul(next xor (next ushr 15), next or 1)
        next = next xor (next + imul(next xor (next ushr 7), next or 61))
        ((next xor (next ushr 14)).toLong() and 0xffffffffL).toDouble() / 4_294_967_296.0
    }
}

fun createHandwritingSeed(): Int {
    val bytes = ByteArray(4)
    SecureRandom().nextBytes(bytes)
    return ((bytes[0].toLong() and 0xff) or
        ((bytes[1].toLong() and 0xff) shl 8) or
        ((bytes[2].toLong() and 0xff) shl 16) or
        ((bytes[3].toLong() and 0xff) shl 24)).toInt()
}

/** Synthesis preserves the requested characters, including German sharp-s. */
fun normalizeHandwritingText(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFC)
    .replace("\r\n", "\n")
    .replace('\r', '\n')
    .replace("\t", "    ")
    .replace('\u00a0', ' ')
    .replace("…", "...")
    .replace(Regex("[–—−]"), "-")
    .replace(Regex("[“”„«»]"), "\"")
    .replace(Regex("[‘’]"), "'")
    .take(8_000)

private fun codePoints(text: String): List<String> {
    val out = ArrayList<String>()
    var index = 0
    while (index < text.length) {
        val point = text.codePointAt(index)
        out += String(Character.toChars(point))
        index += Character.charCount(point)
    }
    return out
}

private fun isValidSample(sample: GlyphSample): Boolean {
    if (sample.strokes.isEmpty() || sample.strokes.none { it.points.isNotEmpty() }) return false
    if (sample.bbox.size != 4 || sample.bbox.any { !it.isFinite() }) return false
    if (sample.bbox[2] <= 0.0 || sample.bbox[3] <= 0.0) return false
    return sample.sourceWidth > 0.0 && sample.sourceHeight > 0.0 && (sample.sourceWidth + sample.sourceHeight).isFinite() && sample.strokes.all { s -> s.points.all { p -> p.x.isFinite() && p.y.isFinite() && p.t.isFinite() } }
}

private fun aliasesFor(char: String): Set<String> = when (char) {
    "-" -> setOf("-", "−", "operator_minus")
    "'" -> setOf("'", "’", "‘", "apostrophe")
    "\"" -> setOf("\"", "“", "”", "„", "quote")
    else -> setOf(char)
}

private val UMLAUT_BASE = mapOf("ä" to "a", "ö" to "o", "ü" to "u", "Ä" to "A", "Ö" to "O", "Ü" to "U")

private data class SampleMatch(val samples: List<GlyphSample>, val diacritic: String?)

private fun samplesForCharacter(char: String, samples: Map<String, List<GlyphSample>>): SampleMatch {
    val exact = aliasesFor(char).flatMap { samples[it].orEmpty() }.distinctBy { it.id }
    if (exact.isNotEmpty()) return SampleMatch(exact, null)
    val base = UMLAUT_BASE[char] ?: return SampleMatch(emptyList(), null)
    return SampleMatch(samples[base].orEmpty(), "umlaut")
}

private fun glyphProfile(char: String): GlyphProfile = when {
    char == "." -> GlyphProfile(.065, .01, 1.0)
    char == "," -> GlyphProfile(.07, .15, .65)
    char == ":" -> GlyphProfile(.5, .02, .2)
    char == ";" -> GlyphProfile(.5, .15, .2)
    char == "'" -> GlyphProfile(.93, -.62, .3)
    char == "\"" -> GlyphProfile(.93, -.62, .6)
    char == "-" -> GlyphProfile(.35, -.30, 3.8)
    char == "!" -> GlyphProfile(.92, .05, .35)
    char == "?" -> GlyphProfile(.92, .05, .75)
    char in setOf("(", ")", "[", "]", "{", "}") -> GlyphProfile(.92, .05, .42)
    UPPER.matches(char) -> GlyphProfile(0.92, 0.05, 1.0)
    DIGIT.matches(char) -> GlyphProfile(0.86, 0.05, 0.93)
    ASCENDER.matches(char) -> GlyphProfile(0.9, 0.05, 0.96)
    DESCENDER.matches(char) -> GlyphProfile(0.66, 0.29, 0.98)
    LOWER.matches(char) -> GlyphProfile(0.66, 0.05, 1.0)
    else -> GlyphProfile(0.56, 0.12, 0.72)
}

private fun sampleAspect(sample: GlyphSample) = clamp(
    (sample.bbox[2] * sample.sourceWidth) / (sample.bbox[3] * sample.sourceHeight),
    0.12,
    2.4,
)

private fun canJoin(char: String) = JOINABLE.matches(char)

private fun selectSample(matches: List<GlyphSample>, random: () -> Double, previousSampleId: String?): GlyphSample {
    if (matches.size == 1) return matches[0]
    val preferred = matches.filter { it.id != previousSampleId }
    val pool = preferred.ifEmpty { matches }
    val trusted = pool.filter { !it.sessionId.startsWith("context-") }
    val candidates = if (trusted.isNotEmpty() && random() < 0.82) trusted else pool
    return candidates[floor(random() * candidates.size).toInt().coerceIn(0, candidates.lastIndex)]
}

private fun createPlans(
    text: String,
    samples: List<GlyphSample>,
    options: HandwritingSynthesisOptions,
    random: () -> Double,
    availableWidth: Double,
): Pair<List<Plan>, List<String>> {
    val indexed = samples.filter { isValidSample(it) && !it.sessionId.startsWith("context-") && !it.sessionId.startsWith("fanotes-context-") }.flatMap { s -> setOf(s.label, s.labelId).map { it to s } }.groupBy({ it.first }, { it.second })
    val observations = options.model?.observations.orEmpty()
    val units = options.model?.units.orEmpty().groupBy { codePoints(it.label).firstOrNull().orEmpty() }
    val plans = ArrayList<Plan>()
    val missing = LinkedHashSet<String>()
    val variation = clamp(options.variation, 0.0, 1.0)
    val em = clamp(options.fontSize, 16.0, 96.0)
    var previousSampleId: String? = null
    val chars = codePoints(text)
    var index = 0
    var wordObservation: WritingObservation? = null
    while (index < chars.size) {
        var char = chars[index]
        val leftContext = if (index == 0 || chars[index - 1].isBlank()) "^" else chars[index - 1]
        val candidates = units[char].orEmpty().filter { textPart -> chars.subList(index, min(chars.size, index + codePoints(textPart.label).size)).joinToString("") == textPart.label && em * codePoints(textPart.label).maxOf { c -> glyphProfile(c).let { it.top + it.bottom } } * textPart.sourceWidth / textPart.sourceHeight <= availableWidth }.sortedByDescending { it.label.length }
        val longest = candidates.firstOrNull()?.label
        val contextual = candidates.filter { it.label == longest && it.context == "$leftContext|${chars.getOrNull(index + codePoints(it.label).size) ?: "$"}" }
        val pool = contextual.ifEmpty { candidates.filter { it.label == longest } }.take(8)
        val selectedUnit = pool.takeIf { it.isNotEmpty() }?.let { it[(random() * it.size).toInt().coerceAtMost(it.lastIndex)] }
        if (selectedUnit != null) { char = selectedUnit.label; index += codePoints(char).size - 1 }
        index++
        val observation = wordObservation ?: observations.takeIf { it.isNotEmpty() }?.let { it[(random() * it.size).toInt().coerceAtMost(it.lastIndex)] }
        wordObservation = observation
        when (char) {
            "\n" -> {
                plans += Plan.Newline
                previousSampleId = null
                wordObservation = null
                continue
            }
            " " -> {
                plans += Plan.Space(SpacePlan(em * (observation?.wordGap ?: .3)))
                previousSampleId = null
                wordObservation = null
                continue
            }
        }
        val match = selectedUnit?.let { SampleMatch(listOf(it), null) } ?: samplesForCharacter(char, indexed)
        if (match.samples.isEmpty()) {
            missing += char
            plans += Plan.Missing(MissingPlan(char, em * 0.56))
            previousSampleId = null
            continue
        }
        val sample = selectSample(match.samples, random, previousSampleId)
        val unitHeight = if (selectedUnit != null) codePoints(char).maxOf { glyphProfile(it).let { p -> p.top + p.bottom } } else 1.0
        val profile = selectedUnit?.baseline?.let { GlyphProfile(it * unitHeight, (1 - it) * unitHeight, 1.0) } ?: glyphProfile(char)
        val observed = observations.takeIf { it.isNotEmpty() }?.let { it[(random() * it.size).toInt().coerceAtMost(it.lastIndex)] } ?: observation
        val heightRatio = if (observation != null && observed != null) (observed.height / observation.height).coerceIn(.88, 1.12) else 1.0
        val scaleY = 1.0 + (heightRatio - 1) * variation
        val height = em * (profile.top + profile.bottom) * scaleY
        val rawWidth = height * (if (selectedUnit != null) sample.sourceWidth / sample.sourceHeight else sampleAspect(sample)) * profile.widthScale
        val width = clamp(rawWidth, em * 0.06, em * (if (selectedUnit != null) max(1.0, char.length * 1.4) else if (WIDE.matches(char)) 1.32 else 1.08))
        val plan = GlyphPlan(
            char = char,
            sample = sample,
            diacritic = match.diacritic,
            width = width,
            advance = width + em * (observation?.gap ?: .075),
            height = height,
            top = profile.top,
            bottom = profile.bottom,
            scaleY = scaleY,
            slant = if (sample.sessionId == "school-script") observation?.slant ?: 0.0 else 0.0,
            baselineJitter = (observed?.baseline ?: 0.0) * em * variation,
            observation = observation,
        )
        plans += Plan.Glyph(plan)
        previousSampleId = sample.id
    }
    if (options.connectLetters) {
        plans.forEachIndexed { index, plan ->
            val next = plans.getOrNull(index + 1)
            if (plan is Plan.Glyph && next is Plan.Glyph && canJoin(plan.plan.char) && canJoin(next.plan.char)) {
                plan.plan.advance = max(plan.plan.width * 0.84, plan.plan.advance - em * 0.025)
            }
        }
    }
    return plans to missing.toList()
}

private fun planWidth(plans: List<Plan>): Double = plans.sumOf { plan ->
    when (plan) {
        is Plan.Glyph -> plan.plan.advance
        is Plan.Space -> plan.plan.width
        is Plan.Missing -> plan.plan.width
        Plan.Newline -> 0.0
    }
}

private fun wordEnd(plans: List<Plan>, start: Int): Int {
    var end = start
    while (end < plans.size && plans[end] !is Plan.Space && plans[end] !is Plan.Newline) end += 1
    return end
}

private class Clock(var value: Double)

private fun transformGlyph(
    plan: GlyphPlan,
    x: Double,
    baseline: Double,
    line: Int,
    options: HandwritingSynthesisOptions,
    width: Double,
    height: Double,
    clock: Clock,
): List<InkStroke> {
    val em = clamp(options.fontSize, 16.0, 96.0)
    val targetHeight = plan.height
    val targetTop = baseline - plan.top * em * plan.scaleY + plan.baselineJitter
    val generated = ArrayList<InkStroke>()
    for (source in plan.sample.strokes) {
        if (source.points.isEmpty()) continue
        val points = source.points.mapIndexed { pointIndex, point ->
            val localX = clamp((point.x - plan.sample.bbox[0]) / plan.sample.bbox[2], -0.18, 1.18)
            val localY = clamp((point.y - plan.sample.bbox[1]) / plan.sample.bbox[3], -0.18, 1.18)
            var pixelX = x + localX * plan.width
            var pixelY = targetTop + localY * targetHeight
            pixelX += plan.slant * (baseline - pixelY)
            val pressure = if (options.pressureEnabled) {
                val sourcePressure = if (point.pressure.isFinite() && point.pressure >= 0.0) point.pressure else 0.5
                clamp(sourcePressure * (if (plan.sample.sessionId == "school-script" && plan.observation != null) plan.observation.pressure / .55 else 1.0), 0.08, 1.0)
            } else {
                0.5
            }
            val before = source.points[max(0, pointIndex - 1)]
            clock.value += (point.t - before.t).takeIf { it > 0 }?.coerceIn(1.0, 50.0) ?: 4.0
            StrokePoint(
                x = clamp(pixelX / width, 0.0, 1.0),
                y = clamp(pixelY / height, 0.0, 1.0),
                t = clock.value,
                pressure = pressure,
                tiltX = clamp(point.tiltX, -90.0, 90.0),
                tiltY = clamp(point.tiltY, -90.0, 90.0),
                pointerType = "pen",
            )
        }
        generated += InkStroke(
            points = points,
            baseWidth = clamp(options.baseWidth * (plan.observation?.let { (it.nibRatio / .08).coerceIn(.6, 1.6) } ?: 1.0), 0.5, 48.0),
            pressureEnabled = options.pressureEnabled,
            color = options.color,
            purpose = "handwriting",
            brush = "fineliner",
            opacity = 1.0,
            colorEffect = "solid",
        )
    }
    if (plan.diacritic == "umlaut") {
        val markY = clamp((targetTop - em * 0.105) / height, 0.0, 1.0)
        for (offset in doubleArrayOf(0.34, 0.67)) {
            clock.value += 4.0
            generated += InkStroke(
                points = listOf(
                    StrokePoint(
                        x = clamp((x + plan.width * offset) / width, 0.0, 1.0),
                        y = markY,
                        t = clock.value,
                        pressure = 0.55,
                        tiltX = 0.0,
                        tiltY = 0.0,
                        pointerType = "pen",
                    ),
                ),
                baseWidth = clamp(options.baseWidth * 1.08, 0.5, 48.0),
                pressureEnabled = options.pressureEnabled,
                color = options.color,
                purpose = "handwriting",
                brush = "fineliner",
                opacity = 1.0,
                colorEffect = "solid",
            )
        }
    }
    return generated
}

private fun strokeBounds(strokes: List<InkStroke>, width: Double, height: Double): List<Double>? {
    val points = strokes.flatMap { it.points }
    if (points.isEmpty()) return null
    val left = points.minOf { it.x }
    val top = points.minOf { it.y }
    val right = points.maxOf { it.x }
    val bottom = points.maxOf { it.y }
    return listOf(left * width, top * height, (right - left) * width, (bottom - top) * height)
}

private fun layoutSlots(
    plans: List<Plan>,
    options: HandwritingSynthesisOptions,
    width: Double,
    startHeight: Double,
): Triple<List<LayoutSlot>, Int, Double> {
    val em = clamp(options.fontSize, 16.0, 96.0)
    val left = clamp(options.marginLeft ?: 72.0, 0.0, width - 24.0)
    val right = max(left + 12.0, width - clamp(options.marginRight ?: 72.0, 0.0, width - 24.0))
    val top = clamp(options.marginTop ?: 72.0, 0.0, startHeight * 0.4)
    val lineHeight = em * clamp(options.lineSpacing, 1.0, 2.4)
    var baseline = max(top + em * 0.92, options.startY ?: (top + em * 0.92))
    var cursorX = left
    var line = 0
    var lineCount = if (plans.isNotEmpty()) 1 else 0
    var maxBottom = 0.0
    val slots = ArrayList<LayoutSlot>()
    fun nextLine() {
        cursorX = left
        baseline += lineHeight
        line += 1
        lineCount += 1
    }
    for (index in plans.indices) {
        val plan = plans[index]
        if (plan is Plan.Newline) {
            nextLine()
            slots += LayoutSlot(plan, cursorX, baseline, line, baseline)
            continue
        }
        if (plan is Plan.Space) {
            cursorX += plan.plan.width
            slots += LayoutSlot(plan, cursorX, baseline, line, baseline)
            continue
        }
        val previous = plans.getOrNull(index - 1)
        val startsWord = index == 0 || previous is Plan.Space || previous is Plan.Newline
        if (startsWord && cursorX > left) {
            val end = wordEnd(plans, index)
            val widthOfWord = planWidth(plans.subList(index, end))
            if (widthOfWord <= right - left && cursorX + widthOfWord > right) nextLine()
        }
        val requiredWidth = when (plan) {
            is Plan.Glyph -> plan.plan.width
            is Plan.Missing -> plan.plan.width
            else -> 0.0
        }
        if (cursorX > left && cursorX + requiredWidth > right) nextLine()
        val planBottom = if (plan is Plan.Glyph) plan.plan.bottom * em * plan.plan.scaleY else em * 0.12
        val bottom = baseline + planBottom + (if (plan is Plan.Glyph) plan.plan.baselineJitter else 0.0)
        maxBottom = max(maxBottom, bottom)
        slots += LayoutSlot(plan, cursorX, baseline, line, bottom)
        cursorX += when (plan) {
            is Plan.Glyph -> plan.plan.advance
            is Plan.Missing -> plan.plan.width
            else -> 0.0
        }
    }
    return Triple(slots, lineCount, maxBottom)
}

fun synthesizeHandwriting(
    input: String,
    samples: List<GlyphSample>,
    options: HandwritingSynthesisOptions,
    page: HandwritingPage = HandwritingPage(PAGE_START_WIDTH, PAGE_START_HEIGHT),
    clockStart: Double = System.currentTimeMillis().toDouble(),
): HandwritingSynthesisResult {
    val width = min(WRITE_CAP_WIDTH, max(240.0, page.width))
    val startHeight = min(WRITE_CAP_HEIGHT, max(300.0, page.height))
    val text = normalizeHandwritingText(input)
    val random = handwritingRandom(options.seed)
    val (plans, missing) = createPlans(text, glyphsForSynthesis(samples), options, random, max(12.0, width - (options.marginLeft ?: 72.0) - (options.marginRight ?: 72.0)))
    val em = clamp(options.fontSize, 16.0, 96.0)
    val marginBottom = clamp(options.marginBottom ?: 72.0, 0.0, startHeight * 0.4)
    val (slots, plannedLines, maxBottom) = layoutSlots(plans, options, width, startHeight)
    val neededHeight = max(startHeight, ceil(maxBottom + marginBottom))
    val height = min(WRITE_CAP_HEIGHT, neededHeight)
    val writableBottom = height - marginBottom
    val overflow = neededHeight > WRITE_CAP_HEIGHT
    var overflowCharacters = 0
    val lineCount = if (text.isNotEmpty()) plannedLines else 0
    var glyphCount = 0
    var connectionCount = 0
    var previousBody = -1
    var previousLine = -1
    var previousChar = ""
    val strokes = ArrayList<InkStroke>()
    val usedSampleIds = LinkedHashSet<String>()
    val clock = Clock(clockStart)
    val joiningMotions = options.model?.joins.orEmpty()
    for (index in slots.indices) {
        val slot = slots[index]
        val plan = slot.plan
        if (plan is Plan.Newline || plan is Plan.Space) {
            previousBody = -1
            previousChar = ""
            continue
        }
        if (slot.bottom > writableBottom) {
            overflowCharacters = slots.drop(index).sumOf { remaining -> when (val p = remaining.plan) { is Plan.Glyph -> codePoints(p.plan.char).size; is Plan.Missing -> 1; else -> 0 } }
            break
        }
        if (plan is Plan.Missing) {
            previousBody = -1
            previousChar = ""
            continue
        }
        val glyph = (plan as Plan.Glyph).plan
        val generated = transformGlyph(glyph, slot.x, slot.baseline, slot.line, options, width, height, clock).mapIndexed { part, stroke ->
            stroke.copy(extras = jsonObject("synthesis" to jsonObject("segments" to jsonArray(jsonObject(
                "start" to jsonNumber(0.0), "end" to jsonNumber(stroke.points.size.toDouble()), "order" to jsonNumber((index * 128 + part).toDouble()))))))
        }
        val bodyIndex = generated.indices.maxByOrNull { generated[it].points.size } ?: 0
        val body = generated.getOrNull(bodyIndex)
        var merged = false
        if (body != null && options.connectLetters && previousBody >= 0 && previousLine == slot.line && canJoin(previousChar) && canJoin(glyph.char)
            && (glyph.observation?.joinRate ?: 1.0) > .5 && codePoints(glyph.char).size == 1 && codePoints(previousChar).size == 1) {
            val left = strokes[previousBody]
            fun pixel(p: StrokePoint) = p.copy(x = p.x * width, y = p.y * height)
            val joined = spliceWritingTrajectories(left.points.map(::pixel), body.points.map(::pixel), em, joiningMotions)
            if (joined != null) {
                val offset = joined.size - body.points.size
                val parts = left.extras.obj("synthesis")?.array("segments")?.items.orEmpty().toMutableList()
                val order = (body.extras.obj("synthesis")?.array("segments")?.items?.firstOrNull() as? JsonValue.Obj)?.double("order") ?: 0.0
                parts += jsonObject("start" to jsonNumber(offset.toDouble()), "end" to jsonNumber(joined.size.toDouble()), "order" to jsonNumber(order))
                strokes[previousBody] = left.copy(points = joined.map { it.copy(x = it.x / width, y = it.y / height) }, extras = jsonObject("synthesis" to jsonObject("segments" to JsonValue.Arr(parts))))
                merged = true; connectionCount++
            }
        }
        val offset = strokes.size
        strokes += generated.filterIndexed { i, _ -> !merged || i != bodyIndex }
        previousBody = if (merged) previousBody else offset + bodyIndex
        previousLine = slot.line
        previousChar = glyph.char
        glyphCount += codePoints(glyph.char).size
        usedSampleIds += glyph.sample.id
    }
    if (overflow && overflowCharacters == 0) {
        val plannedGlyphs = plans.sumOf { when (it) { is Plan.Glyph -> codePoints(it.plan.char).size; is Plan.Missing -> 1; else -> 0 } }
        overflowCharacters = plannedGlyphs - glyphCount
    }
    var time = clockStart
    val targetSpeed = options.model?.observations?.map { it.speed }?.takeIf { it.isNotEmpty() }?.average() ?: .3
    val generated = strokes.map { stroke ->
        time += 35
        var previousSpeed = targetSpeed
        val points = stroke.points.mapIndexed { i, p ->
            val previous = stroke.points[max(0, i - 1)]
            val distance = hypot((p.x - previous.x) * width, (p.y - previous.y) * height)
            val localSpeed = (distance / max(1.0, p.t - previous.t)).coerceIn(targetSpeed * .5, targetSpeed * 2)
            previousSpeed = previousSpeed * .7 + localSpeed * .3
            time += max(1.0, distance / previousSpeed)
            p.copy(t = time)
        }
        stroke.copy(points = points, extras = jsonObject("synthesis" to jsonObject("engine" to jsonNumber(2.0), "seed" to jsonNumber(options.seed.toDouble()), "group" to jsonString("${options.seed}:$clockStart"), "segments" to stroke.extras.obj("synthesis")?.array("segments"))))
    }
    return HandwritingSynthesisResult(
        strokes = generated,
        normalizedText = text,
        missingCharacters = missing,
        overflow = overflow,
        overflowCharacters = overflowCharacters,
        glyphCount = glyphCount,
        lineCount = lineCount,
        connectionCount = connectionCount,
        usedSampleIds = usedSampleIds.toList(),
        fontSizeUsed = em,
        bounds = strokeBounds(strokes, width, height),
        pageWidth = width,
        pageHeight = height,
    )
}

fun synthesizeHandwritingToFit(
    input: String,
    samples: List<GlyphSample>,
    options: HandwritingSynthesisOptions,
    page: HandwritingPage = HandwritingPage(PAGE_START_WIDTH, PAGE_START_HEIGHT),
    minimumFontSize: Double = 18.0,
    clockStart: Double = System.currentTimeMillis().toDouble(),
): HandwritingSynthesisResult {
    val requested = clamp(options.fontSize, minimumFontSize, 96.0)
    var result = synthesizeHandwriting(input, samples, options.copy(fontSize = requested), page, clockStart)
    var fontSize = requested - 2.0
    while (result.overflow && fontSize >= minimumFontSize) {
        result = synthesizeHandwriting(input, samples, options.copy(fontSize = fontSize), page, clockStart)
        fontSize -= 2.0
    }
    return result
}

/** Personal samples win. The school script only fills letters nobody trained. */
fun glyphsForSynthesis(personal: List<GlyphSample>): List<GlyphSample> {
    val covered = personal.map { it.label }.toSet()
    return personal + schoolScript().filter { it.label !in covered }
}

/** Same placement the desktop dialog uses: under the lowest ink, at least 96 px down. */
fun suggestedHandwritingStartY(document: InkDocument): Double {
    val bottom = document.strokes.flatMap { it.points }.maxOfOrNull { it.y * document.sourceHeight } ?: 0.0
    return max(96.0, bottom + 58.0)
}
