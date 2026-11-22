package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.desk.TOUCH_CHIP_TEXT_SP
import ch.fasrv.fanotes.desk.TOUCH_GAP_DP
import ch.fasrv.fanotes.desk.TOUCH_SWATCH_DP
import ch.fasrv.fanotes.desk.TOUCH_TARGET_DP
import ch.fasrv.fanotes.desk.TOUCH_TOOL_ICON_DP
import ch.fasrv.fanotes.desk.TOUCH_TOOL_LABEL_SP

/** Colours of the pen chrome for the current theme. */
internal data class PenChromeColors(
    val bar: Int,
    val panel: Int,
    val ink: Int,
    val muted: Int,
    val track: Int,
    val active: Int,
    val activeInk: Int,
    val accent: Int,
    val border: Int,
    val dark: Boolean,
)

internal fun penChromeColors(themeId: String, systemDark: Boolean, dark: Boolean, accent: Int): PenChromeColors {
    val bar = ch.fasrv.fanotes.desk.editorToolbarColor(themeId, systemDark)
    val ink = ch.fasrv.fanotes.desk.formatChipInk(themeId, systemDark)
    return PenChromeColors(
        bar = bar,
        panel = if (dark) 0xFF1E2028.toInt() else 0xFFFDFCFA.toInt(),
        ink = ink,
        muted = (ink and 0x00FFFFFF) or (0x9A shl 24),
        track = ch.fasrv.fanotes.desk.modeSwitchTrackColor(themeId, systemDark),
        active = (accent and 0x00FFFFFF) or (if (dark) 0x3D shl 24 else 0x26 shl 24),
        activeInk = ink,
        accent = accent,
        border = if (dark) 0x33FFFFFF else 0x22000000,
        dark = dark,
    )
}

/**
 * Builders for the pen toolbar and its cards. Every control has at least a 48 dp hit area (pen and
 * finger); drawn sizes can be smaller. [vertical] lays the bar out as a side rail.
 */
internal class PenToolbarKit(private val context: Context) {
    var colors = penChromeColors("", true, true, 0xFF2A6F97.toInt())
    var vertical = false

    fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()
    fun dpf(value: Float): Float = value * context.resources.displayMetrics.density

    fun rounded(color: Int, radiusDp: Int, stroke: Int = 0, strokeDp: Int = 0) = GradientDrawable().apply {
        cornerRadius = dpf(radiusDp.toFloat())
        setColor(color)
        if (strokeDp > 0) setStroke(dp(strokeDp), stroke)
    }

    /** Spacing between neighbours along the bar. */
    fun itemParams(width: Int = ViewGroup.LayoutParams.WRAP_CONTENT, height: Int = dp(TOUCH_TARGET_DP), gapDp: Int = TOUCH_GAP_DP): LinearLayout.LayoutParams =
        if (vertical) {
            LinearLayout.LayoutParams(if (width == ViewGroup.LayoutParams.WRAP_CONTENT) ViewGroup.LayoutParams.MATCH_PARENT else width, height).apply {
                topMargin = dp(gapDp)
                gravity = Gravity.CENTER_HORIZONTAL
            }
        } else {
            LinearLayout.LayoutParams(width, height).apply {
                marginStart = dp(gapDp)
                gravity = Gravity.CENTER_VERTICAL
            }
        }

    /** Icon over a short label; [active] fills it with the accent wash. */
    fun toolButton(
        icon: String,
        label: String,
        active: Boolean = false,
        enabled: Boolean = true,
        description: String = label,
        showLabel: Boolean = true,
        click: () -> Unit,
    ): View {
        val box = LinearLayout(context)
        box.orientation = LinearLayout.VERTICAL
        box.gravity = Gravity.CENTER
        box.minimumWidth = dp(TOUCH_TARGET_DP)
        box.setPadding(dp(6), dp(3), dp(6), dp(3))
        val glyph = ImageView(context)
        glyph.setImageDrawable(PenIconDrawable(icon, if (active) colors.activeInk else colors.ink))
        box.addView(glyph, LinearLayout.LayoutParams(dp(TOUCH_TOOL_ICON_DP), dp(TOUCH_TOOL_ICON_DP)))
        if (showLabel) {
            val text = TextView(context)
            text.text = ChromeText.ui(label)
            text.textSize = TOUCH_TOOL_LABEL_SP
            text.maxLines = 1
            text.ellipsize = TextUtils.TruncateAt.END
            text.setTextColor(if (active) colors.activeInk else colors.muted)
            text.gravity = Gravity.CENTER
            if (active) text.typeface = Typeface.create(Typeface.DEFAULT, 650, false)
            box.addView(text, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(1) })
        }
        box.background = rounded(if (active) colors.active else android.graphics.Color.TRANSPARENT, 10)
        box.contentDescription = ChromeText.ui(description)
        if (!showLabel) box.tooltipText = ChromeText.ui(description)
        box.isSelected = active
        box.isEnabled = enabled
        box.alpha = if (enabled) 1f else ch.fasrv.fanotes.desk.FORMAT_DISABLED_ALPHA
        box.setOnClickListener { if (enabled) click() }
        box.layoutParams = itemParams(height = dp(if (vertical) 54 else TOUCH_TARGET_DP))
        return box
    }

    /** Text chip; in the rail it wraps to two lines across the rail width. */
    fun chip(label: String, enabled: Boolean = true, description: String = label, click: () -> Unit): TextView {
        val view = TextView(context)
        view.text = ChromeText.ui(label)
        view.contentDescription = ChromeText.ui(description)
        view.textSize = if (vertical) TOUCH_TOOL_LABEL_SP + 1f else TOUCH_CHIP_TEXT_SP
        view.gravity = Gravity.CENTER
        view.maxLines = if (vertical) 2 else 1
        view.ellipsize = TextUtils.TruncateAt.END
        view.setPadding(dp(if (vertical) 4 else 12), 0, dp(if (vertical) 4 else 12), 0)
        view.minHeight = dp(TOUCH_TARGET_DP)
        view.minWidth = dp(TOUCH_TARGET_DP)
        view.background = rounded(android.graphics.Color.TRANSPARENT, 10)
        view.isEnabled = enabled
        view.alpha = if (enabled) 1f else ch.fasrv.fanotes.desk.FORMAT_DISABLED_ALPHA
        view.setTextColor(colors.ink)
        view.setOnClickListener { if (enabled) click() }
        view.layoutParams = itemParams()
        return view
    }

    /** Round colour swatch, [TOUCH_SWATCH_DP] drawn in a 48 dp target. [effect] paints a special ink. */
    fun swatch(color: String, selected: Boolean, description: String = "Farbe $color", effect: String? = null, click: () -> Unit): View {
        val view = SwatchView(context, color, effect, selected, colors, dpf(TOUCH_SWATCH_DP.toFloat()))
        view.contentDescription = ChromeText.ui(description)
        view.setOnClickListener { click() }
        view.layoutParams = itemParams(width = dp(if (vertical) TOUCH_TARGET_DP else 40), height = dp(if (vertical) 40 else TOUCH_TARGET_DP), gapDp = 0)
        return view
    }

    /** A thin rule between groups. */
    fun divider(): View {
        val view = View(context)
        view.setBackgroundColor(colors.border)
        view.layoutParams = if (vertical) {
            LinearLayout.LayoutParams(dp(36), dp(1)).apply {
                topMargin = dp(8)
                bottomMargin = dp(4)
                gravity = Gravity.CENTER_HORIZONTAL
            }
        } else {
            LinearLayout.LayoutParams(dp(1), dp(28)).apply {
                marginStart = dp(8)
                marginEnd = dp(4)
                gravity = Gravity.CENTER_VERTICAL
            }
        }
        return view
    }

    /** Card heading with a close button, used by every floating card. */
    fun cardHeader(icon: String, title: String, subtitle: String, onClose: () -> Unit): View {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val badge = ImageView(context)
        badge.setImageDrawable(PenIconDrawable(icon, colors.accent))
        badge.setPadding(dp(6), dp(6), dp(6), dp(6))
        badge.background = rounded(colors.active, 9)
        row.addView(badge, LinearLayout.LayoutParams(dp(32), dp(32)))
        val texts = LinearLayout(context)
        texts.orientation = LinearLayout.VERTICAL
        texts.setPadding(dp(10), 0, dp(4), 0)
        texts.addView(label(title, 14f, colors.ink, bold = true))
        if (subtitle.isNotEmpty()) texts.addView(label(subtitle, 12f, colors.muted))
        row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val close = ImageView(context)
        close.setImageDrawable(PenIconDrawable("x", colors.muted))
        close.setPadding(dp(13), dp(13), dp(13), dp(13))
        close.contentDescription = ChromeText.ui("Schliessen")
        close.setOnClickListener { onClose() }
        row.addView(close, LinearLayout.LayoutParams(dp(TOUCH_TARGET_DP), dp(TOUCH_TARGET_DP)))
        return row
    }

    fun label(text: String, sp: Float, color: Int, bold: Boolean = false): TextView = TextView(context).apply {
        this.text = ChromeText.ui(text)
        textSize = sp
        setTextColor(color)
        if (bold) typeface = Typeface.create(Typeface.DEFAULT, 650, false)
    }

    /** Segmented row of text tabs (card tabs, figure groups, symbol categories). */
    fun tabs(items: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit): LinearLayout {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.background = rounded(colors.track, 12)
        row.setPadding(dp(3), dp(3), dp(3), dp(3))
        for ((id, text) in items) {
            val on = id == selected
            val tab = TextView(context)
            tab.text = ChromeText.ui(text)
            tab.textSize = 13f
            tab.gravity = Gravity.CENTER
            tab.maxLines = 1
            tab.ellipsize = TextUtils.TruncateAt.END
            tab.setTextColor(if (on) colors.ink else colors.muted)
            if (on) {
                tab.typeface = Typeface.create(Typeface.DEFAULT, 650, false)
                tab.background = rounded(colors.panel, 9, colors.border, 1)
            }
            tab.setOnClickListener { onPick(id) }
            row.addView(tab, LinearLayout.LayoutParams(0, dp(42), 1f))
        }
        return row
    }
}

/** A colour dot. A special ink shows its gradient; the selected one gets an accent ring. */
internal class SwatchView(
    context: Context,
    private val color: String,
    private val effect: String?,
    private val selected: Boolean,
    private val colors: PenChromeColors,
    private val diameter: Float,
) : View(context) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val r = minOf(diameter, minOf(width, height).toFloat()) / 2f - 2f
        val gradient = effect?.let { ch.fasrv.fanotes.ink.inkEffectGradient(it) }
        if (gradient != null) {
            fill.shader = LinearGradient(cx - r, cy - r, cx + r, cy + r, gradient.second, gradient.first, Shader.TileMode.CLAMP)
        } else {
            fill.shader = null
            fill.color = runCatching { android.graphics.Color.parseColor(color) }.getOrDefault(android.graphics.Color.GRAY)
        }
        canvas.drawCircle(cx, cy, r, fill)
        ring.strokeWidth = resources.displayMetrics.density
        ring.color = colors.border
        canvas.drawCircle(cx, cy, r, ring)
        if (selected) {
            ring.strokeWidth = 2.5f * resources.displayMetrics.density
            ring.color = colors.accent
            canvas.drawCircle(cx, cy, r + 3f * resources.displayMetrics.density, ring)
        }
    }
}

/** Vertical rail scroller: a pen tap on a tool never turns into a scroll. */
internal class EditorRailScroll(context: Context) : ScrollView(context) {
    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        if (event.pointerCount > 1) return false
        for (index in 0 until event.pointerCount) {
            val tool = event.getToolType(index)
            if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) return false
        }
        return super.onInterceptTouchEvent(event)
    }
}
