package ch.fasrv.fanotes.companion

import android.content.Context
import android.content.Intent
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StrikethroughSpan
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import ch.fasrv.fanotes.schulnetz.isAddedLesson
import ch.fasrv.fanotes.schulnetz.isChangedLesson
import ch.fasrv.fanotes.schulnetz.isMovedLesson
import ch.fasrv.fanotes.schulnetz.WidgetRow
import ch.fasrv.fanotes.schulnetz.lessonTargetId
import ch.fasrv.fanotes.schulnetz.linkedChange
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/** Feeds the scrolling lesson list of the home-screen widget: what is left today, then the next school day. */
class NextLessonWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)

    private class Factory(private val context: Context) : RemoteViewsFactory {
        private var rows: List<WidgetRow> = emptyList()
        private val zone: ZoneId get() = ZoneId.systemDefault()

        override fun onCreate() {}

        override fun onDataSetChanged() {
            rows = NextLessonWidget.rowsFor(NextLessonWidget.loadData(context), zone)
        }

        override fun onDestroy() {
            rows = emptyList()
        }

        override fun getCount(): Int = rows.size

        override fun getViewTypeCount(): Int = 2

        override fun hasStableIds(): Boolean = false

        override fun getItemId(position: Int): Long = position.toLong()

        override fun getLoadingView(): RemoteViews? = null

        override fun getViewAt(position: Int): RemoteViews {
            val row = rows.getOrNull(position) ?: return RemoteViews(context.packageName, R.layout.widget_row_heading)
            if (row.heading) return headingView(row)
            val views = RemoteViews(context.packageName, R.layout.widget_row_lesson)
            val muted = context.getColor(R.color.widget_muted)
            val alert = context.getColor(R.color.widget_alert)
            val accent = context.getColor(R.color.widget_accent)
            val state = when {
                row.cancelled -> t(R.string.cancelled)
                row.exam -> t(R.string.exam)
                row.substitution -> t(R.string.substitution)
                row.event?.isMovedLesson() == true -> t(R.string.lesson_moved)
                row.event?.isAddedLesson() == true -> t(R.string.lesson_added)
                row.event?.isChangedLesson() == true -> t(R.string.lesson_changed)
                else -> ""
            }
            val markerColor = when {
                row.cancelled -> alert
                row.exam -> accent
                row.substitution -> accent
                state.isNotBlank() -> accent
                else -> muted
            }
            views.setTextViewText(R.id.row_time, row.clock.ifBlank { "–" })
            views.setTextViewText(R.id.row_title, if (row.cancelled) struck(row.title) else row.title)
            val detail = listOf(row.room.takeIf { it.isNotBlank() }, state.takeIf { it.isNotBlank() }).filterNotNull().joinToString(" · ")
            views.setTextViewText(R.id.row_detail, detail)
            views.setTextColor(R.id.row_detail, if (state.isNotBlank()) markerColor else muted)
            val event = row.event
            val target = if (event == null) Intent() else CompanionAlerts.notifyIntent(context,
                linkedChange("widget-row", "timetable", "", "", lessonTargetId(event), date = ch.fasrv.fanotes.schulnetz.eventDay(event)))
            views.setOnClickFillInIntent(R.id.row_title, target)
            views.setOnClickFillInIntent(R.id.row_time, target)
            views.setOnClickFillInIntent(R.id.row_detail, target)
            return views
        }

        private fun headingView(row: WidgetRow): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_row_heading)
            val today = LocalDate.now(zone)
            val text = if (row.day == today.plusDays(1)) t(R.string.tomorrow)
                else row.day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault())
            views.setTextViewText(R.id.row_heading, text)
            views.setOnClickFillInIntent(R.id.row_heading, Intent())
            return views
        }

        private fun struck(text: String): CharSequence =
            SpannableString(text).also { it.setSpan(StrikethroughSpan(), 0, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
    }
}
