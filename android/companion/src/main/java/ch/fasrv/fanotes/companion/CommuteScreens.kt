package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.commute.*

/*
 * Pendelstrecken on screen: the Heute card, the route detail with its trips and legs, and the
 * route list. The composables take plain values and callbacks so tests can render every state.
 */

// ── Heute card ───────────────────────────────────────────────────────────────

/** Heute: the next trip of the route that matters now, or an invitation to add a route. */
@Composable
fun CommuteCard(ui: CommuteUi, nowMs: Long, showInvite: Boolean, onOpen: (String) -> Unit, onAdd: () -> Unit, modifier: Modifier = Modifier) {
    if (ui.routes.isEmpty()) {
        if (showInvite) CommuteInvite(onAdd, modifier)
        return
    }
    val board = remember(ui, nowMs / 60_000) { ui.relevant(nowMs) } ?: return
    val route = ui.routes.firstOrNull { it.id == board.routeId } ?: return
    CommuteBoardCard(route, board, nowMs, onOpen = { onOpen(route.id) }, modifier)
}

@Composable
private fun CommuteInvite(onAdd: () -> Unit, modifier: Modifier = Modifier) {
    Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp)) {
            IconTile(Icons.Outlined.DirectionsBus, StateTone.Accent, 44.dp)
            Text(t(R.string.commute_invite_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 16.dp).semantics { heading() })
            Text(t(R.string.commute_invite_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            PrimaryButton(t(R.string.commute_add_route), onAdd, Modifier.padding(top = 18.dp), icon = Icons.Outlined.Add)
        }
    }
}

@Composable
fun CommuteBoardCard(route: Route, board: RouteBoard, nowMs: Long, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    val trip = board.trips.firstOrNull()
    val minutes = trip?.let { minutesUntil(it.departure.ifBlank { it.plannedDeparture }, nowMs) }
    Surface(onClick = onOpen, color = scheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(stopTypeIcon(trip?.firstRide()?.type ?: route.from.type), null, Modifier.size(20.dp), tint = scheme.primary)
                Column(Modifier.weight(1f)) {
                    Text(routeTitle(route), style = MaterialTheme.typography.labelLarge, color = scheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(commuteTargetText(board.target), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                if (trip != null && !trip.unusable && minutes != null) Text(commuteInText(minutes), style = MaterialTheme.typography.labelLarge, color = scheme.onSurface, maxLines = 1)
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(20.dp), tint = scheme.onSurfaceVariant)
            }
            commuteLessonBanner(board)?.let { (title, body) ->
                val last = board.target.lessonChange == LessonChange.LAST_CANCELLED
                val planned = board.target.plannedAt?.let(::isoClock).orEmpty()
                CommuteNotice(if (last) Icons.Outlined.EventBusy else Icons.Outlined.EventRepeat, title,
                    if (planned.isBlank()) body else body + "\n" + t(R.string.commute_was_planned, planned),
                    if (last) s.successSoft else s.warningSoft, if (last) s.success else s.warning)
            }
            if (trip == null) {
                Text(t(R.string.commute_no_connection), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
            } else {
                CommuteTripSummary(trip, showArrival = true)
                if (trip.unusable) {
                    CommuteNotice(Icons.Outlined.ErrorOutline,
                        if (trip.status == TripStatus.BROKEN) t(R.string.commute_connection_missed) else t(R.string.commute_trip_cancelled),
                        trip.issues.firstOrNull { it.kind == "cancelled" || it.kind == "missedTransfer" }?.text.orEmpty(),
                        s.dangerSoft, scheme.error)
                    board.alternatives.firstOrNull()?.let { CommuteAlternative(it, board.viaDropped, route.via?.name) }
                        ?: Text(t(R.string.commute_no_alternative), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                } else {
                    val later = board.trips.drop(1).take(3).map { isoClock(it.departure.ifBlank { it.plannedDeparture }) }.filter { it.isNotBlank() }
                    if (later.isNotEmpty()) Text(t(R.string.commute_then, later.joinToString(" · ")), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
            }
            if (board.stale) {
                val at = isoClock(board.updatedAt)
                StatusLine(if (at.isBlank()) t(R.string.commute_stale) else t(R.string.commute_stale_since, at), StateTone.Offline)
            }
        }
    }
}

/** Departure, delay, line chips, platform, arrival, transfers and load of one trip. */
@Composable
fun CommuteTripSummary(trip: Trip, showArrival: Boolean, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val cls = tripDelayClass(trip)
    val ride = trip.firstRide()
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.Bottom) {
            DepartureClock(trip)
            if (cls != DelayClass.ON_TIME) DelayBadge(cls, trip.depDelay ?: trip.arrDelay, Modifier.padding(bottom = 6.dp))
            if (ride != null && !trip.unusable) PlatformText(ride, modifier = Modifier.padding(bottom = 6.dp))
        }
        TripChips(trip)
        if (showArrival) {
            val arrival = isoClock(trip.arrival.ifBlank { trip.plannedArrival })
            if (arrival.isNotBlank()) Text(
                listOf(t(R.string.commute_arrival_at, arrival) + (trip.arrDelay?.takeIf { it > 0 }?.let { " (+$it)" } ?: ""),
                    commuteDurationText(trip.minutes).takeIf { trip.minutes > 0 }, commuteTransfersText(trip.transfers)).filterNotNull().joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant,
            )
        }
        val rides = trip.rides()
        trip.changes.forEachIndexed { index, change -> TransferLine(change, rides.getOrNull(index + 1)) }
        if (!trip.unusable) OccupancyRow(trip.occupancy, trip.quietest)
    }
}

/** Line chips and walks in order: [371] > walk 4 min > [S29]. */
@Composable
fun TripChips(trip: Trip) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
        trip.legs.forEachIndexed { index, leg ->
            if (index > 0) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.outline)
            if (leg.walk) Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.DirectionsWalk, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(t(R.string.commute_duration_minutes, leg.minutes), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 2.dp))
            } else LineChip(leg)
        }
    }
}

/** "Alternative: 07:35 ..." shown prominently under a cancelled or broken trip. */
@Composable
fun CommuteAlternative(trip: Trip, viaDropped: Boolean, viaName: String?) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().background(scheme.primaryContainer, MaterialTheme.shapes.medium).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(t(R.string.commute_alternative), style = MaterialTheme.typography.labelLarge, color = scheme.primary)
        if (viaDropped) Text(
            if (viaName.isNullOrBlank()) t(R.string.commute_alternative_no_via) else t(R.string.commute_alternative_no_via_named, viaName),
            style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
        )
        CommuteTripSummary(trip, showArrival = true)
    }
}

// ── Route detail ─────────────────────────────────────────────────────────────

/** Everything about one route: the target, its trips (with earlier/later), legs, and the honest occupancy note. */
fun LazyListScope.commuteDetailItems(
    route: Route,
    board: RouteBoard?,
    extraTrips: List<Trip>,
    provider: Provider,
    nowMs: Long,
    loadingMore: Boolean,
    moreFailed: Boolean,
    onEarlier: () -> Unit,
    onLater: () -> Unit,
    onEdit: () -> Unit,
) {
    item(key = "head") {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp)) {
            PageIntro(routeTitle(route), commuteRouteLine(route).takeIf { route.name.isNotBlank() } ?: "", commuteScheduleText(route.schedule))
        }
    }
    if (board == null) {
        item(key = "empty") { InfoBanner(t(R.string.commute_no_board), t(R.string.commute_no_board_body)) }
    } else {
        item(key = "target") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(commuteTargetText(board.target), style = MaterialTheme.typography.titleMedium)
                commuteLessonBanner(board)?.let { (title, body) ->
                    val last = board.target.lessonChange == LessonChange.LAST_CANCELLED
                    val sem = LocalCompanionSemantics.current
                    CommuteNotice(if (last) Icons.Outlined.EventBusy else Icons.Outlined.EventRepeat, title, body,
                        if (last) sem.successSoft else sem.warningSoft, if (last) sem.success else sem.warning)
                }
                if (board.stale) StatusLine(isoClock(board.updatedAt).let { if (it.isBlank()) t(R.string.commute_stale) else t(R.string.commute_stale_since, it) }, StateTone.Offline)
            }
        }
        val shown = (board.trips + extraTrips).distinctBy { it.id.ifBlank { it.departure + it.arrival } }
            .sortedBy { isoMillis(it.plannedDeparture) ?: isoMillis(it.departure) ?: Long.MAX_VALUE }
        item(key = "earlier") {
            TextButton(onClick = onEarlier, enabled = !loadingMore) { Icon(Icons.Outlined.KeyboardArrowUp, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(t(R.string.commute_earlier)) }
        }
        if (shown.isEmpty()) item(key = "none") { Text(t(R.string.commute_no_connection), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        itemsIndexed(shown, key = { _, trip -> "trip:" + trip.id.ifBlank { trip.departure + trip.arrival } }) { index, trip ->
            CommuteTripCard(trip, startOpen = trip.id == board.trips.firstOrNull()?.id, nowMs = nowMs, modifier = Modifier.padding(bottom = 10.dp))
        }
        item(key = "later") {
            Column {
                TextButton(onClick = onLater, enabled = !loadingMore) { Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(t(R.string.commute_later)) }
                if (moreFailed) StatusLine(t(R.string.commute_more_failed), StateTone.Warning)
            }
        }
        val first = board.trips.firstOrNull()
        if (first != null && first.unusable) board.alternatives.takeIf { it.isNotEmpty() }?.let { alt ->
            item(key = "alternatives") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    alt.take(2).forEach { CommuteAlternative(it, board.viaDropped, route.via?.name) }
                }
            }
        }
    }
    item(key = "note") {
        Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(t(R.string.commute_occupancy_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (provider.name.isNotBlank()) Text(t(R.string.commute_provider, provider.name), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    item(key = "edit") {
        SecondaryButton(t(R.string.commute_edit_route), onEdit, Modifier.fillMaxWidth().padding(top = 14.dp), icon = Icons.Outlined.Edit)
    }
}

/** One trip of the detail list: the summary, and the legs timeline when opened. */
@Composable
fun CommuteTripCard(trip: Trip, startOpen: Boolean, nowMs: Long, modifier: Modifier = Modifier) {
    var open by rememberSaveable(trip.id) { mutableStateOf(startOpen) }
    val minutes = minutesUntil(trip.departure.ifBlank { trip.plannedDeparture }, nowMs)
    Surface(onClick = { open = !open }, color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.large, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                CommuteTripSummary(trip, showArrival = true, modifier = Modifier.weight(1f))
                Column(horizontalAlignment = Alignment.End) {
                    if (!trip.unusable && minutes != null && minutes >= -1) Text(commuteInText(minutes), style = MaterialTheme.typography.labelLarge)
                    Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.padding(top = 6.dp).size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (trip.status != TripStatus.OK) trip.issues.filter { it.kind != "platformChange" }.take(3).forEach { issue ->
                if (issue.text.isNotBlank()) Text(issue.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (open) LegTimeline(trip)
        }
    }
}

/** Departure stop to destination, leg by leg, with a rail on the left. */
@Composable
fun LegTimeline(trip: Trip, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val rail = scheme.outlineVariant
    val dot = scheme.primary
    Column(modifier.fillMaxWidth().padding(top = 4.dp)) {
        HorizontalDivider(color = LocalCompanionSemantics.current.hairline, modifier = Modifier.padding(bottom = 10.dp))
        trip.legs.forEachIndexed { index, leg ->
            val last = index == trip.legs.lastIndex
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.width(48.dp), horizontalAlignment = Alignment.End) {
                    val planned = isoClock(leg.from.planned)
                    val real = isoClock(leg.from.time.ifBlank { leg.from.planned })
                    Text(real, style = TimeStyle, color = if (leg.cancelled) scheme.error else scheme.onSurface)
                    if (planned.isNotBlank() && planned != real) Text(planned, style = TimeSmallStyle, color = scheme.onSurfaceVariant, textDecoration = androidx.compose.ui.text.style.TextDecoration.LineThrough)
                }
                Box(Modifier.width(14.dp).fillMaxHeight().drawBehind {
                    val x = size.width / 2
                    drawLine(rail, Offset(x, 10.dp.toPx()), Offset(x, size.height), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
                    drawCircle(dot, 4.5.dp.toPx(), Offset(x, 10.dp.toPx()))
                })
                Column(Modifier.weight(1f).padding(bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(leg.from.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                    if (leg.walk) Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.DirectionsWalk, null, Modifier.size(16.dp), tint = scheme.onSurfaceVariant)
                        Text(t(R.string.commute_walk, leg.minutes), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
                    } else {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                            LineChip(leg)
                            if (leg.direction.isNotBlank()) Text(t(R.string.commute_towards, leg.direction), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                            PlatformText(leg)
                            val dc = delayClass(leg.from.delay, leg.cancelled)
                            if (dc != DelayClass.ON_TIME) DelayBadge(dc, leg.from.delay)
                        }
                        val arrive = isoClock(leg.to.time.ifBlank { leg.to.planned })
                        Text(listOf(t(R.string.commute_arrive_stop, leg.to.name, arrive), commuteDurationText(leg.minutes).takeIf { leg.minutes > 0 }).filterNotNull().joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                        OccupancyRow(leg.occupancy, false)
                        leg.notes.take(2).forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalCompanionSemantics.current.warning) }
                    }
                }
            }
            if (last) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                Text(isoClock(leg.to.time.ifBlank { leg.to.planned }), style = TimeStyle, modifier = Modifier.width(48.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End)
                Box(Modifier.width(14.dp).height(20.dp).drawBehind { drawCircle(dot, 4.5.dp.toPx(), Offset(size.width / 2, 10.dp.toPx())) })
                Column(Modifier.weight(1f)) {
                    Text(leg.to.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                    PlatformText(leg, leg.to)
                }
            }
        }
    }
}

// ── Route list ───────────────────────────────────────────────────────────────

/** One route in the settings list: name, ends, schedule; up/down to reorder. */
@Composable
fun CommuteRouteRow(route: Route, index: Int, count: Int, onOpen: () -> Unit, onMove: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = Space.row), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = onOpen).padding(start = 16.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            IconTile(stopTypeIcon(route.from.type), StateTone.Accent)
            Column(Modifier.weight(1f)) {
                Text(routeTitle(route), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (route.name.isNotBlank()) Text(commuteRouteLine(route), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(commuteScheduleText(route.schedule), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (!route.notify) Icon(Icons.Outlined.NotificationsOff, t(R.string.commute_alerts_off), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (count > 1) {
            ActionIcon(Icons.Outlined.ArrowUpward, t(R.string.commute_move_up, routeTitle(route)), enabled = index > 0) { onMove(-1) }
            ActionIcon(Icons.Outlined.ArrowDownward, t(R.string.commute_move_down, routeTitle(route)), enabled = index < count - 1) { onMove(1) }
        }
    }
}

@Composable
fun CommuteListContent(
    ui: CommuteUi,
    onOpen: (Route) -> Unit,
    onMove: (Route, Int) -> Unit,
    onAdd: () -> Unit,
    onThreshold: (Int) -> Unit,
    onNotifications: () -> Unit,
) {
    ScreenList {
        item(key = "intro") { PageIntro(t(R.string.commute_title), t(R.string.commute_intro)) }
        if (ui.routes.isEmpty()) {
            item(key = "empty") {
                EmptyState(Icons.Outlined.DirectionsBus, t(R.string.commute_empty_title), t(R.string.commute_empty_body), t(R.string.commute_add_route), StateTone.Accent, onAdd)
            }
        } else {
            item(key = "routes-head") { SectionLabel(t(R.string.commute_routes), count = ui.routes.size) }
            itemsIndexed(ui.routes, key = { _, route -> "route:${route.id}" }) { index, route ->
                GroupItem(index, ui.routes.size) { CommuteRouteRow(route, index, ui.routes.size, { onOpen(route) }) { delta -> onMove(route, delta) } }
            }
            item(key = "add") {
                if (ui.routes.size < MAX_ROUTES) PrimaryButton(t(R.string.commute_add_route), onAdd, Modifier.fillMaxWidth().padding(top = 14.dp), icon = Icons.Outlined.Add)
                else Text(t(R.string.commute_limit, MAX_ROUTES), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 14.dp))
            }
        }
        item(key = "alerts-head") { SectionLabel(t(R.string.commute_alerts)) }
        item(key = "alerts") {
            Column {
                Text(t(R.string.commute_threshold_label), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
                ChoiceRow(DELAY_THRESHOLD_CHOICES.map { it.toString() to t(R.string.commute_minutes_short, it) }, ui.settings.delayThreshold.toString(), { onThreshold(it.toInt()) })
                Group(Modifier.padding(top = 10.dp)) { SettingRow(Icons.Outlined.NotificationsNone, t(R.string.notifications), t(R.string.commute_notification_row), onClick = onNotifications) }
            }
        }
        item(key = "privacy") {
            Text(t(R.string.commute_privacy), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 16.dp))
        }
    }
}
