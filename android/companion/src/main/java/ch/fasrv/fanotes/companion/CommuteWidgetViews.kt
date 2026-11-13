package ch.fasrv.fanotes.companion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import ch.fasrv.fanotes.commute.*
import ch.fasrv.fanotes.schulnetz.WidgetSpan
import ch.fasrv.fanotes.schulnetz.linkedChange

/** What the commute widget has to say. */
internal sealed interface CommuteWidgetContent {
    /** The routes (or the first board of a route) have not been read yet. */
    data class Loading(val route: Route? = null) : CommuteWidgetContent
    data object NoRoute : CommuteWidgetContent
    /** The board is there but offers no trip. */
    data class NoConnection(val route: Route, val stale: String) : CommuteWidgetContent
    data class Trips(
        val route: Route,
        val board: RouteBoard,
        val rows: List<CommuteRow>,
        /** Minutes until the first usable trip leaves; null when unknown or none. */
        val minutes: Int?,
        /** Pinned-route remark, empty for an ordinary route. */
        val pinNote: String,
        /** "As of 07:02" or "Offline" when the data is old; empty when fresh. */
        val stale: String,
        val target: String,
        /** The trip a tap opens. */
        val shown: Trip?,
    ) : CommuteWidgetContent
}

internal fun commuteContent(ui: CommuteUi, route: Route?, board: RouteBoard?, now: Long): CommuteWidgetContent {
    if (!ui.loaded) return CommuteWidgetContent.Loading()
    if (ui.routes.isEmpty()) return CommuteWidgetContent.NoRoute
    if (route == null || board == null) return CommuteWidgetContent.Loading(ui.routes.firstOrNull())
    val stale = board.stale || ui.boardAt == 0L || now - ui.boardAt > 15 * 60_000L
    val staleNote = if (!stale) "" else if (ui.boardAt > 0) t(R.string.commute_stale_since, clockOf(ui.boardAt)) else t(R.string.commute_widget_offline)
    val rows = commuteRows(board)
    val first = board.headTrip()
    if (first == null || rows.isEmpty()) return CommuteWidgetContent.NoConnection(route, staleNote)
    val focus = boardFocus(board)
    val minutes = first.takeIf { !it.unusable }?.let { minutesUntil(it.departure.ifBlank { it.plannedDeparture }, now) }
    // A pinned route says what is wrong with its connection; the rows show the pinned trip only.
    val pinNote = when (focus.kind) {
        FocusKind.MISSING -> t(R.string.commute_widget_pin_missing)
        FocusKind.UNUSABLE -> if (board.pinned?.status == PinStatus.GONE) t(R.string.commute_pin_gone_title) else t(R.string.commute_trip_cancelled)
        FocusKind.MOVED -> t(R.string.commute_pin_moved, focus.movedClock)
        else -> ""
    }
    return CommuteWidgetContent.Trips(route, board, rows, minutes, pinNote, staleNote, commuteTargetText(board.target), focus.main ?: first)
}

/** The three layouts with a list: compact rows from [COMMUTE_MEDIUM_WIDTH], wide rows from [COMMUTE_LARGE_WIDTH], wide rows with occupancy from [COMMUTE_XL_WIDTH]. */
private const val COMMUTE_MEDIUM_WIDTH = 180f
private const val COMMUTE_LARGE_WIDTH = 240f
private const val COMMUTE_XL_WIDTH = 300f
private const val COMMUTE_MAX_ROWS = 4

/** How a list layout draws its rows. */
internal enum class CommuteRowStyle(val width: Float, val span: WidgetSpan, val wide: Boolean, val arrival: Boolean, val occupancy: Boolean) {
    COMPACT(COMMUTE_MEDIUM_WIDTH, WidgetSpan.MEDIUM, false, false, false),
    WIDE(COMMUTE_LARGE_WIDTH, WidgetSpan.LARGE, true, false, false),
    FULL(COMMUTE_XL_WIDTH, WidgetSpan.LARGE, true, true, true),
}

/** Dp heights of the commute header and rows at font scale [s]; worst case of each layout plus slack. */
private fun commuteHeaderDp(style: CommuteRowStyle, s: Float, detail: Boolean): Float =
    (if (style == CommuteRowStyle.COMPACT) 24f else 28f) + WidgetMetrics.line(13f, s) + WidgetMetrics.line(17f, s) + 2f + (if (detail) WidgetMetrics.line(12f, s) + 2f else 0f) + 2f

private fun commuteRowDp(style: CommuteRowStyle, s: Float): Float =
    if (style.wide) 10f + WidgetMetrics.line(16f, s) + WidgetMetrics.line(11f, s) + 2f else 13f + WidgetMetrics.line(15f, s) + WidgetMetrics.line(11f, s) + 2f

/**
 * Every layout of the commute widget. The small one shows the first trip only. The list layouts show whole rows:
 * from one row up, where the header drops its detail line when only one row fits.
 */
internal fun commuteWidgetVariants(context: Context, widgetId: Int, content: CommuteWidgetContent): List<WidgetVariant> {
    val s = WidgetMetrics.scale(context)
    val variants = mutableListOf(WidgetVariant(SizeF(110f, 72f), 0) { commuteWidgetViews(context, widgetId, WidgetSpan.SMALL, content, CommuteRowStyle.COMPACT, 0) })
    val trips = content as? CommuteWidgetContent.Trips
    if (trips == null) {
        variants += WidgetVariant(SizeF(WidgetMetrics.width(COMMUTE_MEDIUM_WIDTH, s), Math.ceil(commuteHeaderDp(CommuteRowStyle.COMPACT, s, true).toDouble()).toFloat()), 0) {
            commuteWidgetViews(context, widgetId, WidgetSpan.MEDIUM, content, CommuteRowStyle.COMPACT, 0)
        }
        return variants
    }
    for (style in CommuteRowStyle.values()) for (n in 1..minOf(trips.rows.size, COMMUTE_MAX_ROWS)) {
        val detail = n >= 2
        val height = commuteHeaderDp(style, s, detail) + 6f + n * commuteRowDp(style, s)
        variants += WidgetVariant(SizeF(WidgetMetrics.width(style.width, s), Math.ceil(height.toDouble()).toFloat()), n) { commuteWidgetViews(context, widgetId, style.span, content, style, n) }
    }
    return variants
}

/** The commute widget for one layout. [rows] whole trip rows are drawn under the header of the list layouts. */
internal fun commuteWidgetViews(context: Context, widgetId: Int, span: WidgetSpan, content: CommuteWidgetContent, style: CommuteRowStyle, rows: Int): RemoteViews {
    val layout = when (span) {
        WidgetSpan.SMALL -> R.layout.widget_commute_small
        WidgetSpan.MEDIUM -> R.layout.widget_commute_medium
        WidgetSpan.LARGE -> R.layout.widget_commute_large
    }
    val views = RemoteViews(context.packageName, layout)
    val small = span == WidgetSpan.SMALL
    val title: String
    val body: String
    var stale = ""
    var description: String
    when (content) {
        is CommuteWidgetContent.NoRoute -> { title = t(R.string.commute_widget_empty_title); body = t(R.string.commute_widget_empty_body); description = "$title. $body" }
        is CommuteWidgetContent.Loading -> {
            title = content.route?.let(::routeTitle) ?: t(R.string.commute_widget_loading_title)
            body = t(R.string.commute_widget_loading_body); description = "$title. $body"
        }
        is CommuteWidgetContent.NoConnection -> { title = routeTitle(content.route); body = t(R.string.commute_no_connection); stale = content.stale; description = "$title. $body" }
        is CommuteWidgetContent.Trips -> { title = routeTitle(content.route); body = ""; stale = content.stale; description = "" }
    }
    val trips = content as? CommuteWidgetContent.Trips
    val hero = trips?.rows?.firstOrNull()
    if (small) {
        if (hero != null && trips != null) {
            val unusable = hero.unusable()
            views.setTextViewText(R.id.widget_dep, if (unusable) struck(hero.departClock) else hero.departClock)
            views.setTextViewTextSize(R.id.widget_dep, android.util.TypedValue.COMPLEX_UNIT_SP, 18f)
            // The time itself carries the tone, so a delay shows even when the box is too narrow for its text.
            val tone = delayTone(hero)
            views.setTextColor(R.id.widget_dep, context.getColor(if (unusable) R.color.widget_muted else if (tone == WidgetTone.SUCCESS || tone == WidgetTone.NEUTRAL) R.color.widget_text else tone.ink))
            // Line 1: the time and its delay (or, when the data is old, that). Line 2: the line badge and the countdown (or why the trip does not run).
            val delay = if (unusable || hero.delayClass == DelayClass.ON_TIME) "" else commuteDelayText(hero)
            views.setTextViewText(R.id.widget_hero_delay, delay.ifBlank { stale })
            views.setTextColor(R.id.widget_hero_delay, context.getColor(if (delay.isBlank()) R.color.widget_warning else delayTone(hero).ink))
            bindLineChip(context, views, R.id.widget_hero_line, hero.line, hero.lineBg, hero.lineFg)
            views.setTextViewText(R.id.widget_detail, if (unusable) commuteStatusText(hero) else commuteInText(trips.minutes))
            views.setTextColor(R.id.widget_detail, context.getColor(if (unusable) R.color.widget_alert else R.color.widget_accent))
        } else {
            // An empty state in a small box: the message in place of the time, the hint under it.
            views.setTextViewText(R.id.widget_dep, title)
            views.setTextViewTextSize(R.id.widget_dep, android.util.TypedValue.COMPLEX_UNIT_SP, 15f)
            views.setTextColor(R.id.widget_dep, context.getColor(R.color.widget_text))
            views.setViewVisibility(R.id.widget_hero_line, View.GONE)
            views.setTextViewText(R.id.widget_hero_delay, "")
            views.setTextViewText(R.id.widget_detail, listOf(body, stale).filter { it.isNotBlank() }.joinToString(" · "))
            views.setTextColor(R.id.widget_detail, context.getColor(R.color.widget_muted))
        }
    } else {
        val detail = if (trips != null) {
            // With a single row the header keeps its two lines so that row fits whole.
            if (rows < 2) "" else listOf(trips.pinNote, commuteInText(trips.minutes), if (style == CommuteRowStyle.COMPACT) trips.rows.firstOrNull()?.let { commuteTransfersText(it.transfers) }.orEmpty() else "", if (span == WidgetSpan.LARGE) trips.target else "").filter { it.isNotBlank() }.joinToString(" · ")
        } else body
        views.setTextViewText(R.id.widget_kicker, t(R.string.commute_widget_kicker))
        views.setTextViewText(R.id.widget_title, title)
        views.setTextOrGone(R.id.widget_detail, detail)
        views.setPill(context, R.id.widget_state, stale, WidgetTone.WARNING)
        views.removeAllViews(R.id.widget_rows)
        views.setViewVisibility(R.id.widget_rows, if (rows == 0 || trips == null) View.GONE else View.VISIBLE)
        trips?.rows?.take(rows)?.forEachIndexed { index, row ->
            views.addView(R.id.widget_rows, commuteRowViews(context, row, style.wide, trips.route.id, style.arrival, style.occupancy, 200 + index))
        }
    }
    if (trips != null && hero != null) {
        description = listOf(
            t(R.string.commute_widget_kicker), title, hero.departClock, hero.line, commuteDelayText(hero), commuteStatusText(hero),
            if (hero.platform.isBlank()) "" else t(R.string.commute_platform_short, hero.platform), commuteTransfersText(hero.transfers), commuteInText(trips.minutes), stale,
        ).filter { it.isNotBlank() }.joinToString(", ")
    }
    views.setContentDescription(R.id.widget_header, description)
    views.setOnClickPendingIntent(R.id.widget_header, PendingIntent.getActivity(context, 11, commuteWidgetTarget(context, content), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    return views
}

/**
 * Where a tap on the header goes: the trip the first row shows (its detail falls back to the route's list when it is gone),
 * the route's list while waiting for its first board, and the commute screen when there is no route yet.
 */
internal fun commuteWidgetTarget(context: Context, content: CommuteWidgetContent): Intent = when (content) {
    is CommuteWidgetContent.Trips -> CommuteWidget.commuteOpenIntent(context, content.route.id, content.shown?.id.orEmpty(), content.shown?.plannedDeparture.orEmpty())
    is CommuteWidgetContent.NoConnection -> CommuteWidget.commuteOpenIntent(context, content.route.id, "", "")
    is CommuteWidgetContent.Loading -> content.route?.let { CommuteWidget.commuteOpenIntent(context, it.id, "", "") } ?: commuteListIntent(context)
    CommuteWidgetContent.NoRoute -> commuteListIntent(context)
}

/** Opens the commute screen with all routes. */
internal fun commuteListIntent(context: Context): Intent =
    CompanionAlerts.notifyIntent(context, linkedChange("widget-commute", "commute", "", "", ""))
