package ch.fasrv.fanotes.ink

import java.security.SecureRandom
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Text → Handschrift from `fanotes/src/lib/textToHandwriting.ts`.
 * Each glyph is a stored training stroke. The tablet fills letters that
 * have no personal sample from the built-in school script.
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
    val scaleX: Double,
    val scaleY: Double,
    val slant: Double,
    val rotation: Double,
    val baselineJitter: Double,
    val warpPhase: Double,
    val widthVariation: Double,
    val pressurePhase: Double,
)

private data class SpacePlan(val width: Double)
private data class MissingPlan(val char: String, val width: Double)

private sealed class Plan {
    data class Glyph(val plan: GlyphPlan) : Plan()
    data class Space(val plan: SpacePlan) : Plan()
    data object Newline : Plan()
    data class Missing(val plan: MissingPlan) : Plan()
}

private data class Anchor(
    val x: Double,
    val y: Double,
    val tangentX: Double,
    val tangentY: Double,
    val pressure: Double,
    val width: Double,
    val char: String,
    val line: Int,
)

private data class LayoutSlot(
    val plan: Plan,
    val x: Double,
    val baseline: Double,
    val line: Int,
    val bottom: Double,
)

private val UPPER = Regex("^[A-ZÄÖÜ]$")
private val DIGIT = Regex("^[0-9]$")
private val ASCENDER = Regex("^[bdfhklt]$")
private val DESCENDER = Regex("^[gjpqy]$")
private val LOWER = Regex("^[a-zäöü]$")
private val WIDE = Regex("^[MWmw]$")
private val JOINABLE = Regex("^[A-Za-zÄÖÜäöü]$")

private fun clamp(value: Double, minValue: Double, maxValue: Double) = min(maxValue, max(minValue, value))
private fun mix(from: Double, to: Double, amount: Double) = from + (to - from) * amount
private fun between(random: () -> Double, minValue: Double, maxValue: Double) = mix(minValue, maxValue, random())

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

/** Swiss prose folds ß/ẞ before the glyphs are chosen. */
fun normalizeHandwritingText(value: String): String = value
    .replace("ẞ", "SS")
    .replace("ß", "ss")
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
    return sample.sourceWidth > 0.0 && sample.sourceHeight > 0.0
}

private fun aliasesFor(char: String): Set<String> = when (char) {
    "-" -> setOf("-", "−", "operator_minus")
    "'" -> setOf("'", "’", "‘", "apostrophe")
    "\"" -> setOf("\"", "“", "”", "„", "quote")
    else -> setOf(char)
}

private val UMLAUT_BASE = mapOf("ä" to "a", "ö" to "o", "ü" to "u", "Ä" to "A", "Ö" to "O", "Ü" to "U")

private data class SampleMatch(val samples: List<GlyphSample>, val diacritic: String?)

private fun samplesForCharacter(char: String, samples: List<GlyphSample>): SampleMatch {
    val aliases = aliasesFor(char)
    val exact = samples.filter { sample ->
        isValidSample(sample) && (sample.label in aliases || sample.labelId in aliases)
    }
    if (exact.isNotEmpty()) return SampleMatch(exact, null)
    val base = UMLAUT_BASE[char] ?: return SampleMatch(emptyList(), null)
    return SampleMatch(
        samples.filter { isValidSample(it) && it.label == base },
        "umlaut",
    )
}

private fun glyphProfile(char: String): GlyphProfile = when {
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
): Pair<List<Plan>, List<String>> {
    val plans = ArrayList<Plan>()
    val missing = LinkedHashSet<String>()
    val variation = clamp(options.variation, 0.0, 1.0)
    val em = clamp(options.fontSize, 16.0, 96.0)
    val globalSlant = between(random, -0.035, 0.045) * variation
    val globalWidth = 1.0 + between(random, -0.025, 0.025) * variation
    var previousSampleId: String? = null
    for (char in codePoints(text)) {
        when (char) {
            "\n" -> {
                plans += Plan.Newline
                previousSampleId = null
                continue
            }
            " " -> {
                plans += Plan.Space(SpacePlan(em * (0.3 + between(random, -0.025, 0.035) * variation)))
                previousSampleId = null
                continue
            }
        }
        val match = samplesForCharacter(char, samples)
        if (match.samples.isEmpty()) {
            missing += char
            plans += Plan.Missing(MissingPlan(char, em * 0.56))
            previousSampleId = null
            continue
        }
        val sample = selectSample(match.samples, random, previousSampleId)
        val profile = glyphProfile(char)
        val scaleX = globalWidth * (1.0 + between(random, -0.075, 0.075) * variation)
        val scaleY = 1.0 + between(random, -0.11, 0.13) * variation
        val height = em * (profile.top + profile.bottom) * scaleY
        val rawWidth = height * sampleAspect(sample) * profile.widthScale * scaleX
        val width = clamp(rawWidth, em * 0.16, em * (if (WIDE.matches(char)) 1.32 else 1.08))
        val plan = GlyphPlan(
            char = char,
            sample = sample,
            diacritic = match.diacritic,
            width = width,
            advance = width + em * (0.075 + between(random, -0.018, 0.025) * variation),
            height = height,
            top = profile.top,
            bottom = profile.bottom,
            scaleX = scaleX,
            scaleY = scaleY,
            slant = globalSlant + between(random, -0.045, 0.045) * variation,
            rotation = between(random, -1.25, 1.25) * Math.PI / 180.0 * variation,
            baselineJitter = between(random, -0.22, 0.20) * em * variation,
            warpPhase = between(random, 0.0, Math.PI * 2),
            widthVariation = 1.0 + between(random, -0.09, 0.09) * variation,
            pressurePhase = between(random, 0.0, Math.PI * 2),
        )
        plans += Plan.Glyph(plan)
        previousSampleId = sample.id
    }
    if (options.connectLetters) {
        plans.forEachIndexed { index, plan ->
            val next = plans.getOrNull(index + 1)
            if (plan is Plan.Glyph && next is Plan.Glyph && canJoin(plan.plan.char) && canJoin(next.plan.char)) {
                plan.plan.advance = max(plan.plan.width * 0.84, plan.plan.advance - em * 0.12)
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

private fun pointDistance(left: StrokePoint, right: StrokePoint, width: Double, height: Double) = hypot(
    (right.x - left.x) * width,
    (right.y - left.y) * height,
)

private fun anchorsForGlyph(
    strokes: List<InkStroke>,
    char: String,
    line: Int,
    baseline: Double,
    width: Double,
    height: Double,
): Pair<Anchor, Anchor>? {
    val lengths = strokes.map { stroke ->
        stroke.points.drop(1).mapIndexed { index, point ->
            pointDistance(stroke.points[index], point, width, height)
        }.sum()
    }
    val maxLength = lengths.maxOrNull() ?: 0.0
    data class Candidate(val point: StrokePoint, val inward: StrokePoint, val stroke: InkStroke)
    val candidates = strokes.flatMapIndexed { index, stroke ->
        if (stroke.points.isEmpty() || lengths[index] < max(2.0, maxLength * 0.2)) emptyList()
        else {
            val first = stroke.points.first()
            val last = stroke.points.last()
            val afterFirst = stroke.points[min(1, stroke.points.lastIndex)]
            val beforeLast = stroke.points[max(0, stroke.points.lastIndex - 1)]
            listOf(Candidate(first, afterFirst, stroke), Candidate(last, beforeLast, stroke))
        }
    }
    if (candidates.isEmpty()) return null
    val baselineNormalized = baseline / height
    val entry = candidates.reduce { best, candidate ->
        val score = candidate.point.x * width + kotlin.math.abs(candidate.point.y - baselineNormalized) * height * 0.38
        val bestScore = best.point.x * width + kotlin.math.abs(best.point.y - baselineNormalized) * height * 0.38
        if (score < bestScore) candidate else best
    }
    val exit = candidates.reduce { best, candidate ->
        val score = candidate.point.x * width - kotlin.math.abs(candidate.point.y - baselineNormalized) * height * 0.38
        val bestScore = best.point.x * width - kotlin.math.abs(best.point.y - baselineNormalized) * height * 0.38
        if (score > bestScore) candidate else best
    }
    fun make(candidate: Candidate, role: String): Anchor {
        val inwardX = (candidate.inward.x - candidate.point.x) * width
        val inwardY = (candidate.inward.y - candidate.point.y) * height
        val inwardLength = hypot(inwardX, inwardY).takeIf { it > 0.0 } ?: 1.0
        val direction = if (role == "entry") 1.0 else -1.0
        return Anchor(
            x = candidate.point.x * width,
            y = candidate.point.y * height,
            tangentX = inwardX / inwardLength * direction,
            tangentY = inwardY / inwardLength * direction,
            pressure = candidate.point.pressure,
            width = candidate.stroke.baseWidth,
            char = char,
            line = line,
        )
    }
    return make(entry, "entry") to make(exit, "exit")
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
): Pair<List<InkStroke>, Pair<Anchor, Anchor>?> {
    val variation = clamp(options.variation, 0.0, 1.0)
    val em = clamp(options.fontSize, 16.0, 96.0)
    val targetHeight = plan.height
    val targetTop = baseline - plan.top * em * plan.scaleY + plan.baselineJitter
    val centerX = x + plan.width / 2.0
    val centerY = targetTop + targetHeight / 2.0
    val cosine = cos(plan.rotation)
    val sine = sin(plan.rotation)
    val generated = ArrayList<InkStroke>()
    for (source in plan.sample.strokes) {
        if (source.points.isEmpty()) continue
        val points = source.points.mapIndexed { pointIndex, point ->
            val localX = clamp((point.x - plan.sample.bbox[0]) / plan.sample.bbox[2], -0.18, 1.18)
            val localY = clamp((point.y - plan.sample.bbox[1]) / plan.sample.bbox[3], -0.18, 1.18)
            var pixelX = x + localX * plan.width
            var pixelY = targetTop + localY * targetHeight
            pixelX += plan.slant * (baseline - pixelY)
            pixelX += sin(localY * Math.PI * 1.7 + plan.warpPhase) * em * 0.009 * variation
            pixelY += sin(localX * Math.PI * 1.4 + plan.warpPhase * 0.73) * em * 0.006 * variation
            val relativeX = pixelX - centerX
            val relativeY = pixelY - centerY
            val rotatedX = centerX + relativeX * cosine - relativeY * sine
            val rotatedY = centerY + relativeX * sine + relativeY * cosine
            val pressure = if (options.pressureEnabled) {
                val sourcePressure = if (point.pressure.isFinite() && point.pressure > 0.0) point.pressure else 0.5
                clamp(sourcePressure * (1.0 + sin(pointIndex * 0.42 + plan.pressurePhase) * 0.055 * variation), 0.08, 1.0)
            } else {
                0.5
            }
            clock.value += 4.0
            StrokePoint(
                x = clamp(rotatedX / width, 0.0, 1.0),
                y = clamp(rotatedY / height, 0.0, 1.0),
                t = clock.value,
                pressure = pressure,
                tiltX = clamp(point.tiltX, -90.0, 90.0),
                tiltY = clamp(point.tiltY, -90.0, 90.0),
                pointerType = "pen",
            )
        }
        generated += InkStroke(
            points = points,
            baseWidth = clamp(options.baseWidth * plan.widthVariation, 0.5, 48.0),
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
    return generated to anchorsForGlyph(generated, plan.char, line, baseline, width, height)
}

private fun connectorStroke(
    from: Anchor,
    to: Anchor,
    options: HandwritingSynthesisOptions,
    width: Double,
    height: Double,
    random: () -> Double,
    clock: Clock,
): InkStroke? {
    val em = clamp(options.fontSize, 16.0, 96.0)
    val dx = to.x - from.x
    val dy = to.y - from.y
    if (from.line != to.line || dx < -em * 0.2 || dx > em * 0.72 || kotlin.math.abs(dy) > em * 0.46) return null
    val variation = clamp(options.variation, 0.0, 1.0)
    val lift = between(random, -0.035, 0.035) * em * variation
    val controlDistance = clamp(hypot(dx, dy) * 0.36, em * 0.08, em * 0.28)
    val firstX = from.x + from.tangentX * controlDistance
    val firstY = from.y + from.tangentY * controlDistance + lift
    val secondX = to.x - to.tangentX * controlDistance
    val secondY = to.y - to.tangentY * controlDistance - lift * 0.45
    val points = (0..12).map { index ->
        val t = index / 12.0
        val inverse = 1.0 - t
        val x = inverse * inverse * inverse * from.x +
            3 * inverse * inverse * t * firstX +
            3 * inverse * t * t * secondX +
            t * t * t * to.x
        val y = inverse * inverse * inverse * from.y +
            3 * inverse * inverse * t * firstY +
            3 * inverse * t * t * secondY +
            t * t * t * to.y
        clock.value += 4.0
        StrokePoint(
            x = clamp(x / width, 0.0, 1.0),
            y = clamp(y / height, 0.0, 1.0),
            t = clock.value,
            pressure = mix(from.pressure, to.pressure, t),
            tiltX = 0.0,
            tiltY = 0.0,
            pointerType = "pen",
        )
    }
    return InkStroke(
        points = points,
        baseWidth = clamp((from.width + to.width) / 2.0 * 0.92, 0.5, 48.0),
        pressureEnabled = options.pressureEnabled,
        color = options.color,
        purpose = "handwriting",
        brush = "fineliner",
        opacity = 1.0,
        colorEffect = "solid",
    )
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
        val bottom = baseline + planBottom
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
    val (plans, missing) = createPlans(text, samples, options, random)
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
    var previousExit: Anchor? = null
    var previousChar = ""
    val strokes = ArrayList<InkStroke>()
    val usedSampleIds = LinkedHashSet<String>()
    val clock = Clock(clockStart)
    for (index in slots.indices) {
        val slot = slots[index]
        val plan = slot.plan
        if (plan is Plan.Newline || plan is Plan.Space) {
            previousExit = null
            previousChar = ""
            continue
        }
        if (slot.bottom > writableBottom) {
            overflowCharacters = slots.drop(index).count { remaining ->
                remaining.plan is Plan.Glyph || remaining.plan is Plan.Missing
            }
            break
        }
        if (plan is Plan.Missing) {
            previousExit = null
            previousChar = ""
            continue
        }
        val glyph = (plan as Plan.Glyph).plan
        val generated = transformGlyph(glyph, slot.x, slot.baseline, slot.line, options, width, height, clock)
        val anchors = generated.second
        val exit = previousExit
        if (options.connectLetters && exit != null && anchors != null && canJoin(previousChar) && canJoin(glyph.char)) {
            val connector = connectorStroke(exit, anchors.first, options, width, height, random, clock)
            if (connector != null) {
                strokes += connector
                connectionCount += 1
            }
        }
        strokes += generated.first
        previousExit = generated.second?.second
        previousChar = glyph.char
        glyphCount += 1
        usedSampleIds += glyph.sample.id
    }
    if (overflow && overflowCharacters == 0) {
        val plannedGlyphs = plans.count { it is Plan.Glyph || it is Plan.Missing }
        overflowCharacters = plannedGlyphs - glyphCount
    }
    return HandwritingSynthesisResult(
        strokes = strokes,
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
