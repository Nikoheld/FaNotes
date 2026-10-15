package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import ch.fasrv.fanotes.desk.activeLineArgb
import ch.fasrv.fanotes.desk.activeLineHead

/** Paint the desktop active-line band behind the caret's visual line. */
internal fun Canvas.drawEditorActiveLine(
    layout: Layout,
    textLength: Int,
    selectionEnd: Int,
    paint: Paint,
    scrollY: Int,
    paddingLeft: Int,
    paddingTop: Int,
    paddingRight: Int,
    viewWidth: Int,
    viewHeight: Int,
) {
    if (layout.lineCount <= 0) return
    val right = viewWidth - paddingRight
    if (right <= paddingLeft) return
    val layoutLength = layout.text?.length ?: textLength
    val head = activeLineHead(selectionEnd, textLength).coerceAtMost(layoutLength.coerceAtLeast(0))
    val line = layout.getLineForOffset(head).coerceIn(0, layout.lineCount - 1)
    val top = paddingTop + layout.getLineTop(line) - scrollY
    val bottom = paddingTop + layout.getLineBottom(line) - scrollY
    if (bottom <= 0 || top >= viewHeight) return
    paint.color = activeLineArgb()
    drawRect(paddingLeft.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
}
