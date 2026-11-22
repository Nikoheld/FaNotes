package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.app.Activity
import android.content.ClipboardManager
import android.content.ContextWrapper
import android.view.DragEvent
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import ch.fasrv.fanotes.desk.selectionWashArgb
import ch.fasrv.fanotes.desk.bracketTyping
import ch.fasrv.fanotes.desk.insertMarkdownBlankLine
import ch.fasrv.fanotes.desk.insertMarkdownNewlineIndent
import ch.fasrv.fanotes.desk.markdownFormatShortcut
import ch.fasrv.fanotes.desk.matchingBracketJump
import ch.fasrv.fanotes.desk.selectMarkdownLine
import ch.fasrv.fanotes.desk.copyMarkdownLines
import ch.fasrv.fanotes.desk.deleteMarkdownLines
import ch.fasrv.fanotes.desk.toggleMarkdownBlockComment
import ch.fasrv.fanotes.desk.toggleMarkdownComment
import ch.fasrv.fanotes.desk.indentMarkdownLines
import ch.fasrv.fanotes.desk.moveMarkdownLines
import ch.fasrv.fanotes.desk.pasteUrlAsMarkdownLink
import ch.fasrv.fanotes.ink.DraftingKind
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.remember
import ch.fasrv.fanotes.ink.switchMode
import ch.fasrv.fanotes.study.encode
import ch.fasrv.fanotes.study.liveSeconds

/**
 * The running task timer as the toolbar chip shows it: the task's name, the seconds already in the note and the
 * timer itself, whose checkpoint tells how many seconds came on top. It changes when the timer starts, stops or is saved.
 */
data class StudyTimerChip(val label: String, val baseSec: Int, val run: ch.fasrv.fanotes.study.StudyTimerRun)

/** A gutter column whose size [NotePageView.placeEditor] decides; the parent's measure pass does not re-wrap it. */
private class GutterText(context: Context) : TextView(context) {
    var fixedWidth = 0
    var fixedHeight = 0

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (fixedWidth > 0 && fixedHeight > 0) {
            super.onMeasure(
                MeasureSpec.makeMeasureSpec(fixedWidth, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(fixedHeight, MeasureSpec.EXACTLY),
            )
        } else {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        }
    }
}

private const val PREVIEW_WINDOW_MIN_CHARS = 30_000
private const val PREVIEW_FIRST_CHARS = 12_000
private const val PREVIEW_CARET_CHARS = 1_500
private const val PREVIEW_TYPING_CHARS = 500
private const val BLOCK_MARKER_CHARS = "`~\$|<-\n"

/**
 * The page and its chrome live in one clipped frame. The toolbar is a later
 * sibling of the canvas, so a zoomed sheet cannot paint over it, and hiding
 * the bar does not resize the page under an active pen.
 */
class NotePageView(context: Context) : FrameLayout(context) {
    val ink = InkSurfaceView(context)
    private var previewReady = false
    private var paintingPreview = false
    /** True while [apply] loads text: one paint at the end instead of one per text or selection change. */
    private var batchingPreview = false
    private val previewRunnable = Runnable { paintLivePreview() }
    /** Layout pixel range the last windowed paint covered; null when the whole text was styled. */
    private var paintedTop = 0
    private var paintedBottom = 0
    private var paintedWindowed = false
    /** Set by a keystroke in a long note: the next paint restyles only the lines around the caret. */
    private var typingPaint = false
    /** Whether the long note has block markers (fences, tables, ...), kept across typing so a keystroke does not rescan it. */
    private var blockMarkersKnown: Boolean? = null
    private val editor = object : EditText(context) {
        // EditText.setText runs from the constructor and reports a selection
        // before the fields below exist. Stay quiet until init finishes.
        private var constructed = false
        private var detailsDownX = 0f
        private var detailsDownY = 0f
        private var touchX = 0f
        private var touchY = 0f
        val spelling = SpellingController(this)
        private val linkPointer = PreviewLinkPointer()

        fun bindLinkPointer() {
            text?.bindPreviewLinkPointer(linkPointer)
        }
        private var tabFocusMode = false
        private val history = ch.fasrv.fanotes.desk.EditorHistory()
        private var cursorBeforeEdit = 0
        private val activeLinePaint = Paint()

        init {
            constructed = true
        }

        fun captureCursor() {
            cursorBeforeEdit = selectionEnd.coerceAtLeast(0)
        }

        fun resetHistory() {
            history.reset()
        }

        fun rememberChange(
            before: String,
            after: String,
            cursorBefore: Int = cursorBeforeEdit,
            cursorAfter: Int = selectionEnd.coerceAtLeast(0),
        ) {
            history.record(before, after, cursorBefore, cursorAfter, System.currentTimeMillis())
        }

        fun undoTyping(): Boolean = restoreHistory(history.undo(text?.toString().orEmpty()))

        fun redoTyping(): Boolean = restoreHistory(history.redo(text?.toString().orEmpty()))

        fun trackSelection(anchor: Int, head: Int) {
            if (applyingHistory) return
            history.noteSelection(anchor, head, text?.length ?: 0, System.currentTimeMillis())
        }

        fun undoSelectionMove(): Boolean = moveSelectionHistory(history.undoSelection(selectionStart, selectionEnd, text?.length ?: 0))

        fun redoSelectionMove(): Boolean = moveSelectionHistory(history.redoSelection(selectionStart, selectionEnd, text?.length ?: 0))

        private var applyingHistory = false

        private fun moveSelectionHistory(mark: Pair<Int, Int>?): Boolean {
            if (mark == null) return false
            applyingHistory = true
            setSelection(mark.first, mark.second)
            applyingHistory = false
            return true
        }

        private fun restoreHistory(edit: ch.fasrv.fanotes.desk.MarkdownEdit?): Boolean {
            if (edit == null) return false
            val origin = text?.toString().orEmpty()
            writing = true
            applyingHistory = true
            setText(edit.text)
            setSelection(
                edit.selectionStart.coerceIn(0, edit.text.length),
                edit.selectionEnd.coerceIn(0, edit.text.length),
            )
            applyingHistory = false
            writing = false
            editBefore = edit.text
            onVisibleMarkdown(origin, edit.text)
            paintLivePreview()
            return true
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            super.onSizeChanged(w, h, oldw, oldh)
            if ((w != oldw || h != oldh) && previewReady && !paintingPreview) schedulePreview()
        }

        /** The size [placeEditor] decided on. The parent's own measure pass must not give the text another width. */
        var fixedWidth = 0
        var fixedHeight = 0

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            if (fixedWidth > 0 && fixedHeight > 0) {
                super.onMeasure(
                    MeasureSpec.makeMeasureSpec(fixedWidth, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(fixedHeight, MeasureSpec.EXACTLY),
                )
            } else {
                super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            }
        }

        override fun onScrollChanged(horiz: Int, vert: Int, oldHoriz: Int, oldVert: Int) {
            super.onScrollChanged(horiz, vert, oldHoriz, oldVert)
            if (previewReady && !paintingPreview && paintedWindowed) {
                val margin = height / 2
                val needsTop = paintedTop > 0 && vert < paintedTop + margin
                val needsBottom = paintedBottom < (layout?.height ?: 0) && vert + height > paintedBottom - margin
                if (needsTop || needsBottom) schedulePreview(40)
            }
        }

        override fun onDraw(canvas: Canvas) {
            val textLayout = layout
            if (textLayout != null) {
                canvas.drawEditorActiveLine(
                    textLayout,
                    text?.length ?: 0,
                    selectionEnd,
                    activeLinePaint,
                    scrollY,
                    paddingLeft,
                    paddingTop,
                    paddingRight,
                    width,
                    height,
                )
            }
            super.onDraw(canvas)
            spelling.draw(canvas)
        }

        override fun onSelectionChanged(selStart: Int, selEnd: Int) {
            super.onSelectionChanged(selStart, selEnd)
            if (!constructed) return
            trackSelection(selStart, selEnd)
            spelling.schedule(220)
            invalidate()
            if (previewReady && !paintingPreview && !writing) schedulePreview()
            tags?.onCaretMoved()
        }

        override fun performLongClick(): Boolean {
            if (spelling.showAt(getOffsetForPosition(touchX, touchY))) return true
            return super.performLongClick()
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            touchX = event.x
            touchY = event.y
            if (event.actionMasked == MotionEvent.ACTION_DOWN && event.buttonState and MotionEvent.BUTTON_SECONDARY != 0) {
                if (spelling.showAt(getOffsetForPosition(event.x, event.y))) return true
            }
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    detailsDownX = event.x
                    detailsDownY = event.y
                    followPreviewLinkPointer(linkPointer, event, true)
                }
                MotionEvent.ACTION_MOVE -> followPreviewLinkPointer(linkPointer, event, true)
                MotionEvent.ACTION_UP -> {
                    val tapped = kotlin.math.abs(event.x - detailsDownX) < 24f && kotlin.math.abs(event.y - detailsDownY) < 24f
                    val handled = tapped && (followRenderedLink(event.x, event.y) || toggleDetailsSummary(event.x, event.y) || toggleTaskBox(event.x, event.y) || openStudyBlock(event.x, event.y))
                    followPreviewLinkPointer(linkPointer, event, false)
                    if (handled) return true
                }
                MotionEvent.ACTION_CANCEL -> followPreviewLinkPointer(linkPointer, event, false)
            }
            return super.onTouchEvent(event)
        }

        override fun onHoverEvent(event: MotionEvent): Boolean {
            followPreviewLinkPointer(linkPointer, event, event.actionMasked != MotionEvent.ACTION_HOVER_EXIT)
            return super.onHoverEvent(event)
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
            if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_PERIOD &&
                (event.isCtrlPressed || event.isMetaPressed) && !event.isAltPressed
            ) {
                if (spelling.showAtCursor()) return true
            }
            if (keyCode == KeyEvent.KEYCODE_ESCAPE && !event.isCtrlPressed && !event.isAltPressed &&
                !event.isMetaPressed && !event.isShiftPressed
            ) {
                val head = ch.fasrv.fanotes.desk.simplifyEditorSelection(
                    selectionStart,
                    selectionEnd,
                    text?.length ?: 0,
                )
                if (head != null) {
                    if (event.action == KeyEvent.ACTION_DOWN) setSelection(head)
                    return true
                }
            }
            if (tags?.onKey(keyCode, event) == true) return true
            val historyKey = when (keyCode) {
                KeyEvent.KEYCODE_Z -> "z"
                KeyEvent.KEYCODE_Y -> "y"
                KeyEvent.KEYCODE_U -> "u"
                else -> ""
            }
            val historyCommand = ch.fasrv.fanotes.desk.editorHistoryCommand(
                event.isCtrlPressed,
                event.isShiftPressed,
                event.isAltPressed,
                event.isMetaPressed,
                historyKey,
            )
            val selectionCommand = ch.fasrv.fanotes.desk.editorSelectionCommand(
                event.isCtrlPressed,
                event.isShiftPressed,
                event.isAltPressed,
                event.isMetaPressed,
                historyKey,
            )
            if (historyCommand != null || selectionCommand != null) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    tags?.hide()
                    when {
                        historyCommand == "undo" -> undoTyping()
                        historyCommand == "redo" -> redoTyping()
                        selectionCommand == "undo-selection" -> undoSelectionMove()
                        selectionCommand == "redo-selection" -> redoSelectionMove()
                    }
                }
                return true
            }
            if (ch.fasrv.fanotes.desk.togglesEditorTabFocus(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    if (keyCode == KeyEvent.KEYCODE_M) "m" else "",
                )
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    tabFocusMode = !tabFocusMode
                    @Suppress("DEPRECATION")
                    announceForAccessibility(ch.fasrv.fanotes.desk.editorTabFocusAnnouncement(tabFocusMode))
                }
                return true
            }
            if (event.isAltPressed && !event.isCtrlPressed && !event.isMetaPressed &&
                (keyCode == KeyEvent.KEYCODE_DPAD_UP || keyCode == KeyEvent.KEYCODE_DPAD_DOWN)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    val forward = keyCode == KeyEvent.KEYCODE_DPAD_DOWN
                    if (event.isShiftPressed) copySelection(forward) else moveSelection(forward)
                }
                return true
            }
            if (event.isAltPressed && !event.isCtrlPressed && !event.isMetaPressed &&
                (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    moveBySyntax(keyCode == KeyEvent.KEYCODE_DPAD_RIGHT, event.isShiftPressed)
                }
                return true
            }
            if (keyCode == KeyEvent.KEYCODE_BACKSLASH && event.isCtrlPressed && event.isShiftPressed &&
                !event.isAltPressed && !event.isMetaPressed
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) jumpToMatchingBracket()
                return true
            }
            if (keyCode == KeyEvent.KEYCODE_L && event.isAltPressed && !event.isCtrlPressed && !event.isMetaPressed) {
                if (event.action == KeyEvent.ACTION_DOWN) selectCurrentLine()
                return true
            }
            if (keyCode == KeyEvent.KEYCODE_ENTER && event.isShiftPressed && !event.isCtrlPressed &&
                !event.isAltPressed && !event.isMetaPressed
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) insertIndentedBreak()
                return true
            }
            if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                val command = ch.fasrv.fanotes.desk.deskShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    "enter",
                )
                if (command != null) {
                    if (event.action == KeyEvent.ACTION_DOWN) onDeskShortcut(command)
                    return true
                }
            }
            if (!event.isCtrlPressed && !event.isMetaPressed && !event.isAltPressed &&
                (keyCode == KeyEvent.KEYCODE_PAGE_UP || keyCode == KeyEvent.KEYCODE_PAGE_DOWN)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    moveByPage(keyCode == KeyEvent.KEYCODE_PAGE_DOWN, event.isShiftPressed)
                }
                return true
            }
            if ((event.isCtrlPressed || event.isMetaPressed) && !event.isAltPressed &&
                (keyCode == KeyEvent.KEYCODE_MOVE_HOME || keyCode == KeyEvent.KEYCODE_MOVE_END)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    moveToDocumentEdge(keyCode == KeyEvent.KEYCODE_MOVE_END, event.isShiftPressed)
                }
                return true
            }
            if (!event.isCtrlPressed && !event.isMetaPressed && !event.isAltPressed &&
                (keyCode == KeyEvent.KEYCODE_MOVE_HOME || keyCode == KeyEvent.KEYCODE_MOVE_END)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    moveByLineBoundary(keyCode == KeyEvent.KEYCODE_MOVE_END, event.isShiftPressed)
                }
                return true
            }
            if ((event.isCtrlPressed || event.isMetaPressed) && !event.isAltPressed &&
                (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    moveByEditorGroup(keyCode == KeyEvent.KEYCODE_DPAD_RIGHT, event.isShiftPressed)
                }
                return true
            }
            if ((event.isCtrlPressed || event.isMetaPressed) && !event.isShiftPressed && !event.isAltPressed &&
                (keyCode == KeyEvent.KEYCODE_DEL || keyCode == KeyEvent.KEYCODE_FORWARD_DEL)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    deleteByEditorGroup(keyCode == KeyEvent.KEYCODE_FORWARD_DEL)
                }
                return true
            }
            if (keyCode == KeyEvent.KEYCODE_K && event.isCtrlPressed && event.isShiftPressed &&
                !event.isAltPressed && !event.isMetaPressed
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) deleteLines()
                return true
            }
            if (event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed &&
                (keyCode == KeyEvent.KEYCODE_SLASH || event.unicodeChar == '/'.code)
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) toggleComment()
                return true
            }
            if (keyCode == KeyEvent.KEYCODE_A && event.isAltPressed && event.isShiftPressed &&
                !event.isCtrlPressed && !event.isMetaPressed
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) toggleBlockComment()
                return true
            }
            val searchKey = when (keyCode) {
                KeyEvent.KEYCODE_F -> "f"
                KeyEvent.KEYCODE_G -> "g"
                KeyEvent.KEYCODE_F3 -> "f3"
                else -> null
            }
            if (searchKey != null) {
                val command = ch.fasrv.fanotes.desk.editorSearchShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    searchKey,
                )
                if (command != null) {
                    if (event.action == KeyEvent.ACTION_DOWN) searchKeys(command)
                    return true
                }
            }
            if (keyCode == KeyEvent.KEYCODE_D && ch.fasrv.fanotes.desk.nextOccurrenceShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    'd',
                )
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    selectNextOccurrence()
                    onDeskShortcut("pen")
                }
                return true
            }
            val formatLetter = when (keyCode) {
                KeyEvent.KEYCODE_B -> 'b'
                KeyEvent.KEYCODE_I -> 'i'
                KeyEvent.KEYCODE_K -> 'k'
                else -> null
            }
            if (formatLetter != null) {
                val action = markdownFormatShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    formatLetter,
                )
                if (action != null) {
                    if (event.action == KeyEvent.ACTION_DOWN) format(action)
                    return true
                }
            }
            val bracket = when (keyCode) {
                KeyEvent.KEYCODE_LEFT_BRACKET -> '['
                KeyEvent.KEYCODE_RIGHT_BRACKET -> ']'
                else -> null
            }
            if (bracket != null) {
                val command = ch.fasrv.fanotes.desk.foldShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    bracket,
                )
                if (command != null) {
                    if (event.action == KeyEvent.ACTION_DOWN) foldKeys(command)
                    return true
                }
                val outdent = ch.fasrv.fanotes.desk.indentBracketShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    bracket,
                )
                if (outdent != null) {
                    if (event.action == KeyEvent.ACTION_DOWN) indentSelection(outdent)
                    return true
                }
            }
            val deskKey = when (keyCode) {
                KeyEvent.KEYCODE_TAB -> "tab"
                KeyEvent.KEYCODE_DPAD_LEFT -> "left"
                KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
                KeyEvent.KEYCODE_T -> "t"
                KeyEvent.KEYCODE_O -> "o"
                KeyEvent.KEYCODE_BACKSLASH -> "\\"
                KeyEvent.KEYCODE_W -> "w"
                KeyEvent.KEYCODE_S -> "s"
                KeyEvent.KEYCODE_P -> "p"
                KeyEvent.KEYCODE_F -> "f"
                KeyEvent.KEYCODE_A -> "a"
                KeyEvent.KEYCODE_I -> "i"
                KeyEvent.KEYCODE_N -> "n"
                KeyEvent.KEYCODE_COMMA -> ","
                KeyEvent.KEYCODE_E -> "e"
                KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "enter"
                in KeyEvent.KEYCODE_1..KeyEvent.KEYCODE_9 -> ('1' + (keyCode - KeyEvent.KEYCODE_1)).toString()
                else -> null
            }
            if (deskKey != null) {
                val command = ch.fasrv.fanotes.desk.deskShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    deskKey,
                )
                if (command != null) {
                    if (event.action == KeyEvent.ACTION_DOWN) onDeskShortcut(command)
                    return true
                }
            }
            if (keyCode == KeyEvent.KEYCODE_TAB && ch.fasrv.fanotes.desk.editorIndentsOnTab(
                    tabFocusMode,
                    event.isCtrlPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                )
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) indentSelection(event.isShiftPressed)
                return true
            }
            return super.onKeyPreIme(keyCode, event)
        }

        fun jumpToMatchingBracket() {
            val edit = matchingBracketJump(text?.toString().orEmpty(), selectionStart, selectionEnd) ?: return
            setSelection(edit.selectionStart.coerceIn(0, edit.text.length))
        }

        fun selectCurrentLine() {
            val edit = selectMarkdownLine(text?.toString().orEmpty(), selectionStart, selectionEnd)
            setSelection(
                edit.selectionStart.coerceIn(0, edit.text.length),
                edit.selectionEnd.coerceIn(0, edit.text.length),
            )
        }

        fun insertIndentedBreak() {
            applyLineEdit(insertMarkdownNewlineIndent(text?.toString().orEmpty(), selectionStart, selectionEnd))
        }

        fun insertBlankLine() {
            applyLineEdit(insertMarkdownBlankLine(text?.toString().orEmpty(), selectionStart, selectionEnd))
        }

        fun deleteLines() {
            applyLineEdit(deleteMarkdownLines(text?.toString().orEmpty(), selectionStart, selectionEnd))
        }

        fun moveToDocumentEdge(forward: Boolean, extend: Boolean) {
            val value = text?.toString().orEmpty()
            val (anchor, head) = ch.fasrv.fanotes.desk.editorDocumentSelection(
                value,
                selectionStart,
                forward,
                extend,
            )
            val length = value.length
            val nextHead = head.coerceIn(0, length)
            setSelection(anchor.coerceIn(0, length), nextHead)
            val metrics = layout ?: return
            if (metrics.lineCount == 0) return
            val line = metrics.getLineForOffset(nextHead.coerceAtMost(metrics.getLineEnd(metrics.lineCount - 1)))
            val top = metrics.getLineTop(line)
            scrollTo(scrollX, (top - height / 3).coerceAtLeast(0))
        }

        fun moveByPage(forward: Boolean, extend: Boolean) {
            val value = text?.toString().orEmpty()
            val metrics = layout
            val lineHeight = if (metrics != null && metrics.lineCount > 0) {
                (metrics.getLineBottom(0) - metrics.getLineTop(0)).coerceAtLeast(1)
            } else this.lineHeight.coerceAtLeast(1)
            val lines = ch.fasrv.fanotes.desk.editorPageLineCount(height, lineHeight)
            val headNow = selectionEnd.coerceIn(0, value.length)
            val before = metrics?.getLineTop(metrics.getLineForOffset(headNow)) ?: 0
            val (anchor, head) = ch.fasrv.fanotes.desk.editorPageSelection(
                value,
                selectionStart,
                selectionEnd,
                forward,
                extend,
                lines,
            )
            val length = value.length
            setSelection(anchor.coerceIn(0, length), head.coerceIn(0, length))
            val afterLayout = layout ?: return
            val after = afterLayout.getLineTop(afterLayout.getLineForOffset(head.coerceIn(0, length)))
            scrollBy(0, after - before)
        }

        fun moveByLineBoundary(forward: Boolean, extend: Boolean) {
            val value = text?.toString().orEmpty()
            val (anchor, head) = ch.fasrv.fanotes.desk.editorLineBoundarySelection(
                value,
                selectionStart,
                selectionEnd,
                forward,
                extend,
            )
            val length = value.length
            setSelection(anchor.coerceIn(0, length), head.coerceIn(0, length))
        }

        fun moveBySyntax(forward: Boolean, extend: Boolean) {
            val value = text?.toString().orEmpty()
            val (anchor, head) = ch.fasrv.fanotes.desk.editorSyntaxSelection(
                value,
                selectionStart,
                selectionEnd,
                forward,
                extend,
            )
            val length = value.length
            setSelection(anchor.coerceIn(0, length), head.coerceIn(0, length))
        }

        fun moveByEditorGroup(forward: Boolean, extend: Boolean) {
            val value = text?.toString().orEmpty()
            val (anchor, head) = ch.fasrv.fanotes.desk.editorGroupSelection(
                value,
                selectionStart,
                selectionEnd,
                forward,
                extend,
            )
            val length = value.length
            setSelection(anchor.coerceIn(0, length), head.coerceIn(0, length))
        }

        fun deleteByEditorGroup(forward: Boolean) {
            val edit = ch.fasrv.fanotes.desk.deleteEditorGroup(
                text?.toString().orEmpty(),
                selectionStart,
                selectionEnd,
                forward,
            )
            if (edit.text == text?.toString()) return
            applyLineEdit(edit)
        }

        fun toggleComment() {
            applyLineEdit(toggleMarkdownComment(text?.toString().orEmpty(), selectionStart, selectionEnd))
        }

        fun toggleBlockComment() {
            applyLineEdit(toggleMarkdownBlockComment(text?.toString().orEmpty(), selectionStart, selectionEnd))
        }

        fun moveSelection(forward: Boolean) {
            applyLineEdit(moveMarkdownLines(text?.toString().orEmpty(), selectionStart, selectionEnd, forward))
        }

        fun copySelection(forward: Boolean) {
            applyLineEdit(copyMarkdownLines(text?.toString().orEmpty(), selectionStart, selectionEnd, forward))
        }

        private fun applyLineEdit(edit: ch.fasrv.fanotes.desk.MarkdownEdit?) {
            if (writing || edit == null) return
            setText(edit.text)
            setSelection(
                edit.selectionStart.coerceIn(0, edit.text.length),
                edit.selectionEnd.coerceIn(0, edit.text.length),
            )
        }

        fun indentSelection(outdent: Boolean) {
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
            val cursor = selectionEnd.coerceAtLeast(0)
            writing = true
            setText(edit.text)
            setSelection(edit.selectionStart, edit.selectionEnd)
            writing = false
            editBefore = edit.text
            rememberChange(origin, edit.text, cursor)
            onVisibleMarkdown(origin, edit.text)
            return true
        }
    }
    private val lineNumbers = GutterText(context)
    private val foldMarks = GutterText(context)
    private val boxField = object : EditText(context) {
        override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
            if (keyCode == KeyEvent.KEYCODE_ESCAPE && !event.isCtrlPressed && !event.isAltPressed &&
                !event.isMetaPressed && !event.isShiftPressed
            ) {
                if (event.action == KeyEvent.ACTION_UP) onWorksheetBoxClosed()
                return true
            }
            return super.onKeyPreIme(keyCode, event)
        }
    }
    private val boxRemove = TextView(context)
    private val noteField = object : EditText(context) {
        override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
            if (keyCode == KeyEvent.KEYCODE_ESCAPE && !event.isCtrlPressed && !event.isAltPressed &&
                !event.isMetaPressed && !event.isShiftPressed
            ) {
                if (event.action == KeyEvent.ACTION_UP) onNoteTextFieldClosed()
                return true
            }
            return super.onKeyPreIme(keyCode, event)
        }
    }
    private val noteRemove = TextView(context)
    private val noteBar = NoteTextFieldBar(context)
    private var requestedNoteFieldId: String? = null
    private var openNoteFieldId: String? = null
    private var acceptedNoteText = ""
    private var writingNoteField = false
    private var suppressNoteClose = false
    private var noteRemovePressed = false
    private var requestedBoxId: String? = null
    private var openBoxId: String? = null
    private var acceptedBoxText = ""
    private var writingBox = false
    private var suppressBoxClose = false
    private var boxRemovePressed = false
    private var boxChromeFocused = false
    private var boxChromeAccent = Int.MIN_VALUE
    private val toolbar = EditorToolbarScroll(context)
    private val toolbarRule = View(context)
    private val tools = LinearLayout(context)
    private val handle = TextView(context)
    private val syncPill = TextView(context)

    // ---- pen toolbar: touch sizes, side rail, Zeichenstudio, quick menu, laser ------------------
    private val rail = EditorRailScroll(context)
    private val penKit = PenToolbarKit(context)
    private val penCard = PenCardFrame(context, penKit)
    private val quickMenu = PenQuickMenuView(context)
    private val laserLayer = LaserOverlayView(context)
    private var barPosition = ch.fasrv.fanotes.desk.ToolbarPosition.TOP
    private var toolMemory = ch.fasrv.fanotes.ink.InkToolMemory()
    private var toolMemoryLoaded: String? = null
    private var toolMemoryRestored = false
    private var latestStyle = StrokeStyle()
    private var toolsStale = false
    private val penButtons = HashMap<String, View>()
    private var widthDot: WidthDotView? = null
    private var figureSpecState = ch.fasrv.fanotes.ink.FigureStampSpec("cube", ch.fasrv.fanotes.ink.defaultFigureParams("cube"))
    private var graphSpecState: ch.fasrv.fanotes.ink.GraphStampSpec? = null
    private val saveToolMemory = Runnable {
        val encoded = ch.fasrv.fanotes.ink.encodeToolMemory(toolMemory)
        // The setting comes back through the activity; the echo must not reset newer local state.
        toolMemoryLoaded = encoded
        onToolMemory(encoded)
    }
    /** Every style change made by the pen toolbar, its cards and the quick menu. */
    var onStyle: (StrokeStyle) -> Unit = {}
    /** Desk setting `tool-memory` (writing and drawing pen), saved a moment after the last change. */
    var onToolMemory: (String) -> Unit = {}
    var toolMemoryRaw: String?
        get() = toolMemoryLoaded
        set(value) {
            if (value == toolMemoryLoaded) return
            toolMemoryLoaded = value
            toolMemory = ch.fasrv.fanotes.ink.decodeToolMemory(value)
        }
    /** Desk setting `toolbar-position`: top bar or side rail (desktop "Werkzeugleiste"). */
    var toolbarPosition: ch.fasrv.fanotes.desk.ToolbarPosition
        get() = barPosition
        set(value) {
            if (value == barPosition) return
            barPosition = value
            closeCard()
            placeToolbar()
            toolSignature = ""
        }
    private val cardHost = object : PenCardHost {
        override val kit get() = penKit
        override val currentStyle get() = latestStyle
        override val drawingMode get() = toolMemory.drawingMode
        override val recentColors get() = toolMemory.recentColors
        override val armedSymbol get() = ink.placingSymbol
        override val symbolSize get() = ink.symbolSize
        override val symbolRotation get() = ink.symbolRotation
        override val symbolOpacity get() = ink.symbolOpacity
        override val symbolCategory get() = ink.symbolCategory
        override var figureSpec: ch.fasrv.fanotes.ink.FigureStampSpec
            get() = figureSpecState
            set(value) { figureSpecState = value }
        override var graphSpec: ch.fasrv.fanotes.ink.GraphStampSpec?
            get() = graphSpecState
            set(value) { graphSpecState = value }
        override val figureArmed get() = ink.placingFigure != null || ink.placingGraph != null
        override fun changeStyle(next: StrokeStyle) = changePenStyle(next)
        override fun chooseBrush(id: String) {
            ink.placingSymbol = null
            changePenStyle(ch.fasrv.fanotes.ink.styleWithBrush(latestStyle, id))
        }
        override fun pickCustomColor(hex: String) = pickPenColor(hex, custom = true)
        override fun armSymbol(id: String?) {
            ink.placingFigure = null
            ink.placingGraph = null
            ink.placingSymbol = id
            if (id != null && builtTool != InkTool.PEN) onTool(InkTool.PEN)
            refreshTools()
        }
        override fun setSymbolSize(value: Double) {
            ink.symbolSize = ch.fasrv.fanotes.ink.snapArtSymbolSize(value)
            onSymbolSize(value)
        }
        override fun setSymbolRotation(value: Double) {
            ink.symbolRotation = ch.fasrv.fanotes.ink.snapArtSymbolRotation(value)
            onSymbolRotation(value)
        }
        override fun setSymbolOpacity(value: Double) {
            ink.symbolOpacity = ch.fasrv.fanotes.ink.snapArtSymbolOpacity(value)
            onSymbolOpacity(value)
        }
        override fun setSymbolCategory(value: String) {
            ink.symbolCategory = ch.fasrv.fanotes.ink.artSymbolCategorySetting(value)
            onSymbolCategory(value)
        }
        override fun armFigure(spec: ch.fasrv.fanotes.ink.FigureStampSpec?) {
            ink.placingSymbol = null
            ink.placingGraph = null
            ink.placingFigure = spec
            if (spec != null && builtTool != InkTool.PEN) onTool(InkTool.PEN)
        }
        override fun armGraph(spec: ch.fasrv.fanotes.ink.GraphStampSpec?) {
            ink.placingSymbol = null
            ink.placingFigure = null
            ink.placingGraph = spec
            if (spec != null && builtTool != InkTool.PEN) onTool(InkTool.PEN)
        }
        override fun closeCard() = this@NotePageView.closeCard()
    }
    private val penCards = PenCards(context, cardHost) { id -> refreshCard(id) }
    private var boundPath = ""
    private var writing = false
    private var tags: HtmlTagAssist? = null
    private var editBefore = ""
    private var changeStart = 0
    private var changeDeleted = 0
    private val closedBrackets = mutableSetOf<Int>()
    private var sourceMarkdown = ""
    private var foldedLines: Set<Int> = emptySet()
    private var textMode = false
    private var followPen = true
    private var userOpen = true
    private var penDown = false
    private var dark = true
    private var themeId = ""
    private var systemDark = true

    var onTool: (InkTool) -> Unit = {}
    var onSync: () -> Unit = {}
    var onMarkdown: (String) -> Unit = {}
    var onPasteImage: (String, ByteArray, String) -> Unit = { _, _, _ -> }
    var onFollowLink: (String, Boolean, String?) -> Unit = { _, _, _ -> }
    /** A tap on a drawn study block: kind id and the block's position in the note. */
    var onStudyBlock: (String, Int, Int) -> Unit = { _, _, _ -> }
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
    var onTextHand: () -> Unit = {}
    var onWorksheetBoxText: (String, String) -> Unit = { _, _ -> }
    var onWorksheetBoxRemove: (String) -> Unit = {}
    var onWorksheetBoxClosed: () -> Unit = {}
    var onNoteTextFieldText: (String, String) -> Unit = { _, _ -> }
    var onNoteTextFieldRemove: (String) -> Unit = {}
    var onNoteTextFieldClosed: () -> Unit = {}
    /** Box id, font size, whether to set the colour, colour (null: default ink), bold. */
    var onNoteTextFieldStyle: (String, Int?, Boolean, String?, Boolean?) -> Unit = { _, _, _, _, _ -> }
    var onUnfoldHeading: (Int) -> Unit = {}
    var onToggleHeading: (Int) -> Unit = {}
    var onEditorFold: (String, Int) -> Unit = { _, _ -> }
    var onSearchCommand: (String, String, Int) -> Unit = { _, _, _ -> }
    var onDeskShortcut: (String) -> Unit = {}
    var onToolbarAction: (String) -> Unit = {}
    /** "Lernen" menu: annotation undo/redo availability and the image picker, wired by the activity. */
    var studyCanUndo = false
    var studyCanRedo = false
    var onStudyUndo: () -> Unit = {}
    var onStudyRedo: () -> Unit = {}
    var onStudyImage: () -> Unit = {}
    var onStudyCamera: () -> Unit = {}
    var onStudyCrop: (Int, ch.fasrv.fanotes.study.SRect) -> Unit = { _, _ -> }
    private var studyOpen = false

    // ---- compare view: the reference next to the live sketch ---------------------------------
    private var compareId: String? = null
    private var compareSrcKey = ""
    private var compareDock: ch.fasrv.fanotes.study.CompareDock? = null
    private var comparePanelPx = -1
    private val comparePanel = LinearLayout(context)
    private val compareSpacer = android.view.View(context)
    private val compareTitle = TextView(context)
    private val compareClose = TextView(context)
    private val compareImage = ImageView(context)
    private var compareDecoderPool: java.util.concurrent.ExecutorService? = null
    private val compareDecoder: java.util.concurrent.ExecutorService
        get() = compareDecoderPool?.takeUnless { it.isShutdown }
            ?: java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "study-compare").apply { isDaemon = true } }.also { compareDecoderPool = it }

    init {
        comparePanel.orientation = LinearLayout.VERTICAL
        comparePanel.visibility = GONE
        comparePanel.elevation = 6f
        comparePanel.isClickable = true
        val header = LinearLayout(context)
        header.orientation = LinearLayout.HORIZONTAL
        header.gravity = Gravity.CENTER_VERTICAL
        header.setPadding(dp(12), dp(4), dp(4), dp(4))
        compareTitle.textSize = 13f
        compareTitle.maxLines = 1
        compareTitle.ellipsize = android.text.TextUtils.TruncateAt.END
        compareClose.text = "✕"
        compareClose.textSize = 16f
        compareClose.gravity = Gravity.CENTER
        compareClose.minWidth = dp(48)
        compareClose.minHeight = dp(48)
        compareClose.contentDescription = ch.fasrv.fanotes.desk.ChromeText.ui("Vergleich schliessen")
        compareClose.setOnClickListener { closeCompare() }
        header.addView(compareTitle, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        header.addView(compareClose, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        compareImage.scaleType = ImageView.ScaleType.FIT_CENTER
        compareImage.setBackgroundColor(android.graphics.Color.WHITE)
        compareImage.setPadding(dp(6), dp(6), dp(6), dp(6))
        comparePanel.addView(compareSpacer, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0))
        comparePanel.addView(header, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        comparePanel.addView(compareImage, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
        addView(comparePanel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    private var pendingCursor: Int? = null
    var onPdfPage: (Int) -> Unit = {}
    var onSymbolSize: (Double) -> Unit = {}
    var onSymbolRotation: (Double) -> Unit = {}
    var onSymbolOpacity: (Double) -> Unit = {}
    var onSymbolCategory: (String) -> Unit = {}
    var onSymbolPose: () -> Unit = {}
    var onRestyleLink: (String, String) -> Unit = { _, _ -> }

    var pdfNote = false
    var onPdfKey: (String) -> Unit = {}

    /** The running task timer: a chip beside "Aufträge" that counts up here every second and stops the timer when tapped. */
    var studyTimerChip: StudyTimerChip? = null
        set(value) {
            if (field == value) return
            field = value
            removeCallbacks(timerTick)
            if (value != null) postDelayed(timerTick, 1000)
        }
    private var timerChipView: TextView? = null
    private val timerTick = object : Runnable {
        override fun run() {
            val timer = studyTimerChip ?: return
            timerChipView?.text = timerChipText(timer)
            postDelayed(this, 1000)
        }
    }

    private fun timerChipText(timer: StudyTimerChip): String =
        "■ ${timer.label} · ${ch.fasrv.fanotes.study.formatClock(timer.baseSec + timer.run.liveSeconds(android.os.SystemClock.elapsedRealtime()))}"

    private fun timerChip(timer: StudyTimerChip): TextView {
        val view = chip(timerChipText(timer), description = "Timer anhalten") { onToolbarAction("study-timer-stop") }
        view.setTextColor(ink.accentColor)
        view.setTypeface(view.typeface, Typeface.BOLD)
        timerChipView = view
        removeCallbacks(timerTick)
        postDelayed(timerTick, 1000)
        return view
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        removeCallbacks(timerTick)
        if (studyTimerChip != null) postDelayed(timerTick, 1000)
    }

    init {
        ink.study.onEditLabel = { promptCallout(it) }
        ink.study.onCrop = { page, rect -> onStudyCrop(page, rect) }
        ink.study.onEditLegendRow = { legend, key -> promptLegendRow(legend, key) }
        isFocusable = true
        isFocusableInTouchMode = true
        ink.onPageFocus = { requestFocus() }
        tags = HtmlTagAssist(editor) { block ->
            val origin = editor.text?.toString().orEmpty()
            val cursor = editor.selectionEnd.coerceAtLeast(0)
            writing = true
            try {
                block()
            } finally {
                writing = false
            }
            editor.rememberChange(origin, editor.text?.toString().orEmpty(), cursor)
        }
        clipChildren = true
        clipToPadding = true
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        ink.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        addView(ink, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        editor.background = null
        editor.setTextColor(0xFF252630.toInt())
        editor.highlightColor = selectionWashArgb(ink.accentColor)
        editor.setHintTextColor(0xFF8A8D98.toInt())
        editor.hint = ch.fasrv.fanotes.desk.ChromeText.ui("Text auf dem Papier")
        editor.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        editor.setLineSpacing(0f, EDITOR_LINE_SPACING_MULT)
        editor.gravity = Gravity.TOP or Gravity.START
        editor.setPadding(0, 0, 0, 0)
        lineNumbers.setTextColor(0xFF8A8D98.toInt())
        lineNumbers.gravity = Gravity.TOP or Gravity.END
        lineNumbers.setPadding(0, 0, 0, 0)
        lineNumbers.visibility = GONE
        foldMarks.setTextColor(0xFF8A8D98.toInt())
        foldMarks.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
        foldMarks.setPadding(0, 0, 0, 0)
        foldMarks.visibility = GONE
        foldMarks.setOnTouchListener { _, event ->
            if (event.actionMasked != MotionEvent.ACTION_UP) return@setOnTouchListener true
            val layout = foldMarks.layout ?: return@setOnTouchListener true
            val line = layout.getLineForVertical((event.y + foldMarks.scrollY).toInt()).coerceAtLeast(0)
            onToggleHeading(line + 1)
            true
        }
        editor.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        editor.setOnFocusChangeListener { _, focused ->
            paintLivePreview()
            if (!focused) tags?.hide()
        }
        editor.visibility = GONE
        editor.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
                textRevision += 1
                if (writing) foldStructural = true
                if (!writing) {
                    editBefore = s?.toString().orEmpty()
                    changeStart = start
                    changeDeleted = count
                    editor.captureCursor()
                }
            }
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) {
                editor.spelling.schedule(360)
                if (lineNumbers.visibility == VISIBLE || foldMarks.visibility == VISIBLE) placeEditor()
                if (writing) {
                    closedBrackets.clear()
                } else {
                    val next = s?.toString().orEmpty()
                    val insertedChars = next.length - editBefore.length + changeDeleted
                    if (!ch.fasrv.fanotes.desk.foldMarkersSurviveEdit(editBefore, next, changeStart, changeDeleted, insertedChars)) foldStructural = true
                    val bracket = bracketTyping(editBefore, changeStart, changeDeleted, next, closedBrackets)
                        ?: ch.fasrv.fanotes.desk.htmlAutoClose(editBefore, changeStart, changeDeleted, next)?.let {
                            ch.fasrv.fanotes.desk.BracketEdit(it.text, it.selectionStart, it.selectionEnd, emptySet())
                        }
                    if (bracket != null) {
                        writing = true
                        editor.setText(bracket.text)
                        editor.setSelection(bracket.selectionStart, bracket.selectionEnd)
                        writing = false
                        closedBrackets.clear()
                        closedBrackets.addAll(bracket.closedAt)
                        val origin = editBefore
                        editBefore = bracket.text
                        editor.rememberChange(origin, bracket.text)
                        onVisibleMarkdown(origin, bracket.text)
                    } else {
                        val replacement = (if (next.length == editBefore.length + 1 && next.getOrNull(changeStart) == '\n') {
                            ch.fasrv.fanotes.desk.markdownEnterReplacement(editBefore, next)
                        } else null)
                            ?: (if (next.length == editBefore.length - 1) ch.fasrv.fanotes.desk.markdownBackspaceReplacement(editBefore, next) else null)
                        if (replacement != null) {
                            writing = true
                            editor.setText(replacement.text)
                            editor.setSelection(replacement.cursor.coerceIn(0, replacement.text.length))
                            writing = false
                            closedBrackets.clear()
                            val origin = editBefore
                            editBefore = replacement.text
                            editor.rememberChange(origin, replacement.text)
                            onVisibleMarkdown(origin, replacement.text)
                        } else {
                            val inserted = next.length - editBefore.length + changeDeleted
                            val shifted = ch.fasrv.fanotes.desk.shiftClosedBrackets(
                                closedBrackets,
                                changeStart,
                                changeDeleted,
                                inserted.coerceAtLeast(0),
                            )
                            closedBrackets.clear()
                            closedBrackets.addAll(
                                ch.fasrv.fanotes.desk.bracketsOnCursorLine(next, editor.selectionStart, shifted),
                            )
                            val corrected = editor.spelling.autocorrectEdit(editBefore, next, changeStart, changeDeleted)
                            if (corrected != null) {
                                writing = true
                                editor.setText(corrected.text)
                                editor.setSelection(corrected.cursor.coerceIn(0, corrected.text.length))
                                writing = false
                                val origin = editBefore
                                editBefore = corrected.text
                                val boundaryCursor = (changeStart + 1).coerceIn(0, next.length)
                                if (corrected.splitHistory) {
                                    editor.rememberChange(origin, next, cursorAfter = boundaryCursor)
                                    editor.rememberChange(next, corrected.text, boundaryCursor, corrected.cursor)
                                } else {
                                    editor.rememberChange(origin, corrected.text, cursorAfter = corrected.cursor)
                                }
                                onVisibleMarkdown(origin, corrected.text)
                            } else {
                                editor.rememberChange(editBefore, next)
                                typedText = next
                                typedTextRevision = textRevision
                                onVisibleMarkdown(editBefore, next)
                            }
                        }
                    }
                }
                val next0Large = !writing && (editor.text?.length ?: 0) > PREVIEW_WINDOW_MIN_CHARS
                // Large note: the caret move that follows this edit schedules the (single) repaint; painting here
                // as well would restyle the window twice per keystroke.
                if (previewReady) {
                    if (next0Large) {
                        val live: CharSequence = editor.text ?: ""
                        val insertedLen = live.length - editBefore.length + changeDeleted
                        val inserted = if (insertedLen in 1..40 && changeStart + insertedLen <= live.length) live.subSequence(changeStart, changeStart + insertedLen).toString() else ""
                        if (changeDeleted > 0 || insertedLen > 40 || inserted.any { it in BLOCK_MARKER_CHARS }) blockMarkersKnown = null
                        typingPaint = true
                        schedulePreview()
                    } else paintLivePreview()
                }
                if (!writing) tags?.onUserEdit()
            }
        })
        addView(lineNumbers, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        addView(foldMarks, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        addView(editor, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        boxField.setTextColor(0xFF20222B.toInt())
        boxField.setHintTextColor(0xFF747887.toInt())
        boxField.hint = ch.fasrv.fanotes.desk.BOX_EDITOR_PLACEHOLDER
        boxField.gravity = Gravity.TOP or Gravity.START
        boxField.setLineSpacing(0f, 1.35f)
        boxField.minHeight = 0
        boxField.minimumHeight = 0
        boxField.isFocusableInTouchMode = true
        boxField.imeOptions = EditorInfo.IME_ACTION_DONE
        boxField.setRawInputType(
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
        )
        boxField.setImeActionLabel(ch.fasrv.fanotes.desk.BOX_EDITOR_SAVE, EditorInfo.IME_ACTION_DONE)
        boxField.visibility = GONE
        boxField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId != EditorInfo.IME_ACTION_DONE || requestedBoxId == null) return@setOnEditorActionListener false
            onWorksheetBoxClosed()
            true
        }
        boxField.setOnFocusChangeListener { _, focused ->
            applyBoxFieldChrome(focused)
            if (focused || suppressBoxClose || requestedBoxId == null) return@setOnFocusChangeListener
            boxField.post {
                if (suppressBoxClose || requestedBoxId == null || boxRemovePressed) return@post
                onWorksheetBoxClosed()
            }
        }
        boxField.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) {
                if (writingBox) return
                val id = openBoxId ?: return
                val next = s?.toString().orEmpty()
                if (next == acceptedBoxText) return
                if (ch.fasrv.fanotes.desk.worksheetBoxTextError(next) != null) {
                    onWorksheetBoxText(id, next)
                    writingBox = true
                    boxField.setText(acceptedBoxText)
                    boxField.setSelection((boxField.text?.length ?: 0).coerceAtMost(acceptedBoxText.length))
                    writingBox = false
                    return
                }
                acceptedBoxText = next
                onWorksheetBoxText(id, next)
                placeWorksheetField()
            }
        })
        applyBoxFieldChrome(false)
        boxRemove.text = "×"
        boxRemove.contentDescription = ch.fasrv.fanotes.desk.BOX_EDITOR_REMOVE
        boxRemove.gravity = Gravity.CENTER
        boxRemove.textSize = 12f
        boxRemove.setTextColor(0xFFA33F56.toInt())
        boxRemove.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(android.graphics.Color.WHITE)
            setStroke(dp(1).coerceAtLeast(1), 0x2E58222F)
        }
        boxRemove.visibility = GONE
        boxRemove.isFocusable = false
        boxRemove.isFocusableInTouchMode = false
        boxRemove.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> boxRemovePressed = true
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> boxRemovePressed = false
            }
            false
        }
        boxRemove.setOnClickListener {
            val id = requestedBoxId ?: return@setOnClickListener
            boxRemovePressed = false
            onWorksheetBoxRemove(id)
        }
        addView(boxField, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        addView(boxRemove, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        noteField.setTextColor(0xFF20222B.toInt())
        noteField.setHintTextColor(0xFF747887.toInt())
        noteField.hint = ch.fasrv.fanotes.desk.ChromeText.ui("Text eingeben …")
        noteField.gravity = Gravity.TOP or Gravity.START
        noteField.setLineSpacing(0f, 1.35f)
        noteField.minHeight = 0
        noteField.minimumHeight = 0
        noteField.isFocusableInTouchMode = true
        noteField.background = GradientDrawable().apply {
            cornerRadius = dp(6).toFloat()
            setColor(android.graphics.Color.argb(224, 255, 255, 255))
            setStroke(dp(1).coerceAtLeast(1), 0x5920222B)
        }
        noteField.setPadding(dp(8), dp(6), dp(8), dp(6))
        noteField.visibility = GONE
        noteField.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) {
                if (writingNoteField) return
                val id = openNoteFieldId ?: return
                val next = s?.toString().orEmpty().take(8000)
                if (next == acceptedNoteText) return
                acceptedNoteText = next
                onNoteTextFieldText(id, next)
                placeNoteTextFieldEditor()
            }
        })
        noteField.setOnFocusChangeListener { _, focused ->
            if (focused || suppressNoteClose || requestedNoteFieldId == null) return@setOnFocusChangeListener
            noteField.post {
                if (suppressNoteClose || requestedNoteFieldId == null || noteRemovePressed || noteBar.pressed) return@post
                onNoteTextFieldClosed()
            }
        }
        noteRemove.text = "×"
        noteRemove.contentDescription = ch.fasrv.fanotes.desk.ChromeText.ui("Textfeld entfernen")
        noteRemove.gravity = Gravity.CENTER
        noteRemove.textSize = 12f
        noteRemove.setTextColor(0xFFA33F56.toInt())
        noteRemove.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(android.graphics.Color.WHITE)
            setStroke(dp(1).coerceAtLeast(1), 0x2E58222F)
        }
        noteRemove.visibility = GONE
        noteRemove.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> noteRemovePressed = true
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> noteRemovePressed = false
            }
            false
        }
        noteRemove.setOnClickListener {
            val id = requestedNoteFieldId ?: return@setOnClickListener
            noteRemovePressed = false
            onNoteTextFieldRemove(id)
        }
        addView(noteField, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        addView(noteRemove, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        noteBar.visibility = GONE
        noteBar.onStyle = { fontSize, setColor, color, bold ->
            requestedNoteFieldId?.let { id -> onNoteTextFieldStyle(id, fontSize, setColor, color, bold) }
        }
        noteBar.onRemove = { requestedNoteFieldId?.let { id -> onNoteTextFieldRemove(id) } }
        addView(noteBar, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        noteField.setOnKeyListener { _, keyCode, event ->
            // Strg+B toggles bold for the whole box, as on the desktop.
            if (keyCode != KeyEvent.KEYCODE_B || !event.isCtrlPressed || event.isAltPressed || event.isShiftPressed) return@setOnKeyListener false
            if (event.action == KeyEvent.ACTION_DOWN) {
                val id = requestedNoteFieldId
                val field = ink.noteTextFields.firstOrNull { it.id == id }
                if (id != null && field != null) onNoteTextFieldStyle(id, null, false, null, !field.bold)
            }
            true
        }
        editor.setOnScrollChangeListener { _, _, scrollY, _, _ ->
            lineNumbers.scrollTo(0, scrollY)
            foldMarks.scrollTo(0, scrollY)
            tags?.onCaretMoved()
        }
        tools.orientation = LinearLayout.HORIZONTAL
        tools.gravity = Gravity.CENTER_VERTICAL
        toolbar.isHorizontalScrollBarEnabled = false
        toolbar.setPadding(dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_PAD_DP), 0, dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_PAD_DP), 0)
        toolbar.addView(tools, LayoutParams(LayoutParams.WRAP_CONTENT, dp(ch.fasrv.fanotes.desk.TOUCH_TOOLBAR_DP)))
        toolbar.elevation = 12f
        toolbar.addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
            if (right - left != fitWidth) toolbar.post { fitTextToolbar() }
        }
        addView(toolbar, LayoutParams(LayoutParams.MATCH_PARENT, dp(ch.fasrv.fanotes.desk.TOUCH_TOOLBAR_DP), Gravity.TOP))
        addView(
            toolbarRule,
            LayoutParams(LayoutParams.MATCH_PARENT, dp(1).coerceAtLeast(1), Gravity.TOP).apply {
                topMargin = dp(ch.fasrv.fanotes.desk.TOUCH_TOOLBAR_DP) - dp(1).coerceAtLeast(1)
            },
        )
        handle.text = ch.fasrv.fanotes.desk.ChromeText.ui("Werkzeuge")
        handle.gravity = Gravity.CENTER
        handle.textSize = 13f
        handle.visibility = GONE
        handle.setOnClickListener { setChromeOpen(true) }
        handle.elevation = 12f
        addView(handle, LayoutParams(dp(120), dp(40), Gravity.TOP or Gravity.END))
        ink.onPaperImages = { paintLivePreview() }
        ink.onCamera = { _, _, _ ->
            placeEditor()
            placeWorksheetField()
            placeNoteTextFieldEditor()
        }
        ink.onPenActive = { active ->
            penDown = active
            applyChromeVisibility()
            penActiveChanged(active)
        }
        applyChromeColors()
        previewReady = true
        ink.onTogglePaperTask = { line ->
            val next = ch.fasrv.fanotes.desk.toggleTask(ink.markdown, line)
            if (next != ink.markdown) {
                ink.markdown = next
                ink.invalidate()
                onMarkdown(next)
            }
        }
        ink.onFollowMarkdown = { target, web, anchor -> onFollowLink(target, web, anchor) }
        ink.onStudyBlock = { kind, index ->
            val visible = ink.markdown
            ch.fasrv.fanotes.study.findStudyBlocks(visible).getOrNull(index)?.let { reportStudyBlock(kind, visible, it) }
        }
        installPenChrome()
    }

    /** A tap on a rendered link opens the note or the web address. */
    private fun followRenderedLink(x: Float, y: Float): Boolean {
        val editable = editor.text ?: return false
        if (editable.isEmpty()) return false
        val offset = editor.getOffsetForPosition(x, y).coerceIn(0, editable.length)
        val probeStart = (offset - 1).coerceAtLeast(0)
        val probeEnd = (offset + 1).coerceAtMost(editable.length)
        if (editable.getSpans(probeStart, probeEnd, LinkSpan::class.java).isEmpty()) return false
        val link = ch.fasrv.fanotes.desk.followedLinkAt(editable.toString(), offset) ?: return false
        onFollowLink(link.target, link.web, link.anchor)
        return true
    }

    /** A tap on a details summary writes the desktop `open` attribute into the note. */
    private fun toggleDetailsSummary(x: Float, y: Float): Boolean {
        val editable = editor.text ?: return false
        if (editable.isEmpty()) return false
        val offset = editor.getOffsetForPosition(x, y).coerceIn(0, editable.length)
        val probeStart = (offset - 1).coerceAtLeast(0)
        val probeEnd = (offset + 1).coerceAtMost(editable.length)
        val spans = editable.getSpans(probeStart, probeEnd, DetailsSummarySpan::class.java)
        if (spans.isEmpty()) return false
        val before = editable.toString()
        val right = (editor.layout?.width ?: editor.width).toFloat()
        if (ch.fasrv.fanotes.desk.detailsTapAction(right, x, editor.textSize) == "edit") {
            val block = ch.fasrv.fanotes.desk.findDetailsBlocks(before)
                .firstOrNull { offset >= it.from && offset < it.to }
                ?: return false
            val cursor = (block.from + 1).coerceAtMost(before.length)
            editor.setSelection(cursor)
            return true
        }
        val layoutX = x - editor.totalPaddingLeft + editor.scrollX
        val layoutY = y - editor.totalPaddingTop + editor.scrollY
        val jump = spans.firstNotNullOfOrNull { it.footnoteJumpTop(layoutX, layoutY) }
        if (jump != null) {
            editor.scrollTo(0, ch.fasrv.fanotes.desk.revealScrollTop(kotlin.math.round(jump).toInt(), editor.paddingTop))
            return true
        }
        val followed = spans.firstNotNullOfOrNull { it.linkAt(layoutX, layoutY) }
        if (followed != null) {
            onFollowLink(followed.target, followed.web, followed.anchor)
            return true
        }
        val next = ch.fasrv.fanotes.desk.toggleDetailsOpen(before, offset) ?: return false
        val cursor = ch.fasrv.fanotes.desk.findDetailsBlocks(before)
            .firstOrNull { offset >= it.from && offset < it.to }
            ?.from
            ?: 0
        val caret = editor.selectionEnd.coerceAtLeast(0)
        writing = true
        editor.setText(next)
        editor.setSelection(cursor.coerceIn(0, next.length))
        writing = false
        editor.rememberChange(before, next, caret)
        paintLivePreview()
        onVisibleMarkdown(before, next)
        return true
    }

    /** A tap on a drawn study block opens its editor; the source stays reachable through the caret. */
    private fun openStudyBlock(x: Float, y: Float): Boolean {
        val editable = editor.text ?: return false
        if (editable.isEmpty()) return false
        val offset = editor.getOffsetForPosition(x, y).coerceIn(0, editable.length)
        val span = editable.getSpans((offset - 1).coerceAtLeast(0), (offset + 1).coerceAtMost(editable.length), StudyBlockSpan::class.java).firstOrNull() ?: return false
        val visible = editable.toString()
        val ref = ch.fasrv.fanotes.study.findStudyBlocks(visible).firstOrNull { offset >= it.from && offset <= it.to } ?: return false
        reportStudyBlock(span.kindId, visible, ref)
        return true
    }

    /** What is shown has folded sections cut out; the block is named by its offset in the whole note and its JSON. */
    private fun reportStudyBlock(kind: String, visible: String, ref: ch.fasrv.fanotes.study.StudyBlockRef) {
        val full = ch.fasrv.fanotes.desk.sourceOffsetForVisible(sourceMarkdown, foldedLines, ref.from)
        onStudyBlock(kind, full, ch.fasrv.fanotes.study.studyBodyHash(ref.body))
    }

    /** A tap on the task box writes `[x]` or `[ ]`, and leaves the cursor where it was. */
    private fun toggleTaskBox(x: Float, y: Float): Boolean {
        val editable = editor.text ?: return false
        if (editable.isEmpty()) return false
        val offset = editor.getOffsetForPosition(x, y).coerceIn(0, editable.length)
        val probeStart = (offset - 1).coerceAtLeast(0)
        val probeEnd = (offset + 1).coerceAtMost(editable.length)
        if (editable.getSpans(probeStart, probeEnd, TaskSpan::class.java).isEmpty()) return false
        val before = editable.toString()
        val next = ch.fasrv.fanotes.desk.toggleTaskMarker(before, offset) ?: return false
        val start = editor.selectionStart.coerceAtLeast(0)
        val end = editor.selectionEnd.coerceAtLeast(start)
        writing = true
        editor.setText(next)
        editor.setSelection(start.coerceIn(0, next.length), end.coerceIn(0, next.length))
        writing = false
        editor.rememberChange(before, next, end)
        paintLivePreview()
        onVisibleMarkdown(before, next)
        return true
    }

    /** Styles every line except the one being edited, matching the desktop live preview. */
    private fun schedulePreview(delayMs: Long = 0) {
        editor.removeCallbacks(previewRunnable)
        editor.postDelayed(previewRunnable, delayMs)
    }

    /**
     * Character ranges to restyle. A short note is styled whole (null). A long one gets the screen and a couple of
     * screens around it plus the lines around the caret, so a caret move costs the same in a 5,000-line note.
     */
    private fun previewWindows(editable: android.text.Editable): List<IntRange>? {
        val length = editable.length
        if (length <= PREVIEW_WINDOW_MIN_CHARS) {
            paintedWindowed = false
            return null
        }
        val windows = ArrayList<IntRange>(2)
        val layout = editor.layout
        if (typingPaint && paintedWindowed && editor.visibility == VISIBLE) {
            // Typing: the screen was styled already and moves with the text; only the caret lines change.
            val from = (editor.selectionStart.coerceAtLeast(0) - PREVIEW_TYPING_CHARS).coerceAtLeast(0)
            val to = (editor.selectionEnd.coerceAtLeast(0) + PREVIEW_TYPING_CHARS).coerceAtMost(length)
            return listOf(from until to.coerceAtLeast(from + 1))
        }
        if (layout != null && layout.lineCount > 0 && editor.height > 0 && editor.visibility == VISIBLE) {
            val top = (editor.scrollY - editor.height * 2).coerceAtLeast(0)
            val bottom = (editor.scrollY + editor.height * 3).coerceAtMost(layout.height)
            val first = layout.getLineForVertical(top)
            val last = layout.getLineForVertical(bottom).coerceAtLeast(first)
            paintedTop = layout.getLineTop(first)
            paintedBottom = layout.getLineBottom(last)
            windows += layout.getLineStart(first) until layout.getLineEnd(last).coerceAtLeast(layout.getLineStart(first) + 1)
        } else {
            // Hidden or not laid out yet: style the top of the note; the next layout or scroll paints the rest.
            paintedTop = 0
            paintedBottom = 0
            windows += 0 until PREVIEW_FIRST_CHARS.coerceAtMost(length)
        }
        paintedWindowed = true
        val caretFrom = (editor.selectionStart.coerceAtLeast(0) - PREVIEW_CARET_CHARS).coerceAtLeast(0)
        val caretTo = (editor.selectionEnd.coerceAtLeast(0) + PREVIEW_CARET_CHARS).coerceAtMost(length)
        if (caretTo > caretFrom && windows.none { caretFrom >= it.first && caretTo <= it.last + 1 }) windows += caretFrom until caretTo
        return windows
    }

    private fun paintLivePreview() {
        if (!previewReady || paintingPreview || batchingPreview) return
        val editable = editor.text ?: return
        editor.removeCallbacks(previewRunnable)
        paintingPreview = true
        try {
            val box = ch.fasrv.fanotes.desk.paperDetailsBox(editor.textSize)
            val textWidth = editor.layout?.width?.toFloat()
                ?: (editor.width - editor.paddingLeft - editor.paddingRight).toFloat()
            val imageColumn = (textWidth - box.border * 2f - box.padX * 2f).coerceAtLeast(0f)
            val windows = previewWindows(editable)
            val markers = when {
                windows == null -> null
                typingPaint && blockMarkersKnown != null -> blockMarkersKnown
                else -> ch.fasrv.fanotes.desk.textHasBlockMarkers(editable.toString()).also { blockMarkersKnown = it }
            }
            applyLivePreview(
                editable,
                editor.selectionStart,
                editor.selectionEnd,
                ink.accentColor,
                editor.textSize,
                editor.isFocused,
                ink.paperImages,
                imageColumn,
                windows,
                markers,
                editor.lineSpacingMultiplier,
            )
            editor.bindLinkPointer()
        } finally {
            typingPaint = false
            paintingPreview = false
        }
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

    /**
     * Flips the caret line, and every selected line, with the desktop task rule.
     * Fails while the pen is the editor.
     */
    fun toggleTasks(): Boolean {
        if (!textMode) return false
        val editable = editor.text ?: return false
        val before = editable.toString()
        val start = editor.selectionStart.coerceIn(0, before.length)
        val end = editor.selectionEnd.coerceIn(0, before.length)
        val edit = ch.fasrv.fanotes.desk.toggleTasksInNote(before, start, end)
        if (edit.text == before) return true
        val caret = editor.selectionEnd.coerceAtLeast(0)
        writing = true
        editor.setText(edit.text)
        editor.setSelection(
            edit.selectionStart.coerceIn(0, edit.text.length),
            edit.selectionEnd.coerceIn(0, edit.text.length),
        )
        writing = false
        editor.rememberChange(before, edit.text, caret)
        paintLivePreview()
        onVisibleMarkdown(before, edit.text)
        return true
    }

    /** Inserts a date stamp at the caret. Fails while the pen is the editor. */
    fun insertStamp(stamp: String): Boolean {
        if (!textMode) return false
        val editable = editor.text ?: return false
        val start = editor.selectionStart.coerceIn(0, editable.length)
        val end = editor.selectionEnd.coerceIn(0, editable.length).coerceAtLeast(start)
        val insert = ch.fasrv.fanotes.vault.stampToInsert(editable.subSequence(0, start).toString(), stamp)
        if (insert.isEmpty()) return false
        editable.replace(start, end, insert)
        editor.setSelection((start + insert.length).coerceIn(0, editable.length))
        return true
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
            editor.scrollTo(0, ch.fasrv.fanotes.desk.revealScrollTop(top, editor.paddingTop))
        }
    }

    fun revealLine(line: Int) {
        val sourceOffset = ch.fasrv.fanotes.desk.revealLineStart(sourceMarkdown, line)
        revealSourceOffset(sourceOffset)
    }

    /** CodeMirror's go-to-line field. Returns false when the text is not a line, offset, percent, or column. */
    fun gotoLine(input: String): Boolean {
        val visibleCursor = editor.selectionStart.coerceAtLeast(0)
        val sourceOffset = ch.fasrv.fanotes.desk.sourceOffsetForVisible(sourceMarkdown, foldedLines, visibleCursor)
        val current = ch.fasrv.fanotes.desk.lineNumberAt(sourceMarkdown, sourceOffset)
        val cursor = ch.fasrv.fanotes.desk.gotoLineCursor(sourceMarkdown, input, current) ?: return false
        revealSourceOffset(cursor.offset)
        return true
    }

    fun revealSourceRange(sourceStart: Int, sourceEnd: Int) {
        val lines = listOf(
            ch.fasrv.fanotes.desk.lineNumberAt(sourceMarkdown, sourceStart),
            ch.fasrv.fanotes.desk.lineNumberAt(sourceMarkdown, sourceEnd),
        )
        var opened = false
        for (line in lines) {
            while (true) {
                val hiding = ch.fasrv.fanotes.desk.foldedHeadingHidingLine(sourceMarkdown, foldedLines, line) ?: break
                foldedLines = foldedLines - hiding
                onUnfoldHeading(hiding)
                opened = true
            }
        }
        if (opened) {
            val visible = ch.fasrv.fanotes.desk.markdownWithFolds(sourceMarkdown, foldedLines)
            editor.resetHistory()
            writing = true
            editor.setText(visible)
            writing = false
        }
        val length = editor.text?.length ?: 0
        val from = ch.fasrv.fanotes.desk.visibleOffsetForSource(sourceMarkdown, foldedLines, sourceStart).coerceIn(0, length)
        val to = ch.fasrv.fanotes.desk.visibleOffsetForSource(sourceMarkdown, foldedLines, sourceEnd).coerceIn(from, length)
        if (!textMode) setTextMode(true)
        editor.requestFocus()
        editor.setSelection(from, to)
        editor.post {
            val layout = editor.layout ?: return@post
            val safe = from.coerceAtMost(layout.text.length)
            val top = layout.getLineTop(layout.getLineForOffset(safe))
            editor.scrollTo(0, ch.fasrv.fanotes.desk.revealScrollTop(top, editor.paddingTop))
        }
    }

    private fun revealSourceOffset(sourceOffset: Int) {
        val line = ch.fasrv.fanotes.desk.lineNumberAt(sourceMarkdown, sourceOffset)
        val hiding = ch.fasrv.fanotes.desk.foldedHeadingHidingLine(sourceMarkdown, foldedLines, line)
        if (hiding != null) {
            foldedLines = foldedLines - hiding
            onUnfoldHeading(hiding)
            val visible = ch.fasrv.fanotes.desk.markdownWithFolds(sourceMarkdown, foldedLines)
            val cursor = editor.selectionStart.coerceAtLeast(0).coerceAtMost(visible.length)
            editor.resetHistory()
            writing = true
            editor.setText(visible)
            editor.setSelection(cursor)
            writing = false
        }
        val offset = ch.fasrv.fanotes.desk.visibleOffsetForSource(sourceMarkdown, foldedLines, sourceOffset)
            .coerceIn(0, editor.text?.length ?: 0)
        if (!textMode) setTextMode(true)
        editor.requestFocus()
        editor.setSelection(offset)
        editor.post {
            val layout = editor.layout ?: return@post
            val safe = offset.coerceAtMost(layout.text.length)
            val top = layout.getLineTop(layout.getLineForOffset(safe))
            editor.scrollTo(0, ch.fasrv.fanotes.desk.revealScrollTop(top, editor.paddingTop))
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
        theme: String = "",
        systemDark: Boolean = darkChrome,
        folded: Set<Int> = emptySet(),
        metrics: ch.fasrv.fanotes.desk.EditorMetrics = ch.fasrv.fanotes.desk.editorMetrics(emptyMap()),
    ) {
        ink.onPdfPage = onPdfPage
        if (dark != darkChrome || themeId != theme || this.systemDark != systemDark) {
            dark = darkChrome
            themeId = theme
            this.systemDark = systemDark
            applyChromeColors()
        }
        ink.inkTool = tool
        ink.style = style
        latestStyle = style
        applyPenTool(tool, style)
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
        // The text typed a moment ago is the editor's text still: no second 300 KB copy per keystroke.
        val shown = typedText?.takeIf { typedTextRevision == textRevision } ?: editor.text?.toString().orEmpty()
        val pending = pendingCursor
        if (path != boundPath || shown != visible || pending != null) {
            val selection = when {
                path != boundPath -> visible.length to visible.length
                pending != null -> {
                    val cursor = pending.coerceIn(0, visible.length)
                    cursor to cursor
                }
                else -> ch.fasrv.fanotes.desk.mapSelectionThroughReplacement(
                    shown,
                    visible,
                    editor.selectionStart,
                    editor.selectionEnd,
                )
            }
            pendingCursor = null
            if (path != boundPath || shown != visible) editor.resetHistory()
            boundPath = path
            writing = true
            batchingPreview = true
            try {
                replaceEditorText(shown, visible)
                editor.setSelection(selection.first, selection.second)
            } finally {
                batchingPreview = false
                writing = false
            }
            paintLivePreview()
        }
        if (ink.markdown != visible) {
            ink.markdown = visible
            ink.invalidate()
        }
        if (textMode != text) setTextMode(text)
        syncPill.text = if (syncBusy && !syncLabel.contains('/')) "Startet…" else syncLabel
        val metricsPx = resources.displayMetrics
        val inset = ch.fasrv.fanotes.desk.editorSideInsetDp(metricsPx.widthPixels, metricsPx.heightPixels, metricsPx.densityDpi)
        val toolbarPad = ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_PAD_DP + inset
        toolbar.setPadding(dp(toolbarPad), 0, dp(toolbarPad), 0)
        val signature = "$tool|${style.color}|${style.brush}|${style.colorEffect}|${ink.placingSymbol}|${ink.placingSection}|${ink.symbolSize}|${ink.symbolRotation}|${ink.symbolOpacity}|${ink.symbolCategory}|$paper|$fingerDraws|$text|$pdfNote|$canUndo|$canRedo|$dark|$themeId|$systemDark|$followPen|$studyOpen|${ink.study.tool}|${ink.study.selected.hashCode()}|${ink.study.stampId}|${ink.study.numbered}|${ink.study.labelColor}|${ink.study.branchColor}|${ink.study.branchWidth}|$studyCanUndo|$studyCanRedo|${ink.study.crop?.rect}|$compareId|${studyTimerChip != null}|${toolMemory.inkMode}|$barPosition|${ink.placingFigure != null}|${ink.placingGraph != null}|${penCard.cardId}|${toolMemory.recentColors.firstOrNull()}|${ink.guideOn(DraftingKind.RULER)}${ink.guideOn(DraftingKind.SET_SQUARE)}${ink.guideOn(DraftingKind.COMPASS)}"
        if (signature != toolSignature) {
            toolSignature = signature
            rebuildTools(tool, style, paper, fingerDraws, canUndo, canRedo)
        } else {
            widthDot?.value = style.baseWidth
        }
        placeEditor()
    }

    /**
     * Applies an external note the way the desktop editor does: only the span
     * that differs is replaced, then the selection is mapped through it.
     */
    private fun replaceEditorText(current: String, next: String) {
        val editable = editor.text
        val change = ch.fasrv.fanotes.desk.minimalReplacement(current, next)
        if (editable == null || change.from == 0 && change.to == current.length) {
            editor.setText(next)
            return
        }
        editable.replace(change.from, change.to.coerceAtMost(editable.length), change.insert)
    }

    private var textRevision = 0
    private var typedText: String? = null
    private var typedTextRevision = -1
    private var toolSignature = ""
    private var builtTool: InkTool = InkTool.PEN
    private var builtStyle: StrokeStyle = StrokeStyle()
    private var builtPaper = "dots"
    private var builtFinger = false
    private var builtUndo = false
    private var builtRedo = false

    fun configureSpelling(
        enabled: Boolean,
        wave: Int,
        ink: Int,
        paper: Int,
        epoch: Int,
        accepted: () -> Set<String>,
        onLanguage: (String) -> Unit,
        onLearn: (String) -> Unit,
        onIgnore: (String) -> Unit,
        autocorrect: Boolean = true,
        declined: (String) -> Boolean = { false },
        onDecline: (String) -> Unit = {},
    ) {
        editor.spelling.configure(
            enabled, wave, ink, paper, epoch, accepted, onLanguage, onLearn, onIgnore, autocorrect, declined, onDecline,
        )
    }

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
            schedulePreview()
        } else {
            editor.clearFocus()
            val imm = context.getSystemService(InputMethodManager::class.java)
            imm.hideSoftInputFromWindow(windowToken, 0)
            requestFocus()
        }
    }

    private fun searchKeys(command: String) {
        val text = editor.text?.toString().orEmpty()
        val start = editor.selectionStart.coerceAtLeast(0)
        val end = editor.selectionEnd.coerceAtLeast(start)
        val selected = if (end <= text.length) text.substring(start, end) else ""
        val offset = if (command == "previous") start else end
        onSearchCommand(command, selected, offset)
    }

    private fun foldKeys(command: String) {
        val offset = editor.selectionEnd.coerceAtLeast(0)
        val next = ch.fasrv.fanotes.desk.headingFoldCommand(sourceMarkdown, foldedLines, command, offset) ?: return
        pendingCursor = ch.fasrv.fanotes.desk.visibleCursorAfterFold(sourceMarkdown, foldedLines, next, offset)
        onEditorFold(command, offset)
    }

    private fun selectNextOccurrence() {
        val text = editor.text?.toString().orEmpty()
        val start = editor.selectionStart.coerceAtLeast(0)
        val end = editor.selectionEnd.coerceAtLeast(start)
        val next = ch.fasrv.fanotes.desk.nextEditorOccurrence(text, start, end) ?: return
        if (!textMode) setTextMode(true)
        editor.requestFocus()
        editor.setSelection(next.first, next.second)
        editor.post {
            val layout = editor.layout ?: return@post
            val safe = next.first.coerceAtMost(layout.text.length)
            val top = layout.getLineTop(layout.getLineForOffset(safe))
            editor.scrollTo(0, (top - editor.paddingTop).coerceAtLeast(0))
        }
    }

    private fun indentLines(outdent: Boolean) {
        if (!textMode) setTextMode(true)
        editor.indentSelection(outdent)
    }

    private fun moveLines(forward: Boolean) {
        if (!textMode) setTextMode(true)
        editor.moveSelection(forward)
    }

    private fun commentLines() {
        if (!textMode) setTextMode(true)
        editor.toggleComment()
    }

    private fun jumpBracket() {
        if (!textMode) setTextMode(true)
        editor.jumpToMatchingBracket()
    }

    private fun selectLine() {
        if (!textMode) setTextMode(true)
        editor.selectCurrentLine()
    }

    private fun insertIndentedNewline() {
        if (!textMode) setTextMode(true)
        editor.insertIndentedBreak()
    }

    private fun insertBlank() {
        if (!textMode) setTextMode(true)
        editor.insertBlankLine()
    }

    private fun deleteCurrentLines() {
        if (!textMode) setTextMode(true)
        editor.deleteLines()
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
        val side = barPosition.vertical
        toolbar.visibility = if (visible && !side) VISIBLE else GONE
        toolbarRule.visibility = if (visible && !side) VISIBLE else GONE
        rail.visibility = if (visible && side) VISIBLE else GONE
        handle.visibility = if (visible) GONE else VISIBLE
    }

    // ---- pen toolbar behaviour (desktop DrawingBoard activate*, PenQuickMenu, art studio) --------

    private fun installPenChrome() {
        rail.isVerticalScrollBarEnabled = false
        rail.elevation = 12f
        rail.visibility = GONE
        rail.clipToPadding = false
        addView(rail, LayoutParams(dp(ch.fasrv.fanotes.desk.TOUCH_RAIL_DP), LayoutParams.MATCH_PARENT, Gravity.START))
        laserLayer.visibility = GONE
        laserLayer.elevation = 11f
        addView(laserLayer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(penCard, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        quickMenu.elevation = 30f
        addView(quickMenu, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        ink.onQuickMenu = { x, y, _ -> openQuickMenu(x + ink.left, y + ink.top) }
        ink.onQuickMenuDrag = { x, y, lifted -> quickMenu.drag(x + ink.left, y + ink.top, lifted) }
        ink.onLaser = { x, y, t, phase -> laserLayer.sample(x + ink.left, y + ink.top, t, phase) }
        quickMenu.onTool = { id ->
            when (id) {
                "write" -> activateWriting()
                "highlighter" -> activateHighlighter()
                "eraser" -> activatePenTool(InkTool.ERASER)
                "select" -> activatePenTool(InkTool.SELECT)
                "laser" -> activatePenTool(InkTool.LASER)
            }
        }
        quickMenu.onColor = { color -> chooseQuickColor(color) }
        quickMenu.onClosed = { requestFocus() }
        placeToolbar()
    }

    /** Moves the tool row between the top bar and the side rail. */
    private fun placeToolbar() {
        (tools.parent as? android.view.ViewGroup)?.removeView(tools)
        val side = barPosition.vertical
        if (side) {
            tools.orientation = LinearLayout.VERTICAL
            tools.gravity = Gravity.CENTER_HORIZONTAL
            tools.setPadding(dp(4), dp(6), dp(4), dp(10))
            rail.addView(tools, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            val right = barPosition == ch.fasrv.fanotes.desk.ToolbarPosition.SIDE_RIGHT
            rail.layoutParams = LayoutParams(dp(ch.fasrv.fanotes.desk.TOUCH_RAIL_DP), LayoutParams.MATCH_PARENT, if (right) Gravity.END else Gravity.START)
            handle.text = if (right) "‹" else "›"
            handle.textSize = 20f
            handle.layoutParams = LayoutParams(dp(40), dp(96), Gravity.CENTER_VERTICAL or if (right) Gravity.END else Gravity.START)
        } else {
            tools.orientation = LinearLayout.HORIZONTAL
            tools.gravity = Gravity.CENTER_VERTICAL
            tools.setPadding(0, 0, dp(8), 0)
            toolbar.addView(tools, LayoutParams(LayoutParams.WRAP_CONTENT, dp(ch.fasrv.fanotes.desk.TOUCH_TOOLBAR_DP)))
            handle.text = ch.fasrv.fanotes.desk.ChromeText.ui("Werkzeuge")
            handle.textSize = 13f
            handle.layoutParams = LayoutParams(dp(120), dp(40), Gravity.TOP or Gravity.END)
        }
        handle.contentDescription = ch.fasrv.fanotes.desk.ChromeText.ui("Werkzeuge")
        applyChromeVisibility()
    }

    private fun refreshTools() = rebuildTools(builtTool, latestStyle, builtPaper, builtFinger, builtUndo, builtRedo)

    /** Laser layer on for the laser tool; armed stamps end when the pen tool is left. */
    private fun applyPenTool(tool: InkTool, style: StrokeStyle) {
        val laser = tool == InkTool.LASER
        if (laser != (laserLayer.visibility == VISIBLE)) {
            laserLayer.visibility = if (laser) VISIBLE else GONE
            if (!laser) laserLayer.clear()
        }
        if (tool != InkTool.PEN && (ink.placingFigure != null || ink.placingGraph != null || ink.placingSymbol != null)) {
            ink.placingFigure = null
            ink.placingGraph = null
            ink.placingSymbol = null
        }
        if (!toolMemoryRestored) {
            toolMemoryRestored = true
            if (toolMemory.drawingMode) {
                // Last session ended in the drawing mode: put its pen back (desktop restores inkMode too).
                if (style != toolMemory.drawing) post { changePenStyle(toolMemory.drawing, remember = false) }
            } else if (style.colorEffect != "solid" || style.purpose != "handwriting") {
                // Special inks belong to the drawing pen now; an older single pen keeps its colour, drawn solid.
                post { changePenStyle(latestStyle.copy(colorEffect = "solid", purpose = "handwriting"), remember = false) }
            }
        }
    }

    private fun scheduleToolMemorySave() {
        removeCallbacks(saveToolMemory)
        postDelayed(saveToolMemory, 450)
    }

    private fun changePenStyle(next: StrokeStyle, remember: Boolean = true) {
        latestStyle = next
        if (remember) {
            toolMemory = toolMemory.remember(next)
            scheduleToolMemorySave()
        }
        onStyle(next)
        widthDot?.value = next.baseWidth
    }

    private fun switchInkMode(mode: String) {
        if ((mode == ch.fasrv.fanotes.ink.INK_MODE_DRAWING) == toolMemory.drawingMode) return
        val (memory, style) = toolMemory.switchMode(mode, latestStyle)
        toolMemory = memory
        scheduleToolMemorySave()
        latestStyle = style
        onStyle(style)
    }

    private fun disarmStamps() {
        ink.placingSymbol = null
        ink.placingFigure = null
        ink.placingGraph = null
    }

    private fun activateWriting() {
        disarmStamps()
        closeCard()
        switchInkMode(ch.fasrv.fanotes.ink.INK_MODE_WRITING)
        onTool(InkTool.PEN)
        refreshTools()
    }

    /** Zeichnen: the drawing pen; tapping it again toggles the Zeichenstudio (desktop `activateDrawing`). */
    private fun activateDrawing() {
        val already = toolMemory.drawingMode && builtTool == InkTool.PEN && ink.placingFigure == null && ink.placingGraph == null
        ink.placingFigure = null
        ink.placingGraph = null
        if (penCard.cardId == "figures") penCard.hide()
        switchInkMode(ch.fasrv.fanotes.ink.INK_MODE_DRAWING)
        onTool(InkTool.PEN)
        if (already && penCard.cardId == "studio") {
            closeCard()
        } else if (!(latestStyle.brush == "marker" || latestStyle.brush == "highlighter") || already) {
            openCard("studio", "draw")
        } else {
            refreshTools()
        }
    }

    /** Quick menu "Textmarker": drawing mode with the highlighter brush. */
    private fun activateHighlighter() {
        disarmStamps()
        closeCard()
        switchInkMode(ch.fasrv.fanotes.ink.INK_MODE_DRAWING)
        changePenStyle(ch.fasrv.fanotes.ink.styleWithBrush(latestStyle, "highlighter"))
        onTool(InkTool.PEN)
        refreshTools()
    }

    private fun activatePenTool(tool: InkTool) {
        disarmStamps()
        closeCard()
        onTool(tool)
    }

    /** A swatch or a custom colour: drawing colours reset a special ink to solid, like the desktop strip. */
    private fun pickPenColor(color: String, custom: Boolean = false) {
        val hex = ch.fasrv.fanotes.ink.normalizeInkHex(color) ?: return
        if (custom) {
            toolMemory = toolMemory.copy(recentColors = ch.fasrv.fanotes.ink.pushRecentColor(toolMemory.recentColors, hex))
            scheduleToolMemorySave()
        }
        val next = if (toolMemory.drawingMode) latestStyle.copy(color = hex, colorEffect = "solid") else latestStyle.copy(color = hex)
        changePenStyle(next)
        if (builtTool != InkTool.PEN && ink.placingSymbol == null) onTool(InkTool.PEN)
        if (custom && penCard.cardId == "color") closeCard()
    }

    /** Desktop `chooseQuickMenuColor`: the drawing pen keeps drawing; otherwise a colour is for writing. */
    private fun chooseQuickColor(color: String) {
        if (builtTool == InkTool.PEN && toolMemory.drawingMode) {
            changePenStyle(latestStyle.copy(color = color, colorEffect = "solid"))
        } else {
            if (builtTool != InkTool.PEN || toolMemory.drawingMode) activateWriting()
            changePenStyle(latestStyle.copy(color = color))
        }
    }

    private fun openQuickMenu(x: Float, y: Float) {
        closeCard()
        val drawing = toolMemory.drawingMode
        val active = buildSet {
            if (builtTool == InkTool.PEN && !drawing) add("write")
            if (builtTool == InkTool.PEN && drawing && latestStyle.brush == "highlighter") add("highlighter")
            if (builtTool == InkTool.ERASER) add("eraser")
            if (builtTool == InkTool.SELECT) add("select")
            if (builtTool == InkTool.LASER) add("laser")
        }
        val ring = ch.fasrv.fanotes.ink.quickMenuColors(builtTool == InkTool.PEN && drawing, PenColors, toolMemory.recentColors)
        quickMenu.open(x, y, penChromeColors(themeId, systemDark, dark, ink.accentColor), active, ring, latestStyle.color)
    }

    private fun toggleGuide(kind: DraftingKind) {
        ink.toggleGuide(kind)
        refreshTools()
    }

    /** Figuren / Funktionsgraph: the library card arms the stamp; closing it disarms. */
    private fun toggleFigures(tab: String) {
        val graph = tab == "graph"
        val open = penCard.cardId == "figures" && (penCards.figureTab == "graph") == graph
        if (open) {
            closeCard()
            return
        }
        if (graph) {
            penCards.figureTab = "graph"
            penCards.ensureGraph()
        } else {
            if (penCards.figureTab == "graph") penCards.figureTab = ch.fasrv.fanotes.ink.mathFigureById(figureSpecState.figureId).group
            cardHost.armFigure(figureSpecState)
        }
        if (builtTool != InkTool.PEN) onTool(InkTool.PEN)
        openCard("figures", if (graph) "graph" else "figures")
    }

    private fun anchorRect(id: String?): android.graphics.Rect {
        val view = id?.let { penButtons[it] }
        val rect = android.graphics.Rect()
        if (view != null && view.isAttachedToWindow) {
            view.getDrawingRect(rect)
            runCatching { offsetDescendantRectToMyCoords(view, rect) }.onSuccess { return rect }
        }
        return android.graphics.Rect(dp(12), dp(12), dp(60), dp(60))
    }

    private fun toolbarBandPx(): Int =
        if (barPosition.vertical) dp(ch.fasrv.fanotes.desk.TOUCH_RAIL_DP) else dp(ch.fasrv.fanotes.desk.TOUCH_TOOLBAR_DP)

    private fun cardContent(id: String): View? = when (id) {
        "studio" -> penCards.studioCard()
        "width" -> penCards.widthCard()
        "color" -> penCards.colorCard()
        "figures" -> penCards.figureCard()
        else -> null
    }

    private fun openCard(id: String, anchorId: String = id) {
        val content = cardContent(id) ?: return
        val anchor = anchorRect(anchorId)
        if (penCard.cardId == "figures" && id != "figures") {
            ink.placingFigure = null
            ink.placingGraph = null
        }
        penCard.show(id, content, anchor, barPosition.vertical, barPosition == ch.fasrv.fanotes.desk.ToolbarPosition.SIDE_RIGHT, toolbarBandPx())
        refreshTools()
    }

    private fun toggleCard(id: String) {
        if (penCard.cardId == id) closeCard() else openCard(id)
    }

    /** Rebuilds the open card after a choice inside it, or opens another card from it. */
    private fun refreshCard(id: String) {
        if (penCard.cardId == id) {
            cardContent(id)?.let { penCard.replace(it) }
            refreshTools()
        } else {
            openCard(id)
        }
    }

    private fun closeCard(rebuild: Boolean = true) {
        val was = penCard.cardId ?: return
        penCard.hide()
        if (was == "figures") {
            ink.placingFigure = null
            ink.placingGraph = null
        }
        if (rebuild) refreshTools() else toolsStale = true
    }

    /** Pen down on the page closes the cards (desktop), except the figure library that keeps stamping. */
    private fun penActiveChanged(active: Boolean) {
        if (active) {
            if (quickMenu.isOpen) quickMenu.close()
            // The toolbar is rebuilt after the stroke, never at its start.
            if (penCard.cardId != null && penCard.cardId != "figures") closeCard(rebuild = false)
        } else if (toolsStale) {
            post { if (toolsStale && !penDown) refreshTools() }
        }
    }

    private fun rebuildTools(
        tool: InkTool,
        style: StrokeStyle,
        paper: String,
        fingerDraws: Boolean,
        canUndo: Boolean,
        canRedo: Boolean,
    ) {
        builtTool = tool
        builtStyle = style
        toolsStale = false
        penKit.vertical = barPosition.vertical
        penKit.colors = penChromeColors(themeId, systemDark, dark, ink.accentColor)
        penButtons.clear()
        widthDot = null
        builtPaper = paper
        builtFinger = fingerDraws
        builtUndo = canUndo
        builtRedo = canRedo
        ink.onSelection = {
            post {
                if (builtTool == InkTool.LASSO || builtTool == InkTool.SELECT) {
                    rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
                }
            }
        }
        ink.onStudyChrome = { post { rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo) } }
        tools.removeAllViews()
        timerChipView = null
        tools.addView(modeSwitch())
        if (studyOpen && textMode) {
            studyOpen = false
            ink.study.tool = null
        }
        if (studyOpen) {
            addStudyTools()
            return
        }
        when {
            pdfNote -> addPdfTools()
            textMode -> addTextTools(canUndo, canRedo)
            else -> addInkTools(tool, style, fingerDraws, canUndo, canRedo)
        }
        for (slot in ch.fasrv.fanotes.desk.toolbarEndSlots(textMode, pdfNote)) {
            when (slot) {
                "paper" -> tools.addView(paperChip(paper))
                "tags" -> tools.addView(endIcon("tag", "Tag hinzufügen") { onToolbarAction("tags") })
                "search" -> tools.addView(endIcon("search", "Im Text suchen") { onToolbarAction("search") })
                "backup" -> tools.addView(endIcon("history", "Notiz sichern") { onToolbarAction("backup") })
                "links" -> addLinkTools()
                "more" -> endIcon("ellipsis", "Mehr") { onToolbarAction("more") }.also {
                    moreButton = it
                    tools.addView(it)
                }
            }
        }
        toolbar.post { fitTextToolbar() }
    }

    private var moreButton: View? = null
    private var overflowViews: List<View> = emptyList()
    private var fitWidth = -1

    /**
     * Keyboard-mode toolbar at a narrow width: items that do not fit (last first) are hidden and listed in a
     * popup behind the "Mehr" button, which stays pinned at the end. With room, "Mehr" opens the sheet as before.
     */
    private fun fitTextToolbar() {
        val more = moreButton ?: return
        if (!textMode || studyOpen || pdfNote || barPosition.vertical || tools.childCount < 3 || tools.getChildAt(tools.childCount - 1) !== more) return
        val available = toolbar.width - toolbar.paddingLeft - toolbar.paddingRight
        if (available <= 0) return
        fitWidth = toolbar.width
        val items = (1 until tools.childCount - 1).map { tools.getChildAt(it) }
        fun divider(view: View) = !view.isClickable
        items.forEach { it.visibility = VISIBLE }
        val spec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        fun natural(): Int {
            tools.measure(spec, spec)
            return tools.measuredWidth
        }
        var index = items.lastIndex
        while (natural() > available && index >= 0) {
            items[index].visibility = GONE
            index--
        }
        items.forEachIndexed { position, view ->
            if (!divider(view)) return@forEachIndexed
            val before = items.take(position).any { !divider(it) && it.visibility == VISIBLE }
            val after = items.drop(position + 1).any { !divider(it) && it.visibility == VISIBLE }
            view.visibility = if (before && after) VISIBLE else GONE
        }
        overflowViews = items.filter { !divider(it) && it.visibility == GONE }
        more.setOnClickListener {
            if (overflowViews.isEmpty()) {
                onToolbarAction("more")
            } else {
                val menu = android.widget.PopupMenu(context, more)
                overflowViews.forEachIndexed { position, view ->
                    val title = view.contentDescription?.toString() ?: (view as? TextView)?.text?.toString() ?: ""
                    menu.menu.add(0, position, position, title).isEnabled = view.isEnabled
                }
                menu.menu.add(0, overflowViews.size, overflowViews.size, ch.fasrv.fanotes.desk.ChromeText.ui("Mehr") + " ...")
                menu.setOnMenuItemClickListener { item ->
                    if (item.itemId < overflowViews.size) overflowViews[item.itemId].performClick() else onToolbarAction("more")
                    true
                }
                menu.show()
            }
        }
    }

    private fun modeSwitch(): LinearLayout {
        val row = LinearLayout(context)
        row.orientation = if (barPosition.vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        row.setPadding(dp(2), dp(2), dp(2), dp(2))
        row.layoutParams = if (barPosition.vertical) {
            LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
        } else {
            LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, dp(ch.fasrv.fanotes.desk.TOUCH_TARGET_DP)).apply { gravity = Gravity.CENTER_VERTICAL }
        }
        row.background = rounded(ch.fasrv.fanotes.desk.modeSwitchTrackColor(themeId, systemDark), dp(ch.fasrv.fanotes.desk.MODE_SWITCH_RADIUS_DP))
        val vertical = barPosition.vertical
        fun segParams() = if (vertical) LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
            else LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT)
        row.addView(seg("Tastatur", textMode) { onTextMode(true) }, segParams())
        row.addView(seg("Stift", !textMode) { onTextMode(false) }, segParams())
        return row
    }

    private fun addInkTools(tool: InkTool, style: StrokeStyle, fingerDraws: Boolean, canUndo: Boolean, canRedo: Boolean) {
        val drawing = toolMemory.drawingMode
        val stamping = ink.placingFigure != null || ink.placingGraph != null
        fun add(id: String, view: View) {
            penButtons[id] = view
            tools.addView(view)
        }
        fun toolButton(id: String, icon: String, label: String, active: Boolean, description: String, enabled: Boolean = true, click: () -> Unit) =
            add(id, penKit.toolButton(icon, label, active, enabled, description, click = click))
        tools.addView(penKit.divider())
        toolButton("write", "pen-line", "Schreiben", tool == InkTool.PEN && !drawing && !stamping, "Handschrift schreiben oder vorhandene Wörter mehrfach durchkritzeln") { activateWriting() }
        toolButton("draw", "paintbrush", "Zeichnen", tool == InkTool.PEN && drawing && !stamping, "Zeichenstudio mit Pinseln und Spezialfarben öffnen") { activateDrawing() }
        toolButton("eraser", "eraser", "Radierer", tool == InkTool.ERASER, "Radierer: löscht den Buchstaben, den er wirklich berührt") { activatePenTool(InkTool.ERASER) }
        toolButton("select", "move", "Verschieben", tool == InkTool.SELECT, "Handschrift einrahmen und dann verschieben") { activatePenTool(InkTool.SELECT) }
        toolButton("lasso", "lasso", "Lasso", tool == InkTool.LASSO, "Lasso: Handschrift frei umfahren und auswählen") { activatePenTool(InkTool.LASSO) }
        toolButton("laser", "crosshair", "Laser", tool == InkTool.LASER, "Laserpointer: zeigt einen Punkt, ohne zu schreiben") { activatePenTool(InkTool.LASER) }
        tools.addView(penKit.divider())
        if (drawing) {
            val brush = ch.fasrv.fanotes.ink.artBrush(style.brush)
            val label = ink.placingSymbol?.let { ch.fasrv.fanotes.ink.artSymbol(it)?.label } ?: brush.label
            toolButton("studio", "palette", label, penCard.cardId == "studio", "Zeichenstudio: Pinsel, Farben und Piktogramme") { toggleCard("studio") }
            QUICK_DRAW_COLORS.forEach { color ->
                add("color:$color", penKit.swatch(color, style.colorEffect == "solid" && color.equals(style.color, true), "Zeichenfarbe $color") { pickPenColor(color) })
            }
            if (style.colorEffect != "solid") {
                add("effect", penKit.swatch(style.color, true, "${ch.fasrv.fanotes.ink.inkEffectLabel(style.colorEffect)} Spezialtinte", effect = style.colorEffect) {
                    penCards.studioTab = "colors"
                    openCard("studio", "studio")
                })
            }
        } else {
            PenColors.forEach { color ->
                add("color:$color", penKit.swatch(color, color.equals(style.color, true), "Farbe $color") { pickPenColor(color) })
            }
            if (PenColors.none { it.equals(style.color, true) }) {
                add("color:custom", penKit.swatch(style.color, true, "Eigene Farbe ${style.color}") { toggleCard("color") })
            }
        }
        toolButton("color", "plus", "Farbe", penCard.cardId == "color", if (drawing) "Eigene Zeichenfarbe" else "Eigene Farbe") { toggleCard("color") }
        val width = LinearLayout(context)
        width.orientation = LinearLayout.VERTICAL
        width.gravity = Gravity.CENTER
        val dot = WidthDotView(context, style.baseWidth, penKit.colors, false)
        widthDot = dot
        width.addView(dot, LinearLayout.LayoutParams(dp(30), dp(24)))
        width.addView(penKit.label("Breite", ch.fasrv.fanotes.desk.TOUCH_TOOL_LABEL_SP, penKit.colors.muted))
        width.minimumWidth = dp(ch.fasrv.fanotes.desk.TOUCH_TARGET_DP)
        width.background = penKit.rounded(if (penCard.cardId == "width") penKit.colors.active else android.graphics.Color.TRANSPARENT, 10)
        width.contentDescription = ch.fasrv.fanotes.desk.ChromeText.ui("Breite")
        width.setOnClickListener { toggleCard("width") }
        width.layoutParams = penKit.itemParams(height = dp(if (barPosition.vertical) 54 else ch.fasrv.fanotes.desk.TOUCH_TARGET_DP))
        add("width", width)
        tools.addView(penKit.divider())
        toolButton("ruler", "ruler", "Lineal", ink.guideOn(DraftingKind.RULER), "Lineal einblenden: verschieben, drehen und an beiden Kanten nachzeichnen") { toggleGuide(DraftingKind.RULER) }
        toolButton("setsquare", "triangle", "Geodreieck", ink.guideOn(DraftingKind.SET_SQUARE), "Geodreieck einblenden: Winkel messen und an drei Kanten zeichnen") { toggleGuide(DraftingKind.SET_SQUARE) }
        toolButton("compass", "compass", "Zirkel", ink.guideOn(DraftingKind.COMPASS), "Zirkel: Nadel setzen, Radius messen, Bogen zeichnen") { toggleGuide(DraftingKind.COMPASS) }
        toolButton("figures", "box", "Figuren", ink.placingFigure != null, "Figurenbibliothek: Figur wählen und auf die Seite tippen") { toggleFigures("plane") }
        toolButton("graph", "chart-spline", "Graph", ink.placingGraph != null, "Funktionsgraph einfügen: Formel wählen und auf die Seite tippen") { toggleFigures("graph") }
        tools.addView(penKit.divider())
        toolButton("undo", "undo-2", "Zurück", false, "Rückgängig", enabled = canUndo) { onUndo() }
        toolButton("redo", "redo-2", "Vor", false, "Wiederholen", enabled = canRedo) { onRedo() }
        toolButton("study", "graduation-cap", "Lernen", false, "Lernwerkzeuge") { setStudyOpen(true) }
        if (tool == InkTool.LASSO && ink.session?.selection?.isNotEmpty() == true) {
            // Recognition of the selection (work package 4); the panel opens over the page.
            listOf("ink-convert" to "Konvertieren", "ink-solve" to "Mathe-Löser", "ink-check" to "Mathe-Korrigierer").forEach { (action, label) ->
                tools.addView(chip(label) { onToolbarAction(action) })
            }
            listOf("move" to "Verschieben", "copy" to "Kopieren", "recolor" to "Färben", "delete" to "Löschen").forEach { (action, label) ->
                tools.addView(chip(label) {
                    val session = ink.session ?: return@chip
                    if (session.commitLasso(action, java.time.Instant.now().toString(), style.color)) {
                        ink.refresh()
                        ink.onChanged()
                        ink.onInkNotice(ch.fasrv.fanotes.ink.InkNotice("success", ch.fasrv.fanotes.ink.lassoActionNotice(action)))
                        ink.onSelection(session.selection.size)
                    }
                })
            }
        }
    }

    /** Icon buttons in groups (text, structure, blocks, history); every one stays a 48 dp target. */
    private fun addTextTools(canUndo: Boolean, canRedo: Boolean) {
        fun icon(name: String, label: String, enabled: Boolean = true, click: () -> Unit) {
            tools.addView(penKit.toolButton(name, label, enabled = enabled, showLabel = false, click = click))
        }
        fun fmt(name: String, label: String, action: String) = icon(name, label) { format(action) }
        fmt("bold", "Fett", "bold")
        fmt("italic", "Kursiv", "italic")
        fmt("strikethrough", "Durchgestrichen", "strike")
        fmt("code", "Code", "inlineCode")
        tools.addView(penKit.divider())
        fmt("link", "Link", "link")
        fmt("heading-1", "Überschrift 1", "heading1")
        fmt("heading-2", "Überschrift 2", "heading2")
        tools.addView(penKit.divider())
        fmt("list", "Liste", "bulletList")
        fmt("list-checks", "Aufgabe", "checklist")
        fmt("quote", "Zitat", "quote")
        fmt("table", "Tabelle", "table")
        icon("graduation-cap", "Lernblock einfügen") { onToolbarAction("study-insert") }
        tools.addView(penKit.divider())
        icon("undo-2", "Rückgängig", canUndo) { onUndo() }
        icon("redo-2", "Wiederholen", canRedo) { onRedo() }
    }

    private fun addPdfTools() {
        tools.addView(chip("Vorherige Seite") { onToolbarAction("pdf-prev") })
        tools.addView(chip("Nächste Seite") { onToolbarAction("pdf-next") })
        tools.addView(chip("Im PDF suchen") { onToolbarAction("pdf-search") })
        tools.addView(chip("Seiten") { onToolbarAction("pdf-thumbs") })
        tools.addView(chip("Gliederung", description = "PDF-Gliederung") { onToolbarAction("pdf-outline") })
        tools.addView(seg("Text markieren", ink.pdfText.armed) {
            ink.pdfText.arm(!ink.pdfText.armed)
            rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
        })
        tools.addView(chip("Aufträge") { onToolbarAction("study-tasks") })
        studyTimerChip?.let { tools.addView(timerChip(it)) }
        tools.addView(chip("Markierungen") { onToolbarAction("study-marks") })
        tools.addView(chip("Passwort") { onToolbarAction("pdf-password") })
        tools.addView(chip("Lernen", description = "Lernwerkzeuge") { setStudyOpen(true) })
    }

    // ---- "Lernen" menu: study annotations -------------------------------------------------

    /** Shows [image] beside the page (landscape: left, portrait: bottom); the sketch stays live. */
    private fun openCompare(image: ch.fasrv.fanotes.study.StudyImage) {
        compareId = image.id
        compareTitle.text = image.title.ifBlank { ch.fasrv.fanotes.desk.ChromeText.ui("Referenz") }
        loadCompareBitmap(image)
        applyCompare(force = true)
        rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
    }

    private fun closeCompare() {
        if (compareId == null) return
        compareId = null
        compareSrcKey = ""
        compareImage.setImageDrawable(null)
        applyCompare(force = true)
        rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
    }

    private fun loadCompareBitmap(image: ch.fasrv.fanotes.study.StudyImage) {
        val key = "${image.id}|${image.src.length}|${image.src.hashCode()}"
        if (key == compareSrcKey) return
        compareSrcKey = key
        val src = image.src
        compareDecoder.execute {
            val bitmap = try { StudyImageCache.decode(src, 1600) } catch (_: Throwable) { null }
            post { if (compareSrcKey == key) compareImage.setImageBitmap(bitmap) }
        }
    }

    /** Called when the annotations change: closes the panel when its image is gone, refreshes it when edited. */
    fun syncCompare() {
        val id = compareId ?: return
        val image = ink.study.items.firstOrNull { it.id == id } as? ch.fasrv.fanotes.study.StudyImage
        if (image == null) closeCompare() else loadCompareBitmap(image)
    }

    private fun applyCompare(force: Boolean = false) {
        val ps = ink.layoutParams as? LayoutParams ?: return
        val dock = if (compareId == null || width <= 0) null else ch.fasrv.fanotes.study.compareLayout(width, height)
        if (!force && dock?.dock == compareDock && (dock?.panelPx ?: -1) == comparePanelPx) return
        compareDock = dock?.dock
        comparePanelPx = dock?.panelPx ?: -1
        ps.leftMargin = 0; ps.bottomMargin = 0
        if (dock == null) {
            comparePanel.visibility = GONE
        } else {
            val left = dock.dock == ch.fasrv.fanotes.study.CompareDock.LEFT
            val lp = if (left) LayoutParams(dock.panelPx, LayoutParams.MATCH_PARENT, Gravity.START) else LayoutParams(LayoutParams.MATCH_PARENT, dock.panelPx, Gravity.BOTTOM)
            comparePanel.layoutParams = lp
            // Left panel starts under the toolbar; the bottom one has no toolbar above it.
            compareSpacer.layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, if (left && !barPosition.vertical) dp(ch.fasrv.fanotes.desk.TOUCH_TOOLBAR_DP) else 0)
            if (left) ps.leftMargin = dock.panelPx else ps.bottomMargin = dock.panelPx
            comparePanel.setBackgroundColor(if (dark) 0xFF1B1D23.toInt() else 0xFFF1F3F8.toInt())
            compareTitle.setTextColor(if (dark) 0xFFE6E8EE.toInt() else 0xFF1B1D23.toInt())
            compareClose.setTextColor(if (dark) 0xFFE6E8EE.toInt() else 0xFF1B1D23.toInt())
            comparePanel.visibility = VISIBLE
        }
        ink.layoutParams = ps
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (compareId != null) post { applyCompare() }
    }

    private fun setStudyOpen(open: Boolean) {
        studyOpen = open
        ink.study.tool = if (open) ch.fasrv.fanotes.study.StudyTool.SELECT else null
        if (!open) ink.study.selectedId = null
        rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
    }

    private fun studyChip(label: String, active: Boolean = false, enabled: Boolean = true, description: String = label, click: () -> Unit): TextView {
        val view = chip(label, enabled, description, click)
        if (active) {
            view.background = rounded(ch.fasrv.fanotes.desk.modeSwitchTrackColor(themeId, systemDark), dp(ch.fasrv.fanotes.desk.FORMAT_BUTTON_RADIUS_DP))
            view.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, 650, false)
        }
        return view
    }

    private fun studyToolChip(label: String, tool: ch.fasrv.fanotes.study.StudyTool, description: String = label): TextView =
        studyChip(label, ink.study.tool == tool, description = description) {
            ink.study.cancelPending()
            ink.study.tool = if (ink.study.tool == tool && tool != ch.fasrv.fanotes.study.StudyTool.SELECT) ch.fasrv.fanotes.study.StudyTool.SELECT else tool
        }

    private fun addStudyTools() {
        val study = ink.study
        val select = ch.fasrv.fanotes.study.StudyTool.SELECT
        tools.addView(studyChip("Fertig", description = "Lernwerkzeuge schliessen") { setStudyOpen(false) })
        tools.addView(studyToolChip("Wählen", select, "Auswählen und verschieben"))
        tools.addView(studyToolChip("Beschriftung setzen", ch.fasrv.fanotes.study.StudyTool.CALLOUT))
        tools.addView(studyChip("Nummeriert", study.numbered, description = "Nummeriert (1, 2, 3 + Legende)") {
            study.numbered = !study.numbered
            rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
        })
        if (study.numbered) tools.addView(studyChip("Neu nummerieren") { study.renumber() })
        listOf("#1d4ed8", "#dc2626", "#16a34a", "#111827").forEach { color ->
            tools.addView(swatch(color, study.labelColor == color) { study.labelColor = color })
        }
        ch.fasrv.fanotes.study.STUDY_STAMPS.forEach { def ->
            val active = study.tool == ch.fasrv.fanotes.study.StudyTool.STAMP && study.stampId == def.id
            val view = studyChip(def.glyph, active, description = def.label) {
                study.stampId = def.id
                study.tool = ch.fasrv.fanotes.study.StudyTool.STAMP
                rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
            }
            view.setTextColor(android.graphics.Color.parseColor(def.color))
            view.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
            tools.addView(view)
        }
        tools.addView(studyToolChip("Legende platzieren", ch.fasrv.fanotes.study.StudyTool.LEGEND))
        tools.addView(studyToolChip("Ast markieren", ch.fasrv.fanotes.study.StudyTool.BRANCH))
        listOf("#facc15", "#f97316", "#22c55e", "#38bdf8", "#e879f9").forEach { color ->
            tools.addView(swatch(color, study.branchColor == color) {
                study.branchColor = color
                study.tool = ch.fasrv.fanotes.study.StudyTool.BRANCH
            })
        }
        tools.addView(studyChip("Dicke ${study.branchWidth.toInt()}", description = "Dicke") {
            val steps = listOf(10.0, 18.0, 28.0, 40.0)
            study.branchWidth = steps.firstOrNull { it > study.branchWidth } ?: steps.first()
            study.tool = ch.fasrv.fanotes.study.StudyTool.BRANCH
            rebuildTools(builtTool, builtStyle, builtPaper, builtFinger, builtUndo, builtRedo)
        })
        tools.addView(studyToolChip("Winkel (3 Punkte)", ch.fasrv.fanotes.study.StudyTool.ANGLE))
        tools.addView(studyToolChip("Winkel (2 Linien)", ch.fasrv.fanotes.study.StudyTool.ANGLE_LINES))
        tools.addView(studyToolChip("Strecke", ch.fasrv.fanotes.study.StudyTool.DISTANCE))
        tools.addView(studyChip("Bild einfügen") { onStudyImage() })
        tools.addView(studyChip("Kamera", description = "Foto als Referenzbild aufnehmen") { onStudyCamera() })
        if (pdfNote) {
            tools.addView(studyToolChip("PDF-Ausschnitt", ch.fasrv.fanotes.study.StudyTool.CROP, "Bereich einer PDF-Seite als Bild übernehmen (z. B. Abbildung)"))
            val crop = ink.study.crop
            if (ink.study.tool == ch.fasrv.fanotes.study.StudyTool.CROP && crop != null && ch.fasrv.fanotes.study.cropIsUsable(crop.rect)) {
                tools.addView(studyChip("Ausschnitt übernehmen") { ink.study.confirmCrop() })
                tools.addView(studyChip("Abbrechen") { ink.study.cancelCrop() })
            }
        }
        tools.addView(studyChip("Begriffe") { promptTerms() })
        tools.addView(studyChip("↶", enabled = studyCanUndo, description = "Rückgängig") { onStudyUndo() })
        tools.addView(studyChip("↷", enabled = studyCanRedo, description = "Wiederholen") { onStudyRedo() })
        val selected = study.selected
        if (selected != null && selected !is ch.fasrv.fanotes.study.StudyTerms) {
            if (selected is ch.fasrv.fanotes.study.StudyImage) {
                tools.addView(studyChip("Vergleich", active = compareId == selected.id, description = "Vergleichsansicht") {
                    if (compareId == selected.id) closeCompare() else openCompare(selected)
                })
                tools.addView(studyChip("Deckkraft ${Math.round(selected.opacity * 100)} %", description = "Deckkraft") {
                    val steps = listOf(1.0, 0.7, 0.5, 0.35, 0.2)
                    val next = steps.firstOrNull { it < selected.opacity - 0.001 } ?: steps.first()
                    study.replace(selected.copy(opacity = next))
                })
                tools.addView(studyChip(if (selected.locked) "Entsperren" else "Sperren", description = if (selected.locked) "Entsperren" else "Sperren (nicht mehr verschiebbar)") {
                    study.replace(selected.copy(locked = !selected.locked))
                })
            }
            tools.addView(studyChip("Löschen") { study.deleteSelected() })
        }
    }

    private fun promptTerms(draft: String? = null) {
        val terms = ch.fasrv.fanotes.study.termsOf(ink.study.items)
        textDialog(
            title = "Begriffe",
            hint = ch.fasrv.fanotes.desk.ChromeText.ui("Begriffe, mit Komma getrennt"),
            initial = draft ?: terms.joinToString(", "),
            max = 4000,
            multiline = true,
            track = ch.fasrv.fanotes.study.StudyDialogState(ch.fasrv.fanotes.study.StudyDialogKind.TERMS),
        ) { raw -> ink.study.setTerms(ch.fasrv.fanotes.study.termsFromText(raw)) }
    }

    /** [draft] is the text typed before the screen was recreated. */
    private fun promptCallout(callout: ch.fasrv.fanotes.study.StudyCallout, draft: String? = null) {
        val terms = ch.fasrv.fanotes.study.termsOf(ink.study.items)
        textDialog(
            title = if (callout.num != null) "Bedeutung" else "Beschriftung",
            hint = if (callout.num != null) "Bedeutung" else "Beschriftung",
            initial = draft ?: callout.text,
            max = 120,
            multiline = false,
            terms = terms,
            onDelete = { ink.study.selectedId = callout.id; ink.study.deleteSelected() },
            track = ch.fasrv.fanotes.study.StudyDialogState(ch.fasrv.fanotes.study.StudyDialogKind.CALLOUT, id = callout.id),
        ) { value ->
            val current = ink.study.items.firstOrNull { it.id == callout.id } as? ch.fasrv.fanotes.study.StudyCallout ?: return@textDialog
            if (current.text != value) ink.study.replace(current.copy(text = value))
        }
    }

    private fun promptLegendRow(legend: ch.fasrv.fanotes.study.StudyLegend, key: String, draft: String? = null) {
        val def = ch.fasrv.fanotes.study.stampById(key) ?: return
        val track = ch.fasrv.fanotes.study.StudyDialogState(ch.fasrv.fanotes.study.StudyDialogKind.LEGEND_ROW, id = legend.id, key = key)
        textDialog("${def.glyph} ${ch.fasrv.fanotes.desk.ChromeText.ui("Legende")}", def.label, draft ?: legend.names[key].orEmpty().ifEmpty { def.label }, 60, false, track = track) { value ->
            val current = ink.study.items.firstOrNull { it.id == legend.id } as? ch.fasrv.fanotes.study.StudyLegend ?: return@textDialog
            val names = LinkedHashMap(current.names)
            if (value.isBlank() || value == def.label) names.remove(key) else names[key] = value.take(60)
            ink.study.replace(current.copy(names = names))
        }
    }

    /** Small on-screen-keyboard dialog; [terms] show as one-tap chips for the word bank. */
    private fun textDialog(
        title: String,
        hint: String,
        initial: String,
        max: Int,
        multiline: Boolean,
        terms: List<String> = emptyList(),
        onDelete: (() -> Unit)? = null,
        track: ch.fasrv.fanotes.study.StudyDialogState? = null,
        onOk: (String) -> Unit,
    ) {
        val ui = ch.fasrv.fanotes.desk.ChromeText::ui
        studyDialog?.dismiss()
        val field = android.widget.EditText(context)
        field.setText(initial)
        field.setSelection(initial.length)
        if (track != null) {
            // Rotation recreates the screen: keep what is typed so the editor can reopen with it.
            ink.study.openDialog = track.copy(text = initial)
            field.addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: android.text.Editable?) {
                    ink.study.openDialog = ink.study.openDialog?.copy(text = s?.toString().orEmpty())
                }
            })
        }
        field.hint = ui(hint)
        field.filters = arrayOf(android.text.InputFilter.LengthFilter(max))
        field.inputType = android.text.InputType.TYPE_CLASS_TEXT or
            (if (multiline) android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE else android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        val column = LinearLayout(context)
        column.orientation = LinearLayout.VERTICAL
        column.setPadding(dp(20), dp(8), dp(20), 0)
        column.addView(field)
        if (terms.isNotEmpty()) {
            val scroll = android.widget.HorizontalScrollView(context)
            val row = LinearLayout(context)
            terms.forEach { term ->
                val chipView = TextView(context)
                chipView.text = term
                chipView.setPadding(dp(10), dp(6), dp(10), dp(6))
                chipView.setOnClickListener { field.setText(term); field.setSelection(term.length.coerceAtMost(max)) }
                row.addView(chipView)
            }
            scroll.addView(row)
            column.addView(scroll)
        }
        val builder = android.app.AlertDialog.Builder(context)
            .setTitle(ui(title))
            .setView(column)
            .setPositiveButton(ui("OK")) { _, _ -> onOk(field.text.toString()) }
            .setNegativeButton(ui("Abbrechen"), null)
        if (onDelete != null) builder.setNeutralButton(ui("Löschen")) { _, _ -> onDelete() }
        val dialog = builder.create()
        dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        dialog.setOnDismissListener {
            if (studyDialog === dialog) studyDialog = null
            // Leaving the window (rotation) keeps the state for the recreated screen; any other dismissal ends the editor.
            if (!leavingWindow && track != null) ink.study.openDialog = null
        }
        studyDialog = dialog
        dialog.show()
        field.requestFocus()
    }

    private var studyDialog: android.app.AlertDialog? = null
    private var leavingWindow = false

    /**
     * Reopens the label editor that was open when the screen was recreated, with the text typed so far.
     * Called once the note's annotations are set; a dialog whose callout or legend is gone is dropped.
     */
    fun resumeStudyDialog() {
        val saved = ink.study.openDialog ?: return
        if (studyDialog != null) return
        val items = ink.study.items
        when (saved.kind) {
            ch.fasrv.fanotes.study.StudyDialogKind.TERMS -> promptTerms(saved.text)
            ch.fasrv.fanotes.study.StudyDialogKind.CALLOUT -> {
                val callout = items.firstOrNull { it.id == saved.id } as? ch.fasrv.fanotes.study.StudyCallout
                if (callout != null) promptCallout(callout, saved.text) else if (items.isNotEmpty()) ink.study.openDialog = null
            }
            ch.fasrv.fanotes.study.StudyDialogKind.LEGEND_ROW -> {
                val legend = items.firstOrNull { it.id == saved.id } as? ch.fasrv.fanotes.study.StudyLegend
                if (legend != null) promptLegendRow(legend, saved.key, saved.text) else if (items.isNotEmpty()) ink.study.openDialog = null
            }
        }
    }

    /** The study tools' transient state as text, for the activity's saved instance state. */
    fun studyStateSnapshot(): String = ink.study.snapshot().encode()

    /** Puts [studyStateSnapshot] text back; the toolbar rebuilds on the next sync. */
    fun restoreStudyState(raw: String?) {
        val state = ch.fasrv.fanotes.study.decodeStudyUiState(raw) ?: return
        ink.study.restore(state)
        studyOpen = state.tool != null
    }

    private fun endIcon(icon: String, label: String, click: () -> Unit): View =
        penKit.toolButton(icon, label, showLabel = false, click = click)

    private fun addLinkTools() {
        tools.addView(endIcon("link-2", "Verlinkung") {
            ink.placingLink = true
            ink.publishLinkChrome()
            onDeskShortcut("note-link")
        })
        tools.addView(endIcon("unlink", "Verlinkung entfernen") {
            val id = ink.selectedLinkId ?: ink.linkMarks.lastOrNull()?.id ?: return@endIcon
            ink.onRemoveLink(id)
            ink.selectedLinkId = null
            ink.publishLinkChrome()
        })
    }

    private fun paperChip(paper: String): TextView {
        val label = ch.fasrv.fanotes.desk.paperStyleLabel(paper)
        return chip(label) {
            val index = Papers.indexOfFirst { it.first == paper }.let { if (it < 0) 0 else it }
            onPaper(Papers[(index + 1) % Papers.size].first)
        }
    }

    private fun seg(label: String, selected: Boolean, click: () -> Unit): TextView {
        val view = TextView(context)
        view.text = ch.fasrv.fanotes.desk.ChromeText.ui(label)
        view.textSize = if (barPosition.vertical) 11f else 13f
        view.gravity = Gravity.CENTER
        view.setPadding(dp(if (barPosition.vertical) 2 else 12), 0, dp(if (barPosition.vertical) 2 else 12), 0)
        view.minHeight = dp(if (barPosition.vertical) 40 else 44)
        view.maxLines = 1
        view.setTextColor(ch.fasrv.fanotes.desk.modeSwitchInk(themeId, systemDark, selected))
        view.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, 650, false)
        if (selected) {
            view.background = rounded(
                ch.fasrv.fanotes.desk.modeSwitchActiveColor(themeId, systemDark),
                dp(ch.fasrv.fanotes.desk.MODE_BUTTON_RADIUS_DP),
            )
            view.elevation = dp(ch.fasrv.fanotes.desk.MODE_ACTIVE_SHADOW_BLUR_DP).toFloat()
            view.outlineAmbientShadowColor = ch.fasrv.fanotes.desk.modeSwitchShadowColor()
            view.outlineSpotShadowColor = ch.fasrv.fanotes.desk.modeSwitchShadowColor()
        } else {
            view.elevation = 0f
        }
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

    private fun chip(label: String, enabled: Boolean = true, description: String = label, click: () -> Unit): TextView =
        penKit.chip(label, enabled, description, click)

    private fun swatch(color: String, selected: Boolean, click: () -> Unit): View = penKit.swatch(color, selected, click = click)

    fun handleToolbarAction(action: String): Boolean {
        when (action) {
            "zoom-in" -> ink.zoomByStep(1)
            "zoom-out" -> ink.zoomByStep(-1)
            "rotate-left" -> ink.rotateBy(-1)
            "rotate-right" -> ink.rotateBy(1)
            "reset-view" -> ink.resetView()
            "math" -> onMath()
            "text-hand" -> onTextHand()
            "text-field" -> onDeskShortcut("text-field")
            "highlight" -> ink.armWorksheetHighlight(!ink.placingHighlight)
            "finger" -> onFinger(!builtFinger)
            "clear" -> onClear()
            "duplicate" -> onDuplicate()
            "collapse" -> setChromeOpen(false)
            "laser" -> activatePenTool(InkTool.LASER)
            "pen-quick-menu" -> openQuickMenu(width / 2f, height / 2f)
            "zeichenstudio" -> { if (toolMemory.drawingMode) openCard("studio") else activateDrawing() }
            "notes" -> onToggleRail()
            else -> return false
        }
        return true
    }

    private fun applyChromeColors() {
        ink.applyDeskChrome(themeId, systemDark)
        val bg = ch.fasrv.fanotes.desk.editorToolbarColor(themeId, systemDark)
        toolbarRule.setBackgroundColor(ch.fasrv.fanotes.desk.editorToolbarRule(dark))
        val fg = if (dark) 0xFFEDEDEC.toInt() else 0xFF252630.toInt()
        toolbar.setBackgroundColor(bg)
        rail.setBackgroundColor(bg)
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
        val chrome = ch.fasrv.fanotes.desk.windowChrome(themeId, systemDark)
        setBackgroundColor(if (next == "clean") android.graphics.Color.parseColor(chrome.window) else android.graphics.Color.TRANSPARENT)
        ink.applyWorkspaceKind(next)
    }

    override fun onDragEvent(event: DragEvent): Boolean {
        if (!dragOffersImage(event)) return false
        return when (event.action) {
            DragEvent.ACTION_DRAG_STARTED,
            DragEvent.ACTION_DRAG_ENTERED,
            DragEvent.ACTION_DRAG_LOCATION,
            DragEvent.ACTION_DRAG_EXITED,
            DragEvent.ACTION_DRAG_ENDED,
            -> true
            DragEvent.ACTION_DROP -> dropImage(event)
            else -> false
        }
    }

    private fun hostActivity(): Activity? {
        var current = context
        while (current is ContextWrapper) {
            if (current is Activity) return current
            current = current.baseContext
        }
        return null
    }

    private fun dragOffersImage(event: DragEvent): Boolean {
        val description = event.clipDescription ?: return false
        for (index in 0 until description.mimeTypeCount) {
            if (ch.fasrv.fanotes.desk.droppedImageFile(description.getMimeType(index)) != null) return true
        }
        return false
    }

    private fun dropImage(event: DragEvent): Boolean {
        val description = event.clipDescription ?: return false
        var mime: String? = null
        for (index in 0 until description.mimeTypeCount) {
            mime = ch.fasrv.fanotes.desk.clipboardImageMime(description.getMimeType(index))
            if (mime != null) break
        }
        val type = mime ?: return false
        val clip = event.clipData ?: return false
        if (clip.itemCount == 0) return false
        val uri = clip.getItemAt(0).uri ?: return false
        val permission = hostActivity()?.requestDragAndDropPermissions(event)
        val bytes = runCatching {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        }.getOrNull()
        permission?.release()
        if (bytes == null || bytes.isEmpty()) return false
        val name = ch.fasrv.fanotes.desk.droppedImageFile(type) ?: return false
        onPasteImage(name, bytes, type)
        return true
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            val sheetName = when (event.keyCode) {
                KeyEvent.KEYCODE_LEFT_BRACKET -> "["
                KeyEvent.KEYCODE_RIGHT_BRACKET -> "]"
                KeyEvent.KEYCODE_EQUALS, KeyEvent.KEYCODE_PLUS, KeyEvent.KEYCODE_NUMPAD_ADD -> if (event.isShiftPressed) "+" else "="
                KeyEvent.KEYCODE_MINUS, KeyEvent.KEYCODE_NUMPAD_SUBTRACT -> "-"
                KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_NUMPAD_0 -> "0"
                else -> null
            }
            if (sheetName != null) {
                val sheet = ch.fasrv.fanotes.desk.sheetViewKey(
                    sheetName,
                    event.isCtrlPressed,
                    event.isMetaPressed,
                    event.isAltPressed,
                    event.isShiftPressed,
                    editor.hasFocus() || boxField.hasFocus(),
                )
                when (sheet) {
                    "zoom-in" -> ink.zoomByStep(1)
                    "zoom-out" -> ink.zoomByStep(-1)
                    "reset" -> ink.resetView()
                    "rotate-ccw" -> ink.rotateBy(-1)
                    "rotate-cw" -> ink.rotateBy(1)
                    else -> sheet
                }
                if (sheet != null) return true
            }
        }
        if (pdfNote && !editor.hasFocus() && !boxField.hasFocus() && event.action == KeyEvent.ACTION_DOWN) {
            val name = when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_DOWN -> "down"
                KeyEvent.KEYCODE_PAGE_DOWN -> "page-down"
                KeyEvent.KEYCODE_DPAD_UP -> "up"
                KeyEvent.KEYCODE_PAGE_UP -> "page-up"
                KeyEvent.KEYCODE_MOVE_HOME -> "home"
                KeyEvent.KEYCODE_MOVE_END -> "end"
                KeyEvent.KEYCODE_F -> "f"
                else -> null
            }
            if (name != null) {
                val action = ch.fasrv.fanotes.desk.pdfViewerKey(
                    name,
                    event.isCtrlPressed,
                    event.isMetaPressed,
                    event.isAltPressed,
                    event.isShiftPressed,
                )
                if (action != null) {
                    onPdfKey(action)
                    return true
                }
            }
        }
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            val deleting = event.keyCode == KeyEvent.KEYCODE_DEL || event.keyCode == KeyEvent.KEYCODE_FORWARD_DEL
            val id = ink.selectedLinkId
            if (ch.fasrv.fanotes.desk.noteLinkDeleteKey(deleting, findFocus() is android.widget.EditText, id != null) && id != null) {
                ink.onRemoveLink(id)
                ink.selectedLinkId = null
                ink.publishLinkChrome()
                return true
            }
        }
        if (event.action == KeyEvent.ACTION_DOWN &&
            event.isCtrlPressed && !event.isShiftPressed && !event.isAltPressed && !event.isMetaPressed &&
            event.keyCode == KeyEvent.KEYCODE_V &&
            ch.fasrv.fanotes.desk.pasteImageOntoSheet(textMode && editor.hasFocus()) &&
            pasteClipboardImage()
        ) {
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun pasteClipboardImage(): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
        val clip = clipboard.primaryClip ?: return false
        if (clip.itemCount == 0) return false
        var mime: String? = null
        val description = clip.description
        for (index in 0 until description.mimeTypeCount) {
            mime = ch.fasrv.fanotes.desk.clipboardImageMime(description.getMimeType(index))
            if (mime != null) break
        }
        val type = mime ?: return false
        val uri = clip.getItemAt(0).uri ?: return false
        val bytes = runCatching {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        }.getOrNull() ?: return false
        if (bytes.isEmpty()) return false
        onPasteImage(ch.fasrv.fanotes.desk.clipboardImageFileName(type), bytes, type)
        return true
    }

    /**
     * Shows or moves the on-sheet worksheet field. There is no dialog fallback:
     * if the worksheet frame is not laid out yet, this waits for the next camera or layout pass.
     */
    fun syncWorksheetField(id: String?) {
        requestedBoxId = id
        placeWorksheetField()
    }

    /** Shows the keyboard editor on a placed note text field. */
    fun syncNoteTextField(id: String?) {
        requestedNoteFieldId = id
        placeNoteTextFieldEditor()
    }

    private fun placeNoteTextFieldEditor() {
        val id = requestedNoteFieldId
        if (id == null) {
            dismissNoteTextField()
            return
        }
        if (ink.noteTextFields.none { it.id == id }) {
            if (openNoteFieldId == id) {
                openNoteFieldId = null
                post { onNoteTextFieldClosed() }
            }
            return
        }
        val live = if (openNoteFieldId == id) noteField.text?.toString() else null
        val rect = ink.noteTextFieldScreenRect(id, live) ?: return
        if (openNoteFieldId != id) {
            val text = ink.noteTextFields.firstOrNull { it.id == id }?.text.orEmpty()
            openNoteFieldId = id
            writingNoteField = true
            noteField.setText(text)
            noteField.setSelection(noteField.text?.length ?: 0)
            writingNoteField = false
            acceptedNoteText = text
            noteField.hint = ch.fasrv.fanotes.desk.ChromeText.ui("Text eingeben …")
            noteField.visibility = VISIBLE
            noteBar.visibility = VISIBLE
            noteField.requestFocusFromTouch()
            val imm = context.getSystemService(InputMethodManager::class.java)
            imm?.showSoftInput(noteField, InputMethodManager.SHOW_IMPLICIT)
        }
        ink.activeNoteTextFieldId = id
        val field = ink.noteTextFields.firstOrNull { it.id == id }
        val scale = ink.cameraScale().coerceAtLeast(0.2f)
        val font = ((field?.fontSize ?: 16) * scale).coerceAtLeast(12f)
        noteField.setTextSize(TypedValue.COMPLEX_UNIT_PX, font)
        noteField.setTextColor(field?.color?.let { android.graphics.Color.parseColor(it) } ?: 0xFF20222B.toInt())
        noteField.setTypeface(null, if (field?.bold == true) Typeface.BOLD else Typeface.NORMAL)
        val left = rect.left.toInt()
        val top = rect.top.toInt()
        val right = (rect.left + rect.width).toInt().coerceAtLeast(left + 1)
        val bottom = (rect.top + rect.height).toInt().coerceAtLeast(top + 1)
        pinToSheet(noteField, left, top, right, bottom)
        if (field != null) placeNoteTextFieldBar(field, left, top, bottom)
        ink.invalidate()
    }

    /** The style bar above the open field, or below it when the toolbar is in the way; kept on screen. */
    private fun placeNoteTextFieldBar(field: ch.fasrv.fanotes.desk.NoteTextField, left: Int, top: Int, bottom: Int) {
        noteBar.applyColors(penKit.colors)
        noteBar.bind(field)
        noteBar.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val barWidth = noteBar.measuredWidth
        val barHeight = noteBar.measuredHeight
        val margin = dp(8)
        val ceiling = if (toolbar.visibility == VISIBLE) toolbar.bottom + margin else margin
        val above = top - margin - barHeight
        val y = if (above >= ceiling) above else (bottom + margin).coerceAtMost(height - barHeight - margin)
        // A side rail covers one edge of the page: keep the bar beside it, not under it.
        val railOpen = rail.visibility == VISIBLE
        val minX = if (railOpen && barPosition == ch.fasrv.fanotes.desk.ToolbarPosition.SIDE) rail.right + margin else margin
        val maxX = (if (railOpen && barPosition == ch.fasrv.fanotes.desk.ToolbarPosition.SIDE_RIGHT) rail.left - margin else width - margin) - barWidth
        val x = left.coerceIn(minX, maxX.coerceAtLeast(minX))
        noteBar.layout(x, y, x + barWidth, y + barHeight)
    }

    private fun dismissNoteTextField() {
        val open = openNoteFieldId != null || noteField.visibility == VISIBLE
        requestedNoteFieldId = null
        if (!open && ink.activeNoteTextFieldId == null) return
        suppressNoteClose = true
        noteField.visibility = GONE
        noteRemove.visibility = GONE
        noteBar.visibility = GONE
        openNoteFieldId = null
        if (noteField.hasFocus()) noteField.clearFocus()
        val imm = context.getSystemService(InputMethodManager::class.java)
        imm?.hideSoftInputFromWindow(noteField.windowToken, 0)
        if (ink.activeNoteTextFieldId != null) ink.activeNoteTextFieldId = null
        ink.invalidate()
        suppressNoteClose = false
    }

    private fun placeWorksheetField() {
        val id = requestedBoxId
        if (id == null) {
            dismissWorksheetField()
            return
        }
        if (ink.worksheetBoxes.none { it.box.id == id }) {
            if (openBoxId == id) {
                openBoxId = null
                post { onWorksheetBoxClosed() }
            }
            return
        }
        val live = if (openBoxId == id) boxField.text?.toString() else null
        val rect = ink.worksheetFieldScreenRect(id, live) ?: return
        if (openBoxId != id) {
            val text = ink.worksheetBoxes.firstOrNull { it.box.id == id }?.box?.text.orEmpty()
            openBoxId = id
            writingBox = true
            boxField.setText(text)
            boxField.setSelection(boxField.text?.length ?: 0)
            writingBox = false
            acceptedBoxText = text
            boxField.visibility = VISIBLE
            boxRemove.visibility = VISIBLE
            boxField.requestFocusFromTouch()
        }
        ink.activeWorksheetBoxId = id
        val anchored = ink.worksheetBoxes.firstOrNull { it.box.id == id }
        val scale = ink.cameraScale().coerceAtLeast(0.2f)
        val font = ((anchored?.box?.fontSize ?: 16.0) * scale).toFloat().coerceAtLeast(12f)
        boxField.setTextSize(TypedValue.COMPLEX_UNIT_PX, font)
        val left = rect.left.toInt()
        val top = rect.top.toInt()
        val right = (rect.left + rect.width).toInt().coerceAtLeast(left + 1)
        val bottom = (rect.top + rect.height).toInt().coerceAtLeast(top + 1)
        pinToSheet(boxField, left, top, right, bottom)
        val size = dp(ch.fasrv.fanotes.desk.BOX_FIELD_REMOVE_DP).coerceAtLeast(1)
        val outset = dp(ch.fasrv.fanotes.desk.BOX_FIELD_REMOVE_OUTSET_DP)
        val removeRight = right + outset
        val removeTop = top - outset
        pinToSheet(boxRemove, removeRight - size, removeTop, removeRight, removeTop + size)
        ink.placeWorksheetBoxChrome(
            left.toFloat(),
            top.toFloat(),
            right.toFloat(),
            bottom.toFloat(),
            (removeRight - size).toFloat(),
            removeTop.toFloat(),
            removeRight.toFloat(),
            (removeTop + size).toFloat(),
            boxRemove.visibility == VISIBLE,
        )
    }

    private fun pinToSheet(view: View, left: Int, top: Int, right: Int, bottom: Int) {
        view.layout(left, top, right, bottom)
        val rotation = ink.sheetRotation()
        if (rotation == 0f) {
            view.rotation = 0f
            return
        }
        view.pivotX = ink.width / 2f - left
        view.pivotY = ink.height / 2f - top
        view.rotation = rotation
    }

    fun refreshBoxChrome() {
        applyBoxFieldChrome(boxField.isFocused)
    }

    private fun applyBoxFieldChrome(focused: Boolean) {
        ink.updateWorksheetBoxFocus(focused)
        val accent = ink.accentColor
        if (boxField.background != null && focused == boxChromeFocused && accent == boxChromeAccent) return
        boxChromeFocused = focused
        boxChromeAccent = accent
        val alpha = if (focused) ch.fasrv.fanotes.desk.BOX_FIELD_FOCUS_BG_ALPHA else ch.fasrv.fanotes.desk.BOX_FIELD_BG_ALPHA
        boxField.background = GradientDrawable().apply {
            cornerRadius = dp(ch.fasrv.fanotes.desk.BOX_EDITOR_RADIUS_DP).toFloat()
            setColor(android.graphics.Color.argb((alpha * 255f + 0.5f).toInt(), 255, 255, 255))
            val stroke = if (focused) accent else ch.fasrv.fanotes.desk.worksheetBoxRestBorder(accent)
            setStroke(dp(1).coerceAtLeast(1), stroke)
        }
        val padX = dp(ch.fasrv.fanotes.desk.BOX_EDITOR_PAD_X_DP)
        val padY = dp(ch.fasrv.fanotes.desk.BOX_EDITOR_PAD_Y_DP)
        boxField.setPadding(padX, padY, padX, padY)
    }

    private fun dismissWorksheetField() {
        val open = openBoxId != null || boxField.visibility == VISIBLE
        requestedBoxId = null
        if (!open && ink.activeWorksheetBoxId == null) {
            ink.clearWorksheetBoxChrome()
            return
        }
        suppressBoxClose = true
        boxField.visibility = GONE
        boxRemove.visibility = GONE
        openBoxId = null
        if (boxField.hasFocus()) boxField.clearFocus()
        val imm = context.getSystemService(InputMethodManager::class.java)
        imm?.hideSoftInputFromWindow(boxField.windowToken, 0)
        if (ink.activeWorksheetBoxId != null) ink.activeWorksheetBoxId = null
        ink.clearWorksheetBoxChrome()
        suppressBoxClose = false
    }

    private var foldGlyphText: String = ""
    private var editorPlaceKey = ""
    private var lineNumberCount = -1

    private var foldGlyphSource: String? = null
    private var foldGlyphFolds: Set<Int> = emptySet()
    private var foldGlyphList: List<String> = emptyList()
    private var foldLaidOutText: String? = null
    /** Set when the text changed in a way the kept gutter glyphs cannot follow. */
    private var foldStructural = true
    private val foldRefresh = Runnable {
        foldStructural = true
        placeEditor()
    }

    /**
     * The fold gutter glyphs. Scanning a long note for headings costs tens of milliseconds, so typing a plain word
     * in the middle of a line keeps the glyphs from before and refreshes them after a pause; a new line, a heading
     * mark or a fence character (see [foldMarkersSurviveEdit]) or any other change of the text updates them at once.
     */
    private fun foldGlyphsFor(source: String, folds: Set<Int>): List<String> {
        val last = foldGlyphSource
        if (last != null && folds == foldGlyphFolds && !foldStructural && source.length > PREVIEW_WINDOW_MIN_CHARS) {
            if (last !== source) {
                removeCallbacks(foldRefresh)
                postDelayed(foldRefresh, FOLD_GLYPH_SETTLE_MS)
            }
            return foldGlyphList
        }
        if (last != null && last === source && folds == foldGlyphFolds && !foldStructural) return foldGlyphList
        removeCallbacks(foldRefresh)
        val glyphs = ch.fasrv.fanotes.desk.foldMarkerGlyphs(source, folds)
        foldGlyphSource = source
        foldGlyphFolds = folds
        foldGlyphList = glyphs
        foldGlyphText = glyphs.joinToString("\n")
        foldStructural = false
        return glyphs
    }

    private fun placeEditor() {
        if (editor.visibility != VISIBLE) {
            lineNumbers.visibility = GONE
            foldMarks.visibility = GONE
            return
        }
        val scale = ink.cameraScale().coerceAtLeast(0.2f)
        val x = (ink.cameraLeft() + 72f * scale).toInt()
        val y = (ink.cameraTop() + 78f * scale).toInt()
        val width = (ink.textColumnPx() * scale).toInt().coerceAtLeast(dp(80))
        val height = (ink.height - y).coerceAtLeast(dp(40))
        // Typing and caret moves call this too; the editor only needs touching when its geometry or look changed.
        val placeKey = "$x|$y|$width|$height|${ink.editorFontPx * scale}|${ink.editorLineHeight}|${ink.accentColor}"
        if (placeKey != editorPlaceKey) {
            editorPlaceKey = placeKey
            editor.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale)
            editor.setLineSpacing(0f, ink.editorLineHeight)
            applyPaperCaret(editor, ink.accentColor, ink.editorFontPx * scale)
            editor.highlightColor = selectionWashArgb(ink.accentColor)
            editor.fixedWidth = width
            editor.fixedHeight = height
            editor.measure(
                MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
            )
        }
        // The frame layout moves its children in onLayout; put the editor back where it belongs.
        editor.layout(x, y, x + width, y + height)
        val foldWidth = dp(18)
        val glyphs = foldGlyphsFor(sourceMarkdown, foldedLines)
        // A five-thousand-line gutter is re-laid out whenever its text is set, even to the same string.
        val glyphText = foldGlyphText
        if (glyphText != foldLaidOutText) {
            foldLaidOutText = glyphText
            foldMarks.text = glyphText
        }
        if (foldMarks.typeface !== ink.editorTypeface) foldMarks.typeface = ink.editorTypeface
        foldMarks.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale)
        foldMarks.setLineSpacing(0f, ink.editorLineHeight)
        foldMarks.visibility = if (glyphs.any { it.isNotEmpty() }) VISIBLE else GONE
        foldMarks.fixedWidth = foldWidth
        foldMarks.fixedHeight = height
        foldMarks.measure(
            MeasureSpec.makeMeasureSpec(foldWidth, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
        )
        foldMarks.layout(x - foldWidth - dp(2), y, x - dp(2), y + height)
        foldMarks.scrollTo(0, editor.scrollY)
        if (ink.showLineNumbers) {
            val labels = ch.fasrv.fanotes.desk.editorLineNumberLabels(editor.text?.toString().orEmpty())
            if (labels.size != lineNumberCount) {
                lineNumberCount = labels.size
                lineNumbers.text = labels.joinToString("\n")
            }
            lineNumbers.typeface = ink.editorTypeface
            lineNumbers.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale * 0.82f)
            lineNumbers.setLineSpacing(0f, ink.editorLineHeight)
            lineNumbers.visibility = VISIBLE
            val gutter = ch.fasrv.fanotes.desk.lineNumberColumnPx(editor.text?.toString().orEmpty(), ink.editorFontPx * scale, dp(18))
            lineNumbers.fixedWidth = gutter
            lineNumbers.fixedHeight = height
            lineNumbers.measure(
                MeasureSpec.makeMeasureSpec(gutter, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
            )
            lineNumbers.layout(x - foldWidth - gutter - dp(6), y, x - foldWidth - dp(6), y + height)
            lineNumbers.scrollTo(0, editor.scrollY)
        } else {
            lineNumbers.visibility = GONE
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(timerTick)
        compareDecoderPool?.shutdownNow()
        compareDecoderPool = null
        tags?.hide()
        // A showing dialog would leak its window when the activity is recreated; its text lives in the study state.
        leavingWindow = true
        studyDialog?.dismiss()
        leavingWindow = false
        super.onDetachedFromWindow()
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        placeEditor()
        placeWorksheetField()
        placeNoteTextFieldEditor()
    }

    private fun rounded(color: Int, radius: Int, stroke: Int = 0, strokeWidth: Int = 0) = GradientDrawable().apply {
        cornerRadius = radius.toFloat()
        setColor(color)
        if (strokeWidth > 0) setStroke(strokeWidth, stroke)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val FOLD_GLYPH_SETTLE_MS = 400L
        val PenColors = listOf("#202333", "#2457D6", "#D23B4A", "#1F8A4C", "#E2A21B", "#7A4DD6")
        val Papers = ch.fasrv.fanotes.desk.PAPER_STYLES.map { it.id to it.label }
        /** Drawing colours on the bar (desktop quick-menu ring, first six). */
        val QUICK_DRAW_COLORS = ch.fasrv.fanotes.ink.QUICK_ART_COLORS.take(6)
    }
}

private fun android.text.Editable?.orEmpty() = this?.toString().orEmpty()

private class EditorToolbarScroll(context: Context) : HorizontalScrollView(context) {
    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        if (event.pointerCount > 1) return false
        for (index in 0 until event.pointerCount) {
            val tool = event.getToolType(index)
            if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) return false
        }
        return super.onInterceptTouchEvent(event)
    }
}
