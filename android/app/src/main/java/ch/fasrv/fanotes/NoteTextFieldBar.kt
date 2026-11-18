package ch.fasrv.fanotes

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.desk.NOTE_TEXT_FIELD_COLORS
import ch.fasrv.fanotes.desk.NoteTextField
import ch.fasrv.fanotes.desk.stepNoteTextFieldFontSize

/**
 * Size, bold and colour controls of the open text field (desktop `NoteTextFieldToolbar`): Schrift kleiner, the size,
 * Schrift grösser, Fett, the six inks and Textfeld entfernen. It floats next to the field at touch size (48 dp), so
 * a finger or the pen reaches it without leaving the box. Its buttons never take focus, so the field stays open.
 */
@SuppressLint("ViewConstructor")
internal class NoteTextFieldBar(context: Context) : LinearLayout(context) {
    /** fontSize, whether to set the colour, the colour (null: default ink), bold. */
    var onStyle: (Int?, Boolean, String?, Boolean?) -> Unit = { _, _, _, _ -> }
    var onRemove: () -> Unit = {}

    /** A button is under a finger or the pen; the field's focus loss then is not a close. */
    var pressed = false
        private set

    private val smaller = button("A−", "Schrift kleiner")
    private val size = label()
    private val larger = button("A+", "Schrift größer")
    private val bold = button("B", "Fett").apply { setTypeface(typeface, Typeface.BOLD) }
    private val swatches = NOTE_TEXT_FIELD_COLORS.map { color -> color to swatch(color.css, color.label) }
    private val remove = button("🗑", "Textfeld entfernen").apply { setTextColor(0xFFA33F56.toInt()) }
    private var field: NoteTextField? = null

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(4), 0, dp(4), 0)
        elevation = dp(6).toFloat()
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(Color.WHITE)
            setStroke(dp(1).coerceAtLeast(1), 0x2620222B)
        }
        isFocusable = false
        addView(smaller)
        addView(size)
        addView(larger)
        addView(separator())
        addView(bold)
        addView(separator())
        swatches.forEach { addView(it.second) }
        addView(separator())
        addView(remove)
        smaller.setOnClickListener { field?.let { onStyle(stepNoteTextFieldFontSize(it.fontSize, -1), false, null, null) } }
        larger.setOnClickListener { field?.let { onStyle(stepNoteTextFieldFontSize(it.fontSize, 1), false, null, null) } }
        bold.setOnClickListener { field?.let { onStyle(null, false, null, !it.bold) } }
        swatches.forEach { (color, view) -> view.setOnClickListener { onStyle(null, true, color.value, null) } }
        remove.setOnClickListener { onRemove() }
    }

    fun bind(next: NoteTextField) {
        field = next
        size.text = next.fontSize.toString()
        smaller.isEnabled = next.fontSize > 10
        smaller.alpha = if (smaller.isEnabled) 1f else 0.4f
        larger.isEnabled = next.fontSize < 48
        larger.alpha = if (larger.isEnabled) 1f else 0.4f
        bold.isSelected = next.bold
        bold.background = if (next.bold) pill(0x1F2563C9) else null
        swatches.forEach { (color, view) ->
            val on = color.value == next.color
            (view.background as? GradientDrawable)?.setStroke(if (on) dp(3) else dp(1).coerceAtLeast(1), if (on) 0xFF2563C9.toInt() else 0x4020222B)
            view.isSelected = on
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun keepFocus(view: View) {
        view.isFocusable = false
        view.isFocusableInTouchMode = false
        view.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> pressed = true
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> post { pressed = false }
            }
            false
        }
    }

    private fun button(text: String, description: String) = TextView(context).apply {
        this.text = text
        contentDescription = ui(description)
        tooltipText = ui(description)
        gravity = Gravity.CENTER
        textSize = 16f
        setTextColor(0xFF20222B.toInt())
        minWidth = dp(TOUCH_DP)
        layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, dp(TOUCH_DP))
        keepFocus(this)
    }

    private fun label() = TextView(context).apply {
        gravity = Gravity.CENTER
        textSize = 14f
        setTextColor(0xFF20222B.toInt())
        contentDescription = ui("Schriftgröße")
        minWidth = dp(30)
        layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, dp(TOUCH_DP))
    }

    private fun swatch(css: String, label: String) = View(context).apply {
        contentDescription = ui(label)
        tooltipText = ui(label)
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor(css))
            setStroke(dp(1).coerceAtLeast(1), 0x4020222B)
        }
        // A 28 dp dot inside a 44 dp target.
        layoutParams = LayoutParams(dp(28), dp(28)).apply { setMargins(dp(8), dp(8), dp(8), dp(8)) }
        keepFocus(this)
    }

    private fun separator() = View(context).apply {
        setBackgroundColor(0x2620222B)
        layoutParams = LayoutParams(dp(1).coerceAtLeast(1), dp(24)).apply { setMargins(dp(4), 0, dp(4), 0) }
    }

    private fun pill(color: Int) = GradientDrawable().apply {
        cornerRadius = dp(8).toFloat()
        setColor(color)
    }

    /** Desktop wording (the English catalogue is keyed by it), shown in Swiss spelling. */
    private fun ui(key: String) = ChromeText.ui(key).replace("ß", "ss")

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val TOUCH_DP = 44
    }
}
