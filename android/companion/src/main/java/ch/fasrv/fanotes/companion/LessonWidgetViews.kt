package ch.fasrv.fanotes.companion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.text.SpannableString
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.StrikethroughSpan
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.WidgetRow
import ch.fasrv.fanotes.schulnetz.WidgetSpan
import ch.fasrv.fanotes.schulnetz.eventDate
import ch.fasrv.fanotes.schulnetz.isAddedLesson
import ch.fasrv.fanotes.schulnetz.isChangedLesson
import ch.fasrv.fanotes.schulnetz.isMovedLesson
import ch.fasrv.fanotes.schulnetz.lessonTargetId
import ch.fasrv.fanotes.schulnetz.linkedChange
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** What the "next lesson" widget has to say. Empty states are first-class so each gets a clear message and its own tap target. */
internal sealed interface LessonWidgetContent {
    /** No timetable on the phone at all: not signed in, or nothing read yet. */
    data object SignedOut : LessonWidgetContent
    /** A signed-in timetable whose coming weeks have not been read yet. */
    data object NotLoaded : LessonWidgetContent
    data class Holidays(val name: String, val until: LocalDate?) : LessonWidgetContent
    /** Nothing is left today and nothing is planned ahead. */
    data object NothingAhead : LessonWidgetContent
    data class Next(val row: WidgetRow) : LessonWidgetContent
}

/** Picks the state from the cached snapshot and the rows the widget list shows. Pure, so tests can drive every state. */
internal fun lessonWidgetContent(snapshot: SchulnetzSnapshot?, rows: List<WidgetRow>, today: LocalDate): LessonWidgetContent {
    if (snapshot == null) return LessonWidgetContent.SignedOut
    val next = rows.firstOrNull { !it.heading && !it.cancelled }
    if (next != null && next.day == today) return LessonWidgetContent.Next(next)
    val vacation = snapshot.vacations.firstOrNull { v ->
        val start = eventDate(v.start) ?: return@firstOrNull false
        val end = eventDate(v.end) ?: start
        !today.isBefore(start) && !today.isAfter(end)
    }
    if (vacation != null) return LessonWidgetContent.Holidays(vacation.name, eventDate(vacation.end))
    if (next != null) return LessonWidgetContent.Next(next)
    return if (ch.fasrv.fanotes.schulnetz.upcomingTimetableUnread(snapshot, today)) LessonWidgetContent.NotLoaded else LessonWidgetContent.NothingAhead
}

/** State label of a lesson row or hero: cancelled, exam, substitution, moved, added or changed. Null for a plain lesson. */
internal fun lessonState(row: WidgetRow): Pair<String, WidgetTone>? = when {
    row.cancelled -> t(R.string.cancelled) to WidgetTone.DANGER
    row.exam -> t(R.string.exam) to WidgetTone.ACCENT
    row.substitution -> t(R.string.substitution) to WidgetTone.WARNING
    row.event?.isMovedLesson() == true -> t(R.string.lesson_moved) to WidgetTone.WARNING
    row.event?.isAddedLesson() == true -> t(R.string.lesson_added) to WidgetTone.ACCENT
    row.event?.isChangedLesson() == true -> t(R.string.lesson_changed) to WidgetTone.WARNING
    else -> null
}

private fun dayLabel(day: LocalDate, today: LocalDate): String =
    if (day == today.plusDays(1)) t(R.string.tomorrow) else day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault())

/** Rows the lesson widget lists under the header: the lessons after the shown one (all of them for holidays), none for the other states. */
internal fun lessonListRows(content: LessonWidgetContent, rows: List<WidgetRow>): List<WidgetRow> {
    val list = when (content) {
        is LessonWidgetContent.Next -> rows.dropWhile { it !== content.row }.drop(1)
        is LessonWidgetContent.Holidays -> rows
        else -> emptyList()
    }
    // A day heading is never the last thing shown.
    return list.dropLastWhile { it.heading }
}

private const val LESSON_MAX_ROWS = 6
private const val LESSON_MEDIUM_WIDTH = 180f
private const val LESSON_LARGE_WIDTH = 250f

/** Heights in dp of the pieces of the lesson widget, at font scale [s]. Each is the worst case of its layout, with a little slack. */
private fun lessonHeaderDp(span: WidgetSpan, s: Float): Float = when (span) {
    // padding 12+12, kicker row (pill is the taller one), title, detail, paddings
    WidgetSpan.MEDIUM -> 24f + WidgetMetrics.line(13f, s) + WidgetMetrics.line(17f, s) + WidgetMetrics.line(13f, s) + 4f + 2f
    else -> 32f + WidgetMetrics.line(13f, s) + WidgetMetrics.line(20f, s) + WidgetMetrics.line(14f, s) + 4f + 2f
}

private fun lessonRowDp(row: WidgetRow, s: Float): Float =
    if (row.heading) 16f + WidgetMetrics.line(12f, s) + 2f else 12f + WidgetMetrics.line(14f, s) + WidgetMetrics.line(12f, s) + 2f

/**
 * Every layout of the lesson widget: the small one-line header, then the medium and large headers with
 * zero to [LESSON_MAX_ROWS] whole rows of the following lessons. Each box height is header plus those rows.
 */
internal fun lessonWidgetVariants(context: Context, widgetId: Int, content: LessonWidgetContent, rows: List<WidgetRow>, today: LocalDate): List<WidgetVariant> {
    val s = WidgetMetrics.scale(context)
    val list = lessonListRows(content, rows)
    val variants = mutableListOf(WidgetVariant(SizeF(110f, 56f), 0) { lessonWidgetViews(context, widgetId, WidgetSpan.SMALL, content, emptyList(), today) })
    for ((span, width) in listOf(WidgetSpan.MEDIUM to LESSON_MEDIUM_WIDTH, WidgetSpan.LARGE to LESSON_LARGE_WIDTH)) {
        var height = lessonHeaderDp(span, s) + if (span == WidgetSpan.LARGE) 0f else 0f
        for (n in 0..minOf(list.size, LESSON_MAX_ROWS)) {
            if (n > 0) height += lessonRowDp(list[n - 1], s) + if (n == 1) (if (span == WidgetSpan.LARGE) 8f else 6f) else 0f
            if (n == 0 && span == WidgetSpan.LARGE) continue
            if (n > 0 && list[n - 1].heading) continue
            val shown = list.take(n)
            variants += WidgetVariant(SizeF(WidgetMetrics.width(width, s), Math.ceil(height.toDouble()).toFloat()), n) { lessonWidgetViews(context, widgetId, span, content, shown, today) }
        }
    }
    return variants
}

/** The widget for one layout. [shown] are the following lessons drawn as whole rows below the header. */
internal fun lessonWidgetViews(
    context: Context,
    widgetId: Int,
    span: WidgetSpan,
    content: LessonWidgetContent,
    shown: List<WidgetRow>,
    today: LocalDate,
): RemoteViews {
    val layout = when (span) {
        WidgetSpan.SMALL -> R.layout.widget_next_lesson_small
        WidgetSpan.MEDIUM -> R.layout.widget_next_lesson_medium
        WidgetSpan.LARGE -> R.layout.widget_next_lesson_large
    }
    val views = RemoteViews(context.packageName, layout)
    var kicker = t(R.string.widget_kicker)
    var title: String
    var detail = ""
    var state: Pair<String, WidgetTone>? = null
    var description: String
    when (content) {
        is LessonWidgetContent.Next -> {
            val row = content.row
            title = row.title
            detail = listOf(row.clock, row.room.takeIf { it.isNotBlank() }?.let { t(R.string.room_named, it) }.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ")
            state = lessonState(row)
            if (row.nextDay) kicker = dayLabel(row.day, today)
            description = listOf(kicker, title, detail, state?.first.orEmpty()).filter { it.isNotBlank() }.joinToString(", ")
        }
        LessonWidgetContent.SignedOut -> { title = t(R.string.phrase_not_signed_in_short); detail = t(R.string.widget_signed_out_body); description = "$title. $detail" }
        LessonWidgetContent.NotLoaded -> { title = t(R.string.timetable_not_loaded); detail = t(R.string.widget_open_to_load); description = "$title. $detail" }
        is LessonWidgetContent.Holidays -> {
            title = content.name.ifBlank { t(R.string.holidays) }
            detail = content.until?.let { t(R.string.widget_holidays_until, it.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()))) }.orEmpty()
            description = listOf(title, detail).filter { it.isNotBlank() }.joinToString(". ")
        }
        LessonWidgetContent.NothingAhead -> { title = t(R.string.widget_no_lessons_today); detail = t(R.string.widget_nothing_ahead); description = "$title. $detail" }
    }
    views.setTextViewText(R.id.widget_kicker, kicker)
    views.setTextViewText(R.id.widget_title, title)
    views.setTextOrGone(R.id.widget_detail, detail)
    if (span == WidgetSpan.SMALL) {
        // No room for a pill: the state leads the detail line, in its own tone, so an ellipsis cuts the times first.
        views.setTextOrGone(R.id.widget_detail, listOf(state?.first.orEmpty(), detail).filter { it.isNotBlank() }.joinToString(" · "))
        views.setTextColor(R.id.widget_detail, context.getColor(state?.second?.ink ?: R.color.widget_muted))
    } else {
        views.setPill(context, R.id.widget_state, state?.first.orEmpty(), state?.second ?: WidgetTone.ACCENT)
        views.setContentDescription(R.id.widget_header, description)
        views.removeAllViews(R.id.widget_rows)
        views.setViewVisibility(R.id.widget_rows, if (shown.isEmpty()) View.GONE else View.VISIBLE)
        shown.forEachIndexed { index, row ->
            views.addView(R.id.widget_rows, if (row.heading) lessonHeadingViews(context, row, today) else lessonRowViews(context, row, 100 + index))
        }
    }
    if (span == WidgetSpan.SMALL) views.setContentDescription(R.id.widget_header, description)
    views.setOnClickPendingIntent(R.id.widget_header, PendingIntent.getActivity(context, 1, lessonWidgetTarget(context, content, today), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    return views
}

/** Where a tap on the header goes: the lesson itself, the timetable when there is nothing to show, the app (and its sign-in) when signed out. */
internal fun lessonWidgetTarget(context: Context, content: LessonWidgetContent, today: LocalDate): Intent = when (content) {
    is LessonWidgetContent.Next -> content.row.event?.let {
        CompanionAlerts.notifyIntent(context, linkedChange("widget-next", "timetable", "", "", lessonTargetId(it), date = ch.fasrv.fanotes.schulnetz.eventDay(it)))
    } ?: Intent(context, MainActivity::class.java)
    LessonWidgetContent.SignedOut -> Intent(context, MainActivity::class.java)
    else -> CompanionAlerts.notifyIntent(context, linkedChange("widget-empty", "timetable", "", "", "", date = today.toString()))
}

/** One lesson of the list: start over end time, title over room, and a pill for cancelled, exam or changed lessons. */
internal fun lessonRowViews(context: Context, row: WidgetRow, requestCode: Int = 100): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.widget_row_lesson)
    val muted = context.getColor(R.color.widget_muted)
    val parts = row.clock.split('–', '-').map { it.trim() }.filter { it.isNotBlank() }
    views.setTextViewText(R.id.row_time, parts.firstOrNull() ?: "–")
    views.setTextOrGone(R.id.row_time_end, parts.getOrNull(1).orEmpty())
    views.setTextViewText(R.id.row_title, if (row.cancelled) struck(row.title) else row.title)
    views.setTextColor(R.id.row_title, context.getColor(if (row.cancelled) R.color.widget_muted else R.color.widget_text))
    views.setTextColor(R.id.row_time, if (row.cancelled) muted else context.getColor(R.color.widget_accent))
    // The state leads the detail line in its tone (cancelled, exam, substitution...), so an ellipsis only ever cuts the room.
    val state = lessonState(row)
    val detail = SpannableStringBuilder()
    if (state != null) {
        detail.append(state.first)
        detail.setSpan(ForegroundColorSpan(context.getColor(state.second.ink)), 0, detail.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        detail.setSpan(StyleSpan(Typeface.BOLD), 0, detail.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (row.room.isNotBlank()) detail.append(if (detail.isEmpty()) "" else " · ").append(row.room)
    views.setTextOrGone(R.id.row_detail, detail)
    val event = row.event
    val target = if (event == null) Intent(context, MainActivity::class.java) else CompanionAlerts.notifyIntent(context,
        linkedChange("widget-row", "timetable", "", "", lessonTargetId(event), date = ch.fasrv.fanotes.schulnetz.eventDay(event)))
    // One request code per row: intents that differ only in their extras would otherwise share a PendingIntent.
    views.setOnClickPendingIntent(R.id.row_root, PendingIntent.getActivity(context, requestCode, target, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    return views
}

/** The day heading between today's lessons and the next school day's. */
internal fun lessonHeadingViews(context: Context, row: WidgetRow, today: LocalDate): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.widget_row_heading)
    views.setTextViewText(R.id.row_heading, dayLabel(row.day, today))
    return views
}
