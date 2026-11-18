package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.jsNumber
import ch.fasrv.fanotes.json.parseJson

/**
 * Requests to and answers from the recognition host (`fanotes/src/recognitionHost/main.ts`).
 * The host runs the desktop recognizers; these types only carry their results.
 */

enum class RecognitionPreference(val id: String) { AUTO("auto"), TEXT("text"), MATH("math") }

fun recognitionPreference(raw: String?): RecognitionPreference =
    RecognitionPreference.entries.firstOrNull { it.id == raw } ?: RecognitionPreference.AUTO

/** `de` and `en` have models; other note languages fall back to English like `modelLanguageFor`. */
fun recognitionLanguage(raw: String?): String = if (raw == null || raw == "de") "de" else "en"

/**
 * UI text through the desktop catalog; German shows Swiss spelling ("ss"). A source written with
 * "ss" still finds the desktop's "ß" key ("Schliessen" → "Schließen" → "Close").
 */
fun recognitionUi(source: String): String {
    val direct = ChromeText.ui(source)
    if (direct != source || !source.contains("ss")) return direct.replace("ß", "ss")
    val desktop = source.replace("ss", "ß")
    val translated = ChromeText.ui(desktop)
    return (if (translated != desktop) translated else direct).replace("ß", "ss")
}

data class RecognitionPage(
    val strokes: List<ch.fasrv.fanotes.ink.InkStroke>,
    val width: Double,
    val height: Double,
    val language: String,
    val neural: Boolean,
)

/** Payload JSON for the host methods that take a page (`Page` in `main.ts`). */
fun pagePayload(page: RecognitionPage, extra: Map<String, String> = emptyMap()): String = buildString {
    append("{\"strokes\":").append(strokesJson(handwritingStrokes(page.strokes)))
    append(",\"width\":").append(jsNumber(page.width))
    append(",\"height\":").append(jsNumber(page.height))
    append(",\"language\":").append(escapeJson(page.language))
    append(",\"neural\":").append(page.neural)
    extra.forEach { (key, value) -> append(',').append(escapeJson(key)).append(':').append(escapeJson(value)) }
    append('}')
}

data class ConversionResult(
    val mode: String,
    val value: String,
    val confidence: Int,
    val reason: String,
    val engine: String,
    val neuralError: String,
)

data class TranscriptEntry(val y: Double, val text: String, val kind: String)

data class MathReading(val input: String, val latex: String, val confidence: Int)

data class MathSolutionStep(val expression: String, val display: String, val latex: String, val kind: String)

data class MathSolverResult(
    val action: String,
    val normalizedInput: String,
    val inputLatex: String,
    val variables: List<String>,
    val variable: String?,
    val steps: List<MathSolutionStep>,
)

data class MathCheckLine(val index: Int, val input: String, val status: String, val message: String)

data class MathCheckResult(
    val status: String,
    val lines: List<MathCheckLine>,
    val errorLineIndex: Int?,
    val message: String,
    val suggestion: String?,
)

data class MathStepReading(
    val input: String,
    val latex: String,
    val confidence: Int,
    val recognitionRisk: Boolean,
    val confirmed: Boolean,
    val rect: ch.fasrv.fanotes.ink.NormalizedRect,
)

data class MathCheckOutcome(val lines: List<MathStepReading>, val result: MathCheckResult)

class RecognitionHostException(message: String) : IllegalStateException(message)

/** Unwraps the host's `{ ok, value | error }` envelope. */
fun hostValue(json: String): JsonValue {
    val root = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull()
        ?: throw RecognitionHostException("Die Handschrifterkennung hat keine lesbare Antwort geliefert.")
    if (root.bool("ok") != true) throw RecognitionHostException(root.string("error")?.takeIf { it.isNotBlank() } ?: "Die Handschrifterkennung ist fehlgeschlagen.")
    return root["value"] ?: JsonValue.Null
}

private fun JsonValue.obj(): JsonValue.Obj = this as? JsonValue.Obj ?: throw RecognitionHostException("Die Handschrifterkennung hat keine lesbare Antwort geliefert.")

private fun JsonValue.Obj.int(key: String): Int = double(key)?.takeIf { it.isFinite() }?.let { Math.round(it).toInt() } ?: 0

fun parseConversion(value: JsonValue): ConversionResult {
    val obj = value.obj()
    return ConversionResult(
        mode = if (obj.string("mode") == "math") "math" else "text",
        value = obj.string("value").orEmpty(),
        confidence = obj.int("confidence").coerceIn(0, 100),
        reason = obj.string("reason").orEmpty(),
        engine = obj.string("engine").orEmpty(),
        neuralError = obj.string("neuralError").orEmpty(),
    )
}

fun parseTranscript(value: JsonValue): List<TranscriptEntry> =
    value.obj().array("lines")?.items.orEmpty().mapNotNull { item ->
        val line = item as? JsonValue.Obj ?: return@mapNotNull null
        val text = line.string("text")?.trim().orEmpty()
        val y = line.double("y")?.takeIf { it.isFinite() } ?: return@mapNotNull null
        if (text.isEmpty()) null else TranscriptEntry(y.coerceIn(0.0, 1.0), text, if (line.string("kind") == "math") "math" else "text")
    }

fun parseMathReading(value: JsonValue): MathReading {
    val obj = value.obj()
    return MathReading(obj.string("input").orEmpty(), obj.string("latex").orEmpty(), obj.int("confidence").coerceIn(0, 100))
}

fun parseSolverResult(value: JsonValue): MathSolverResult {
    val obj = value.obj()
    return MathSolverResult(
        action = obj.string("action").orEmpty(),
        normalizedInput = obj.string("normalizedInput").orEmpty(),
        inputLatex = obj.string("inputLatex").orEmpty(),
        variables = obj.array("variables")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value },
        variable = obj.string("variable"),
        steps = obj.array("steps")?.items.orEmpty().mapNotNull { item ->
            val step = item as? JsonValue.Obj ?: return@mapNotNull null
            MathSolutionStep(
                step.string("expression").orEmpty(),
                step.string("display").orEmpty(),
                step.string("latex").orEmpty(),
                if (step.string("kind") == "result") "result" else "intermediate",
            )
        },
    )
}

fun parseCheckResult(value: JsonValue): MathCheckResult {
    val obj = value.obj()
    return MathCheckResult(
        status = obj.string("status").orEmpty(),
        lines = obj.array("lines")?.items.orEmpty().mapNotNull { item ->
            val line = item as? JsonValue.Obj ?: return@mapNotNull null
            MathCheckLine(line.int("index"), line.string("input").orEmpty(), line.string("status").orEmpty(), line.string("message").orEmpty())
        },
        errorLineIndex = obj.double("errorLineIndex")?.toInt(),
        message = obj.string("message").orEmpty(),
        suggestion = obj.string("suggestion"),
    )
}

fun parseCheckOutcome(value: JsonValue): MathCheckOutcome {
    val obj = value.obj()
    val lines = obj.array("lines")?.items.orEmpty().mapNotNull { item ->
        val line = item as? JsonValue.Obj ?: return@mapNotNull null
        val rect = line.obj("rect")
        MathStepReading(
            input = line.string("input").orEmpty(),
            latex = line.string("latex").orEmpty(),
            confidence = line.int("confidence").coerceIn(0, 100),
            recognitionRisk = line.bool("recognitionRisk") == true,
            confirmed = line.bool("confirmed") == true,
            rect = ch.fasrv.fanotes.ink.NormalizedRect(
                rect?.double("x") ?: 0.0,
                rect?.double("y") ?: 0.0,
                rect?.double("width") ?: 0.0,
                rect?.double("height") ?: 0.0,
            ),
        )
    }
    return MathCheckOutcome(lines, parseCheckResult(obj["result"] ?: JsonValue.Null))
}

/** `verifyLines` payload after the writer corrected or confirmed steps. */
fun verifyPayload(lines: List<MathStepReading>): String = buildString {
    append("{\"lines\":[")
    lines.forEachIndexed { index, line ->
        if (index > 0) append(',')
        append("{\"input\":").append(escapeJson(line.input))
        append(",\"latex\":").append(escapeJson(line.latex))
        append(",\"confidence\":").append(line.confidence)
        append(",\"recognitionRisk\":").append(line.recognitionRisk)
        append(",\"confirmed\":").append(line.confirmed)
        append(",\"rect\":{\"x\":").append(jsNumber(line.rect.x)).append(",\"y\":").append(jsNumber(line.rect.y))
        append(",\"width\":").append(jsNumber(line.rect.width)).append(",\"height\":").append(jsNumber(line.rect.height)).append("}}")
    }
    append("]}")
}

fun solvePayload(input: String, action: String, variable: String?): String =
    "{\"input\":${escapeJson(input)},\"action\":${escapeJson(action)}" + (variable?.let { ",\"variable\":${escapeJson(it)}" } ?: "") + "}"

/**
 * The host behind recognition, math reading, the solver and the step checker. The app implements
 * it with a headless WebView over the desktop code; [HandwritingRecognizer] stays the plain seam.
 */
interface InkRecognitionEngine {
    val neuralInstalled: Boolean
    suspend fun recognize(page: RecognitionPage, mode: RecognitionPreference, lastMode: String): ConversionResult
    suspend fun transcribe(page: RecognitionPage, mode: RecognitionPreference, lastMode: String): List<TranscriptEntry>
    suspend fun readMath(page: RecognitionPage): MathReading
    suspend fun solve(input: String, action: String, variable: String?): MathSolverResult
    suspend fun checkSteps(page: RecognitionPage): MathCheckOutcome
    suspend fun verifyLines(lines: List<MathStepReading>): MathCheckResult
}

/** Solver actions in the order and wording of the desktop solver panel. */
val MATH_SOLVER_ACTIONS: List<Pair<String, String>> = listOf(
    "step" to "Nächster Schritt",
    "simplify" to "Term vereinfachen",
    "solve" to "Gleichung lösen",
    "expand" to "Ausmultiplizieren",
    "factor" to "Faktorisieren",
    "calculate" to "Ausrechnen",
)
