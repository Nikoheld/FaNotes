package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ScrollView
import android.widget.TextView
import android.graphics.DashPathEffect
import ch.fasrv.fanotes.desk.AutocorrectEdit
import ch.fasrv.fanotes.desk.AutocorrectMark
import ch.fasrv.fanotes.desk.SpellingDictionaries
import ch.fasrv.fanotes.desk.SpellingError
import ch.fasrv.fanotes.desk.SpellingLexicon
import ch.fasrv.fanotes.desk.SpellingLine
import ch.fasrv.fanotes.desk.autocorrectAfterEdit
import ch.fasrv.fanotes.desk.checkNoteSpelling
import ch.fasrv.fanotes.desk.loadBundledSpelling
import ch.fasrv.fanotes.desk.normalizeForDictionary
import ch.fasrv.fanotes.desk.suggestCorrections
import java.util.concurrent.Executors

/**
 * Red wavy underlines and the desktop suggestion menu for one editor.
 * Dictionaries stay on the device; the check runs off the UI thread.
 */
class SpellingController(private val view: EditText) {
    var enabled: Boolean = true
    var autocorrect: Boolean = true
    var accentColor: Int = 0xFF2A6F97.toInt()
    var waveColor: Int = 0xFFC03543.toInt()
    var inkColor: Int = 0xFF1C1C1C.toInt()
    var paperColor: Int = 0xFFFFFFFF.toInt()
    var acceptedWords: () -> Set<String> = { emptySet() }
    var onLanguage: (String) -> Unit = {}
    var onLearn: (String) -> Unit = {}
    var onIgnore: (String) -> Unit = {}

    private var epoch = -1
    private var token = 0
    private var errors: List<SpellingError> = emptyList()
    private var lines: List<SpellingLine> = emptyList()
    private var popup: PopupWindow? = null
    private var mark: AutocorrectMark? = null
    private var markText: String? = null
    private val declined = HashSet<String>()
    private val handler = Handler(Looper.getMainLooper())
    private val wave = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    fun configure(
        enabled: Boolean,
        waveColor: Int,
        inkColor: Int,
        paperColor: Int,
        epoch: Int,
        acceptedWords: () -> Set<String>,
        onLanguage: (String) -> Unit,
        onLearn: (String) -> Unit,
        onIgnore: (String) -> Unit,
    ) {
        val turned = enabled != this.enabled || epoch != this.epoch
        this.enabled = enabled
        this.waveColor = waveColor
        this.inkColor = inkColor
        this.paperColor = paperColor
        this.epoch = epoch
        this.acceptedWords = acceptedWords
        this.onLanguage = onLanguage
        this.onLearn = onLearn
        this.onIgnore = onIgnore
        if (!enabled) clear() else if (turned) schedule(0) else view.invalidate()
    }

    /**
     * One desktop autocorrect step. Returns the editor text to install, or null
     * when this keystroke should stay as typed.
     */
    fun autocorrectEdit(before: String, next: String, changeStart: Int, changeDeleted: Int): AutocorrectEdit? {
        if (!enabled && mark == null) return null
        val edit = autocorrectAfterEdit(
            before,
            next,
            changeStart,
            changeDeleted,
            enabled && autocorrect,
            SpellingBundle.readyLexicon(acceptedWords()),
            ::languageAt,
            mark,
            { normalizeForDictionary(it) in declined },
            { false },
        )
        val declinedWord = edit?.declined
        if (declinedWord != null) {
            val key = normalizeForDictionary(declinedWord)
            if (key.isNotEmpty()) declined += key
        }
        mark = edit?.mark
        markText = if (edit?.mark == null) null else edit.text
        if (edit != null) popup?.dismiss()
        return edit
    }

    fun finishAutocorrect() {
        mark = null
        markText = null
    }

    fun schedule(delayMs: Long) {
        popup?.dismiss()
        val current = ++token
        handler.removeCallbacksAndMessages(SCHEDULE)
        if (!enabled) {
            clear()
            return
        }
        handler.postDelayed({
            if (current != token) return@postDelayed
            val text = view.text?.toString().orEmpty()
            val cursors = listOf(view.selectionStart, view.selectionEnd).filter { it >= 0 }
            val accepted = acceptedWords()
            executor.execute {
                val dictionaries = SpellingBundle.bloom() ?: return@execute
                SpellingBundle.warm()
                val result = runCatching {
                    checkNoteSpelling(text, cursors, dictionaries, accepted)
                }.getOrNull() ?: return@execute
                handler.post {
                    if (current != token) return@post
                    errors = result.errors
                    lines = result.lines
                    view.invalidate()
                    onLanguage(result.detectedLanguage)
                }
            }
        }, SCHEDULE, delayMs)
    }

    fun draw(canvas: Canvas) {
        val layout = view.layout ?: return
        if (!enabled || (errors.isEmpty() && mark == null)) return
        val density = view.resources.displayMetrics.density
        wave.color = waveColor
        wave.strokeWidth = 1.5f * density
        val offset = 3f * density
        val amplitude = 1.05f * density
        val period = 3.6f * density
        for (error in errors) {
            val startLine = layout.getLineForOffset(error.from.coerceIn(0, layout.text.length))
            val endLine = layout.getLineForOffset((error.to - 1).coerceAtLeast(error.from).coerceIn(0, layout.text.length))
            for (line in startLine..endLine) {
                val lineStart = layout.getLineStart(line)
                val lineEnd = layout.getLineEnd(line)
                val from = maxOf(error.from, lineStart)
                val to = minOf(error.to, lineEnd)
                if (from >= to) continue
                val left = view.paddingLeft + layout.getPrimaryHorizontal(from)
                val right = view.paddingLeft + horizontalEnd(layout, to)
                val baseline = view.paddingTop + layout.getLineBaseline(line) - view.scrollY
                if (baseline < -view.height || baseline > view.height * 2) continue
                drawWave(canvas, left, right, baseline + offset, amplitude, period)
            }
        }
        val corrected = mark?.takeIf { view.text?.toString() == markText } ?: return
        val previous = wave.pathEffect
        wave.color = accentColor
        wave.pathEffect = DashPathEffect(floatArrayOf(1.5f * density, 2.5f * density), 0f)
        val startLine = layout.getLineForOffset(corrected.from.coerceIn(0, layout.text.length))
        val endLine = layout.getLineForOffset((corrected.to - 1).coerceAtLeast(corrected.from).coerceIn(0, layout.text.length))
        for (line in startLine..endLine) {
            val from = maxOf(corrected.from, layout.getLineStart(line))
            val to = minOf(corrected.to, layout.getLineEnd(line))
            if (from >= to) continue
            val left = view.paddingLeft + layout.getPrimaryHorizontal(from)
            val right = view.paddingLeft + horizontalEnd(layout, to)
            val baseline = view.paddingTop + layout.getLineBaseline(line) - view.scrollY
            drawWave(canvas, left, right, baseline + offset, amplitude * 0.6f, period)
        }
        wave.pathEffect = previous
    }

    private fun languageAt(offset: Int): String? =
        lines.firstOrNull { offset in it.from until it.to }?.language

    fun showAt(offset: Int): Boolean {
        if (!enabled) return false
        val error = errors.firstOrNull { offset in it.from..it.to } ?: return false
        show(error)
        return true
    }

    fun showAtCursor(): Boolean = showAt(view.selectionEnd.coerceAtLeast(0))

    private fun clear() {
        errors = emptyList()
        lines = emptyList()
        mark = null
        markText = null
        popup?.dismiss()
        view.invalidate()
        onLanguage("unknown")
    }

    private fun show(error: SpellingError) {
        popup?.dismiss()
        val language = lines.firstOrNull { error.from in it.from..it.to }?.language
        val window = popupWindow(menuView(error, emptyList(), loading = true))
        popup = window
        place(window, error.from)
        val personal = acceptedWords()
        executor.execute {
            val lexicon = SpellingBundle.lexicon(personal)
            val suggestions = if (lexicon == null || !lexicon.isMisspelled(error.word)) {
                emptyList()
            } else {
                val languages = if (language == "de" || language == "en") listOf(language) else lexicon.languages
                suggestCorrections(error.word, languages, lexicon).map { it.word }
            }
            handler.post {
                if (popup !== window) return@post
                window.contentView = menuView(error, suggestions, loading = false)
                window.update()
            }
        }
    }

    private fun menuView(error: SpellingError, suggestions: List<String>, loading: Boolean): View {
        val column = LinearLayout(view.context).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(4)
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                setColor(paperColor)
                cornerRadius = dp(12).toFloat()
                setStroke(dp(1), waveColor and 0x33FFFFFF or (waveColor and 0x00FFFFFF))
            }
            minimumWidth = dp(220)
        }
        column.addView(label(error.word, bold = true))
        when {
            loading -> column.addView(label("Vorschläge werden geladen…", muted = true))
            suggestions.isEmpty() -> column.addView(label("Keine Vorschläge", muted = true))
            else -> suggestions.forEach { suggestion ->
                column.addView(button(suggestion) { replace(error, suggestion) })
            }
        }
        column.addView(button("Ignorieren") {
            onIgnore(error.word)
            schedule(0)
        })
        column.addView(button("Zum Wörterbuch hinzufügen") {
            onLearn(error.word)
            schedule(0)
        })
        return ScrollView(view.context).apply {
            addView(column)
            isVerticalScrollBarEnabled = false
        }
    }

    private fun label(text: String, bold: Boolean = false, muted: Boolean = false) = TextView(view.context).apply {
        this.text = text
        setTextColor(if (muted) inkColor and 0x99FFFFFF.toInt() or (inkColor and 0x00FFFFFF) else inkColor)
        textSize = if (bold) 15f else 13f
        if (bold) typeface = android.graphics.Typeface.DEFAULT_BOLD
        setPadding(dp(10), dp(8), dp(10), dp(4))
    }

    private fun button(text: String, click: () -> Unit) = TextView(view.context).apply {
        this.text = text
        setTextColor(inkColor)
        textSize = 14f
        setPadding(dp(10), dp(8), dp(10), dp(8))
        isClickable = true
        setOnClickListener {
            popup?.dismiss()
            click()
        }
    }

    private fun replace(error: SpellingError, replacement: String) {
        val editable = view.text ?: return
        val from = error.from.coerceIn(0, editable.length)
        val to = error.to.coerceIn(from, editable.length)
        if (editable.subSequence(from, to).toString() != error.word) return
        editable.replace(from, to, replacement)
        view.setSelection((from + replacement.length).coerceIn(0, editable.length))
    }

    private fun popupWindow(content: View) = PopupWindow(content, dp(280), WRAP_CONTENT, true).apply {
        isOutsideTouchable = true
        elevation = dp(8).toFloat()
        setBackgroundDrawable(android.graphics.drawable.ColorDrawable(0))
    }

    private fun place(window: PopupWindow, offset: Int) {
        val layout = view.layout
        val line = layout?.getLineForOffset(offset.coerceIn(0, layout.text.length)) ?: 0
        val x = if (layout == null) 0 else (view.paddingLeft + layout.getPrimaryHorizontal(offset)).toInt()
        val y = if (layout == null) 0 else view.paddingTop + layout.getLineBottom(line) - view.scrollY
        val origin = IntArray(2)
        view.getLocationOnScreen(origin)
        window.showAtLocation(view, Gravity.NO_GRAVITY, origin[0] + x, origin[1] + y)
    }

    private fun drawWave(canvas: Canvas, left: Float, right: Float, y: Float, amplitude: Float, period: Float) {
        if (right - left < 1f) return
        val path = Path()
        var x = left
        var up = true
        path.moveTo(x, y)
        while (x < right) {
            val next = (x + period).coerceAtMost(right)
            val mid = (x + next) / 2f
            path.quadTo(mid, if (up) y - amplitude else y + amplitude, next, y)
            x = next
            up = !up
        }
        canvas.drawPath(path, wave)
    }

    private fun horizontalEnd(layout: Layout, offset: Int): Float =
        layout.getPrimaryHorizontal(offset.coerceIn(0, layout.text.length))

    private fun dp(value: Int) = (value * view.resources.displayMetrics.density).toInt()

    private companion object {
        val SCHEDULE = Any()
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "fanotes-spelling").apply { isDaemon = true }
        }
    }
}

private object SpellingBundle {
    private val gate = Any()
    private var bloom: SpellingDictionaries? = null
    private var full: SpellingDictionaries? = null
    private var bloomFailed = false
    private var fullFailed = false

    fun bloom(): SpellingDictionaries? = synchronized(gate) {
        if (bloomFailed) return null
        bloom ?: try {
            loadBundledSpelling(includeCandidates = false).also { bloom = it }
        } catch (_: Exception) {
            bloomFailed = true
            null
        }
    }

    fun warm() {
        lexicon(emptySet())
    }

    fun readyLexicon(personal: Set<String>): SpellingLexicon? = synchronized(gate) {
        val dictionaries = full ?: return null
        if (dictionaries.deWords == null || dictionaries.enWords == null) return null
        SpellingLexicon(dictionaries, personal)
    }

    fun lexicon(personal: Set<String>): SpellingLexicon? = synchronized(gate) {
        if (fullFailed) return null
        val dictionaries = full ?: try {
            loadBundledSpelling(includeCandidates = true).also {
                full = it
                bloom = it
            }
        } catch (_: Exception) {
            fullFailed = true
            return null
        }
        if (dictionaries.deWords == null || dictionaries.enWords == null) return null
        SpellingLexicon(dictionaries, personal)
    }
}
