package ch.fasrv.fanotes

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.Spanned
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ListView
import android.widget.PopupWindow
import android.widget.TextView
import ch.fasrv.fanotes.desk.HtmlTagCompletion
import ch.fasrv.fanotes.desk.htmlTagCompletion

/**
 * The desktop HTML-tag list that opens after `<`. Enter inserts the highlighted
 * tag, Escape closes the list, and the arrow keys move through it.
 */
class HtmlTagAssist(
    private val editor: EditText,
    private val runWriting: (() -> Unit) -> Unit,
) {
    private var completion: HtmlTagCompletion? = null
    private var selected = 0
    private val rows = ListView(editor.context)
    private val popup: PopupWindow

    init {
        val density = editor.resources.displayMetrics.density
        rows.divider = null
        rows.setBackgroundColor(Color.TRANSPARENT)
        rows.setOnItemClickListener { _, _, position, _ ->
            selected = position
            accept()
        }
        val shape = GradientDrawable().apply {
            setColor(0xFFFFFFFF.toInt())
            cornerRadius = 9f * density
            setStroke(density.toInt().coerceAtLeast(1), 0x33232633)
        }
        popup = PopupWindow(rows, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, false)
        popup.setBackgroundDrawable(shape)
        popup.isTouchable = true
        popup.isOutsideTouchable = false
        popup.elevation = 8f * density
    }

    fun onUserEdit() {
        if (!editor.isFocused || composing() || editor.selectionStart != editor.selectionEnd) {
            hide()
            return
        }
        val next = htmlTagCompletion(editor.text?.toString().orEmpty(), editor.selectionEnd)
        if (next == null) hide() else show(next)
    }

    fun onCaretMoved() {
        if (popup.isShowing) onUserEdit()
    }

    fun hide() {
        completion = null
        if (popup.isShowing) popup.dismiss()
    }

    fun onKey(keyCode: Int, event: KeyEvent): Boolean {
        if (!popup.isShowing) return false
        if (event.isCtrlPressed || event.isAltPressed || event.isMetaPressed) return false
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN && !event.isShiftPressed) move(1)
                return !event.isShiftPressed
            }
            KeyEvent.KEYCODE_DPAD_UP -> {
                if (event.action == KeyEvent.ACTION_DOWN && !event.isShiftPressed) move(-1)
                return !event.isShiftPressed
            }
            KeyEvent.KEYCODE_PAGE_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN) move(PAGE)
                return true
            }
            KeyEvent.KEYCODE_PAGE_UP -> {
                if (event.action == KeyEvent.ACTION_DOWN) move(-PAGE)
                return true
            }
            KeyEvent.KEYCODE_ENTER -> {
                if (event.isShiftPressed) return false
                if (event.action == KeyEvent.ACTION_DOWN) accept()
                return true
            }
            KeyEvent.KEYCODE_ESCAPE -> {
                if (event.action == KeyEvent.ACTION_DOWN) hide()
                return true
            }
        }
        return false
    }

    private fun move(delta: Int) {
        val options = completion?.options ?: return
        if (options.isEmpty()) return
        selected = (selected + delta).coerceIn(0, options.lastIndex)
        rows.invalidateViews()
        rows.setSelection(selected)
    }

    private fun accept() {
        val current = completion ?: return
        val label = current.options.getOrNull(selected) ?: return
        val insert = current.inserts.getOrNull(selected) ?: label
        val cursor = editor.selectionEnd.coerceIn(0, editor.length())
        val from = current.from.coerceIn(0, cursor)
        hide()
        runWriting {
            editor.text?.replace(from, cursor, insert)
            val caret = (from + insert.length).coerceAtMost(editor.text?.length ?: 0)
            editor.setSelection(caret)
        }
    }

    private fun show(next: HtmlTagCompletion) {
        if (completion?.options != next.options) selected = 0
        completion = next
        selected = selected.coerceIn(0, next.options.lastIndex)
        rows.adapter = object : BaseAdapter() {
            override fun getCount() = next.options.size
            override fun getItem(position: Int) = next.options[position]
            override fun getItemId(position: Int) = position.toLong()
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val view = (convertView as? TextView) ?: TextView(editor.context).apply {
                    val density = resources.displayMetrics.density
                    setPadding((10 * density).toInt(), (6 * density).toInt(), (10 * density).toInt(), (6 * density).toInt())
                    textSize = 13f
                }
                view.text = next.options[position]
                val chosen = position == selected
                view.setTextColor(if (chosen) 0xFFFFFFFF.toInt() else 0xFF252630.toInt())
                view.setBackgroundColor(if (chosen) 0xFF1177CC.toInt() else Color.TRANSPARENT)
                return view
            }
        }
        val density = editor.resources.displayMetrics.density
        val row = (32 * density).toInt()
        popup.height = row * next.options.size.coerceAtMost(PAGE)
        val longest = next.options.maxOf { it.length }
        popup.width = ((longest.coerceIn(16, 42) * 7.2f + 24f) * density).toInt()
        if (!popup.isShowing) popup.showAtLocation(editor, Gravity.NO_GRAVITY, 0, 0)
        place()
        rows.setSelection(selected)
    }

    private fun place() {
        val layout = editor.layout ?: return
        val cursor = editor.selectionEnd.coerceIn(0, layout.text.length)
        val line = layout.getLineForOffset(cursor)
        val origin = IntArray(2)
        editor.getLocationOnScreen(origin)
        val x = origin[0] + editor.paddingLeft + layout.getPrimaryHorizontal(cursor).toInt() - editor.scrollX
        var y = origin[1] + editor.paddingTop + layout.getLineBottom(line) - editor.scrollY
        val screen = editor.resources.displayMetrics.heightPixels
        if (y + popup.height > screen - 8) {
            y = origin[1] + editor.paddingTop + layout.getLineTop(line) - editor.scrollY - popup.height
        }
        popup.update(x.coerceAtLeast(0), y.coerceAtLeast(0), popup.width, popup.height)
    }

    private fun composing(): Boolean {
        val text = editor.text ?: return false
        for (span in text.getSpans(0, text.length, Any::class.java)) {
            if (text.getSpanFlags(span) and Spanned.SPAN_COMPOSING != 0) return true
        }
        return false
    }

    private companion object {
        const val PAGE = 8
    }
}
