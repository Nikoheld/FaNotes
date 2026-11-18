package ch.fasrv.fanotes

import ch.fasrv.fanotes.ink.GlyphSample
import ch.fasrv.fanotes.ink.HandwritingPage
import ch.fasrv.fanotes.ink.HandwritingSynthesisOptions
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.NormalizedRect
import ch.fasrv.fanotes.ink.createHandwritingSeed
import ch.fasrv.fanotes.ink.encodeGlyphLibrary
import ch.fasrv.fanotes.ink.glyphsForSynthesis
import ch.fasrv.fanotes.ink.synthesizeHandwriting
import ch.fasrv.fanotes.ink.synthesizeHandwritingToFit
import ch.fasrv.fanotes.recognition.ConversionResult
import ch.fasrv.fanotes.recognition.MathCheckResult
import ch.fasrv.fanotes.recognition.MathInputException
import ch.fasrv.fanotes.recognition.MathSolverResult
import ch.fasrv.fanotes.recognition.MathStepReading
import ch.fasrv.fanotes.recognition.RecognitionPage
import ch.fasrv.fanotes.recognition.RecognitionPreference
import ch.fasrv.fanotes.recognition.SolverPlacement
import ch.fasrv.fanotes.recognition.TranscriptEntry
import ch.fasrv.fanotes.recognition.adaptMathTextToSamples
import ch.fasrv.fanotes.recognition.appendMarkdownBlock
import ch.fasrv.fanotes.recognition.conversionMarkdown
import ch.fasrv.fanotes.recognition.handwritingStrokes
import ch.fasrv.fanotes.recognition.inspectMathInputSyntax
import ch.fasrv.fanotes.recognition.mergeTranscript
import ch.fasrv.fanotes.recognition.recognitionLanguage
import ch.fasrv.fanotes.recognition.recognitionPreference
import ch.fasrv.fanotes.recognition.recognitionUi
import ch.fasrv.fanotes.recognition.solverContinuationText
import ch.fasrv.fanotes.recognition.solverLayout
import ch.fasrv.fanotes.recognition.strokePrefixSignature
import ch.fasrv.fanotes.recognition.strokesRect
import ch.fasrv.fanotes.recognition.transcriptPlan
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Settings keys in the desk map; the desktop names are `experimentalHandwritingToText` etc. */
const val SETTING_HANDWRITING_TO_TEXT = "handwriting-to-text"
const val SETTING_RECOGNITION_MODE = "recognition-mode"
const val SETTING_RECOGNITION_LAST_MODE = "recognition-last-mode"
const val SETTING_RECOGNITION_LANGUAGE = "recognition-language"

data class ConversionUi(
    val scope: String,
    val running: Boolean,
    val preference: RecognitionPreference,
    val result: ConversionResult? = null,
    val value: String = "",
    val mode: String = "text",
    val error: String? = null,
    val strokeIndexes: Set<Int> = emptySet(),
    val rect: NormalizedRect? = null,
)

data class SolverUi(
    val running: Boolean,
    val rect: NormalizedRect?,
    val input: String = "",
    val latex: String = "",
    val confidence: Int = 0,
    val variable: String = "",
    val variables: List<String> = emptyList(),
    val inputError: String? = null,
    val result: MathSolverResult? = null,
    val error: String? = null,
)

data class CheckUi(
    val running: Boolean,
    val lines: List<MathStepReading> = emptyList(),
    val result: MathCheckResult? = null,
    val error: String? = null,
)

/**
 * Conversion, solver, step checker and the invisible transcript for the open note. The flows are
 * the desktop's (`DrawingBoard.tsx`); the recognizers run in [WebInkRecognizer]. Each run checks
 * that its note is still open before it writes, and a note change cancels everything.
 */
class RecognitionController(
    private val model: FaNotesViewModel,
    private val graph: AppGraph,
    private val scope: CoroutineScope,
) {
    val conversion = MutableStateFlow<ConversionUi?>(null)
    val solver = MutableStateFlow<SolverUi?>(null)
    val checker = MutableStateFlow<CheckUi?>(null)
    val modelState get() = graph.inkModels.state
    val neuralReady: Boolean get() = graph.inkModels.installed
    val modelBytes: Long get() = graph.inkModels.manifest.totalBytes

    fun refreshModelState() = graph.inkModels.refresh()

    private var job: Job? = null
    private var transcriptJob: Job? = null
    private val indexed = HashMap<String, Pair<Int, Long>>()

    init {
        scope.launch {
            model.open.map { it?.path }.distinctUntilChanged().collect { closeAll() }
        }
    }

    private val settings get() = model.deskSettings.value
    val enabled: Boolean get() = settings[SETTING_HANDWRITING_TO_TEXT] == "on"
    private val language get() = recognitionLanguage(settings[SETTING_RECOGNITION_LANGUAGE])
    private val preference get() = recognitionPreference(settings[SETTING_RECOGNITION_MODE])
    private val lastMode get() = if (settings[SETTING_RECOGNITION_LAST_MODE] == "math") "math" else "text"

    private fun notice(text: String) {
        model.message.value = recognitionUi(text)
    }

    private fun page(strokes: List<InkStroke>): RecognitionPage {
        val document = model.session.document
        return RecognitionPage(strokes, document.sourceWidth, document.sourceHeight, language, graph.inkRecognizer.neuralInstalled)
    }

    private fun requireEnabled(): Boolean {
        if (!enabled) {
            notice("Handschrift zu Text ist experimentell und in den Einstellungen ausgeschaltet.")
            return false
        }
        if (model.open.value?.kind?.name == "PDF") {
            notice("Auf PDF-Seiten wird Handschrift noch nicht konvertiert.")
            return false
        }
        return true
    }

    /** Lasso selection (`selectionOnly`) or the whole page; art strokes are never read. */
    private fun scopedStrokes(selectionOnly: Boolean): Pair<List<InkStroke>, Set<Int>>? {
        val document = model.session.document
        val selection = model.session.selection
        val indexes = if (selectionOnly) selection else document.strokes.indices.toSet()
        val strokes = indexes.sorted().mapNotNull { document.strokes.getOrNull(it) }
        val usable = handwritingStrokes(strokes)
        if (usable.isEmpty()) {
            notice(if (selectionOnly) "Wähle zuerst Handschrift mit dem Lasso aus." else "Auf dieser Seite gibt es noch keine Handschrift.")
            return null
        }
        return usable to indexes
    }

    private fun cancelRuns() {
        job?.cancel()
        transcriptJob?.cancel()
    }

    fun closeAll() {
        cancelRuns()
        conversion.value = null
        solver.value = null
        checker.value = null
    }

    // ---- Conversion ("Umwandeln") ----

    fun startConversion(selectionOnly: Boolean, requested: RecognitionPreference = preference) {
        if (!requireEnabled()) return
        val (strokes, indexes) = scopedStrokes(selectionOnly) ?: return
        solver.value = null
        checker.value = null
        cancelRuns()
        val path = model.open.value?.path
        conversion.value = ConversionUi(if (selectionOnly) "selection" else "page", running = true, preference = requested, strokeIndexes = indexes, rect = strokesRect(strokes))
        job = scope.launch {
            try {
                val result = graph.inkRecognizer.recognize(page(strokes), requested, lastMode)
                if (model.open.value?.path != path) return@launch
                model.updateDesk(SETTING_RECOGNITION_LAST_MODE, result.mode)
                conversion.value = conversion.value?.copy(running = false, result = result, value = result.value, mode = result.mode, error = null)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                conversion.value = conversion.value?.copy(running = false, error = recognitionUi(error.message ?: "Handschrift konnte nicht analysiert werden."))
            }
        }
    }

    fun rerunConversion(requested: RecognitionPreference) {
        val current = conversion.value ?: return
        model.updateDesk(SETTING_RECOGNITION_MODE, requested.id)
        if (current.scope == "selection" && current.strokeIndexes.isNotEmpty()) model.session.selectIndices(current.strokeIndexes)
        startConversion(current.scope == "selection", requested)
    }

    fun editConversion(value: String) {
        conversion.value = conversion.value?.copy(value = value)
    }

    fun setConversionMode(mode: String) {
        conversion.value = conversion.value?.copy(mode = if (mode == "math") "math" else "text")
    }

    /** `insertConversion`: Markdown at the end of the note, the ink stays unless [removeInk]. */
    fun insertConversion(removeInk: Boolean) {
        val current = conversion.value ?: return
        val block = conversionMarkdown(current.value, current.mode)
        if (block.isEmpty()) return
        if (model.open.value == null) {
            notice("Öffne zuerst eine Notiz, damit die Konvertierung eingefügt werden kann.")
            return
        }
        model.updateMarkdown(appendMarkdownBlock(model.markdown.value, block), typed = false)
        val y = current.rect?.y ?: 0.0
        val transcript = mergeTranscript(
            model.session.document.extras.string("searchTranscript").orEmpty(),
            current.value.trim().trim('$').split('\n').filter { it.isNotBlank() }.map { TranscriptEntry(y, it, current.mode) },
            replace = current.scope == "page",
        )
        model.session.setSearchTranscript(transcript)
        if (removeInk && current.strokeIndexes.isNotEmpty()) {
            model.session.selectIndices(current.strokeIndexes)
            model.session.deleteSelection(ch.fasrv.fanotes.famd.isoNow())
        }
        model.noteChanged()
        conversion.value = null
        notice(if (current.mode == "math") "Formel in die Notiz eingefügt." else "Text in die Notiz eingefügt.")
    }

    fun closeConversion() {
        job?.cancel()
        conversion.value = null
    }

    // ---- Math solver ----

    fun startSolver() {
        if (!requireEnabled()) return
        val (strokes, _) = scopedStrokes(selectionOnly = true) ?: return
        conversion.value = null
        checker.value = null
        cancelRuns()
        val path = model.open.value?.path
        solver.value = SolverUi(running = true, rect = strokesRect(strokes))
        job = scope.launch {
            try {
                val reading = graph.inkRecognizer.readMath(page(strokes))
                if (model.open.value?.path != path) return@launch
                solver.value = inspected(solver.value?.copy(running = false, input = reading.input, latex = reading.latex, confidence = reading.confidence) ?: return@launch, keepVariable = false)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                solver.value = solver.value?.copy(running = false, error = recognitionUi(error.message ?: "Der ausgewählte Ausdruck konnte nicht gelesen werden."))
            }
        }
    }

    private fun inspected(state: SolverUi, keepVariable: Boolean): SolverUi = try {
        val inspection = inspectMathInputSyntax(state.input)
        val variable = state.variable.takeIf { keepVariable && it in inspection.variables } ?: inspection.variables.firstOrNull().orEmpty()
        state.copy(variables = inspection.variables, variable = variable, inputError = null)
    } catch (error: MathInputException) {
        state.copy(variables = emptyList(), inputError = recognitionUi(error.message ?: "Der Ausdruck ist nicht gültig."))
    }

    fun editSolverInput(input: String) {
        val current = solver.value ?: return
        solver.value = inspected(current.copy(input = input, result = null, error = null), keepVariable = true)
    }

    fun setSolverVariable(variable: String) {
        solver.value = solver.value?.copy(variable = variable)
    }

    fun runSolver(action: String) {
        val current = solver.value ?: return
        if (current.inputError != null || current.input.isBlank()) return
        val variable = if (action == "solve") current.variable.ifBlank { current.variables.firstOrNull().orEmpty() } else null
        solver.value = current.copy(running = true, error = null)
        job = scope.launch {
            try {
                val result = graph.inkRecognizer.solve(current.input, action, variable)
                solver.value = solver.value?.copy(running = false, result = result)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                solver.value = solver.value?.copy(running = false, error = recognitionUi(error.message ?: "Der Ausdruck konnte nicht berechnet werden."))
            }
        }
    }

    /** Writes the solution beside or under the expression in the writer's glyphs (school script where none). */
    fun insertSolutionInk() {
        val current = solver.value ?: return
        val result = current.result ?: return
        val rect = current.rect ?: return
        val document = model.session.document
        val samples = glyphsForSynthesis(model.glyphSamples.value)
        val style = model.style.value
        scope.launch {
            val synthesis = withContext(Dispatchers.Default) {
                var layout = solverLayout(result, rect, document.sourceWidth, document.sourceHeight)
                fun write(placement: SolverPlacement): ch.fasrv.fanotes.ink.HandwritingSynthesisResult {
                    layout = solverLayout(result, rect, document.sourceWidth, document.sourceHeight, placement)
                    val text = adaptMathTextToSamples(solverContinuationText(result, placement), samples)
                    val options = HandwritingSynthesisOptions(
                        fontSize = layout.fontSize,
                        lineSpacing = 1.42,
                        variation = 0.5,
                        connectLetters = false,
                        color = style.color,
                        baseWidth = style.baseWidth,
                        pressureEnabled = style.pressureEnabled,
                        seed = createHandwritingSeed(),
                        marginLeft = layout.marginLeft,
                        marginRight = 44.0,
                        marginTop = 18.0,
                        marginBottom = 42.0,
                        startY = layout.startY,
                    )
                    val pageSize = HandwritingPage(document.sourceWidth, document.sourceHeight)
                    return if (placement == SolverPlacement.SAME_LINE) synthesizeHandwriting(text, samples, options, pageSize)
                    else synthesizeHandwritingToFit(text, samples, options, pageSize, 18.0)
                }
                var out = write(layout.placement)
                if (layout.placement == SolverPlacement.SAME_LINE && out.lineCount > 1) out = write(SolverPlacement.NEXT_LINE)
                out
            }
            when {
                synthesis.missingCharacters.isNotEmpty() -> notice(
                    "Für die handschriftliche Lösung fehlen Trainingszeichen: ${synthesis.missingCharacters.take(8).joinToString(", ") { if (it == " ") "Leerzeichen" else "„$it“" }}. Ergänze sie in GlyphenWerk.",
                )
                synthesis.overflow || synthesis.strokes.isEmpty() -> notice("Unter oder neben dem Ausdruck ist auf dieser Seite nicht genug Platz für die vollständige Lösung.")
                else -> {
                    model.insertHandwriting(synthesis)
                    solver.value = null
                }
            }
        }
    }

    /** The solution as a display formula in the note text (`insertMath`). */
    fun insertSolutionMarkdown() {
        val result = solver.value?.result ?: return
        val lines = listOf(result.inputLatex.ifBlank { result.normalizedInput }) + result.steps.map { it.latex.ifBlank { it.expression } }
        model.insertMath(lines.joinToString(" \\\\\n"))
        solver.value = null
    }

    fun closeSolver() {
        job?.cancel()
        solver.value = null
    }

    // ---- Step checker ("Rechenweg prüfen") ----

    fun startCheck() {
        if (!requireEnabled()) return
        val (strokes, _) = scopedStrokes(selectionOnly = true) ?: return
        conversion.value = null
        solver.value = null
        cancelRuns()
        checker.value = CheckUi(running = true)
        job = scope.launch {
            try {
                val outcome = graph.inkRecognizer.checkSteps(page(strokes))
                checker.value = CheckUi(running = false, lines = outcome.lines, result = outcome.result)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                checker.value = CheckUi(running = false, error = recognitionUi(error.message ?: "Der ausgewählte Rechenweg konnte nicht gelesen werden."))
            }
        }
    }

    /** A corrected or confirmed line no longer blocks the verdict (`confirmed`). */
    fun editCheckLine(index: Int, input: String) {
        val current = checker.value ?: return
        checker.value = current.copy(lines = current.lines.mapIndexed { i, line -> if (i == index) line.copy(input = input, confirmed = true) else line })
    }

    fun recheck() {
        val current = checker.value ?: return
        if (current.lines.isEmpty()) return
        checker.value = current.copy(running = true, error = null)
        job = scope.launch {
            try {
                val result = graph.inkRecognizer.verifyLines(current.lines)
                checker.value = checker.value?.copy(running = false, result = result)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                checker.value = checker.value?.copy(running = false, error = recognitionUi(error.message ?: "Der Rechenweg konnte nicht geprüft werden."))
            }
        }
    }

    fun closeCheck() {
        job?.cancel()
        checker.value = null
    }

    // ---- Invisible transcript ----

    /**
     * After a save: read the page again once the pen rests, and store the transcript the search,
     * the document index and the margin use. A later save restarts the wait.
     */
    fun afterSave() {
        if (!enabled || !graph.inkRecognizer.bundled) return
        if (job?.isActive == true) return
        val path = model.open.value?.path ?: return
        val strokes = handwritingStrokes(model.session.document.strokes)
        if (strokes.isEmpty()) return
        val known = indexed[path]
        if (known != null && known.first == strokes.size && known.second == strokePrefixSignature(strokes, strokes.size)) return
        transcriptJob?.cancel()
        transcriptJob = scope.launch {
            delay(TRANSCRIPT_IDLE_MS)
            val document = model.session.document
            val current = handwritingStrokes(document.strokes)
            if (model.open.value?.path != path || current.isEmpty()) return@launch
            val previous = indexed[path]
            val prefixChanged = previous != null && (previous.first > current.size || previous.second != strokePrefixSignature(current, previous.first))
            val plan = transcriptPlan(current.size, previous?.first ?: 0, needsFullRebuild = previous == null || prefixChanged)
            val entries = runCatching { graph.inkRecognizer.transcribe(page(current.drop(plan.start)), preference, lastMode) }.getOrElse { error ->
                if (error is kotlinx.coroutines.CancellationException) throw error
                return@launch
            }
            val after = handwritingStrokes(model.session.document.strokes)
            if (model.open.value?.path != path || after.size != current.size || strokePrefixSignature(after, after.size) != strokePrefixSignature(current, current.size)) return@launch
            val merged = mergeTranscript(model.session.document.extras.string("searchTranscript").orEmpty(), entries, plan.replace)
            indexed[path] = current.size to strokePrefixSignature(current, current.size)
            if (model.session.setSearchTranscript(merged)) model.noteChanged()
        }
    }

    // ---- GlyphenWerk capture ----

    fun saveGlyph(sample: GlyphSample) {
        val merged = (model.glyphSamples.value + sample).takeLast(4_000)
        model.glyphSamples.value = merged
        scope.launch(Dispatchers.IO) {
            graph.writeGlyphLibrary(encodeGlyphLibrary(merged))
            graph.handwritingLearning.request()
        }
    }

    fun removeGlyph(id: String) {
        val merged = model.glyphSamples.value.filterNot { it.id == id }
        model.glyphSamples.value = merged
        scope.launch(Dispatchers.IO) {
            graph.writeGlyphLibrary(encodeGlyphLibrary(merged))
            graph.handwritingLearning.request()
        }
    }

    // ---- Model download ----

    fun downloadModel() = graph.inkModels.download()

    fun cancelDownload() = graph.inkModels.cancel()

    fun removeModel() {
        scope.launch { graph.inkModels.remove { graph.inkRecognizer.destroy() } }
    }

    companion object {
        private const val TRANSCRIPT_IDLE_MS = 2_500L
    }
}
