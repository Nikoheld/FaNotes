package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import androidx.core.graphics.PathParser
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.desk.TOUCH_PANEL_RADIUS_DP
import ch.fasrv.fanotes.desk.TOUCH_PANEL_WIDTH_DP
import ch.fasrv.fanotes.desk.TOUCH_TARGET_DP
import ch.fasrv.fanotes.desk.progressToWidth
import ch.fasrv.fanotes.desk.widthToProgress
import ch.fasrv.fanotes.ink.ART_BRUSHES
import ch.fasrv.fanotes.ink.ART_SYMBOL_CATEGORIES
import ch.fasrv.fanotes.ink.ART_SYMBOL_MAX
import ch.fasrv.fanotes.ink.ART_SYMBOL_MIN
import ch.fasrv.fanotes.ink.FIGURE_LINE_MAX
import ch.fasrv.fanotes.ink.FIGURE_LINE_MIN
import ch.fasrv.fanotes.ink.FIGURE_LINE_STEP
import ch.fasrv.fanotes.ink.FIGURE_SIZE_MAX
import ch.fasrv.fanotes.ink.FIGURE_SIZE_MIN
import ch.fasrv.fanotes.ink.FigureStampSpec
import ch.fasrv.fanotes.ink.GRAPH_PRESETS
import ch.fasrv.fanotes.ink.GraphStampSpec
import ch.fasrv.fanotes.ink.INK_EFFECTS
import ch.fasrv.fanotes.ink.MATH_FIGURES
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.artSymbolsIn
import ch.fasrv.fanotes.ink.clampFigureParams
import ch.fasrv.fanotes.ink.mathFigurePaths

/** What the cards read and change; implemented by [NotePageView]. */
internal interface PenCardHost {
    val kit: PenToolbarKit
    val currentStyle: StrokeStyle
    val drawingMode: Boolean
    val recentColors: List<String>
    val armedSymbol: String?
    val symbolSize: Double
    val symbolRotation: Double
    val symbolOpacity: Double
    val symbolCategory: String
    var figureSpec: FigureStampSpec
    var graphSpec: GraphStampSpec?
    val figureArmed: Boolean
    fun changeStyle(next: StrokeStyle)
    fun chooseBrush(id: String)
    fun pickCustomColor(hex: String)
    fun armSymbol(id: String?)
    fun setSymbolSize(value: Double)
    fun setSymbolRotation(value: Double)
    fun setSymbolOpacity(value: Double)
    fun setSymbolCategory(value: String)
    fun armFigure(spec: FigureStampSpec?)
    fun armGraph(spec: GraphStampSpec?)
    fun closeCard()
}

/**
 * One floating card at a time over the page (Zeichenstudio, Breite, Eigene Farbe, Figuren). It is
 * placed beside the toolbar: below the top bar, or next to the side rail.
 */
internal class PenCardFrame(context: Context, private val kit: PenToolbarKit) : FrameLayout(context) {
    var cardId: String? = null
        private set
    private val scroll = object : ScrollView(context) {
        var maxHeight = Int.MAX_VALUE
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val limit = MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST)
            super.onMeasure(widthMeasureSpec, limit)
        }
    }

    init {
        visibility = GONE
        isClickable = true
        elevation = 24f
        scroll.isVerticalScrollBarEnabled = true
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }

    /** [anchor] is the toolbar button in parent coordinates; [band] the bar's far edge. */
    fun show(id: String, content: View, anchor: android.graphics.Rect, vertical: Boolean, rightRail: Boolean, band: Int) {
        cardId = id
        scroll.removeAllViews()
        content.setPadding(kit.dp(14), kit.dp(10), kit.dp(14), kit.dp(14))
        scroll.addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        background = kit.rounded(kit.colors.panel, TOUCH_PANEL_RADIUS_DP, kit.colors.border, 1)
        val host = parent as? View ?: return
        val gap = kit.dp(8)
        val margin = kit.dp(12)
        val width = minOf(kit.dp(TOUCH_PANEL_WIDTH_DP), host.width - 2 * margin).coerceAtLeast(kit.dp(240))
        val params = LayoutParams(width, LayoutParams.WRAP_CONTENT)
        if (!vertical) {
            params.gravity = Gravity.TOP or Gravity.START
            params.topMargin = band + gap
            params.leftMargin = (anchor.left - kit.dp(8)).coerceIn(margin, (host.width - width - margin).coerceAtLeast(margin))
            scroll.maxHeight = host.height - params.topMargin - margin
        } else {
            params.gravity = Gravity.TOP or if (rightRail) Gravity.END else Gravity.START
            if (rightRail) params.rightMargin = band + gap else params.leftMargin = band + gap
            params.topMargin = (anchor.top - kit.dp(8)).coerceIn(margin, (host.height - kit.dp(260)).coerceAtLeast(margin))
            scroll.maxHeight = host.height - params.topMargin - margin
        }
        layoutParams = params
        visibility = VISIBLE
        alpha = 0f
        translationY = -kit.dpf(6f)
        animate().alpha(1f).translationY(0f).setDuration(160).start()
    }

    /** Swaps the content of the open card in place (a tab switch), keeping its position. */
    fun replace(content: View) {
        if (cardId == null) return
        val y = scroll.scrollY
        scroll.removeAllViews()
        content.setPadding(kit.dp(14), kit.dp(10), kit.dp(14), kit.dp(14))
        scroll.addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        scroll.post { scroll.scrollTo(0, y) }
    }

    fun hide() {
        cardId = null
        animate().cancel()
        visibility = GONE
        scroll.removeAllViews()
    }
}

/** Builds the card contents. Each builder returns a fresh column; the host rebuilds on change. */
internal class PenCards(private val context: Context, private val host: PenCardHost, private val refresh: (String) -> Unit) {
    private val kit get() = host.kit
    var studioTab = "brushes"
    var figureTab = "plane"

    private fun column(): LinearLayout = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    private fun gap(dp: Int) = View(context).apply { layoutParams = LinearLayout.LayoutParams(1, kit.dp(dp)) }

    /** Label, value and a slider whose thumb a pen or finger can grab (48 dp tall). */
    fun sliderRow(
        title: String,
        value: Double,
        min: Double,
        max: Double,
        step: Double,
        format: (Double) -> String,
        live: Boolean = true,
        onChange: (Double) -> Unit,
    ): View {
        val box = column()
        val head = LinearLayout(context)
        head.orientation = LinearLayout.HORIZONTAL
        head.addView(kit.label(title, 13f, kit.colors.ink, bold = true), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val out = kit.label(format(value), 13f, kit.colors.muted)
        head.addView(out)
        box.addView(head)
        val bar = SeekBar(context)
        bar.max = 1000
        bar.progress = widthToProgress(value, min, max)
        bar.setPadding(kit.dp(14), 0, kit.dp(14), 0)
        bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                val next = progressToWidth(progress, min, max, step)
                out.text = format(next)
                if (live) onChange(next)
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
            override fun onStopTrackingTouch(seekBar: SeekBar?) {
                if (!live) onChange(progressToWidth(bar.progress, min, max, step))
            }
        })
        box.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, kit.dp(TOUCH_TARGET_DP)))
        return box
    }

    private fun number(value: Double) = if (value % 1.0 == 0.0) value.toInt().toString() else "%.1f".format(value).replace('.', ',')

    // ---- Breite ---------------------------------------------------------------------------

    fun widthCard(): View {
        val box = column()
        val style = host.currentStyle
        val drawing = host.drawingMode
        val symbol = host.armedSymbol
        box.addView(kit.cardHeader("sliders-horizontal", if (symbol != null) "Grösse" else "Breite", if (drawing) "Zeichenstift" else "Schreibstift") { host.closeCard() })
        box.addView(gap(6))
        if (symbol != null) {
            box.addView(sliderRow("Grösse", host.symbolSize, ART_SYMBOL_MIN, ART_SYMBOL_MAX, 2.0, { "${it.toInt()} px" }, live = false) { host.setSymbolSize(it) })
            return box
        }
        val (min, max, step) = if (drawing) Triple(0.75, 42.0, 0.25) else Triple(1.0, 18.0, 0.5)
        val presets = LinearLayout(context)
        presets.orientation = LinearLayout.HORIZONTAL
        for (preset in ch.fasrv.fanotes.desk.penWidthPresets(drawing)) {
            val dot = WidthDotView(context, preset, kit.colors, Math.abs(style.baseWidth - preset) < 0.01)
            dot.contentDescription = "${number(preset)} px"
            dot.setOnClickListener {
                host.changeStyle(style.copy(baseWidth = preset))
                refresh("width")
            }
            presets.addView(dot, LinearLayout.LayoutParams(0, kit.dp(TOUCH_TARGET_DP), 1f))
        }
        box.addView(presets)
        box.addView(gap(4))
        box.addView(sliderRow("Breite", style.baseWidth, min, max, step, { "${number(it)} px" }) { host.changeStyle(host.currentStyle.copy(baseWidth = it)) })
        if (drawing) {
            box.addView(sliderRow("Deckkraft", style.opacity ?: 1.0, 0.12, 1.0, 0.01, { "${Math.round(it * 100)} %" }) {
                host.changeStyle(host.currentStyle.copy(opacity = it))
            })
        }
        return box
    }

    // ---- Eigene Farbe ---------------------------------------------------------------------

    fun colorCard(): View {
        val box = column()
        box.addView(kit.cardHeader("palette", "Eigene Farbe", if (host.drawingMode) "Zeichenfarbe" else "Stiftfarbe") { host.closeCard() })
        box.addView(gap(8))
        val picker = InkColorPickerView(context)
        picker.setColor(host.currentStyle.color)
        val preview = TextView(context)
        preview.textSize = 13f
        preview.setTextColor(kit.colors.ink)
        preview.text = picker.hex()
        picker.onColor = { hex, done ->
            preview.text = hex
            if (done) host.pickCustomColor(hex)
        }
        box.addView(picker, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val hexRow = LinearLayout(context)
        hexRow.orientation = LinearLayout.HORIZONTAL
        hexRow.gravity = Gravity.CENTER_VERTICAL
        val field = EditText(context)
        field.setText(host.currentStyle.color)
        field.textSize = 14f
        field.setTextColor(kit.colors.ink)
        field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        field.hint = "#rrggbb"
        field.setSingleLine()
        hexRow.addView(kit.label("Hex", 13f, kit.colors.muted))
        hexRow.addView(field, LinearLayout.LayoutParams(0, kit.dp(TOUCH_TARGET_DP), 1f).apply { marginStart = kit.dp(8) })
        val apply = kit.chip("Übernehmen") {
            val hex = ch.fasrv.fanotes.ink.normalizeInkHex(field.text?.toString())
            if (hex != null) host.pickCustomColor(hex) else field.error = ChromeText.ui("Ungültige Farbe")
        }
        hexRow.addView(apply)
        box.addView(hexRow)
        val recent = host.recentColors
        if (recent.isNotEmpty()) {
            box.addView(gap(6))
            box.addView(kit.label("Zuletzt verwendet", 12f, kit.colors.muted))
            box.addView(swatchRow(recent, host.currentStyle.color) { host.pickCustomColor(it) })
        }
        return box
    }

    private fun swatchRow(colors: List<String>, current: String, effect: String? = null, onPick: (String) -> Unit): View {
        val scroll = HorizontalScrollView(context)
        scroll.isHorizontalScrollBarEnabled = false
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        val wasVertical = kit.vertical
        kit.vertical = false
        for (color in colors) {
            row.addView(kit.swatch(color, effect == null && color.equals(current, true)) { onPick(color) })
        }
        kit.vertical = wasVertical
        scroll.addView(row)
        return scroll
    }

    // ---- Zeichenstudio --------------------------------------------------------------------

    fun studioCard(): View {
        val box = column()
        val subtitle = when (studioTab) {
            "colors" -> "Vollfarben und Spezialtinten kombinieren"
            "symbols" -> "Icons direkt auf der Seite platzieren"
            else -> "Strichart und Druckverhalten wählen"
        }
        box.addView(kit.cardHeader("palette", "Zeichenstudio", subtitle) { host.closeCard() })
        box.addView(gap(8))
        box.addView(kit.tabs(listOf("brushes" to "Pinsel", "colors" to "Farben", "symbols" to "Piktogramme"), studioTab) {
            studioTab = it
            refresh("studio")
        })
        box.addView(gap(10))
        when (studioTab) {
            "colors" -> studioColors(box)
            "symbols" -> studioSymbols(box)
            else -> studioBrushes(box)
        }
        box.addView(gap(6))
        val symbol = host.armedSymbol
        if (symbol != null) {
            box.addView(sliderRow("Grösse", host.symbolSize, ART_SYMBOL_MIN, ART_SYMBOL_MAX, 2.0, { "${it.toInt()} px" }, live = false) { host.setSymbolSize(it) })
            box.addView(sliderRow("Drehung", host.symbolRotation, -180.0, 180.0, 5.0, { "${it.toInt()}°" }, live = false) { host.setSymbolRotation(it) })
            box.addView(sliderRow("Deckkraft", host.symbolOpacity, 0.12, 1.0, 0.01, { "${Math.round(it * 100)} %" }, live = false) { host.setSymbolOpacity(it) })
        } else {
            val style = host.currentStyle
            box.addView(sliderRow("Breite", style.baseWidth, 0.75, 42.0, 0.25, { "${number(it)} px" }) { host.changeStyle(host.currentStyle.copy(baseWidth = it)) })
            box.addView(sliderRow("Deckkraft", style.opacity ?: 1.0, 0.12, 1.0, 0.01, { "${Math.round(it * 100)} %" }) {
                host.changeStyle(host.currentStyle.copy(opacity = it))
            })
        }
        return box
    }

    private fun studioBrushes(box: LinearLayout) {
        val current = ch.fasrv.fanotes.ink.artBrush(host.currentStyle.brush)
        box.addView(kit.label(current.description, 12f, kit.colors.muted))
        box.addView(gap(6))
        val grid = GridLayout(context)
        grid.columnCount = 4
        for (brush in ART_BRUSHES) {
            val on = brush.id == current.id && host.armedSymbol == null
            val tile = column()
            tile.gravity = Gravity.CENTER
            tile.background = kit.rounded(if (on) kit.colors.active else android.graphics.Color.TRANSPARENT, 10, if (on) kit.colors.accent else android.graphics.Color.TRANSPARENT, if (on) 1 else 0)
            tile.addView(BrushPreviewView(context, brush.id, kit.colors.ink), LinearLayout.LayoutParams(kit.dp(48), kit.dp(22)))
            val name = kit.label(brush.label, 12f, if (on) kit.colors.ink else kit.colors.muted, bold = on)
            name.gravity = Gravity.CENTER
            name.maxLines = 1
            tile.addView(name)
            tile.contentDescription = ChromeText.ui(brush.label) + ": " + ChromeText.ui(brush.description)
            tile.setOnClickListener {
                host.chooseBrush(brush.id)
                refresh("studio")
            }
            val params = GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED, 1f), GridLayout.spec(GridLayout.UNDEFINED, 1f))
            params.width = 0
            params.height = kit.dp(64)
            params.setMargins(kit.dp(2), kit.dp(2), kit.dp(2), kit.dp(2))
            grid.addView(tile, params)
        }
        box.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun studioColors(box: LinearLayout) {
        val style = host.currentStyle
        box.addView(kit.label(if (style.colorEffect == "solid") "Vollfarbe" else "Spezialtinte", 12f, kit.colors.muted))
        val grid = GridLayout(context)
        grid.columnCount = 7
        val wasVertical = kit.vertical
        kit.vertical = false
        val palette = ART_COLOR_CHOICES + host.recentColors.filter { it !in ART_COLOR_CHOICES }
        for (color in palette) {
            val on = style.colorEffect == "solid" && color.equals(style.color, true)
            val swatch = kit.swatch(color, on) {
                host.changeStyle(host.currentStyle.copy(color = color, colorEffect = "solid"))
                refresh("studio")
            }
            grid.addView(swatch, GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, 1f)).apply {
                width = 0
                height = kit.dp(TOUCH_TARGET_DP)
            })
        }
        val custom = kit.toolButton("plus", "Eigene", description = "Eigene Zeichenfarbe") { refresh("color") }
        grid.addView(custom, GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, 1f)).apply {
            width = 0
            height = kit.dp(TOUCH_TARGET_DP)
        })
        kit.vertical = wasVertical
        box.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        box.addView(gap(8))
        box.addView(kit.label("Spezialfarben", 12f, kit.colors.muted))
        val inks = GridLayout(context)
        inks.columnCount = 4
        for (effect in INK_EFFECTS.filter { it.id != "solid" }) {
            val on = style.colorEffect == effect.id
            val tile = column()
            tile.gravity = Gravity.CENTER
            tile.background = kit.rounded(if (on) kit.colors.active else android.graphics.Color.TRANSPARENT, 9, if (on) kit.colors.accent else kit.colors.border, 1)
            tile.addView(EffectBarView(context, effect.id), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, kit.dp(12)).apply {
                setMargins(kit.dp(6), 0, kit.dp(6), kit.dp(3))
            })
            val name = kit.label(effect.label, 12f, if (on) kit.colors.ink else kit.colors.muted, bold = on)
            name.gravity = Gravity.CENTER
            tile.addView(name)
            tile.contentDescription = ChromeText.ui(effect.label) + " " + ChromeText.ui("Spezialtinte")
            tile.setOnClickListener {
                host.changeStyle(host.currentStyle.copy(colorEffect = effect.id))
                refresh("studio")
            }
            inks.addView(tile, GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, 1f)).apply {
                width = 0
                height = kit.dp(TOUCH_TARGET_DP)
                setMargins(kit.dp(2), kit.dp(2), kit.dp(2), kit.dp(2))
            })
        }
        box.addView(inks, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun studioSymbols(box: LinearLayout) {
        box.addView(kit.label("Symbol wählen · auf die Seite tippen", 12f, kit.colors.muted))
        box.addView(gap(6))
        box.addView(kit.tabs(ART_SYMBOL_CATEGORIES, host.symbolCategory) {
            host.setSymbolCategory(it)
            refresh("studio")
        })
        box.addView(gap(6))
        val grid = GridLayout(context)
        grid.columnCount = 5
        for (symbol in artSymbolsIn(host.symbolCategory)) {
            val on = host.armedSymbol == symbol.id
            val tile = column()
            tile.gravity = Gravity.CENTER
            tile.background = kit.rounded(if (on) kit.colors.active else android.graphics.Color.TRANSPARENT, 10, if (on) kit.colors.accent else android.graphics.Color.TRANSPARENT, if (on) 1 else 0)
            tile.addView(StampGlyphView(context, symbol.paths, 1.75f, if (on) kit.colors.accent else kit.colors.ink), LinearLayout.LayoutParams(kit.dp(26), kit.dp(26)))
            val name = kit.label(symbol.label, 11f, kit.colors.muted)
            name.maxLines = 1
            name.gravity = Gravity.CENTER
            tile.addView(name)
            tile.contentDescription = ChromeText.ui("${ChromeText.ui(symbol.label)} einfügen")
            tile.setOnClickListener {
                host.armSymbol(if (on) null else symbol.id)
                refresh("studio")
            }
            grid.addView(tile, GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, 1f)).apply {
                width = 0
                height = kit.dp(58)
                setMargins(kit.dp(2), kit.dp(2), kit.dp(2), kit.dp(2))
            })
        }
        box.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    // ---- Figuren und Körper, Funktionsgraph -------------------------------------------------

    fun figureCard(): View {
        val box = column()
        val graph = figureTab == "graph"
        box.addView(
            kit.cardHeader(
                if (graph) "chart-spline" else "box",
                if (graph) "Funktionsgraph" else "Figuren und Körper",
                if (graph) "Tippen setzt die Formel auf die Seite." else "Tippen setzt die Figur. Die Regler gelten für die nächste Figur.",
            ) { host.closeCard() },
        )
        box.addView(gap(8))
        box.addView(kit.tabs(listOf("plane" to "Fläche", "solid" to "Körper", "graph" to "Funktionsgraph"), figureTab) {
            figureTab = it
            if (it == "graph") ensureGraph() else {
                host.armGraph(null)
                val spec = host.figureSpec
                if (ch.fasrv.fanotes.ink.mathFigureById(spec.figureId).group != it) {
                    val first = MATH_FIGURES.first { figure -> figure.group == it }
                    host.figureSpec = spec.copy(figureId = first.id, params = ch.fasrv.fanotes.ink.defaultFigureParams(first.id))
                }
                host.armFigure(host.figureSpec)
            }
            refresh("figures")
        })
        box.addView(gap(10))
        if (graph) graphBody(box) else figureBody(box)
        return box
    }

    private fun figureBody(box: LinearLayout) {
        val spec = host.figureSpec
        val strokeUnits = { s: FigureStampSpec -> (24.0 * s.lineWidth / s.size).toFloat().coerceIn(0.4f, 6f) }
        val grid = GridLayout(context)
        grid.columnCount = 5
        for (figure in MATH_FIGURES.filter { it.group == figureTab }) {
            val on = figure.id == spec.figureId
            val tile = column()
            tile.gravity = Gravity.CENTER
            tile.background = kit.rounded(if (on) kit.colors.active else android.graphics.Color.TRANSPARENT, 10, if (on) kit.colors.accent else android.graphics.Color.TRANSPARENT, if (on) 1 else 0)
            val paths = if (on) mathFigurePaths(figure.id, spec.params) else figureCatalog.getOrPut(figure.id) { mathFigurePaths(figure.id, null) }
            tile.addView(StampGlyphView(context, paths, if (on) strokeUnits(spec) else 1.4f, if (on) kit.colors.accent else kit.colors.ink), LinearLayout.LayoutParams(kit.dp(30), kit.dp(30)))
            val name = kit.label(figure.label, 11f, kit.colors.muted)
            name.maxLines = 1
            name.gravity = Gravity.CENTER
            tile.addView(name)
            tile.contentDescription = ChromeText.ui(figure.label)
            tile.setOnClickListener {
                host.figureSpec = host.figureSpec.copy(figureId = figure.id, params = ch.fasrv.fanotes.ink.defaultFigureParams(figure.id))
                host.armFigure(host.figureSpec)
                refresh("figures")
            }
            grid.addView(tile, GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, 1f)).apply {
                width = 0
                height = kit.dp(62)
                setMargins(kit.dp(2), kit.dp(2), kit.dp(2), kit.dp(2))
            })
        }
        box.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        box.addView(gap(8))
        val definition = ch.fasrv.fanotes.ink.mathFigureById(spec.figureId)
        for (param in definition.params) {
            val value = spec.params[param.id] ?: param.value
            box.addView(sliderRow(param.label, value, param.min, param.max, param.step, { number(it) }, live = false) { next ->
                val current = host.figureSpec
                host.figureSpec = current.copy(params = clampFigureParams(current.figureId, current.params + (param.id to next)))
                host.armFigure(host.figureSpec)
                refresh("figures")
            })
        }
        box.addView(sliderRow("Grösse", spec.size, FIGURE_SIZE_MIN, FIGURE_SIZE_MAX, 2.0, { it.toInt().toString() }) { next ->
            host.figureSpec = host.figureSpec.copy(size = next)
            host.armFigure(host.figureSpec)
        })
        box.addView(sliderRow("Linienstärke", spec.lineWidth, FIGURE_LINE_MIN, FIGURE_LINE_MAX, FIGURE_LINE_STEP, { number(it) }, live = false) { next ->
            host.figureSpec = host.figureSpec.copy(lineWidth = next)
            host.armFigure(host.figureSpec)
            refresh("figures")
        })
        box.addView(sliderRow("Drehung", spec.rotation, -180.0, 180.0, 5.0, { "${it.toInt()}°" }) { next ->
            host.figureSpec = host.figureSpec.copy(rotation = next)
            host.armFigure(host.figureSpec)
        })
    }

    private val figureCatalog = HashMap<String, List<String>>()
    var graphExpression = ch.fasrv.fanotes.ink.DEFAULT_GRAPH_EXPRESSION
    var graphXMin = ch.fasrv.fanotes.ink.DEFAULT_GRAPH_X_MIN
    var graphXMax = ch.fasrv.fanotes.ink.DEFAULT_GRAPH_X_MAX
    private var graphError: String? = null

    /** Recomputes the graph from the formula and domain and arms it; an error disarms it. */
    fun ensureGraph() {
        val spec = host.figureSpec
        val paths = try {
            graphError = null
            ch.fasrv.fanotes.ink.functionGraphPaths(graphExpression, graphXMin, graphXMax)
        } catch (error: IllegalArgumentException) {
            graphError = error.message
            emptyList()
        }
        val graph = if (paths.isEmpty()) null else GraphStampSpec(graphExpression.trim(), graphXMin, graphXMax, paths, spec.size, spec.lineWidth)
        host.graphSpec = graph
        host.armGraph(graph)
    }

    private fun graphBody(box: LinearLayout) {
        box.addView(kit.label("Funktionsformel", 13f, kit.colors.ink, bold = true))
        val formula = EditText(context)
        formula.setText(graphExpression)
        formula.hint = "sin(x)"
        formula.textSize = 16f
        formula.setTextColor(kit.colors.ink)
        formula.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        formula.setSingleLine()
        box.addView(formula, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, kit.dp(TOUCH_TARGET_DP + 4)))
        val presets = LinearLayout(context)
        presets.orientation = LinearLayout.HORIZONTAL
        val wasVertical = kit.vertical
        kit.vertical = false
        for (preset in GRAPH_PRESETS) {
            val chip = kit.chip(preset) {
                graphExpression = preset
                ensureGraph()
                refresh("figures")
            }
            if (graphExpression.trim() == preset) chip.background = kit.rounded(kit.colors.active, 10, kit.colors.accent, 1)
            presets.addView(chip)
        }
        kit.vertical = wasVertical
        val presetScroll = HorizontalScrollView(context)
        presetScroll.isHorizontalScrollBarEnabled = false
        presetScroll.addView(presets)
        box.addView(presetScroll)
        val preview = StampGlyphView(context, host.graphSpec?.paths.orEmpty(), 1.2f, kit.colors.accent)
        val error = kit.label(graphError.orEmpty(), 13f, 0xFFD23B4A.toInt())
        error.visibility = if (graphError == null) View.GONE else View.VISIBLE
        preview.visibility = if (graphError == null) View.VISIBLE else View.GONE
        box.addView(preview, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, kit.dp(120)).apply { topMargin = kit.dp(6) })
        box.addView(error)
        formula.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                graphExpression = s?.toString().orEmpty().take(180)
                ensureGraph()
                preview.setPaths(host.graphSpec?.paths.orEmpty())
                error.text = ChromeText.ui(graphError.orEmpty())
                error.visibility = if (graphError == null) View.GONE else View.VISIBLE
                preview.visibility = if (graphError == null) View.VISIBLE else View.GONE
            }
        })
        val domain = LinearLayout(context)
        domain.orientation = LinearLayout.HORIZONTAL
        fun domainField(title: String, value: Double, onValue: (Double) -> Unit): View {
            val col = column()
            col.addView(kit.label(title, 12f, kit.colors.muted))
            val field = EditText(context)
            field.setText(number(value).replace(',', '.'))
            field.textSize = 15f
            field.setTextColor(kit.colors.ink)
            field.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
            field.setSingleLine()
            field.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    val next = s?.toString()?.replace(',', '.')?.toDoubleOrNull() ?: return
                    if (!next.isFinite()) return
                    onValue(next.coerceIn(-1_000_000.0, 1_000_000.0))
                    ensureGraph()
                    preview.setPaths(host.graphSpec?.paths.orEmpty())
                    error.text = ChromeText.ui(graphError.orEmpty())
                    error.visibility = if (graphError == null) View.GONE else View.VISIBLE
                    preview.visibility = if (graphError == null) View.VISIBLE else View.GONE
                }
            })
            col.addView(field, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, kit.dp(TOUCH_TARGET_DP)))
            return col
        }
        domain.addView(domainField("x-Minimum", graphXMin) { graphXMin = it }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        domain.addView(domainField("x-Maximum", graphXMax) { graphXMax = it }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = kit.dp(10) })
        box.addView(domain)
        val spec = host.figureSpec
        box.addView(sliderRow("Grösse", spec.size, FIGURE_SIZE_MIN, FIGURE_SIZE_MAX, 2.0, { it.toInt().toString() }) { next ->
            host.figureSpec = host.figureSpec.copy(size = next)
            ensureGraph()
        })
        box.addView(sliderRow("Linienstärke", spec.lineWidth, FIGURE_LINE_MIN, FIGURE_LINE_MAX, FIGURE_LINE_STEP, { number(it) }) { next ->
            host.figureSpec = host.figureSpec.copy(lineWidth = next)
            ensureGraph()
        })
    }

    companion object {
        /** Desktop `artColorChoices`. */
        val ART_COLOR_CHOICES = listOf(
            "#17191f", "#ffffff", "#6c727f", "#d83b52", "#f06c32", "#f2b735", "#77ad3a",
            "#1ca982", "#21a8c7", "#3478df", "#6548dc", "#a444cf", "#e5489a", "#8b5a3c",
        )
    }
}

/** 24×24 stroke paths (pictogram, figure, graph) scaled to fit. */
internal class StampGlyphView(context: Context, paths: List<String>, private val strokeUnits: Float, color: Int) : View(context) {
    private var parsed: List<Path> = emptyList()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        this.color = color
    }

    init {
        setPaths(paths)
    }

    fun setPaths(paths: List<String>) {
        parsed = paths.mapNotNull { runCatching { PathParser.createPathFromPathData(it) }.getOrNull() }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val side = minOf(width, height).toFloat()
        if (side <= 0f) return
        val scale = side / 24f
        canvas.save()
        canvas.translate(width / 2f - 12f * scale, height / 2f - 12f * scale)
        canvas.scale(scale, scale)
        paint.strokeWidth = strokeUnits
        for (path in parsed) canvas.drawPath(path, paint)
        canvas.restore()
    }
}

/** Small stroke sample per brush, like the desktop `.lw-art-brush-preview`. */
internal class BrushPreviewView(context: Context, private val brush: String, private val color: Int) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }

    override fun onDraw(canvas: Canvas) {
        val d = resources.displayMetrics.density
        val w = width.toFloat()
        val cy = height / 2f
        canvas.save()
        canvas.rotate(-5f, w / 2f, cy)
        paint.color = color
        paint.style = Paint.Style.STROKE
        paint.pathEffect = null
        paint.alpha = 255
        when (brush) {
            "pencil" -> {
                paint.strokeWidth = 2f * d
                paint.alpha = 165
                paint.pathEffect = DashPathEffect(floatArrayOf(3f * d, 1f * d), 0f)
                canvas.drawLine(4 * d, cy, w - 4 * d, cy, paint)
            }
            "marker" -> {
                paint.strokeWidth = 6f * d
                paint.strokeCap = Paint.Cap.SQUARE
                paint.alpha = 225
                canvas.drawLine(5 * d, cy, w - 5 * d, cy, paint)
                paint.strokeCap = Paint.Cap.ROUND
            }
            "paintbrush" -> {
                paint.style = Paint.Style.FILL
                val path = Path()
                path.moveTo(4 * d, cy)
                path.quadTo(w / 2, cy - 5 * d, w - 4 * d, cy - 1 * d)
                path.quadTo(w / 2, cy + 4 * d, 4 * d, cy)
                canvas.drawPath(path, paint)
            }
            "calligraphy" -> {
                paint.style = Paint.Style.FILL
                val path = Path()
                path.moveTo(6 * d, cy + 3 * d)
                path.lineTo(10 * d, cy - 4 * d)
                path.lineTo(w - 4 * d, cy - 4 * d)
                path.lineTo(w - 8 * d, cy + 3 * d)
                path.close()
                canvas.drawPath(path, paint)
            }
            "highlighter" -> {
                paint.strokeWidth = 9f * d
                paint.strokeCap = Paint.Cap.BUTT
                paint.alpha = 90
                canvas.drawLine(4 * d, cy, w - 4 * d, cy, paint)
                paint.strokeCap = Paint.Cap.ROUND
            }
            "watercolor" -> {
                paint.strokeWidth = 8f * d
                paint.alpha = 60
                canvas.drawLine(4 * d, cy - 2 * d, w - 4 * d, cy - 2 * d, paint)
                canvas.drawLine(4 * d, cy + 2 * d, w - 4 * d, cy + 2 * d, paint)
            }
            "spray" -> {
                paint.style = Paint.Style.FILL
                paint.alpha = 190
                var x = 4 * d
                var row = 0
                while (x < w - 4 * d) {
                    for (k in -1..1) canvas.drawCircle(x + (row % 2) * 1.5f * d, cy + k * 3.2f * d, 0.9f * d, paint)
                    x += 3.4f * d
                    row++
                }
            }
            else -> {
                paint.strokeWidth = 2f * d
                canvas.drawLine(4 * d, cy, w - 4 * d, cy, paint)
            }
        }
        canvas.restore()
    }
}

/** Gradient sample of a special ink. */
internal class EffectBarView(context: Context, private val effect: String) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
        val gradient = ch.fasrv.fanotes.ink.inkEffectGradient(effect) ?: return
        paint.shader = android.graphics.LinearGradient(0f, 0f, width.toFloat(), 0f, gradient.second, gradient.first, android.graphics.Shader.TileMode.CLAMP)
        val r = height / 2f
        canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, paint)
    }
}

/** A width preset: a dot as thick as the stroke (capped), ringed when chosen. */
internal class WidthDotView(context: Context, width: Double, private val colors: PenChromeColors, private val chosen: Boolean) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    /** Stroke width shown; the toolbar's width button follows the slider without a rebuild. */
    var value: Double = width
        set(next) {
            if (field == next) return
            field = next
            invalidate()
        }

    override fun onDraw(canvas: Canvas) {
        val d = resources.displayMetrics.density
        val cx = getWidth() / 2f
        val cy = height / 2f
        if (chosen) {
            paint.style = Paint.Style.FILL
            paint.color = colors.active
            canvas.drawCircle(cx, cy, 20f * d, paint)
        }
        paint.style = Paint.Style.FILL
        paint.color = colors.ink
        canvas.drawCircle(cx, cy, (value.toFloat() * d / 2f).coerceIn(1.5f * d, 14f * d), paint)
    }
}
