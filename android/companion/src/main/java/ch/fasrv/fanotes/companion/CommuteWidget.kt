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
import android.widget.RemoteViewsService
import ch.fasrv.fanotes.commute.*
import ch.fasrv.fanotes.schulnetz.linkedChange
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.util.concurrent.Executors

/**
 * Home-screen widget "Pendeln": the next trips of the route that matters now, as a scrolling list.
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
        private const val WIDE_DP = 240

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
            ids.forEach { id ->
                val wide = widthDp(manager, id) >= WIDE_DP
                manager.updateAppWidget(id, views(context, id, ui, route, board, now, wide))
            }
            manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
        }

        internal fun widthDp(manager: AppWidgetManager, id: Int): Int {
            val options = runCatching { manager.getAppWidgetOptions(id) }.getOrNull() ?: return 250
            return options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
        }

        private fun views(context: Context, id: Int, ui: CommuteUi, route: Route?, board: RouteBoard?, now: Long, wide: Boolean): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_commute)
            val first = board?.headTrip()
            val focus = board?.let(::boardFocus)
            when {
                !ui.loaded || ui.routes.isEmpty() -> {
                    views.setTextViewText(R.id.widget_title, t(R.string.commute_widget_empty_title))
                    views.setTextViewText(R.id.widget_detail, t(R.string.commute_widget_empty_body))
                }
                route == null || board == null -> {
                    views.setTextViewText(R.id.widget_title, t(R.string.commute_widget_empty_title))
                    views.setTextViewText(R.id.widget_detail, t(R.string.commute_no_connection))
                }
                else -> {
                    views.setTextViewText(R.id.widget_title, routeTitle(route))
                    val minutes = first?.takeIf { !it.unusable }?.let { minutesUntil(it.departure.ifBlank { it.plannedDeparture }, now) }
                    val stale = board.stale || ui.boardAt == 0L || now - ui.boardAt > 15 * 60_000L
                    val updated = if (stale && ui.boardAt > 0) t(R.string.commute_stale_since, clockOf(ui.boardAt)) else ""
                    // A pinned route says what is wrong with its connection; the rows below show the pinned trip only.
                    val pinNote = when (focus?.kind) {
                        FocusKind.MISSING -> t(R.string.commute_widget_pin_missing)
                        FocusKind.UNUSABLE -> if (board.pinned?.status == PinStatus.GONE) t(R.string.commute_pin_gone_title) else t(R.string.commute_trip_cancelled)
                        FocusKind.MOVED -> t(R.string.commute_pin_moved, focus.movedClock)
                        else -> ""
                    }
                    views.setTextViewText(R.id.widget_detail, listOf(pinNote.takeIf { it.isNotBlank() }, commuteInText(minutes).takeIf { it.isNotBlank() }, updated.takeIf { it.isNotBlank() }, commuteTargetText(board.target).takeIf { wide }).filterNotNull().joinToString(" · "))
                }
            }
            val service = Intent(context, CommuteWidgetService::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
            service.data = android.net.Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME))
            views.setRemoteAdapter(R.id.widget_list, service)
            views.setPendingIntentTemplate(R.id.widget_list, rowTemplate(context))
            // The header opens the trip the first row shows (the detail falls back to the route's list when it is gone).
            val shown = focus?.main ?: first
            val target = if (route == null) Intent(context, MainActivity::class.java)
                else commuteOpenIntent(context, route.id, shown?.id.orEmpty(), shown?.plannedDeparture.orEmpty())
            views.setOnClickPendingIntent(R.id.widget_header, PendingIntent.getActivity(context, 11, target, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            return views
        }

        /** Opens [tripId] of [routeId] in the app; with a blank trip it opens the route's connection list. */
        internal fun commuteOpenIntent(context: Context, routeId: String, tripId: String, plannedDeparture: String): Intent {
            val ids = if (tripId.isBlank() || plannedDeparture.isBlank()) listOf(routeId) else commuteTripLinkIds(CommuteTripRef(routeId, tripId, plannedDeparture))
            val change = linkedChange("widget-commute", "commute", "", "", routeId).copy(targetIds = ids)
            return CompanionAlerts.notifyIntent(context, change)
        }

        internal fun rowTemplate(context: Context): PendingIntent =
            PendingIntent.getActivity(context, 12, Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
    }
}

/** Feeds the scrolling trip list: one row per trip of the relevant route, plus alternatives when the first trip fails. */
class CommuteWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0))

    internal class Factory(private val context: Context, private val widgetId: Int) : RemoteViewsFactory {
        private var rows: List<CommuteRow> = emptyList()
        private var routeId: String = ""
        private var wide = true

        override fun onCreate() {}

        override fun onDataSetChanged() {
            val ui = CommuteWidget.loadCache(context)
            val board = ui.relevant(System.currentTimeMillis())
            routeId = board?.routeId.orEmpty()
            rows = commuteRows(board)
            wide = widgetId == 0 || CommuteWidget.widthDp(AppWidgetManager.getInstance(context), widgetId) >= 240
        }

        override fun onDestroy() { rows = emptyList() }
        override fun getCount(): Int = rows.size
        override fun getViewTypeCount(): Int = 2
        override fun hasStableIds(): Boolean = false
        override fun getItemId(position: Int): Long = position.toLong()
        override fun getLoadingView(): RemoteViews? = null

        override fun getViewAt(position: Int): RemoteViews {
            val row = rows.getOrNull(position) ?: return RemoteViews(context.packageName, R.layout.widget_row_heading)
            return commuteRowViews(context, row, wide, routeId)
        }
    }
}

private fun struck(text: String): CharSequence =
    SpannableString(text).also { it.setSpan(StrikethroughSpan(), 0, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }

/** One list row. Public to the module so tests can inspect it. */
internal fun commuteRowViews(context: Context, row: CommuteRow, wide: Boolean, routeId: String): RemoteViews {
    val views = RemoteViews(context.packageName, if (wide) R.layout.widget_commute_row else R.layout.widget_commute_row_compact)
    val muted = context.getColor(R.color.widget_muted)
    val text = context.getColor(R.color.widget_text)
    val alert = context.getColor(R.color.widget_alert)
    val warning = context.getColor(R.color.widget_warning)
    val success = context.getColor(R.color.widget_success)
    val unusable = row.status == TripStatus.CANCELLED || row.status == TripStatus.BROKEN
    views.setTextViewText(R.id.row_dep, if (unusable) struck(row.departClock) else row.departClock)
    views.setTextColor(R.id.row_dep, if (unusable) muted else text)
    val delayInk = when (row.delayClass) {
        DelayClass.ON_TIME -> success
        DelayClass.MINOR -> muted
        DelayClass.MODERATE -> warning
        DelayClass.MAJOR, DelayClass.CANCELLED -> alert
    }
    views.setTextViewText(R.id.row_delay, if (unusable) "" else if (row.delayClass == DelayClass.ON_TIME) t(R.string.commute_on_time_short) else delayText(row.delay))
    views.setTextColor(R.id.row_delay, delayInk)
    views.setViewVisibility(R.id.row_line, if (row.line.isBlank()) View.GONE else View.VISIBLE)
    if (row.line.isNotBlank()) {
        views.setTextViewText(R.id.row_line, row.line)
        val bgHex = expandHexColor(row.lineBg)
        val bg = bgHex?.let { runCatching { Color.parseColor(it) }.getOrNull() }
        if (bg != null) {
            val fgGiven = expandHexColor(row.lineFg)?.let { runCatching { Color.parseColor(it) }.getOrNull() }
            val fg = if (fgGiven != null && contrastRatio(fgGiven, bg) >= 3.0) fgGiven
                else if (contrastRatio(Color.WHITE, bg) >= contrastRatio(Color.BLACK, bg)) Color.WHITE else Color.BLACK
            views.setTextColor(R.id.row_line, fg)
            if (Build.VERSION.SDK_INT >= 31) views.setColorStateList(R.id.row_line, "setBackgroundTintList", ColorStateList.valueOf(bg))
            else views.setInt(R.id.row_line, "setBackgroundColor", bg)
        } else {
            views.setTextColor(R.id.row_line, text)
            if (Build.VERSION.SDK_INT >= 31) views.setColorStateList(R.id.row_line, "setBackgroundTintList", ColorStateList.valueOf(context.getColor(R.color.widget_outline)))
            else views.setInt(R.id.row_line, "setBackgroundColor", context.getColor(R.color.widget_outline))
        }
    }
    val status = when {
        row.status == TripStatus.CANCELLED -> t(R.string.commute_cancelled)
        row.status == TripStatus.BROKEN -> t(R.string.commute_connection_missed_short)
        row.alternative -> t(R.string.commute_alternative_short)
        else -> ""
    }
    views.setTextViewText(R.id.row_status, status)
    views.setTextColor(R.id.row_status, if (unusable) alert else context.getColor(R.color.widget_accent))
    if (wide) {
        views.setTextViewText(R.id.row_platform, if (row.platform.isBlank()) "" else t(R.string.commute_platform_short, row.platform))
        views.setTextColor(R.id.row_platform, if (row.platformChanged) warning else muted)
        views.setTextViewText(R.id.row_arrive, if (row.arriveClock.isBlank()) "" else t(R.string.commute_arrive_short, row.arriveClock))
        val occ = when (row.occupancy) { 1 -> R.drawable.ic_occ_1; 2 -> R.drawable.ic_occ_2; 3 -> R.drawable.ic_occ_3; else -> 0 }
        views.setViewVisibility(R.id.row_occ, if (occ == 0 || unusable) View.GONE else View.VISIBLE)
        if (occ != 0) {
            views.setImageViewResource(R.id.row_occ, occ)
            views.setContentDescription(R.id.row_occ, commuteOccupancyText(row.occupancy))
        }
    }
    val target = CommuteWidget.commuteOpenIntent(context, routeId, row.tripId, row.plannedDeparture)
    views.setOnClickFillInIntent(R.id.row_dep, target)
    views.setOnClickFillInIntent(R.id.row_delay, target)
    views.setOnClickFillInIntent(R.id.row_line, target)
    views.setOnClickFillInIntent(R.id.row_status, target)
    if (wide) {
        views.setOnClickFillInIntent(R.id.row_platform, target)
        views.setOnClickFillInIntent(R.id.row_arrive, target)
    }
    return views
}
