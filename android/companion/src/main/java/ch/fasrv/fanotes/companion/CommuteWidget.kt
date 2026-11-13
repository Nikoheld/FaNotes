package ch.fasrv.fanotes.companion

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StrikethroughSpan
import android.view.View
import android.widget.RemoteViews
import ch.fasrv.fanotes.commute.*
import ch.fasrv.fanotes.schulnetz.linkedChange
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.util.concurrent.Executors

/**
 * Home-screen widget "Pendeln": the next trips of the route that matters now, as the rows that fit.
 * It reads the files CommuteStore keeps, so drawing never waits for the network. Fresh data arrives
 * with the app's own board refresh, with the commute push, and with the widget's own update at most
 * every 30 minutes (updatePeriodMillis). All work runs off the main thread.
 */
class CommuteWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        async { refreshThenRender(context, manager, ids) }
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        async { render(context, manager, intArrayOf(id)) }
    }

    private fun async(block: () -> Unit) {
        val pending = goAsync()
        worker.execute { try { block() } finally { pending.finish() } }
    }

    companion object {
        private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "commute-widget").apply { isDaemon = true } }

        /** Redraws every placed widget from the saved answers. Cheap when none is placed. Callable from any thread. */
        fun update(context: Context) {
            val app = context.applicationContext
            val manager = AppWidgetManager.getInstance(app)
            val ids = manager.getAppWidgetIds(ComponentName(app, CommuteWidget::class.java))
            if (ids.isEmpty()) return
            worker.execute { runCatching { render(app, manager, ids) } }
        }

        /** The periodic update: ask the server when the saved boards are older than five minutes, then draw. */
        private fun refreshThenRender(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val app = context.applicationContext as? CompanionApplication
            if (app != null && !app.graph.demoActive()) runCatching {
                runBlocking {
                    withTimeoutOrNull(10_000) {
                        app.graph.awaitBoot()
                        app.graph.commute.loadCache()
                        if (app.graph.commute.state.value.routes.isNotEmpty()) app.graph.commute.refresh(maxAgeSeconds = 300)
                    }
                }
            }
            render(context, manager, ids)
        }

        internal fun loadCache(context: Context): CommuteUi =
            CommuteStore.readCache(File(context.filesDir, "commute"))

        internal fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val ui = loadCache(context)
            val now = System.currentTimeMillis()
            val board = ui.relevant(now)
            val route = ui.routes.firstOrNull { it.id == board?.routeId }
            val content = commuteContent(ui, route, board, now)
            ids.forEach { id ->
                val (width, height) = sizeDp(context, manager, id)
                manager.updateAppWidget(id, responsiveViews(commuteWidgetVariants(context, id, content), width, height))
            }
        }

        /** Width and height in dp the launcher last reported (portrait uses the narrow width and the tall height); a roomy default before that. */
        internal fun sizeDp(context: Context, manager: AppWidgetManager, id: Int): Pair<Int, Int> {
            val options = runCatching { manager.getAppWidgetOptions(id) }.getOrNull() ?: return 250 to 140
            val portrait = context.resources.configuration.orientation != android.content.res.Configuration.ORIENTATION_LANDSCAPE
            return ch.fasrv.fanotes.schulnetz.widgetSizeDp(
                options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0),
                options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0), portrait)
        }

        /** Opens [tripId] of [routeId] in the app; with a blank trip it opens the route's connection list. */
        internal fun commuteOpenIntent(context: Context, routeId: String, tripId: String, plannedDeparture: String): Intent {
            val ids = if (tripId.isBlank() || plannedDeparture.isBlank()) listOf(routeId) else commuteTripLinkIds(CommuteTripRef(routeId, tripId, plannedDeparture))
            val change = linkedChange("widget-commute", "commute", "", "", routeId).copy(targetIds = ids)
            return CompanionAlerts.notifyIntent(context, change)
        }
    }
}

internal fun struck(text: String): CharSequence =
    SpannableString(text).also { it.setSpan(StrikethroughSpan(), 0, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }

/** Ink of the delay text: on time green, small delays muted, larger ones amber and red. */
internal fun delayTone(row: CommuteRow): WidgetTone = when (row.delayClass) {
    DelayClass.ON_TIME -> WidgetTone.SUCCESS
    DelayClass.MINOR -> WidgetTone.NEUTRAL
    DelayClass.MODERATE -> WidgetTone.WARNING
    DelayClass.MAJOR, DelayClass.CANCELLED -> WidgetTone.DANGER
}

internal fun CommuteRow.unusable(): Boolean = status == TripStatus.CANCELLED || status == TripStatus.BROKEN

/** The delay or "on time" text of a row, empty for a trip that does not run. */
internal fun commuteDelayText(row: CommuteRow): String =
    if (row.unusable()) "" else if (row.delayClass == DelayClass.ON_TIME) t(R.string.commute_on_time_short) else delayText(row.delay)

/** Short status of a row: cancelled, missed connection or an offered alternative. */
internal fun commuteStatusText(row: CommuteRow): String = when {
    row.status == TripStatus.CANCELLED -> t(R.string.commute_cancelled)
    row.status == TripStatus.BROKEN -> t(R.string.commute_connection_missed_short)
    row.alternative -> t(R.string.commute_alternative_short)
    else -> ""
}

/** Line chip in the line's own colours (readable text on it), or in the outline colour when the line has none. */
internal fun bindLineChip(context: Context, views: RemoteViews, id: Int, line: String, lineBg: String, lineFg: String) {
    views.setViewVisibility(id, if (line.isBlank()) View.GONE else View.VISIBLE)
    if (line.isBlank()) return
    views.setTextViewText(id, line)
    val text = context.getColor(R.color.widget_text)
    val bgHex = expandHexColor(lineBg)
    val bg = bgHex?.let { runCatching { Color.parseColor(it) }.getOrNull() }
    val fill: Int
    if (bg != null) {
        val fgGiven = expandHexColor(lineFg)?.let { runCatching { Color.parseColor(it) }.getOrNull() }
        val fg = if (fgGiven != null && contrastRatio(fgGiven, bg) >= 3.0) fgGiven
            else if (contrastRatio(Color.WHITE, bg) >= contrastRatio(Color.BLACK, bg)) Color.WHITE else Color.BLACK
        views.setTextColor(id, fg)
        fill = bg
    } else {
        views.setTextColor(id, text)
        fill = context.getColor(R.color.widget_outline)
    }
    if (Build.VERSION.SDK_INT >= 31) views.setColorStateList(id, "setBackgroundTintList", ColorStateList.valueOf(fill))
    else views.setInt(id, "setBackgroundColor", fill)
}

/** One list row. Public to the module so tests can inspect it. */
internal fun commuteRowViews(context: Context, row: CommuteRow, wide: Boolean, routeId: String, arrival: Boolean = wide, occupancy: Boolean = wide, requestCode: Int = -1): RemoteViews {
    val views = RemoteViews(context.packageName, if (wide) R.layout.widget_commute_row else R.layout.widget_commute_row_compact)
    val unusable = row.unusable()
    views.setTextViewText(R.id.row_dep, if (unusable) struck(row.departClock) else row.departClock)
    views.setTextColor(R.id.row_dep, context.getColor(if (unusable) R.color.widget_muted else R.color.widget_text))
    views.setTextOrGone(R.id.row_delay, commuteDelayText(row))
    views.setTextColor(R.id.row_delay, context.getColor(delayTone(row).ink))
    bindLineChip(context, views, R.id.row_line, row.line, row.lineBg, row.lineFg)
    val status = commuteStatusText(row)
    views.setPill(context, R.id.row_status, status, if (unusable) WidgetTone.DANGER else WidgetTone.ACCENT)
    views.setTextOrGone(R.id.row_platform, if (row.platform.isBlank()) "" else t(R.string.commute_platform_short, row.platform))
    views.setTextColor(R.id.row_platform, context.getColor(if (row.platformChanged) R.color.widget_warning else R.color.widget_muted))
    views.setTextOrGone(R.id.row_transfers, if (unusable) "" else commuteTransfersText(row.transfers))
    views.setTextOrGone(R.id.row_arrive, if (row.arriveClock.isBlank() || !arrival) "" else t(R.string.commute_arrive_short, row.arriveClock))
    val occ = when (row.occupancy) { 1 -> R.drawable.ic_occ_1; 2 -> R.drawable.ic_occ_2; 3 -> R.drawable.ic_occ_3; else -> 0 }
    views.setViewVisibility(R.id.row_occ, if (occ == 0 || unusable || !occupancy) View.GONE else View.VISIBLE)
    if (occ != 0) {
        views.setImageViewResource(R.id.row_occ, occ)
        views.setContentDescription(R.id.row_occ, commuteOccupancyText(row.occupancy))
    }
    val target = CommuteWidget.commuteOpenIntent(context, routeId, row.tripId, row.plannedDeparture)
    if (requestCode >= 0) {
        // One request code per row: intents that differ only in their extras would otherwise share a PendingIntent.
        views.setOnClickPendingIntent(R.id.row_root, PendingIntent.getActivity(context, requestCode, target, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    } else {
        for (id in intArrayOf(R.id.row_root, R.id.row_dep, R.id.row_delay, R.id.row_line, R.id.row_status, R.id.row_platform, R.id.row_transfers, R.id.row_arrive)) {
            views.setOnClickFillInIntent(id, target)
        }
    }
    return views
}
