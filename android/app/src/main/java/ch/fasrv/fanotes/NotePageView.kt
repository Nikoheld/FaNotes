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
import android.widget.LinearLayout
import android.widget.SeekBar
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

/**
 * The page and its chrome live in one clipped frame. The toolbar is a later
 * sibling of the canvas, so a zoomed sheet cannot paint over it, and hiding
 * the bar does not resize the page under an active pen.
 */
class NotePageView(context: Context) : FrameLayout(context) {
    val ink = InkSurfaceView(context)
    private var previewReady = false
    private var paintingPreview = false
    private val editor = object : EditText(context) {
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

        fun captureCursor() {
            cursorBeforeEdit = selectionEnd.coerceAtLeast(0)
        }

        fun resetHistory() {
            history.reset()
        }

        fun rememberChange(before: String, after: String, cursorBefore: Int = cursorBeforeEdit) {
            history.record(before, after, cursorBefore, selectionEnd.coerceAtLeast(0), System.currentTimeMillis())
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
            if (w != oldw && previewReady && !paintingPreview) paintLivePreview()
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
            trackSelection(selStart, selEnd)
            spelling.schedule(220)
            invalidate()
            if (previewReady && !paintingPreview) paintLivePreview()
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
                    val handled = tapped && (followRenderedLink(event.x, event.y) || toggleDetailsSummary(event.x, event.y) || toggleTaskBox(event.x, event.y))
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
            if (keyCode == KeyEvent.KEYCODE_ENTER && event.isCtrlPressed && !event.isShiftPressed &&
                !event.isAltPressed && !event.isMetaPressed
            ) {
                if (event.action == KeyEvent.ACTION_DOWN) insertBlankLine()
                return true
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
    private val lineNumbers = TextView(context)
    private val foldMarks = TextView(context)
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
    private var requestedBoxId: String? = null
    private var openBoxId: String? = null
    private var acceptedBoxText = ""
    private var writingBox = false
    private var suppressBoxClose = false
    private var boxRemovePressed = false
    private var boxChromeFocused = false
    private var boxChromeAccent = Int.MIN_VALUE
    private val toolbar = HorizontalScrollView(context)
    private val toolbarRule = View(context)
    private val tools = LinearLayout(context)
    private val handle = TextView(context)
    private val syncPill = TextView(context)
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
    var onUnfoldHeading: (Int) -> Unit = {}
    var onToggleHeading: (Int) -> Unit = {}
    var onEditorFold: (String, Int) -> Unit = { _, _ -> }
    var onSearchCommand: (String, String, Int) -> Unit = { _, _, _ -> }
    var onDeskShortcut: (String) -> Unit = {}
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

    init {
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
        setBackgroundColor(0xFFE8E6E1.toInt())
        ink.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        addView(ink, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        editor.background = null
        editor.setTextColor(0xFF252630.toInt())
        editor.highlightColor = selectionWashArgb(ink.accentColor)
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
                        val replacement = ch.fasrv.fanotes.desk.markdownEnterReplacement(editBefore, next)
                            ?: ch.fasrv.fanotes.desk.markdownBackspaceReplacement(editBefore, next)
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
                            editor.rememberChange(editBefore, next)
                            onVisibleMarkdown(editBefore, next)
                        }
                    }
                }
                if (previewReady) paintLivePreview()
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
        editor.setOnScrollChangeListener { _, _, scrollY, _, _ ->
            lineNumbers.scrollTo(0, scrollY)
            foldMarks.scrollTo(0, scrollY)
            tags?.onCaretMoved()
        }
        tools.orientation = LinearLayout.HORIZONTAL
        tools.gravity = Gravity.CENTER_VERTICAL
        toolbar.isHorizontalScrollBarEnabled = false
        toolbar.setPadding(dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_PAD_DP), 0, dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_PAD_DP), 0)
        toolbar.addView(tools, LayoutParams(LayoutParams.WRAP_CONTENT, dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_DP)))
        toolbar.elevation = 12f
        addView(toolbar, LayoutParams(LayoutParams.MATCH_PARENT, dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_DP), Gravity.TOP))
        addView(
            toolbarRule,
            LayoutParams(LayoutParams.MATCH_PARENT, dp(1).coerceAtLeast(1), Gravity.TOP).apply {
                topMargin = dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_DP) - dp(1).coerceAtLeast(1)
            },
        )
        handle.text = "Werkzeuge"
        handle.gravity = Gravity.CENTER
        handle.textSize = 12f
        handle.visibility = GONE
        handle.setOnClickListener { setChromeOpen(true) }
        handle.elevation = 12f
        addView(handle, LayoutParams(dp(112), dp(28), Gravity.TOP or Gravity.END))
        ink.onPaperImages = { paintLivePreview() }
        ink.onCamera = { _, _, _ ->
            placeEditor()
            placeWorksheetField()
        }
        ink.onPenActive = { active ->
            penDown = active
            applyChromeVisibility()
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
    private fun paintLivePreview() {
        if (!previewReady || paintingPreview) return
        val editable = editor.text ?: return
        paintingPreview = true
        try {
            val box = ch.fasrv.fanotes.desk.paperDetailsBox(editor.textSize)
            val textWidth = editor.layout?.width?.toFloat()
                ?: (editor.width - editor.paddingLeft - editor.paddingRight).toFloat()
            val imageColumn = (textWidth - box.border * 2f - box.padX * 2f).coerceAtLeast(0f)
            applyLivePreview(
                editable,
                editor.selectionStart,
                editor.selectionEnd,
                ink.accentColor,
                editor.textSize,
                editor.isFocused,
                ink.paperImages,
                imageColumn,
            )
            editor.bindLinkPointer()
        } finally {
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
            replaceEditorText(shown, visible)
            editor.setSelection(selection.first, selection.second)
            writing = false
            paintLivePreview()
        }
        if (ink.markdown != visible) {
            ink.markdown = visible
            ink.invalidate()
        }
        if (textMode != text) setTextMode(text)
        syncPill.text = if (syncBusy && !syncLabel.contains('/')) "Startet…" else syncLabel
        val signature = "$tool|${style.color}|${style.brush}|${style.colorEffect}|${ink.placingSymbol}|${ink.placingSection}|${ink.symbolSize}|${ink.symbolRotation}|${ink.symbolOpacity}|${ink.symbolCategory}|$paper|$fingerDraws|$text|$canUndo|$canRedo|$dark|$themeId|$systemDark|$followPen"
        if (signature != toolSignature) {
            toolSignature = signature
            rebuildTools(tool, style, paper, fingerDraws, canUndo, canRedo)
        } else if (!widthFromUser) {
            widthBar?.progress = widthProgress(style.baseWidth.toFloat())
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

    private var toolSignature = ""
    private var builtTool: InkTool = InkTool.PEN
    private var builtStyle: StrokeStyle = StrokeStyle()
    private var builtPaper = "dots"
    private var builtFinger = false
    private var builtUndo = false
    private var builtRedo = false
    private var widthBar: SeekBar? = null
    private var widthFromUser = false

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
    ) {
        editor.spelling.configure(enabled, wave, ink, paper, epoch, accepted, onLanguage, onLearn, onIgnore)
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
        toolbar.visibility = if (visible) VISIBLE else GONE
        toolbarRule.visibility = if (visible) VISIBLE else GONE
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
        builtTool = tool
        builtStyle = style
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
        tools.addView(chip(if (ink.placingSection) "Abschnitt · an" else "Abschnitt") {
            val next = !ink.placingSection
            ink.placingSection = next
            ink.sectionGuideY = Float.NaN
            ink.onSectionChrome(next)
            if (next) ink.onInkNotice(ch.fasrv.fanotes.ink.InkNotice("info", ch.fasrv.fanotes.ink.SECTION_PLACE_HINT))
            ink.invalidate()
            post { rebuildTools(tool, style, paper, fingerDraws, canUndo, canRedo) }
        })
        tools.addView(chip("Lasso") { onTool(ch.fasrv.fanotes.ink.InkTool.LASSO) })
        if (tool == InkTool.LASSO && ink.session?.selection?.isNotEmpty() == true) {
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
        tools.addView(chip("Verknüpfung") {
            ink.placingLink = true
            ink.publishLinkChrome()
        })
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
            ink.publishLinkChrome()
        })
        tools.addView(chip("Fett") { format("bold") })
        tools.addView(chip("Nächstes") { selectNextOccurrence() })
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
            tools.addView(chip("Einzug") { indentLines(false) })
            tools.addView(chip("Ausrücken") { indentLines(true) })
            tools.addView(chip("Zeile hoch") { moveLines(false) })
            tools.addView(chip("Zeile runter") { moveLines(true) })
            tools.addView(chip("Kommentar") { commentLines() })
            tools.addView(chip("Zeile löschen") { deleteCurrentLines() })
            tools.addView(chip("Leerzeile") { insertBlank() })
            tools.addView(chip("Umbruch") { insertIndentedNewline() })
            tools.addView(chip("Ganze Zeile") { selectLine() })
            tools.addView(chip("Klammer") { jumpBracket() })
        }
        tools.addView(guideChip("Lineal", DraftingKind.RULER))
        tools.addView(guideChip("Geodreieck", DraftingKind.SET_SQUARE))
        tools.addView(guideChip("Zirkel", DraftingKind.COMPASS))
        tools.addView(chip("Kreis") {
            if (!ink.guideOn(DraftingKind.COMPASS)) ink.toggleGuide(DraftingKind.COMPASS)
            ink.drawCompassCircle()
        })
        tools.addView(chip("Mathe") { onMath() })
        tools.addView(chip("Text → Handschrift") { onTextHand() })
        val textChip = chip(if (ink.placingText) "Auf Seite platzieren" else "Textfeld") {}
        val mark = chip(if (ink.placingHighlight) "Markieren ●" else "Markieren") {}
        ink.onWorksheetTool = { text, highlight ->
            textChip.text = if (text) "Auf Seite platzieren" else "Textfeld"
            mark.text = if (highlight) "Markieren ●" else "Markieren"
            val hint = ch.fasrv.fanotes.desk.worksheetPlaceHint(text, highlight)
            if (hint == null) ink.onDismissInkNotice() else ink.onInkNotice(ch.fasrv.fanotes.ink.InkNotice("info", hint))
        }
        textChip.setOnClickListener { ink.armWorksheetText(!ink.placingText) }
        mark.setOnClickListener { ink.armWorksheetHighlight(!ink.placingHighlight) }
        tools.addView(textChip)
        tools.addView(mark)
        tools.addView(chip("+", description = "Hineinzoomen") { ink.zoomByStep(1) })
        tools.addView(chip("−", description = "Herauszoomen") { ink.zoomByStep(-1) })
        tools.addView(chip("↺", description = "Blatt gegen den Uhrzeigersinn drehen") { ink.rotateBy(-1) })
        tools.addView(chip("↻", description = "Blatt im Uhrzeigersinn drehen") { ink.rotateBy(1) })
        tools.addView(chip("Ansicht", description = "Ansicht zurücksetzen") { ink.resetView() })
        tools.addView(chip("Kopieren") { onDuplicate() })
        tools.addView(chip("Leeren") { onClear() })
        tools.addView(chip("Einklappen") { setChromeOpen(false) })
        tools.addView(syncPill)
    }

    private fun segment(tool: InkTool): LinearLayout {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.background = rounded(ch.fasrv.fanotes.desk.modeSwitchTrackColor(themeId, systemDark), dp(ch.fasrv.fanotes.desk.MODE_SWITCH_RADIUS_DP))
        row.addView(seg("Stift", tool == InkTool.PEN) { onTool(InkTool.PEN) })
        row.addView(seg("Radierer", tool == InkTool.ERASER) { onTool(InkTool.ERASER) })
        row.addView(seg("Auswahl", tool == InkTool.SELECT) { onTool(InkTool.SELECT) })
        return row
    }

    private fun seg(label: String, selected: Boolean, click: () -> Unit): TextView {
        val view = TextView(context)
        view.text = label
        view.textSize = 12f
        view.gravity = Gravity.CENTER
        view.setPadding(dp(10), 0, dp(10), 0)
        view.minHeight = dp(ch.fasrv.fanotes.desk.MODE_BUTTON_DP)
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

    private fun chip(label: String, enabled: Boolean = true, description: String = label, click: () -> Unit): TextView {
        val view = TextView(context)
        view.text = label
        view.contentDescription = description
        view.textSize = 12f
        view.gravity = Gravity.CENTER
        view.setPadding(dp(10), 0, dp(10), 0)
        view.minHeight = dp(ch.fasrv.fanotes.desk.FORMAT_BUTTON_DP)
        view.background = rounded(android.graphics.Color.TRANSPARENT, dp(ch.fasrv.fanotes.desk.FORMAT_BUTTON_RADIUS_DP))
        view.isEnabled = enabled
        view.alpha = if (enabled) 1f else ch.fasrv.fanotes.desk.FORMAT_DISABLED_ALPHA
        view.setTextColor(ch.fasrv.fanotes.desk.formatChipInk(themeId, systemDark))
        view.setOnClickListener { if (enabled) click() }
        val params = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, dp(ch.fasrv.fanotes.desk.FORMAT_BUTTON_DP))
        params.marginStart = dp(ch.fasrv.fanotes.desk.FORMAT_BUTTON_GAP_DP)
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
        val params = LinearLayout.LayoutParams(dp(120), dp(ch.fasrv.fanotes.desk.EDITOR_TOOLBAR_DP))
        params.marginStart = dp(6)
        slider.layoutParams = params
        return slider
    }

    private fun applyChromeColors() {
        val bg = ch.fasrv.fanotes.desk.editorToolbarColor(themeId, systemDark)
        toolbarRule.setBackgroundColor(ch.fasrv.fanotes.desk.editorToolbarRule(dark))
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

    private fun placeEditor() {
        if (editor.visibility != VISIBLE) {
            lineNumbers.visibility = GONE
            foldMarks.visibility = GONE
            return
        }
        val scale = ink.cameraScale().coerceAtLeast(0.2f)
        editor.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale)
        editor.setLineSpacing(0f, ink.editorLineHeight)
        applyPaperCaret(editor, ink.accentColor, ink.editorFontPx * scale)
        editor.highlightColor = selectionWashArgb(ink.accentColor)
        val x = (ink.cameraLeft() + 72f * scale).toInt()
        val y = (ink.cameraTop() + 78f * scale).toInt()
        val width = (ink.textColumnPx() * scale).toInt().coerceAtLeast(dp(80))
        val height = (ink.height - y).coerceAtLeast(dp(40))
        editor.measure(
            MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
        )
        editor.layout(x, y, x + width, y + height)
        val foldWidth = dp(18)
        val glyphs = ch.fasrv.fanotes.desk.foldMarkerGlyphs(sourceMarkdown, foldedLines)
        foldMarks.text = glyphs.joinToString("\n")
        foldMarks.typeface = ink.editorTypeface
        foldMarks.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale)
        foldMarks.setLineSpacing(0f, ink.editorLineHeight)
        foldMarks.visibility = if (glyphs.any { it.isNotEmpty() }) VISIBLE else GONE
        foldMarks.measure(
            MeasureSpec.makeMeasureSpec(foldWidth, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
        )
        foldMarks.layout(x - foldWidth - dp(2), y, x - dp(2), y + height)
        foldMarks.scrollTo(0, editor.scrollY)
        if (ink.showLineNumbers) {
            val labels = ch.fasrv.fanotes.desk.editorLineNumberLabels(editor.text?.toString().orEmpty())
            lineNumbers.text = labels.joinToString("\n")
            lineNumbers.typeface = ink.editorTypeface
            lineNumbers.setTextSize(TypedValue.COMPLEX_UNIT_PX, ink.editorFontPx * scale * 0.82f)
            lineNumbers.setLineSpacing(0f, ink.editorLineHeight)
            lineNumbers.visibility = VISIBLE
            val gutter = ch.fasrv.fanotes.desk.lineNumberColumnPx(editor.text?.toString().orEmpty(), ink.editorFontPx * scale, dp(18))
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
        tags?.hide()
        super.onDetachedFromWindow()
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        placeEditor()
        placeWorksheetField()
    }

    private fun rounded(color: Int, radius: Int, stroke: Int = 0, strokeWidth: Int = 0) = GradientDrawable().apply {
        cornerRadius = radius.toFloat()
        setColor(color)
        if (strokeWidth > 0) setStroke(strokeWidth, stroke)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        val PenColors = listOf("#202333", "#2457D6", "#D23B4A", "#1F8A4C", "#E2A21B", "#7A4DD6")
        val Papers = ch.fasrv.fanotes.desk.PAPER_STYLES.map { it.id to it.label }
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
