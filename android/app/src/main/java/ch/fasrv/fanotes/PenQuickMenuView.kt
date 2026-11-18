package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityEvent
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.ink.QUICK_MENU_COLOR_RADIUS_DP
import ch.fasrv.fanotes.ink.QUICK_MENU_EXTENT_DP
import ch.fasrv.fanotes.ink.QUICK_MENU_HUB_DP
import ch.fasrv.fanotes.ink.QUICK_MENU_ITEM_DP
import ch.fasrv.fanotes.ink.QUICK_MENU_TOOLS
import ch.fasrv.fanotes.ink.QUICK_MENU_TOOL_RADIUS_DP
import ch.fasrv.fanotes.ink.QuickMenuHit
import ch.fasrv.fanotes.ink.clampQuickMenuCenter
import ch.fasrv.fanotes.ink.quickMenuHitTest
import ch.fasrv.fanotes.ink.quickMenuRing

/**
 * Radial quick menu at the pen ("Schnellauswahl Stift und Farbe", desktop `PenQuickMenu.tsx`): tools
 * on the inner ring, colours on the outer ring. Tap an item, or keep the tip down, slide onto one and
 * lift. While open the view covers the page, so a tap outside only closes it and leaves no ink.
 */
internal class PenQuickMenuView(context: Context) : View(context) {
    var onTool: (String) -> Unit = {}
    var onColor: (String) -> Unit = {}
    var onClosed: () -> Unit = {}

    private var colors = penChromeColors("", true, true, 0xFF2A6F97.toInt())
    private var toolActive: Set<String> = emptySet()
    private var swatches: List<String> = emptyList()
    private var activeColor = ""
    private var cx = 0f
    private var cy = 0f
    private var hover: QuickMenuHit? = null
    private var opened = false
    private val density = resources.displayMetrics.density
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG)
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val icons = HashMap<String, PenIconDrawable>()

    val isOpen: Boolean get() = opened

    init {
        visibility = GONE
        isClickable = true
        isFocusable = true
        contentDescription = ChromeText.ui("Schnellauswahl Stift und Farbe")
    }

    fun open(x: Float, y: Float, theme: PenChromeColors, active: Set<String>, colorRing: List<String>, current: String) {
        colors = theme
        toolActive = active
        swatches = colorRing
        activeColor = current.lowercase()
        // A GONE view has no size yet: clamp against the page it covers.
        val host = parent as? View
        val w = (host?.width ?: width).toFloat()
        val h = (host?.height ?: height).toFloat()
        val (clampedX, clampedY) = clampQuickMenuCenter(x, y, w, h, QUICK_MENU_EXTENT_DP * density)
        cx = clampedX
        cy = clampedY
        hover = null
        opened = true
        visibility = VISIBLE
        alpha = 0f
        scaleX = 0.92f
        scaleY = 0.92f
        pivotX = cx
        pivotY = cy
        animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(140).start()
        requestFocus()
        sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED)
        invalidate()
    }

    fun close() {
        if (!opened) return
        opened = false
        hover = null
        animate().cancel()
        visibility = GONE
        onClosed()
    }

    private fun hitAt(x: Float, y: Float): QuickMenuHit? = quickMenuHitTest(
        (x - cx) / density,
        (y - cy) / density,
        QUICK_MENU_TOOLS.size,
        swatches.size,
        QUICK_MENU_TOOL_RADIUS_DP,
        QUICK_MENU_COLOR_RADIUS_DP,
        QUICK_MENU_ITEM_DP,
        QUICK_MENU_HUB_DP,
    )

    private fun pick(hit: QuickMenuHit?) {
        when (hit) {
            is QuickMenuHit.Tool -> {
                val id = QUICK_MENU_TOOLS[hit.index].id
                close()
                onTool(id)
            }
            is QuickMenuHit.Color -> {
                val color = swatches[hit.index]
                close()
                onColor(color)
            }
            QuickMenuHit.Hub -> close()
            null -> Unit
        }
    }

    /** The tip that opened the menu slides (lifted = false) or lifts over it. NaN lifts pick nothing. */
    fun drag(x: Float, y: Float, lifted: Boolean) {
        if (!opened) return
        if (x.isNaN() || y.isNaN()) {
            hover = null
            invalidate()
            return
        }
        val hit = hitAt(x, y)
        if (lifted) {
            hover = null
            if (hit == QuickMenuHit.Hub) invalidate() else pick(hit)
            invalidate()
        } else if (hit != hover) {
            hover = hit
            invalidate()
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!opened) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val hit = hitAt(event.x, event.y)
                if (hit == null) {
                    close()
                    return true
                }
                hover = hit
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                val hit = hitAt(event.x, event.y)
                if (hit != hover) {
                    hover = hit
                    invalidate()
                }
            }
            MotionEvent.ACTION_UP -> pick(hitAt(event.x, event.y))
            MotionEvent.ACTION_CANCEL -> {
                hover = null
                invalidate()
            }
        }
        return true
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (opened && (keyCode == KeyEvent.KEYCODE_ESCAPE || keyCode == KeyEvent.KEYCODE_BACK)) {
            close()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDraw(canvas: Canvas) {
        if (!opened) return
        val extent = QUICK_MENU_EXTENT_DP * density
        disc.color = (colors.panel and 0x00FFFFFF) or (0xF0 shl 24)
        disc.setShadowLayer(18f * density, 0f, 6f * density, 0x44000000)
        canvas.drawCircle(cx, cy, extent, disc)
        edge.strokeWidth = density
        edge.color = colors.border
        canvas.drawCircle(cx, cy, extent, edge)
        val item = QUICK_MENU_ITEM_DP * density / 2f
        // Hub: close.
        fill.color = if (hover == QuickMenuHit.Hub) colors.active else colors.track
        canvas.drawCircle(cx, cy, QUICK_MENU_HUB_DP * density / 2f, fill)
        drawIcon(canvas, "x", cx, cy, 16f * density, colors.muted)
        quickMenuRing(QUICK_MENU_TOOLS.size, QUICK_MENU_TOOL_RADIUS_DP * density).forEachIndexed { index, (dx, dy) ->
            val tool = QUICK_MENU_TOOLS[index]
            val on = tool.id in toolActive
            val hovered = hover == QuickMenuHit.Tool(index)
            val radius = if (hovered) item * 1.1f else item
            fill.color = if (on) colors.accent else colors.track
            canvas.drawCircle(cx + dx, cy + dy, radius, fill)
            edge.color = if (hovered) colors.accent else colors.border
            edge.strokeWidth = (if (hovered) 2f else 1f) * density
            canvas.drawCircle(cx + dx, cy + dy, radius, edge)
            drawIcon(canvas, tool.icon, cx + dx, cy + dy, 22f * density, if (on) 0xFFFFFFFF.toInt() else colors.ink)
        }
        quickMenuRing(swatches.size, QUICK_MENU_COLOR_RADIUS_DP * density, 0.5f).forEachIndexed { index, (dx, dy) ->
            val color = swatches[index]
            val hovered = hover == QuickMenuHit.Color(index)
            val radius = (if (hovered) item * 0.92f else item * 0.78f)
            fill.color = runCatching { android.graphics.Color.parseColor(color) }.getOrDefault(android.graphics.Color.GRAY)
            canvas.drawCircle(cx + dx, cy + dy, radius, fill)
            edge.strokeWidth = 2f * density
            edge.color = colors.panel
            canvas.drawCircle(cx + dx, cy + dy, radius, edge)
            if (color == activeColor || hovered) {
                edge.strokeWidth = 2.5f * density
                edge.color = colors.accent
                canvas.drawCircle(cx + dx, cy + dy, radius + 3.5f * density, edge)
            }
        }
    }

    private fun drawIcon(canvas: Canvas, name: String, x: Float, y: Float, size: Float, color: Int) {
        val icon = icons.getOrPut(name) { PenIconDrawable(name, color) }
        icon.color = color
        val half = (size / 2f).toInt()
        icon.setBounds(x.toInt() - half, y.toInt() - half, x.toInt() + half, y.toInt() + half)
        icon.draw(canvas)
    }
}
