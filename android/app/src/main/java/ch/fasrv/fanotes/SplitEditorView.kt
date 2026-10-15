package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.MotionEvent
import android.widget.EditText
import ch.fasrv.fanotes.desk.editorLineNumberLabels
import ch.fasrv.fanotes.desk.findDetailsBlocks
import ch.fasrv.fanotes.desk.lineNumberColumnPx
import ch.fasrv.fanotes.desk.lineStartOffsets
import ch.fasrv.fanotes.desk.nextEditorOccurrence
import ch.fasrv.fanotes.desk.toggleDetailsOpen
import ch.fasrv.fanotes.desk.toggleTaskMarker
import kotlin.math.abs

/**
 * Text mode for the second column. It uses the same live preview as the open
 * note: markers hide off the cursor line, and a tap checks a task or folds a
 * details block.
 */
class SplitEditorView(context: Context) : EditText(context) {
    var onCommit: (String) -> Unit = {}
    var accent: Int = 0xFF2A6F97.toInt()
    var showLineNumbers: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            applyGutter()
        }
    private var writing = false
    private var painting = false
    private var ready = false
    private var downX = 0f
    private var downY = 0f

    init {
        background = null
        setTextColor(0xFF252630.toInt())
        setHintTextColor(0xFF8A8D98.toInt())
        hint = "Text auf dem Papier"
        gravity = Gravity.TOP or Gravity.START
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        setPadding(0, 0, 0, 0)
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (!ready) return
                paintPreview()
                if (!writing) onCommit(s?.toString().orEmpty())
            }
        })
        ready = true
    }

    fun show(markdown: String) {
        if (text?.toString() == markdown) {
            paintPreview()
            return
        }
        val cursor = selectionStart.coerceAtLeast(0).coerceAtMost(markdown.length)
        writing = true
        setText(markdown)
        setSelection(cursor)
        writing = false
        paintPreview()
    }

    fun selectNext() {
        val value = text?.toString().orEmpty()
        val start = selectionStart.coerceAtLeast(0)
        val end = selectionEnd.coerceAtLeast(start)
        val next = nextEditorOccurrence(value, start, end) ?: return
        requestFocus()
        setSelection(next.first, next.second)
        post {
            val layout = layout ?: return@post
            val safe = next.first.coerceAtMost(layout.text.length)
            val top = layout.getLineTop(layout.getLineForOffset(safe))
            scrollTo(0, (top - paddingTop).coerceAtLeast(0))
        }
    }

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        if (ready && !painting) paintPreview()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_UP -> {
                val tapped = abs(event.x - downX) < 24f && abs(event.y - downY) < 24f
                if (tapped && toggleAt(event.x, event.y)) return true
            }
        }
        return super.onTouchEvent(event)
    }

    private fun toggleAt(x: Float, y: Float): Boolean {
        val editable = text ?: return false
        if (editable.isEmpty()) return false
        val offset = getOffsetForPosition(x, y).coerceIn(0, editable.length)
        val probeStart = (offset - 1).coerceAtLeast(0)
        val probeEnd = (offset + 1).coerceAtMost(editable.length)
        val before = editable.toString()
        val details = editable.getSpans(probeStart, probeEnd, DetailsSummarySpan::class.java).isNotEmpty()
        val next = when {
            details -> toggleDetailsOpen(before, offset)
            editable.getSpans(probeStart, probeEnd, TaskSpan::class.java).isNotEmpty() -> toggleTaskMarker(before, offset)
            else -> null
        } ?: return false
        val start = if (details) {
            findDetailsBlocks(before).firstOrNull { offset >= it.from && offset < it.to }?.from ?: 0
        } else {
            selectionStart.coerceAtLeast(0)
        }
        val end = if (details) start else selectionEnd.coerceAtLeast(start)
        writing = true
        setText(next)
        setSelection(start.coerceIn(0, next.length), end.coerceIn(0, next.length))
        writing = false
        paintPreview()
        onCommit(next)
        return true
    }

    private fun paintPreview() {
        if (painting) return
        val editable = text ?: return
        painting = true
        try {
            applyLivePreview(editable, selectionStart, selectionEnd, accent)
        } finally {
            painting = false
        }
        applyGutter()
    }

    private fun applyGutter() {
        val gap = dp(4)
        val next = if (!showLineNumbers) 0 else lineNumberColumnPx(text?.toString().orEmpty(), textSize, dp(18)) + gap
        if (next == paddingLeft) return
        setPadding(next, paddingTop, paddingRight, paddingBottom)
    }

    override fun onDraw(canvas: Canvas) {
        val layout = layout
        if (showLineNumbers && layout != null && paddingLeft > 0) {
            val value = text?.toString().orEmpty()
            val labels = editorLineNumberLabels(value)
            val starts = lineStartOffsets(value)
            val mark = paint
            val oldColor = mark.color
            val oldSize = mark.textSize
            val oldAlign = mark.textAlign
            mark.color = 0xFF8A8D98.toInt()
            mark.textSize = textSize * 0.82f
            mark.textAlign = Paint.Align.RIGHT
            val right = (paddingLeft - dp(4)).toFloat()
            for (index in starts.indices) {
                val visual = layout.getLineForOffset(starts[index].coerceAtMost(value.length))
                val baseline = paddingTop + layout.getLineBaseline(visual) - scrollY
                if (baseline < 0 || baseline > height + mark.textSize) continue
                canvas.drawText(labels[index], right, baseline.toFloat(), mark)
            }
            mark.color = oldColor
            mark.textSize = oldSize
            mark.textAlign = oldAlign
        }
        super.onDraw(canvas)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
