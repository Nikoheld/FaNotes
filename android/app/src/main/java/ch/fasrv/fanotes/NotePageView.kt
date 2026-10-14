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
    private val toolbar = HorizontalScrollView(context)
    private val tools = LinearLayout(context)
    private val handle = TextView(context)
    private val syncPill = TextView(context)
    private var boundPath = ""
    private var writing = false
    private var textMode = false
    private var followPen = true
    private var userOpen = true
    private var penDown = false
    private var dark = true

    var onTool: (InkTool) -> Unit = {}
    var onSync: () -> Unit = {}
    var onMarkdown: (String) -> Unit = {}
    var onUndo: () -> Unit = {}
    var onRedo: () -> Unit = {}
    var onColor: (String) -> Unit = {}
    var onWidth: (Float) -> Unit = {}
    var onPaper: (String) -> Unit = {}
    var onBrush: (String) -> Unit = {}
    var onToggleRail: () -> Unit = {}
    var onTextMode: (Boolean) -> Unit = {}
    var onDeleteSelection: () -> Unit = {}
    var onDuplicate: () -> Unit = {}
    var onClear: () -> Unit = {}
    var onFinger: (Boolean) -> Unit = {}
    var onMath: () -> Unit = {}

    init {
        clipChildren = true
        clipToPadding = true
        setBackgroundColor(0xFFE8E6E1.toInt())
        addView(ink, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        editor.background = null
        editor.setTextColor(0xFF252630.toInt())
        editor.setHintTextColor(0xFF8A8D98.toInt())
        editor.hint = "Text auf dem Papier"
        editor.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        editor.setLineSpacing(0f, 1.55f)
        editor.gravity = Gravity.TOP or Gravity.START
        editor.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        editor.visibility = GONE
        editor.addTextChangedListener(simpleWatcher { if (!writing) onMarkdown(editor.text?.toString().orEmpty()) })
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
    ) {
        if (dark != darkChrome) {
            dark = darkChrome
            applyChromeColors()
        }
        ink.inkTool = tool
        ink.style = style
        ink.fingerDraws = fingerDraws
        if (path != boundPath) {
            boundPath = path
            writing = true
            editor.setText(markdown)
            editor.setSelection(editor.text?.length ?: 0)
            writing = false
        }
        ink.markdown = markdown
        if (textMode != text) setTextMode(text)
        syncPill.text = if (syncBusy && !syncLabel.contains('/')) "Startet…" else syncLabel
        val signature = "$tool|${style.color}|${style.brush}|$paper|$fingerDraws|$text|$canUndo|$canRedo|$dark|$followPen"
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

    private fun wrapSelection(before: String, after: String) {
        val start = editor.selectionStart.coerceAtLeast(0)
        val end = editor.selectionEnd.coerceAtLeast(start)
        val selected = editor.text?.substring(start, end).orEmpty().ifEmpty { "Text" }
        editor.text?.replace(start, end, "$before$selected$after")
    }

    private fun insertLine(prefix: String) {
        val start = editor.selectionStart.coerceAtLeast(0)
        editor.text?.insert(start, prefix)
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
        tools.addView(chip("Fett") { wrapSelection("**", "**") })
        tools.addView(chip("Liste") { insertLine("- ") })
        tools.addView(chip("Aufgabe") { insertLine("- [ ] ") })
        tools.addView(chip("Zitat") { insertLine("> ") })
        tools.addView(chip("Tabelle") { insertLine("\n| Thema | Notiz |\n| --- | --- |\n|  |  |\n") })
        tools.addView(guideChip("Lineal", DraftingKind.RULER))
        tools.addView(guideChip("Geodreieck", DraftingKind.SET_SQUARE))
        tools.addView(guideChip("Zirkel", DraftingKind.COMPASS))
        tools.addView(chip("Kreis") {
            if (!ink.guideOn(DraftingKind.COMPASS)) ink.toggleGuide(DraftingKind.COMPASS)
            ink.drawCompassCircle()
        })
        tools.addView(chip("Mathe") { onMath() })
        val mark = chip("Markieren") {}
        mark.setOnClickListener {
            ink.placingHighlight = !ink.placingHighlight
            mark.text = if (ink.placingHighlight) "Markieren ●" else "Markieren"
        }
        tools.addView(mark)
        tools.addView(chip("+") { ink.zoomBy(1.15f) })
        tools.addView(chip("−") { ink.zoomBy(1f / 1.15f) })
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

    private fun placeEditor() {
        if (editor.visibility != VISIBLE) return
        val scale = ink.cameraScale().coerceAtLeast(0.2f)
        editor.setTextSize(TypedValue.COMPLEX_UNIT_PX, 16f * scale)
        val x = (ink.cameraLeft() + 72f * scale).toInt()
        val y = (ink.cameraTop() + 78f * scale).toInt()
        val width = ((900f - 144f) * scale).toInt().coerceAtLeast(dp(80))
        val height = (ink.height - y).coerceAtLeast(dp(40))
        editor.measure(
            MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
        )
        editor.layout(x, y, x + width, y + height)
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
            "fineliner" to "Fein",
            "pencil" to "Blei",
            "marker" to "Marker",
            "highlighter" to "Textmarker",
            "calligraphy" to "Feder",
        )
    }
}

private fun android.text.Editable?.orEmpty() = this?.toString().orEmpty()

private fun simpleWatcher(onChange: () -> Unit) = object : android.text.TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
    override fun afterTextChanged(s: android.text.Editable?) = onChange()
}
