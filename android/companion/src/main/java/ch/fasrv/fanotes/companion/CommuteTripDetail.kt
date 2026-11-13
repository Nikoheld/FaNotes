package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.commute.*

/*
 * The connection detail (Verbindungsdetail): header, one section per ride with a stop timeline and the vehicle
 * position, change rows between rides, and the data sources. The composables take plain values so tests can
 * render every state; [CommuteTripPage] (CommutePages.kt) loads the data and refreshes it while visible.
 */

/** What the detail shows. [detail] is null until the first answer; [seed] is the trip as the board knows it (no stops). */
data class TripDetailUi(
    val seed: Trip? = null,
    val detail: TripDetail? = null,
    /** The last request failed (older data, if any, stays on screen). */
    val failed: Boolean = false,
    val refreshing: Boolean = false,
) {
    val trip: Trip? get() = detail?.trip ?: seed.takeIf { detail == null }
}

private val RAIL_X = 20.dp
private val DOT_Y = 12.dp

/** The whole screen: pull-to-refresh around the detail items. */
@Composable
fun CommuteTripDetailContent(ui: TripDetailUi, routeName: String, onRefresh: () -> Unit, onRetry: () -> Unit, onOpenRoute: () -> Unit) {
    RefreshableScreenList(ui.refreshing, onRefresh) { commuteTripDetailItems(ui, routeName, onRetry, onOpenRoute) }
}

fun LazyListScope.commuteTripDetailItems(ui: TripDetailUi, routeName: String, onRetry: () -> Unit, onOpenRoute: () -> Unit) {
    val detail = ui.detail
    val trip = ui.trip
    if (detail?.gone == true) {
        item(key = "gone") {
            EmptyState(Icons.Outlined.EventBusy, t(R.string.commute_detail_gone), t(R.string.commute_detail_gone_body), t(R.string.commute_detail_back_route), StateTone.Warning, onOpenRoute)
        }
        return
    }
    if (trip == null) {
        item(key = "pending") {
            if (ui.failed) EmptyState(Icons.Outlined.CloudOff, t(R.string.commute_detail_error), "", t(R.string.commute_detail_retry), StateTone.Error, onRetry)
            else SkeletonRows(4)
        }
        return
    }
    item(key = "header") { DetailHeader(trip, routeName, onOpenRoute) }
    val position = positionSummary(trip, detail?.position)
    if (position != null) item(key = "position") { PositionBanner(position) }
    if (detail == null) item(key = "loading") {
        if (ui.failed) InfoBanner(t(R.string.commute_detail_error), "", t(R.string.commute_detail_retry), error = true, onAction = onRetry)
        else StatusLine(t(R.string.commute_detail_loading_stops), StateTone.Neutral)
    } else {
        if (ui.failed) item(key = "refresh-failed") { StatusLine(t(R.string.commute_detail_refresh_failed), StateTone.Warning) }
        if (detail.stale) item(key = "stale") {
            StatusLine(isoClock(detail.updatedAt).let { if (it.isBlank()) t(R.string.commute_stale) else t(R.string.commute_stale_since, it) }, StateTone.Offline)
        }
    }
    val items = detailItems(trip)
    items.forEachIndexed { index, entry ->
        when (entry) {
            is DetailItem.Ride -> item(key = "ride:${entry.legIndex}") {
                RideSection(trip.id, entry, vehicleMarker(detail?.position, entry.legIndex), Modifier.padding(top = 12.dp))
            }
            is DetailItem.Walk -> item(key = "walk:${entry.legIndex}") { WalkRow(entry.minutes) }
            is DetailItem.Change -> item(key = "change:$index") { ChangeRow(entry) }
        }
    }
    item(key = "footer") { DetailFooter(trip, detail) }
}

// ── Header ───────────────────────────────────────────────────────────────────

@Composable
private fun DetailHeader(trip: Trip, routeName: String, onOpenRoute: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val cls = tripDelayClass(trip)
    val depPlanned = isoClock(trip.plannedDeparture)
    val depReal = isoClock(trip.departure.ifBlank { trip.plannedDeparture })
    val arrPlanned = isoClock(trip.plannedArrival)
    val arrReal = isoClock(trip.arrival.ifBlank { trip.plannedArrival })
    val arrCls = delayClass(trip.arrDelay, trip.unusable)
    Surface(color = scheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 20.dp, vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (routeName.isNotBlank()) Text(routeName, style = MaterialTheme.typography.labelLarge, color = scheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { heading() })
            val summary = "$depReal → $arrReal"
            Row(Modifier.semantics(mergeDescendants = true) { contentDescription = summary }, verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ClockWithPlanned(depPlanned, depReal, trip.unusable, if (trip.unusable) scheme.onSurfaceVariant else scheme.onSurface)
                Icon(Icons.Outlined.ArrowForward, null, Modifier.padding(bottom = 6.dp).size(20.dp), tint = scheme.onSurfaceVariant)
                ClockWithPlanned(arrPlanned, arrReal, trip.unusable, if (trip.unusable) scheme.onSurfaceVariant else delayInk(arrCls).takeIf { arrCls != DelayClass.ON_TIME } ?: scheme.onSurface)
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Text(listOfNotNull(commuteDurationText(trip.minutes).takeIf { trip.minutes > 0 }, commuteTransfersText(trip.transfers)).joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                DelayBadge(cls, trip.depDelay ?: trip.arrDelay)
            }
            if (trip.status != TripStatus.OK) trip.issues.filter { it.kind != "platformChange" && it.text.isNotBlank() }.take(3).forEach {
                Text(it.text, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
            }
            TextButton(onClick = onOpenRoute, contentPadding = PaddingValues(horizontal = 0.dp)) {
                Text(t(R.string.commute_detail_all_connections))
                Icon(Icons.Outlined.ChevronRight, null, Modifier.padding(start = 2.dp).size(18.dp))
            }
        }
    }
}

@Composable
private fun ClockWithPlanned(planned: String, real: String, struckOut: Boolean, color: Color) {
    val changed = planned.isNotBlank() && planned != real
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (changed) Text(planned, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textDecoration = TextDecoration.LineThrough, modifier = Modifier.padding(bottom = 3.dp))
        Text(real, style = MaterialTheme.typography.headlineMedium, color = color,
            textDecoration = if (struckOut) TextDecoration.LineThrough else TextDecoration.None, maxLines = 1, softWrap = false)
    }
}

@Composable
private fun PositionBanner(summary: PositionSummary) {
    val scheme = MaterialTheme.colorScheme
    val base = positionText(summary)
    val text = if (summary.estimated && summary.kind != PositionKind.NOT_STARTED && summary.kind != PositionKind.ARRIVED) "$base (${t(R.string.commute_pos_estimated)})" else base
    Row(
        Modifier.padding(top = 12.dp).fillMaxWidth().background(scheme.primaryContainer, MaterialTheme.shapes.medium).padding(horizontal = 14.dp, vertical = 12.dp)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Outlined.DirectionsTransit, null, Modifier.size(20.dp), tint = scheme.primary)
        Text(text, style = MaterialTheme.typography.titleSmall, color = scheme.onSurface)
    }
}

/** "Hält in X", "Zwischen X und Y", ...: the vehicle position as a sentence. */
fun positionText(summary: PositionSummary): String = when (summary.kind) {
    PositionKind.NOT_STARTED -> t(R.string.commute_pos_not_started)
    PositionKind.AT_STOP -> t(R.string.commute_pos_at, summary.stop)
    PositionKind.BETWEEN -> t(R.string.commute_pos_between, summary.stop, summary.next)
    PositionKind.TRANSFER -> t(R.string.commute_pos_transfer, summary.stop)
    PositionKind.ARRIVED -> t(R.string.commute_pos_arrived)
}

// ── Ride section ─────────────────────────────────────────────────────────────

@Composable
private fun RideSection(tripId: String, item: DetailItem.Ride, marker: VehicleMarker?, modifier: Modifier = Modifier) {
    val leg = item.leg
    val scheme = MaterialTheme.colorScheme
    val rows = remember(leg) { legRows(leg) }
    var expanded by rememberSaveable(tripId, item.legIndex) { mutableStateOf(false) }
    val entries = remember(rows, expanded, marker) { timelineEntries(rows, expanded, marker) }
    val label = remember(leg) { legLabel(leg) }
    Surface(color = scheme.surface, shape = MaterialTheme.shapes.large, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 10.dp)) {
            val legSummary = t(R.string.commute_a11y_leg, label, leg.direction)
            Column(Modifier.semantics(mergeDescendants = true) { contentDescription = legSummary }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                    LineChip(leg, label)
                    if (leg.direction.isNotBlank()) Text("→ ${leg.direction}", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = scheme.onSurface)
                    if (leg.cancelled) DelayBadge(DelayClass.CANCELLED, null)
                }
                if (leg.operator.isNotBlank()) Text(leg.operator, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
            }
            OccupancyRow(leg.occupancy, false, Modifier.padding(top = 8.dp))
            leg.notes.take(3).forEach {
                Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Outlined.ReportProblem, null, Modifier.padding(top = 2.dp).size(16.dp), tint = LocalCompanionSemantics.current.warning)
                    Text(it, style = MaterialTheme.typography.bodySmall, color = LocalCompanionSemantics.current.warning)
                }
            }
            Column(Modifier.padding(top = 12.dp)) {
                entries.forEachIndexed { index, entry ->
                    when (entry) {
                        is TimelineEntry.Stop -> StopRow(leg, entry.row, marker, first = index == 0, last = index == entries.lastIndex)
                        is TimelineEntry.Toggle -> StopsToggle(entry, onClick = { expanded = !expanded })
                    }
                }
                if (leg.stops.isEmpty() && leg.stopCount > 0) Text(tp(R.plurals.commute_detail_stops, leg.stopCount, leg.stopCount),
                    style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, modifier = Modifier.padding(start = 76.dp, top = 2.dp))
            }
        }
    }
}

@Composable
private fun StopsToggle(toggle: TimelineEntry.Toggle, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val text = if (toggle.expanded) t(R.string.commute_detail_hide_stops) else tp(R.plurals.commute_detail_stops, toggle.count, toggle.count)
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Spacer(Modifier.width(TIME_COLUMN))
        Rail(Modifier.width(RAIL_X).fillMaxHeight(), dashed = !toggle.expanded)
        Row(
            Modifier.weight(1f).heightIn(min = 44.dp)
                .clickable(role = Role.Button, onClickLabel = text, onClick = onClick)
                .semantics { stateDescription = text }.padding(start = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text, style = MaterialTheme.typography.labelLarge, color = scheme.primary)
            Icon(if (toggle.expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.padding(start = 4.dp).size(20.dp), tint = scheme.primary)
        }
    }
}

private val TIME_COLUMN = 56.dp

/** The rail between two rows: a line, dashed while the intermediate stops are folded away. */
@Composable
private fun Rail(modifier: Modifier, dashed: Boolean) {
    val line = MaterialTheme.colorScheme.outlineVariant
    Box(modifier.drawBehind {
        val x = size.width / 2
        if (dashed) {
            val dash = 4.dp.toPx()
            var y = 0f
            while (y < size.height) { drawLine(line, Offset(x, y), Offset(x, minOf(y + dash, size.height)), strokeWidth = 2.dp.toPx()); y += dash * 2 }
        } else drawLine(line, Offset(x, 0f), Offset(x, size.height), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Butt)
    })
}

@Composable
private fun StopRow(leg: Leg, row: TimelineRow, marker: VehicleMarker?, first: Boolean, last: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    val ends = row.role != RowRole.STOP
    val dotColor = if (row.cancelled) scheme.error else scheme.primary
    val railColor = scheme.outlineVariant
    val markerHere = marker?.takeIf { it.point == row.point }
    val markerColor = s.success
    val description = stopDescription(leg, row, markerHere)
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).semantics(mergeDescendants = true) { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        Column(Modifier.width(TIME_COLUMN).padding(top = 2.dp, bottom = 8.dp), horizontalAlignment = Alignment.End) {
            val arr = row.arrival
            val dep = row.departure
            TimeCell(arr, row.cancelled)
            if (dep != null && (arr == null || dep.shownClock != arr.shownClock || dep.plannedClock != arr.plannedClock)) TimeCell(dep, row.cancelled)
        }
        Box(Modifier.width(RAIL_X).fillMaxHeight().drawBehind {
            val x = size.width / 2
            val dotY = DOT_Y.toPx()
            if (!first) drawLine(railColor, Offset(x, 0f), Offset(x, dotY), strokeWidth = 2.dp.toPx())
            if (!last) drawLine(railColor, Offset(x, dotY), Offset(x, size.height), strokeWidth = 2.dp.toPx())
            val radius = if (ends) 6.dp.toPx() else 4.dp.toPx()
            if (row.cancelled || (!ends && !row.realtime)) {
                drawCircle(scheme.surface, radius, Offset(x, dotY))
                drawCircle(dotColor, radius, Offset(x, dotY), style = Stroke(2.dp.toPx()))
            } else drawCircle(dotColor, radius, Offset(x, dotY))
            if (marker != null && marker.point == row.point) {
                val y = if (marker.atStop) dotY else dotY + (size.height * marker.progress.toFloat())
                val r = 8.dp.toPx()
                if (marker.estimated) {
                    drawCircle(scheme.surface, r, Offset(x, y))
                    drawCircle(markerColor, r, Offset(x, y), style = Stroke(2.5.dp.toPx()))
                } else {
                    drawCircle(markerColor, r, Offset(x, y))
                    drawCircle(scheme.surface, 3.dp.toPx(), Offset(x, y))
                }
            }
        })
        Column(Modifier.weight(1f).padding(start = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.name, style = MaterialTheme.typography.bodyLarge, fontWeight = if (ends) FontWeight.SemiBold else FontWeight.Normal,
                color = if (row.cancelled) scheme.error else scheme.onSurface, textDecoration = if (row.cancelled) TextDecoration.LineThrough else TextDecoration.None)
            if (row.cancelled) Text(t(R.string.commute_detail_stop_cancelled), style = MaterialTheme.typography.labelMedium, color = scheme.error, fontWeight = FontWeight.SemiBold)
            val cls = row.badgeClass
            val showDelay = !row.cancelled && cls != null && cls != DelayClass.ON_TIME
            val showPlatform = row.platform.isNotBlank()
            val showNoRealtime = !row.realtime && !row.cancelled
            if (showDelay || showPlatform || showNoRealtime) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                if (showDelay) DelayBadge(cls!!, row.badgeDelay)
                if (showPlatform) PlatformText(leg, Point(platform = row.platform, platformChanged = row.platformChanged))
                if (showNoRealtime) Text(t(R.string.commute_detail_no_realtime), style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant)
            }
        }
    }
}

/** One time: the planned one struck through above the real one when they differ; planned only (neutral) without real time. */
@Composable
private fun TimeCell(time: TimelineTime?, cancelled: Boolean) {
    time ?: return
    val scheme = MaterialTheme.colorScheme
    Column(horizontalAlignment = Alignment.End) {
        if (time.changed && !cancelled) Text(time.plannedClock, style = TimeSmallStyle, color = scheme.onSurfaceVariant, textDecoration = TextDecoration.LineThrough)
        val cls = time.delayClass
        val color = when {
            cancelled -> scheme.onSurfaceVariant
            cls == null -> scheme.onSurface
            else -> delayInk(cls)
        }
        Text(time.shownClock, style = TimeStyle, color = color, textDecoration = if (cancelled) TextDecoration.LineThrough else TextDecoration.None, textAlign = TextAlign.End)
    }
}

/** "Muri AG, an 23:51, ab 23:52, plus 1 Minute, Gleis 4": planned times, the delay, the platform, then the state. */
@Composable
private fun stopDescription(leg: Leg, row: TimelineRow, marker: VehicleMarker?): String {
    val parts = ArrayList<String>()
    parts += row.name
    row.arrival?.plannedClock?.takeIf { it.isNotBlank() }?.let { parts += t(R.string.commute_a11y_arrives, it) }
    row.departure?.plannedClock?.takeIf { it.isNotBlank() }?.let { parts += t(R.string.commute_a11y_departs, it) }
    if (row.cancelled) parts += t(R.string.commute_detail_stop_cancelled)
    else {
        val delay = row.badgeDelay
        if (delay != null && delay > 0) parts += tp(R.plurals.commute_a11y_plus, delay, delay)
        else if (!row.realtime) parts += t(R.string.commute_detail_no_realtime)
    }
    if (row.platform.isNotBlank()) {
        val text = commutePlatformText(leg, Point(platform = row.platform))
        parts += if (row.platformChanged) t(R.string.commute_platform_changed, text) else text
    }
    if (marker != null) parts += t(if (marker.atStop) R.string.commute_a11y_vehicle_here else R.string.commute_a11y_vehicle_next)
    return parts.joinToString(", ")
}

// ── Between legs ─────────────────────────────────────────────────────────────

@Composable
private fun WalkRow(minutes: Int) {
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.padding(start = 16.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Outlined.DirectionsWalk, null, Modifier.size(18.dp), tint = scheme.onSurfaceVariant)
        Text(t(R.string.commute_detail_walk, minutes), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
    }
}

@Composable
private fun ChangeRow(change: DetailItem.Change) {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    val transfer = change.transfer
    val warning = transfer?.let(::transferWarning) ?: TransferWarning.NONE
    val platformChanged = change.next.from.platformChanged
    val ink = when {
        warning == TransferWarning.BROKEN -> scheme.error
        warning == TransferWarning.TIGHT || platformChanged -> s.warning
        else -> scheme.onSurfaceVariant
    }
    val container = when (warning) {
        TransferWarning.BROKEN -> s.dangerSoft
        TransferWarning.TIGHT -> s.warningSoft
        TransferWarning.NONE -> Color.Transparent
    }
    val base = if (transfer == null) t(R.string.commute_detail_change_at, change.at) else commuteTransferText(transfer, tight = false)
    val warnText = when (warning) {
        TransferWarning.BROKEN -> t(R.string.commute_detail_transfer_broken)
        TransferWarning.TIGHT -> t(R.string.commute_detail_transfer_tight)
        TransferWarning.NONE -> ""
    }
    val platform = if (warning == TransferWarning.BROKEN) "" else commutePlatformText(change.next).let { if (it.isNotBlank() && platformChanged) t(R.string.commute_platform_changed, it) else it }
    val text = listOf(base, platform).filter { it.isNotBlank() }.joinToString(" · ")
    val description = listOf(text, warnText).filter { it.isNotBlank() }.joinToString(", ")
    Row(
        Modifier.padding(top = 12.dp).fillMaxWidth().background(container, MaterialTheme.shapes.medium).padding(horizontal = 16.dp, vertical = if (warning == TransferWarning.NONE) 0.dp else 10.dp)
            .semantics(mergeDescendants = true) { contentDescription = description },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(if (warning == TransferWarning.BROKEN) Icons.Outlined.ErrorOutline else Icons.Outlined.SyncAlt, null, Modifier.size(18.dp), tint = ink)
        Column {
            Text(text, style = MaterialTheme.typography.bodyMedium, color = ink, maxLines = 3, overflow = TextOverflow.Ellipsis,
                fontWeight = if (warning != TransferWarning.NONE || platformChanged) FontWeight.SemiBold else FontWeight.Normal)
            if (warnText.isNotBlank()) Text(warnText, style = MaterialTheme.typography.labelLarge, color = ink, fontWeight = FontWeight.Bold)
        }
    }
}

// ── Footer ───────────────────────────────────────────────────────────────────

@Composable
private fun DetailFooter(trip: Trip, detail: TripDetail?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.padding(top = 16.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (trip.rides().any { it.occupancy.known() }) Text(t(R.string.commute_occupancy_note), style = MaterialTheme.typography.bodySmall, color = muted)
        if (detail != null) {
            val sources = listOfNotNull(
                detail.sources.realtime.takeIf { it.isNotBlank() }?.let { t(R.string.commute_detail_src_realtime, it) },
                detail.sources.platforms?.let { t(R.string.commute_detail_src_platforms, it) },
            )
            if (sources.isNotEmpty()) Text(sources.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = muted)
            isoClock(detail.updatedAt).takeIf { it.isNotBlank() }?.let { Text(t(R.string.commute_detail_asof, it), style = MaterialTheme.typography.bodySmall, color = muted) }
            // The formation source needs a key we do not have: say so in one line instead of showing invented cars.
            if (detail.sources.formation == null) Text(t(R.string.commute_detail_formation_none), style = MaterialTheme.typography.bodySmall, color = muted)
        }
    }
}
