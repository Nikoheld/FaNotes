package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import ch.fasrv.fanotes.ink.DraftingKind
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.ink.StrokeStyle

/**
 * The page and its chrome live in one clipped frame. The toolbar is a later
 * sibling of the canvas, so a zoomed sheet cannot paint over it, and hiding
 * the bar does not resize the page under an active pen.
 */
class NotePageView(context: Context) : FrameLayout(context) {
    val ink = InkSurfaceView(context)
    private val editor = EditText(context)
    private val lineNumbers = TextView(context)
    private val toolbar = HorizontalScrollView(context)
    private val tools = LinearLayout(context)
    private val handle = TextView(context)
    private val syncPill = TextView(context)
    private var boundPath = ""
    private var writing = false
    private var editBefore = ""
    private var sourceMarkdown = ""
    private var foldedLines: Set<Int> = emptySet()
    private var textMode = false
    private var followPen = true
    private var userOpen = true
    private var penDown = false
    private var dark = true

    var onTool: (InkTool) -> Unit = {}
    var onSync: () -> Unit = {}
    var onMarkdown: (String) -> Unit = {}
    var onVisibleMarkdown: (String, String) -> Unit = { _, next -> onMarkdown(next) }
    var onRememberCamera: (
        String,
        Double,
        Double,
        Double,
        Double,
        Double,
        Double,
        ch.fasrv.fanotes.desk.PaperTextAnchor?,
    ) -> Unit = { _, _, _, _, _, _, _, _ -> }
    var onRecallCamera: (String) -> ch.fasrv.fanotes.desk.PaperViewMemoryEntry? = { null }
    var onUndo: () -> Unit = {}
    var onRedo: () -> Unit = {}
    var onColor: (String) -> Unit = {}
    var onWidth: (Float) -> Unit = {}
    var onPaper: (String) -> Unit = {}
    var onBrush: (String) -> Unit = {}
    var onEffect: (String) -> Unit = {}
    var onToggleRail: () -> Unit = {}
    var onTextMode: (Boolean) -> Unit = {}
    var onDeleteSelection: () -> Unit = {}
    var onDuplicate: () -> Unit = {}
    var onClear: () -> Unit = {}
    var onFinger: (Boolean) -> Unit = {}
    var onMath: () -> Unit = {}
    var onPdfPage: (Int) -> Unit = {}
    var onSymbolSize: (Double) -> Unit = {}
    var onSymbolRotation: (Double) -> Unit = {}
    var onSymbolOpacity: (Double) -> Unit = {}
    var onSymbolCategory: (String) -> Unit = {}
    var onSymbolPose: () -> Unit = {}
    var onRestyleLink: (String, String) -> Unit = { _, _ -> }

    init {
        clipChildren = true
        clipToPadding = true
        setBackgroundColor(0xFFE8E6E1.toInt())
        ink.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        addView(ink, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        editor.background = null
        editor.setTextColor(0xFF252630.toInt())
        editor.setHintTextColor(0xFF8A8D98.toInt())
        editor.hint = "Text auf dem Papier"
        editor.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        editor.setLineSpacing(0f, 1.72f)
        editor.gravity = Gravity.TOP or Gravity.START
        editor.setPadding(0, 0, 0, 0)
        lineNumbers.setTextColor(0xFF8A8D98.toInt())
        lineNumbers.gravity = Gravity.TOP or Gravity.END
        lineNumbers.setPadding(0, 0, 0, 0)
        lineNumbers.visibility = GONE
        editor.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        editor.visibility = GONE
        editor.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
                if (!writing) editBefore = s?.toString().orEmpty()
            }
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) {
                if (lineNumbers.visibility == VISIBLE) placeEditor()
                if (!writing) onVisibleMarkdown(editBefore, s?.toString().orEmpty())
            }
        })
        addView(lineNumbers, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        addView(editor, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        tools.orientation = LinearLayout.HORIZONTAL
        tools.gravity = Gravity.CENTER_VERTICAL
        toolbar.isHorizontalScrollBarEnabled = false
        toolbar.addView(tools, LayoutParams(LayoutParams.WRAP_CONTENT, dp(44)))
        toolbar.elevation = 12f
        addView(toolbar, LayoutParams(LayoutParams.MATCH_PARENT, dp(44), Gravity.TOP))
        handle.text = "Werkzeuge"
        handle.gravity = Gravity.CENTER
        handle.textSize = 12f
        handle.visibility = GONE
        handle.setOnClickListener { setChromeOpen(true) }
        handle.elevation = 12f
        addView(handle, LayoutParams(dp(112), dp(28), Gravity.TOP or Gravity.END))
        ink.onCamera = { _, _, _ -> placeEditor() }
        ink.onPenActive = { active ->
            penDown = active
            applyChromeVisibility()
        }
        applyChromeColors()
    }

    fun rememberCamera(path: String) {
        if (path.isEmpty()) return
        val sample = ink.cameraSample() ?: return
        onRememberCamera(
            path,
            sample.zoom,
            sample.rotation,
            sample.centreX,
            sample.centreY,
            sample.pageWidth,
            sample.pageHeight,
            textAnchor(),
        )
    }

    fun restoreCamera(path: String, proportional: Boolean) {
        val entry = onRecallCamera(path) ?: return
        ink.restoreCamera(entry.zoom, entry.rotation, entry.centreX, entry.centreY, entry.pageWidth, proportional)
        val anchor = entry.anchor ?: return
        editor.post { scrollToAnchor(anchor) }
    }

    private fun textAnchor(): ch.fasrv.fanotes.desk.PaperTextAnchor? {
        if (editor.visibility != VISIBLE) return null
        val layout = editor.layout ?: return null
        if (layout.lineCount <= 0) return null
        val line = layout.getLineForVertical(editor.scrollY.coerceAtLeast(0)).coerceIn(0, layout.lineCount - 1)
        val scale = (editor.textSize / 16f).coerceAtLeast(0.01f)
        val offset = (editor.scrollY - layout.getLineTop(line)) / scale
        return ch.fasrv.fanotes.desk.PaperTextAnchor(layout.getLineStart(line), kotlin.math.floor(offset * 100.0 + 0.5) / 100.0)
    }

    private fun scrollToAnchor(anchor: ch.fasrv.fanotes.desk.PaperTextAnchor) {
        val layout = editor.layout ?: return
        val length = layout.text?.length ?: editor.text?.length ?: 0
        val pos = anchor.pos.coerceIn(0, length)
        val line = layout.getLineForOffset(pos)
        val scale = editor.textSize / 16f
        val y = layout.getLineTop(line) + (anchor.offset * scale).toInt()
        editor.scrollTo(0, y.coerceAtLeast(0))
    }

    fun revealRange(start: Int, end: Int) {
        if (!textMode) setTextMode(true)
        val length = editor.text?.length ?: 0
        val from = start.coerceIn(0, length)
        val to = end.coerceIn(from, length)
        editor.requestFocus()
        editor.setSelection(from, to)
        editor.post {
            val layout = editor.layout ?: return@post
            val safe = from.coerceAtMost(layout.text.length)
            val top = layout.getLineTop(layout.getLineForOffset(safe))
            editor.scrollTo(0, (top - editor.paddingTop).coerceAtLeast(0))
        }
    }

    fun revealLine(line: Int) {
        val sourceOffset = ch.fasrv.fanotes.desk.revealLineStart(sourceMarkdown, line)
        val offset = ch.fasrv.fanotes.desk.visibleOffsetForSource(sourceMarkdown, foldedLines, sourceOffset)
            .coerceIn(0, editor.text?.length ?: 0)
        if (!textMode) setTextMode(true)
        editor.requestFocus()
        editor.setSelection(offset)
        editor.post {
            val layout = editor.layout ?: return@post
            val safe = offset.coerceAtMost(layout.text.length)
            val top = layout.getLineTop(layout.getLineForOffset(safe))
            editor.scrollTo(0, (top - editor.paddingTop).coerceAtLeast(0))
        }
    }

    fun apply(
        path: String,
        markdown: String,
        tool: InkTool,
        style: StrokeStyle,
        paper: String,
        fingerDraws: Boolean,
        text: Boolean,
        syncLabel: String,
        syncBusy: Boolean,
        canUndo: Boolean,
        canRedo: Boolean,
        darkChrome: Boolean,
        folded: Set<Int> = emptySet(),
        metrics: ch.fasrv.fanotes.desk.EditorMetrics = ch.fasrv.fanotes.desk.editorMetrics(emptyMap()),
    ) {
        ink.onPdfPage = onPdfPage
        if (dark != darkChrome) {
            dark = darkChrome
            applyChromeColors()
        }
        ink.inkTool = tool
        ink.style = style
        ink.fingerDraws = fingerDraws
        ink.editorFontPx = metrics.fontSizePx.toFloat()
        ink.editorLineHeight = metrics.lineHeight.toFloat()
        ink.contentWidthPx = metrics.contentWidthPx.toFloat()
        ink.readableLineLength = metrics.readableLineLength
        ink.setEditorFont(metrics.editorFontId)
        ink.showLineNumbers = metrics.showLineNumbers
        editor.typeface = ink.editorTypeface
        ink.zoomMax = metrics.zoomMax.toFloat()
        ink.zoomSpeed = metrics.zoomSpeed
        sourceMarkdown = markdown
        foldedLines = folded
        val visible = ch.fasrv.fanotes.desk.markdownWithFolds(markdown, folded)
        val shown = editor.text?.toString().orEmpty()
        if (path != boundPath || shown != visible) {
            val cursor = if (path != boundPath) visible.length else editor.selectionStart.coerceIn(0, visible.length)
            boundPath = path
            writing = true
            editor.setText(visible)
            editor.setSelection(cursor)
            writing = false
        }
        if (ink.markdown != visible) {
            ink.markdown = visible
            ink.invalidate()
        }
        if (textMode != text) setTextMode(text)
        syncPill.text = if (syncBusy && !syncLabel.contains('/')) "Startet…" else syncLabel
        val signature = "$tool|${style.color}|${style.brush}|${style.colorEffect}|${ink.placingSymbol}|${ink.symbolSize}|${ink.symbolRotation}|${ink.symbolOpacity}|${ink.symbolCategory}|$paper|$fingerDraws|$text|$canUndo|$canRedo|$dark|$followPen"
        if (signature != toolSignature) {
            toolSignature = signature
            rebuildTools(tool, style, paper, fingerDraws, canUndo, canRedo)
        } else if (!widthFromUser) {
            widthBar?.progress = widthProgress(style.baseWidth.toFloat())
        }
    }

    private var toolSignature = ""
    private var widthBar: SeekBar? = null
    private var widthFromUser = false

    fun attachSession(session: ch.fasrv.fanotes.ink.InkSession) {
        ink.session = session
    }

    private fun setTextMode(on: Boolean) {
        textMode = on
        editor.visibility = if (on) VISIBLE else GONE
        ink.showMarkdown = !on
        ink.invalidate()
        if (on) {
            editor.requestFocus()
            val imm = context.getSystemService(InputMethodManager::class.java)
            imm.showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
            placeEditor()
        } else {
            editor.clearFocus()
            val imm = context.getSystemService(InputMethodManager::class.java)
            imm.hideSoftInputFromWindow(windowToken, 0)
        }
    }

    private fun format(action: String) {
        val start = editor.selectionStart.coerceAtLeast(0)
        val end = editor.selectionEnd.coerceAtLeast(start)
        val result = ch.fasrv.fanotes.desk.applyMarkdownFormat(editor.text?.toString().orEmpty(), start, end, action)
        editor.setText(result.text)
        val from = result.selectionStart.coerceIn(0, result.text.length)
        val to = result.selectionEnd.coerceIn(from, result.text.length)
        editor.setSelection(from, to)
    }

    private fun setChromeOpen(open: Boolean) {
        userOpen = open
        applyChromeVisibility()
    }

    private fun applyChromeVisibility() {
        val visible = userOpen && !(followPen && penDown)
        toolbar.visibility = if (visible) VISIBLE else GONE
        handle.visibility = if (visible) GONE else VISIBLE
    }

    private fun rebuildTools(
        tool: InkTool,
        style: StrokeStyle,
        paper: String,
        fingerDraws: Boolean,
        canUndo: Boolean,
        canRedo: Boolean,
    ) {
        tools.removeAllViews()
        tools.addView(chip("Notizen") { onToggleRail() })
        tools.addView(segment(tool))
        PenColors.forEach { color ->
            tools.addView(swatch(color, color.equals(style.color, true)) { onColor(color) })
        }
        tools.addView(widthSlider(style.baseWidth.toFloat()))
        val brush = Brushes.firstOrNull { it.first == style.brush }?.second ?: "Fein"
        tools.addView(chip(brush) {
            val index = Brushes.indexOfFirst { it.first == style.brush }.let { if (it < 0) 0 else it }
            onBrush(Brushes[(index + 1) % Brushes.size].first)
        })
        tools.addView(chip(ch.fasrv.fanotes.ink.inkEffectLabel(style.colorEffect)) {
            onEffect(ch.fasrv.fanotes.ink.nextInkEffect(style.colorEffect))
        })
        val symbolChip = chip(ch.fasrv.fanotes.ink.artSymbol(ink.placingSymbol)?.label ?: "Symbol") {}
        symbolChip.setOnClickListener {
            ink.placingSymbol = ch.fasrv.fanotes.ink.nextArtSymbol(ink.placingSymbol, ink.symbolCategory)
            symbolChip.text = ch.fasrv.fanotes.ink.artSymbol(ink.placingSymbol)?.label ?: "Symbol"
            onSymbolPose()
        }
        tools.addView(chip(ch.fasrv.fanotes.ink.artSymbolCategoryLabel(ink.symbolCategory)) {
            val next = ch.fasrv.fanotes.ink.nextArtSymbolCategory(ink.symbolCategory)
            ink.symbolCategory = next
            onSymbolCategory(next)
            onSymbolPose()
        })
        if (ink.placingSymbol != null) {
            tools.addView(chip("${ink.symbolSize.toInt()} px") {
                onSymbolSize(ch.fasrv.fanotes.ink.stepArtSymbolSize(ink.symbolSize, 1))
            })
            tools.addView(chip("${ink.symbolRotation.toInt()}°") {
                onSymbolRotation(ch.fasrv.fanotes.ink.stepArtSymbolRotation(ink.symbolRotation, 1))
            })
            tools.addView(chip("${(ink.symbolOpacity * 100).toInt()}%") {
                onSymbolOpacity(ch.fasrv.fanotes.ink.stepArtSymbolOpacity(ink.symbolOpacity, 1))
            })
        }
        tools.addView(symbolChip)
        val paperLabel = Papers.firstOrNull { it.first == paper }?.second ?: "Punkte"
        tools.addView(chip(paperLabel) {
            val index = Papers.indexOfFirst { it.first == paper }.let { if (it < 0) 0 else it }
            onPaper(Papers[(index + 1) % Papers.size].first)
        })
        tools.addView(chip("↶", enabled = canUndo) { onUndo() })
        tools.addView(chip("↷", enabled = canRedo) { onRedo() })
        tools.addView(chip(if (textMode) "Stift" else "Text") { onTextMode(!textMode) })
        tools.addView(chip(if (fingerDraws) "Finger schreibt" else "Finger blättert") { onFinger(!fingerDraws) })
        tools.addView(chip("Auswahl löschen") { onDeleteSelection() })
        tools.addView(chip(if (followPen) "Leiste folgt" else "Leiste fest") {
            followPen = !followPen
            toolSignature = ""
            if (!followPen) setChromeOpen(true) else applyChromeVisibility()
        })
        tools.addView(chip("Abschnitt") { ink.placingSection = true })
        tools.addView(chip("Lasso") { onTool(ch.fasrv.fanotes.ink.InkTool.LASSO) })
        tools.addView(chip("Verknüpfung") { ink.placingLink = true })
        ch.fasrv.fanotes.desk.NOTE_LINK_STYLES.forEach { linkStyle ->
            tools.addView(chip(linkStyle.label) {
                ink.noteLinkStyle = linkStyle.id
                ink.selectedLinkId?.let { onRestyleLink(it, linkStyle.id) }
            })
        }
        tools.addView(chip("Entfernen") {
            val id = ink.selectedLinkId ?: ink.linkMarks.lastOrNull()?.id ?: return@chip
            ink.onRemoveLink(id)
            ink.selectedLinkId = null
        })
        tools.addView(chip("Fett") { format("bold") })
        tools.addView(chip("Liste") { format("bulletList") })
        tools.addView(chip("Aufgabe") { format("checklist") })
        tools.addView(chip("Zitat") { format("quote") })
        tools.addView(chip("Tabelle") { format("table") })
        if (textMode) {
            listOf(
                "heading1" to "H1",
                "heading2" to "H2",
                "italic" to "Kursiv",
                "strike" to "Durchgestrichen",
                "inlineCode" to "Code",
                "link" to "Link",
                "numberedList" to "Nummer",
                "mathBlock" to "Matheblock",
                "codeBlock" to "Codeblock",
                "details" to "Details",
                "horizontalRule" to "Linie",
            ).forEach { (action, label) -> tools.addView(chip(label) { format(action) }) }
        }
        tools.addView(guideChip("Lineal", DraftingKind.RULER))
        tools.addView(guideChip("Geodreieck", DraftingKind.SET_SQUARE))
        tools.addView(guideChip("Zirkel", DraftingKind.COMPASS))
        tools.addView(chip("Kreis") {
            if (!ink.guideOn(DraftingKind.COMPASS)) ink.toggleGuide(DraftingKind.COMPASS)
            ink.drawCompassCircle()
        })
        tools.addView(chip("Mathe") { onMath() })
        val textChip = chip(if (ink.placingText) "Auf Seite platzieren" else "Textfeld") {}
        val mark = chip(if (ink.placingHighlight) "Markieren ●" else "Markieren") {}
        textChip.setOnClickListener {
            ink.placingText = !ink.placingText
            if (ink.placingText) ink.placingHighlight = false
            textChip.text = if (ink.placingText) "Auf Seite platzieren" else "Textfeld"
            mark.text = if (ink.placingHighlight) "Markieren ●" else "Markieren"
        }
        mark.setOnClickListener {
            ink.placingHighlight = !ink.placingHighlight
            if (ink.placingHighlight) ink.placingText = false
            mark.text = if (ink.placingHighlight) "Markieren ●" else "Markieren"
            textChip.text = if (ink.placingText) "Auf Seite platzieren" else "Textfeld"
        }
        tools.addView(textChip)
        tools.addView(mark)
        tools.addView(chip("+") { ink.zoomByStep(1) })
        tools.addView(chip("−") { ink.zoomByStep(-1) })
        tools.addView(chip("Drehen") { ink.rotatePage() })
        tools.addView(chip("Ansicht") { ink.resetView() })
        tools.addView(chip("Kopieren") { onDuplicate() })
        tools.addView(chip("Leeren") { onClear() })
        tools.addView(chip("Einklappen") { setChromeOpen(false) })
        tools.addView(syncPill)
    }

    private fun segment(tool: InkTool): LinearLayout {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.background = rounded(if (dark) 0xFF2A2A2A.toInt() else 0xFFE7E4DE.toInt(), dp(8))
        row.addView(seg("Stift", tool == InkTool.PEN) { onTool(InkTool.PEN) })
        row.addView(seg("Radierer", tool == InkTool.ERASER) { onTool(InkTool.ERASER) })
        row.addView(seg("Auswahl", tool == InkTool.SELECT) { onTool(InkTool.SELECT) })
        return row
    }

    private fun seg(label: String, selected: Boolean, click: () -> Unit): TextView {
        val view = TextView(context)
        view.text = label
        view.textSize = 13f
        view.gravity = Gravity.CENTER
        view.setPadding(dp(10), 0, dp(10), 0)
        view.minHeight = dp(32)
        view.setTextColor(if (dark) 0xFFEDEDEC.toInt() else 0xFF252630.toInt())
        if (selected) view.background = rounded(if (dark) 0xFF3A3A3A.toInt() else 0xFFFFFFFF.toInt(), dp(7))
        view.setOnClickListener { click() }
        return view
    }

    private fun guideChip(label: String, kind: DraftingKind): TextView {
        val view = chip(if (ink.guideOn(kind)) "$label ●" else label) {}
        view.setOnClickListener {
            ink.toggleGuide(kind)
            view.text = if (ink.guideOn(kind)) "$label ●" else label
        }
        return view
    }

    private fun chip(label: String, enabled: Boolean = true, click: () -> Unit): TextView {
        val view = TextView(context)
        view.text = label
        view.textSize = 13f
        view.gravity = Gravity.CENTER
        view.setPadding(dp(10), 0, dp(10), 0)
        view.minHeight = dp(32)
        view.isEnabled = enabled
        view.alpha = if (enabled) 1f else 0.38f
        view.setTextColor(if (dark) 0xFFEDEDEC.toInt() else 0xFF252630.toInt())
        view.setOnClickListener { if (enabled) click() }
        val params = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, dp(36))
        params.marginStart = dp(4)
        view.layoutParams = params
        return view
    }

    private fun swatch(color: String, selected: Boolean, click: () -> Unit): View {
        val view = View(context)
        val dot = GradientDrawable()
        dot.shape = GradientDrawable.OVAL
        dot.setColor(android.graphics.Color.parseColor(color))
        if (selected) dot.setStroke(dp(2), if (dark) 0xFFEDEDEC.toInt() else 0xFF252630.toInt())
        view.background = dot
        val params = LinearLayout.LayoutParams(dp(18), dp(18))
        params.marginStart = dp(6)
        view.layoutParams = params
        view.setOnClickListener { click() }
        return view
    }

    private fun widthProgress(value: Float) = (((value - 1.2f) / (14f - 1.2f)) * 100f).toInt().coerceIn(0, 100)

    private fun widthSlider(value: Float): SeekBar {
        val slider = SeekBar(context)
        slider.max = 100
        slider.progress = widthProgress(value)
        slider.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) onWidth(1.2f + (14f - 1.2f) * progress / 100f)
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) { widthFromUser = true }
            override fun onStopTrackingTouch(seekBar: SeekBar?) { widthFromUser = false }
        })
        widthBar = slider
        val params = LinearLayout.LayoutParams(dp(120), dp(36))
        params.marginStart = dp(6)
        slider.layoutParams = params
        return slider
    }

    private fun applyChromeColors() {
        val bg = if (dark) 0xFF191919.toInt() else 0xFFF7F6F3.toInt()
        val fg = if (dark) 0xFFEDEDEC.toInt() else 0xFF252630.toInt()
        toolbar.setBackgroundColor(bg)
        handle.setBackgroundColor(bg)
        handle.setTextColor(fg)
        syncPill.setTextColor(fg)
        syncPill.gravity = Gravity.CENTER
        syncPill.maxLines = 1
        syncPill.ellipsize = TextUtils.TruncateAt.END
        syncPill.textSize = 12f
        syncPill.setPadding(dp(8), 0, dp(8), 0)
        val params = LinearLayout.LayoutParams(dp(132), dp(32))
        params.marginStart = dp(8)
        syncPill.layoutParams = params
        syncPill.background = rounded(if (dark) 0xFF2A2A2A.toInt() else 0xFFE7E4DE.toInt(), dp(8))
        syncPill.setOnClickListener { onSync() }
    }

    fun setWorkspace(kind: String) {
        val next = ch.fasrv.fanotes.desk.workspaceBackground(kind)
        setBackgroundColor(if (next == "clean") 0xFFE8E6E1.toInt() else android.graphics.Color.TRANSPARENT)
        ink.applyWorkspaceKind(next)
    }

    private fun placeEditor() {
        if (editor.visibility != VISIBLE) {
            lineNumbers.visibility = GONE
            return
        }
        val scale = ink.cameraScale().coerceAtLeast(0.2f)
        editor.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale)
        editor.setLineSpacing(0f, ink.editorLineHeight)
        val x = (ink.cameraLeft() + 72f * scale).toInt()
        val y = (ink.cameraTop() + 78f * scale).toInt()
        val width = (ink.textColumnPx() * scale).toInt().coerceAtLeast(dp(80))
        val height = (ink.height - y).coerceAtLeast(dp(40))
        editor.measure(
            MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
        )
        editor.layout(x, y, x + width, y + height)
        if (ink.showLineNumbers) {
            val labels = ch.fasrv.fanotes.desk.editorLineNumberLabels(editor.text?.toString().orEmpty())
            lineNumbers.text = labels.joinToString("\n")
            lineNumbers.typeface = ink.editorTypeface
            lineNumbers.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale * 0.82f)
            lineNumbers.setLineSpacing(0f, ink.editorLineHeight)
            lineNumbers.visibility = VISIBLE
            val gutter = (labels.maxOf { it.length } * ink.editorFontPx * scale * 0.62f).toInt().coerceAtLeast(dp(18))
            lineNumbers.measure(
                MeasureSpec.makeMeasureSpec(gutter, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
            )
            lineNumbers.layout(x - gutter - dp(4), y, x - dp(4), y + height)
        } else {
            lineNumbers.visibility = GONE
        }
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        placeEditor()
    }

    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
        cornerRadius = radius.toFloat()
        setColor(color)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        val PenColors = listOf("#202333", "#2457D6", "#D23B4A", "#1F8A4C", "#E2A21B", "#7A4DD6")
        val Papers = listOf(
            "blank" to "Leer",
            "dots" to "Punkte",
            "squares" to "Häuschen",
            "grid" to "Kariert",
            "lines" to "Linien",
            "millimeter" to "mm",
        )
        val Brushes = listOf(
            "fineliner" to "Fineliner",
            "pencil" to "Bleistift",
            "marker" to "Marker",
            "paintbrush" to "Pinsel",
            "calligraphy" to "Kalligrafie",
            "highlighter" to "Textmarker",
            "watercolor" to "Aquarell",
            "spray" to "Spray",
        )
    }
}

private fun android.text.Editable?.orEmpty() = this?.toString().orEmpty()
