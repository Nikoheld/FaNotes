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
import android.graphics.Bitmap
import ch.fasrv.fanotes.desk.paperDetailsBox
import ch.fasrv.fanotes.desk.selectionWashArgb
import ch.fasrv.fanotes.desk.editorLineNumberLabels
import ch.fasrv.fanotes.desk.findDetailsBlocks
import ch.fasrv.fanotes.desk.bracketTyping
import ch.fasrv.fanotes.desk.insertMarkdownBlankLine
import ch.fasrv.fanotes.desk.insertMarkdownNewlineIndent
import ch.fasrv.fanotes.desk.applyMarkdownFormat
import ch.fasrv.fanotes.desk.markdownFormatShortcut
import ch.fasrv.fanotes.desk.matchingBracketJump
import ch.fasrv.fanotes.desk.selectMarkdownLine
import ch.fasrv.fanotes.desk.bracketsOnCursorLine
import ch.fasrv.fanotes.desk.copyMarkdownLines
import ch.fasrv.fanotes.desk.deleteMarkdownLines
import ch.fasrv.fanotes.desk.toggleMarkdownBlockComment
import ch.fasrv.fanotes.desk.toggleMarkdownComment
import ch.fasrv.fanotes.desk.indentMarkdownLines
import ch.fasrv.fanotes.desk.moveMarkdownLines
import ch.fasrv.fanotes.desk.pasteUrlAsMarkdownLink
import ch.fasrv.fanotes.desk.lineNumberColumnPx
import ch.fasrv.fanotes.desk.lineStartOffsets
import ch.fasrv.fanotes.desk.nextEditorOccurrence
import ch.fasrv.fanotes.desk.nextOccurrenceShortcut
import ch.fasrv.fanotes.desk.toggleDetailsOpen
import ch.fasrv.fanotes.desk.toggleTaskMarker
import kotlin.math.abs

/**
 * Text mode for the second column. It uses the same live preview as the open
 * note: markers hide off the cursor line, and a tap checks a task or folds a
 * details block.
 */
class SplitEditorView(context: Context) : EditText(context) {
    val spelling = SpellingController(this)
    private var touchX = 0f
    private var touchY = 0f
    var onVisibleEdit: (String, String) -> Unit = { _, _ -> }
    var onFollowLink: (String, Boolean, String?) -> Unit = { _, _, _ -> }
    var paperImages: Map<String, Bitmap> = emptyMap()
        set(value) {
            if (field === value) return
            field = value
            paintPreview()
        }
    var onToggleFold: (Int) -> Unit = {}
    var onEditorFold: (String, Int) -> Unit = { _, _ -> }
    var foldSource: String = ""
    var foldState: Set<Int> = emptySet()
    private var pendingCursor: Int? = null
    var foldMarkers: List<String> = emptyList()
        set(value) {
            if (field == value) return
            field = value
            applyGutter()
            invalidate()
        }
    var accent: Int = 0xFF2A6F97.toInt()
        set(value) {
            if (field == value) return
            field = value
            highlightColor = selectionWashArgb(value)
            invalidate()
        }
    private var tabFocusMode = false
    private val history = ch.fasrv.fanotes.desk.EditorHistory()
    private var cursorBeforeEdit = 0
    private var applyingHistory = false
    private val activeLinePaint = Paint()
    var showLineNumbers: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            applyGutter()
        }
    private var writing = false
    private var tags: HtmlTagAssist? = null
    private var painting = false
    private var ready = false
    private var downX = 0f
    private var downY = 0f
    private val linkPointer = PreviewLinkPointer()
    private var editBefore = ""
    private var changeStart = 0
    private var changeDeleted = 0
    private val closedBrackets = mutableSetOf<Int>()

    init {
        tags = HtmlTagAssist(this) { block ->
            val origin = text?.toString().orEmpty()
            val cursor = selectionEnd.coerceAtLeast(0)
            writing = true
            try {
                block()
            } finally {
                writing = false
            }
            rememberChange(origin, text?.toString().orEmpty(), cursor)
        }
        background = null
        setTextColor(0xFF252630.toInt())
        highlightColor = selectionWashArgb(accent)
        setHintTextColor(0xFF8A8D98.toInt())
        hint = "Text auf dem Papier"
        gravity = Gravity.TOP or Gravity.START
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        setPadding(0, 0, 0, 0)
        setOnFocusChangeListener { _, focused ->
            paintPreview()
            if (!focused) tags?.hide()
        }
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
                if (!writing) {
                    editBefore = s?.toString().orEmpty()
                    changeStart = start
                    changeDeleted = count
                    cursorBeforeEdit = selectionEnd.coerceAtLeast(0)
                }
            }
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                spelling.schedule(360)
                if (!ready) return
                paintPreview()
                if (writing) {
                    closedBrackets.clear()
                } else {
                    val next = s?.toString().orEmpty()
                    val bracket = bracketTyping(editBefore, changeStart, changeDeleted, next, closedBrackets)
                        ?: ch.fasrv.fanotes.desk.htmlAutoClose(editBefore, changeStart, changeDeleted, next)?.let {
                            ch.fasrv.fanotes.desk.BracketEdit(it.text, it.selectionStart, it.selectionEnd, emptySet())
                        }
                    if (bracket != null) {
                        spelling.finishAutocorrect()
                        writing = true
                        setText(bracket.text)
                        setSelection(bracket.selectionStart, bracket.selectionEnd)
                        writing = false
                        closedBrackets.clear()
                        closedBrackets.addAll(bracket.closedAt)
                        val origin = editBefore
                        editBefore = bracket.text
                        rememberChange(origin, bracket.text)
                        onVisibleEdit(origin, bracket.text)
                    } else {
                        val corrected = if (s != null && hasComposingSpan(s)) null else {
                            spelling.autocorrectEdit(editBefore, next, changeStart, changeDeleted)
                        }
                        if (corrected != null) {
                            writing = true
                            setText(corrected.text)
                            setSelection(corrected.cursor.coerceIn(0, corrected.text.length))
                            writing = false
                            closedBrackets.clear()
                            val origin = editBefore
                            editBefore = corrected.text
                            rememberChange(origin, corrected.text)
                            onVisibleEdit(origin, corrected.text)
                        } else {
                        val replacement = ch.fasrv.fanotes.desk.markdownEnterReplacement(editBefore, next)
                            ?: ch.fasrv.fanotes.desk.markdownBackspaceReplacement(editBefore, next)
                        if (replacement != null) {
                            writing = true
                            setText(replacement.text)
                            setSelection(replacement.cursor.coerceIn(0, replacement.text.length))
                            writing = false
                            closedBrackets.clear()
                            val origin = editBefore
                            editBefore = replacement.text
                            rememberChange(origin, replacement.text)
                            onVisibleEdit(origin, replacement.text)
                        } else {
                            val inserted = next.length - editBefore.length + changeDeleted
                            val shifted = ch.fasrv.fanotes.desk.shiftClosedBrackets(
                                closedBrackets,
                                changeStart,
                                changeDeleted,
                                inserted.coerceAtLeast(0),
                            )
                            closedBrackets.clear()
                            closedBrackets.addAll(bracketsOnCursorLine(next, selectionStart, shifted))
                            rememberChange(editBefore, next)
                            onVisibleEdit(editBefore, next)
                        }
                        }
                    }
                }
                if (!writing) tags?.onUserEdit()
            }
        })
        ready = true
    }

    override fun onDetachedFromWindow() {
        tags?.hide()
        super.onDetachedFromWindow()
    }

    override fun onScrollChanged(horiz: Int, vert: Int, oldHoriz: Int, oldVert: Int) {
        super.onScrollChanged(horiz, vert, oldHoriz, oldVert)
        tags?.onCaretMoved()
    }

    private fun rememberChange(before: String, after: String, cursorBefore: Int = cursorBeforeEdit) {
        history.record(before, after, cursorBefore, selectionEnd.coerceAtLeast(0), System.currentTimeMillis())
    }

    private fun undoTyping(): Boolean = restoreHistory(history.undo(text?.toString().orEmpty()))

    private fun redoTyping(): Boolean = restoreHistory(history.redo(text?.toString().orEmpty()))

    private fun undoSelectionMove(): Boolean = moveSelectionHistory(history.undoSelection(selectionStart, selectionEnd, text?.length ?: 0))

    private fun redoSelectionMove(): Boolean = moveSelectionHistory(history.redoSelection(selectionStart, selectionEnd, text?.length ?: 0))

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
        onVisibleEdit(origin, edit.text)
        paintPreview()
        return true
    }

    fun show(markdown: String) {
        val pending = pendingCursor
        if (text?.toString() == markdown && pending == null) {
            paintPreview()
            return
        }
        history.reset()
        val current = text?.toString().orEmpty()
        val selection = if (pending != null) {
            val cursor = pending.coerceIn(0, markdown.length)
            cursor to cursor
        } else {
            ch.fasrv.fanotes.desk.mapSelectionThroughReplacement(current, markdown, selectionStart, selectionEnd)
        }
        pendingCursor = null
        writing = true
        val change = ch.fasrv.fanotes.desk.minimalReplacement(current, markdown)
        if (change.from == 0 && change.to == current.length) setText(markdown)
        else text?.replace(change.from, change.to.coerceAtMost(text?.length ?: 0), change.insert)
        setSelection(selection.first, selection.second)
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
        if (!applyingHistory) history.noteSelection(selStart, selEnd, text?.length ?: 0, System.currentTimeMillis())
        spelling.schedule(220)
        invalidate()
        if (ready && !painting) paintPreview()
        tags?.onCaretMoved()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        touchX = event.x
        touchY = event.y
        if (event.actionMasked == MotionEvent.ACTION_DOWN && event.buttonState and MotionEvent.BUTTON_SECONDARY != 0) {
            if (spelling.showAt(getOffsetForPosition(event.x, event.y))) return true
        }
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                followPreviewLinkPointer(linkPointer, event, true)
            }
            MotionEvent.ACTION_MOVE -> followPreviewLinkPointer(linkPointer, event, true)
            MotionEvent.ACTION_UP -> {
                val tapped = abs(event.x - downX) < 24f && abs(event.y - downY) < 24f
                val fold = tapped && event.x < foldColumn() && toggleFoldAt(event.y)
                val handled = fold || (tapped && toggleAt(event.x, event.y))
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

    override fun performLongClick(): Boolean {
        if (spelling.showAt(getOffsetForPosition(touchX, touchY))) return true
        return super.performLongClick()
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
        if (!event.isCtrlPressed && !event.isMetaPressed && !event.isAltPressed &&
            (keyCode == KeyEvent.KEYCODE_PAGE_UP || keyCode == KeyEvent.KEYCODE_PAGE_DOWN)
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) moveByPage(keyCode == KeyEvent.KEYCODE_PAGE_DOWN, event.isShiftPressed)
            return true
        }
        if ((event.isCtrlPressed || event.isMetaPressed) && !event.isAltPressed &&
            (keyCode == KeyEvent.KEYCODE_MOVE_HOME || keyCode == KeyEvent.KEYCODE_MOVE_END)
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) moveToDocumentEdge(keyCode == KeyEvent.KEYCODE_MOVE_END, event.isShiftPressed)
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
        if (event.isAltPressed && !event.isCtrlPressed && !event.isMetaPressed &&
            (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) moveBySyntax(keyCode == KeyEvent.KEYCODE_DPAD_RIGHT, event.isShiftPressed)
            return true
        }
        if ((event.isCtrlPressed || event.isMetaPressed) && !event.isAltPressed &&
            (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) moveByEditorGroup(keyCode == KeyEvent.KEYCODE_DPAD_RIGHT, event.isShiftPressed)
            return true
        }
        if ((event.isCtrlPressed || event.isMetaPressed) && !event.isShiftPressed && !event.isAltPressed &&
            (keyCode == KeyEvent.KEYCODE_DEL || keyCode == KeyEvent.KEYCODE_FORWARD_DEL)
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) deleteByEditorGroup(keyCode == KeyEvent.KEYCODE_FORWARD_DEL)
            return true
        }
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
        if (keyCode == KeyEvent.KEYCODE_BACKSLASH && event.isCtrlPressed && event.isShiftPressed &&
            !event.isAltPressed && !event.isMetaPressed
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                val edit = matchingBracketJump(text?.toString().orEmpty(), selectionStart, selectionEnd)
                if (edit != null) setSelection(edit.selectionStart.coerceIn(0, edit.text.length))
            }
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_L && event.isAltPressed && !event.isCtrlPressed && !event.isMetaPressed) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                val edit = selectMarkdownLine(text?.toString().orEmpty(), selectionStart, selectionEnd)
                setSelection(
                    edit.selectionStart.coerceIn(0, edit.text.length),
                    edit.selectionEnd.coerceIn(0, edit.text.length),
                )
            }
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_ENTER && event.isShiftPressed && !event.isCtrlPressed &&
            !event.isAltPressed && !event.isMetaPressed
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                applyLineEdit(insertMarkdownNewlineIndent(text?.toString().orEmpty(), selectionStart, selectionEnd))
            }
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_ENTER && event.isCtrlPressed && !event.isShiftPressed &&
            !event.isAltPressed && !event.isMetaPressed
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                applyLineEdit(insertMarkdownBlankLine(text?.toString().orEmpty(), selectionStart, selectionEnd))
            }
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_K && event.isCtrlPressed && event.isShiftPressed &&
            !event.isAltPressed && !event.isMetaPressed
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                applyLineEdit(deleteMarkdownLines(text?.toString().orEmpty(), selectionStart, selectionEnd))
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
        if (keyCode == KeyEvent.KEYCODE_A && event.isAltPressed && event.isShiftPressed &&
            !event.isCtrlPressed && !event.isMetaPressed
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                applyLineEdit(toggleMarkdownBlockComment(text?.toString().orEmpty(), selectionStart, selectionEnd))
            }
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_D && nextOccurrenceShortcut(
                event.isCtrlPressed,
                event.isShiftPressed,
                event.isAltPressed,
                event.isMetaPressed,
                'd',
            )
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) selectNext()
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
                if (event.action == KeyEvent.ACTION_DOWN) {
                    val start = selectionStart.coerceAtLeast(0)
                    val end = selectionEnd.coerceAtLeast(start)
                    applyLineEdit(applyMarkdownFormat(text?.toString().orEmpty(), start, end, action))
                }
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

    private fun foldKeys(command: String) {
        val offset = selectionEnd.coerceAtLeast(0)
        val next = ch.fasrv.fanotes.desk.headingFoldCommand(foldSource, foldState, command, offset) ?: return
        pendingCursor = ch.fasrv.fanotes.desk.visibleCursorAfterFold(foldSource, foldState, next, offset)
        onEditorFold(command, offset)
    }

    private fun moveToDocumentEdge(forward: Boolean, extend: Boolean) {
        val value = text?.toString().orEmpty()
        val (anchor, head) = ch.fasrv.fanotes.desk.editorDocumentSelection(value, selectionStart, forward, extend)
        val length = value.length
        val nextHead = head.coerceIn(0, length)
        setSelection(anchor.coerceIn(0, length), nextHead)
        val metrics = layout ?: return
        if (metrics.lineCount == 0) return
        val line = metrics.getLineForOffset(nextHead.coerceAtMost(metrics.getLineEnd(metrics.lineCount - 1)))
        scrollTo(scrollX, (metrics.getLineTop(line) - height / 3).coerceAtLeast(0))
    }

    private fun moveByPage(forward: Boolean, extend: Boolean) {
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

    private fun moveByLineBoundary(forward: Boolean, extend: Boolean) {
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

    private fun moveBySyntax(forward: Boolean, extend: Boolean) {
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

    private fun moveByEditorGroup(forward: Boolean, extend: Boolean) {
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

    private fun deleteByEditorGroup(forward: Boolean) {
        val edit = ch.fasrv.fanotes.desk.deleteEditorGroup(
            text?.toString().orEmpty(),
            selectionStart,
            selectionEnd,
            forward,
        )
        if (edit.text == text?.toString()) return
        applyLineEdit(edit)
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
        val cursor = selectionEnd.coerceAtLeast(0)
        writing = true
        setText(edit.text)
        setSelection(edit.selectionStart, edit.selectionEnd)
        writing = false
        editBefore = edit.text
        rememberChange(origin, edit.text, cursor)
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
        if (editable.getSpans(probeStart, probeEnd, LinkSpan::class.java).isNotEmpty()) {
            val link = ch.fasrv.fanotes.desk.followedLinkAt(before, offset)
            if (link != null) {
                onFollowLink(link.target, link.web, link.anchor)
                return true
            }
        }
        val detailsSpans = editable.getSpans(probeStart, probeEnd, DetailsSummarySpan::class.java)
        val details = detailsSpans.isNotEmpty()
        if (details && ch.fasrv.fanotes.desk.detailsTapAction((layout?.width ?: width).toFloat(), x, textSize) == "edit") {
            val block = findDetailsBlocks(before).firstOrNull { offset >= it.from && offset < it.to } ?: return false
            setSelection((block.from + 1).coerceAtMost(before.length))
            return true
        }
        if (details) {
            val layoutX = x - totalPaddingLeft + scrollX
            val layoutY = y - totalPaddingTop + scrollY
            val jump = detailsSpans.firstNotNullOfOrNull { it.footnoteJumpTop(layoutX, layoutY) }
            if (jump != null) {
                scrollTo(scrollX, ch.fasrv.fanotes.desk.revealScrollTop(kotlin.math.round(jump).toInt(), paddingTop))
                return true
            }
            val followed = detailsSpans.firstNotNullOfOrNull { it.linkAt(layoutX, layoutY) }
            if (followed != null) {
                onFollowLink(followed.target, followed.web, followed.anchor)
                return true
            }
        }
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
        val caret = selectionEnd.coerceAtLeast(0)
        writing = true
        setText(next)
        setSelection(start.coerceIn(0, next.length), end.coerceIn(0, next.length))
        writing = false
        rememberChange(before, next, caret)
        paintPreview()
        onVisibleEdit(before, next)
        return true
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w != oldw && paperImages.isNotEmpty()) paintPreview()
    }

    private fun paintPreview() {
        if (painting) return
        val editable = text ?: return
        painting = true
        try {
            val box = paperDetailsBox(textSize)
            val textWidth = layout?.width?.toFloat()
                ?: (width - paddingLeft - paddingRight).toFloat()
            val imageColumn = (textWidth - box.border * 2f - box.padX * 2f).coerceAtLeast(0f)
            applyLivePreview(
                editable,
                selectionStart,
                selectionEnd,
                accent,
                textSize,
                isFocused,
                paperImages,
                imageColumn,
            )
            editable.bindPreviewLinkPointer(linkPointer)
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
        if (layout != null) {
            canvas.drawEditorActiveLine(
                layout,
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
        spelling.draw(canvas)
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
