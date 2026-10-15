package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.widget.EditText
import ch.fasrv.fanotes.desk.editorLineNumberLabels
import ch.fasrv.fanotes.desk.findDetailsBlocks
import ch.fasrv.fanotes.desk.copyMarkdownLines
import ch.fasrv.fanotes.desk.toggleMarkdownComment
import ch.fasrv.fanotes.desk.indentMarkdownLines
import ch.fasrv.fanotes.desk.moveMarkdownLines
import ch.fasrv.fanotes.desk.pasteUrlAsMarkdownLink
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
    var onVisibleEdit: (String, String) -> Unit = { _, _ -> }
    var onToggleFold: (Int) -> Unit = {}
    var foldMarkers: List<String> = emptyList()
        set(value) {
            if (field == value) return
            field = value
            applyGutter()
            invalidate()
        }
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
    private var editBefore = ""

    init {
        background = null
        setTextColor(0xFF252630.toInt())
        setHintTextColor(0xFF8A8D98.toInt())
        hint = "Text auf dem Papier"
        gravity = Gravity.TOP or Gravity.START
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        setPadding(0, 0, 0, 0)
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
                if (!writing) editBefore = s?.toString().orEmpty()
            }
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (!ready) return
                paintPreview()
                if (!writing) {
                    val next = s?.toString().orEmpty()
                    val replacement = ch.fasrv.fanotes.desk.markdownEnterReplacement(editBefore, next)
                        ?: ch.fasrv.fanotes.desk.markdownBackspaceReplacement(editBefore, next)
                    if (replacement != null) {
                        writing = true
                        setText(replacement.text)
                        setSelection(replacement.cursor.coerceIn(0, replacement.text.length))
                        writing = false
                        val origin = editBefore
                        editBefore = replacement.text
                        onVisibleEdit(origin, replacement.text)
                    } else {
                        onVisibleEdit(editBefore, next)
                    }
                }
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
        editBefore = markdown
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
                if (tapped && event.x < foldColumn() && toggleFoldAt(event.y)) return true
                if (tapped && toggleAt(event.x, event.y)) return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onTextContextMenuItem(id: Int): Boolean {
        if ((id == android.R.id.paste || id == android.R.id.pasteAsPlainText) && applyPastedLink(clipboardPlainText(context))) {
            return true
        }
        return super.onTextContextMenuItem(id)
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val base = super.onCreateInputConnection(outAttrs) ?: return null
        return object : InputConnectionWrapper(base, true) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                if (writing) return true
                val pasted = text?.toString().orEmpty()
                if (pasted.length > 1 && applyPastedLink(pasted)) return true
                return super.commitText(text, newCursorPosition)
            }
        }
    }

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
        if (event.isAltPressed && !event.isCtrlPressed && !event.isMetaPressed &&
            (keyCode == KeyEvent.KEYCODE_DPAD_UP || keyCode == KeyEvent.KEYCODE_DPAD_DOWN)
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                val forward = keyCode == KeyEvent.KEYCODE_DPAD_DOWN
                val edit = if (event.isShiftPressed) {
                    copyMarkdownLines(text?.toString().orEmpty(), selectionStart, selectionEnd, forward)
                } else {
                    moveMarkdownLines(text?.toString().orEmpty(), selectionStart, selectionEnd, forward)
                }
                applyLineEdit(edit)
            }
            return true
        }
        if (event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed &&
            (keyCode == KeyEvent.KEYCODE_SLASH || event.unicodeChar == '/'.code)
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                applyLineEdit(toggleMarkdownComment(text?.toString().orEmpty(), selectionStart, selectionEnd))
            }
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_TAB && !event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed) {
            if (event.action == KeyEvent.ACTION_DOWN) indentSelection(event.isShiftPressed)
            return true
        }
        return super.onKeyPreIme(keyCode, event)
    }

    private fun applyLineEdit(edit: ch.fasrv.fanotes.desk.MarkdownEdit?) {
        if (writing || edit == null) return
        setText(edit.text)
        setSelection(
            edit.selectionStart.coerceIn(0, edit.text.length),
            edit.selectionEnd.coerceIn(0, edit.text.length),
        )
    }

    private fun indentSelection(outdent: Boolean) {
        if (writing) return
        val edit = indentMarkdownLines(text?.toString().orEmpty(), selectionStart, selectionEnd, outdent)
        if (edit.text == text?.toString()) return
        setText(edit.text)
        setSelection(
            edit.selectionStart.coerceIn(0, edit.text.length),
            edit.selectionEnd.coerceIn(0, edit.text.length),
        )
    }

    private fun applyPastedLink(pasted: String?): Boolean {
        if (pasted.isNullOrEmpty() || writing) return false
        val edit = pasteUrlAsMarkdownLink(text?.toString().orEmpty(), selectionStart, selectionEnd, pasted) ?: return false
        val origin = text?.toString().orEmpty()
        writing = true
        setText(edit.text)
        setSelection(edit.selectionStart, edit.selectionEnd)
        writing = false
        editBefore = edit.text
        onVisibleEdit(origin, edit.text)
        return true
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
        onVisibleEdit(before, next)
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

    private fun foldColumn() = dp(18)

    private fun applyGutter() {
        val gap = dp(4)
        val numbers = if (!showLineNumbers) 0 else lineNumberColumnPx(text?.toString().orEmpty(), textSize, dp(18)) + gap
        val next = foldColumn() + numbers
        if (next == paddingLeft) return
        setPadding(next, paddingTop, paddingRight, paddingBottom)
    }

    override fun onDraw(canvas: Canvas) {
        val layout = layout
        if (layout != null && paddingLeft > 0 && (showLineNumbers || foldMarkers.any { it.isNotEmpty() })) {
            val value = text?.toString().orEmpty()
            val starts = lineStartOffsets(value)
            val mark = paint
            val oldColor = mark.color
            val oldSize = mark.textSize
            val oldAlign = mark.textAlign
            mark.color = 0xFF8A8D98.toInt()
            mark.textAlign = Paint.Align.RIGHT
            mark.textSize = textSize
            for (index in foldMarkers.indices) {
                if (foldMarkers[index].isEmpty() || index >= starts.size) continue
                val visual = layout.getLineForOffset(starts[index].coerceAtMost(value.length))
                val baseline = paddingTop + layout.getLineBaseline(visual) - scrollY
                if (baseline < 0 || baseline > height + mark.textSize) continue
                canvas.drawText(foldMarkers[index], (foldColumn() - dp(2)).toFloat(), baseline.toFloat(), mark)
            }
            if (showLineNumbers) {
                val labels = editorLineNumberLabels(value)
                mark.textSize = textSize * 0.82f
                val right = (paddingLeft - dp(4)).toFloat()
                for (index in starts.indices) {
                    if (index >= labels.size) break
                    val visual = layout.getLineForOffset(starts[index].coerceAtMost(value.length))
                    val baseline = paddingTop + layout.getLineBaseline(visual) - scrollY
                    if (baseline < 0 || baseline > height + mark.textSize) continue
                    canvas.drawText(labels[index], right, baseline.toFloat(), mark)
                }
            }
            mark.color = oldColor
            mark.textSize = oldSize
            mark.textAlign = oldAlign
        }
        super.onDraw(canvas)
    }

    private fun toggleFoldAt(y: Float): Boolean {
        val layout = layout ?: return false
        val visual = layout.getLineForVertical((y + scrollY - paddingTop).toInt()).coerceAtLeast(0)
        val value = text?.toString().orEmpty()
        val starts = lineStartOffsets(value)
        var logical = 1
        for (index in starts.indices) {
            val line = layout.getLineForOffset(starts[index].coerceAtMost(value.length))
            if (line <= visual) logical = index + 1 else break
        }
        onToggleFold(logical)
        return true
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
