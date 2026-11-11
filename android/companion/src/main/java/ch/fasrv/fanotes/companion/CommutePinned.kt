package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.commute.*

/*
 * The part of a route card that changes when the route has a fixed connection (a pin): the pinned trip with
 * its live state, a notice when the timetable moved it, dropped it or the lesson plan changed, and the
 * secondary "other connections" expander. What to show comes from [boardFocus] (core, unit-tested).
 */

/** Lesson-change line: "Letzte Stunde fällt aus – früher: 14:43 S29". Null without a change. */
@Composable
fun CommuteChangeNotice(focus: BoardFocus, modifier: Modifier = Modifier) {
    val change = focus.change ?: return
    val s = LocalCompanionSemantics.current
    val last = focus.changeKind == LessonChange.LAST_CANCELLED
    val brief = commuteTripBrief(change)
    CommuteNotice(
        if (last) Icons.Outlined.EventBusy else Icons.Outlined.EventRepeat,
        if (last) t(R.string.commute_change_last, brief) else t(R.string.commute_change_first, brief), "",
        if (last) s.successSoft else s.warningSoft, if (last) s.success else s.warning, modifier,
    )
}

/**
 * The pinned connection and its state. [alternativeCount] limits the alternatives shown under a failed trip;
 * [onRepick] adds the "Neu wählen" button to a missing connection.
 */
@Composable
fun PinnedBoardContent(route: Route, board: RouteBoard, focus: BoardFocus, alternativeCount: Int, onRepick: (() -> Unit)?, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        focus.pin?.takeIf { it.departure.isNotBlank() }?.let {
            Text(commutePinSummary(it), style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant, maxLines = 2)
        }
        CommuteChangeNotice(focus)
        when (focus.kind) {
            FocusKind.MISSING -> {
                val pin = focus.pin
                CommuteNotice(Icons.Outlined.ErrorOutline, t(R.string.commute_pin_missing_title),
                    if (pin == null) "" else t(R.string.commute_pin_missing_body, pin.departure, pin.line, pin.stop, commutePinDayText(focus.day)).replace("  ", " "),
                    s.dangerSoft, scheme.error)
                focus.nearest?.let { near ->
                    Column(Modifier.fillMaxWidth().padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(t(R.string.commute_pin_nearest), style = MaterialTheme.typography.labelLarge, color = scheme.primary)
                        CommuteTripSummary(near, showArrival = true)
                    }
                }
                if (onRepick != null) PrimaryButton(t(R.string.commute_pin_repick), onRepick, Modifier.fillMaxWidth(), icon = Icons.Outlined.Edit)
            }
            FocusKind.UNUSABLE -> {
                val trip = focus.main
                val gone = board.pinned?.status == PinStatus.GONE
                if (trip != null) CommuteTripSummary(trip, showArrival = true)
                CommuteNotice(Icons.Outlined.ErrorOutline,
                    when {
                        gone -> t(R.string.commute_pin_gone_title)
                        trip?.status == TripStatus.BROKEN -> t(R.string.commute_connection_missed)
                        else -> t(R.string.commute_trip_cancelled)
                    },
                    if (gone) t(R.string.commute_pin_gone_body) else trip?.issues?.firstOrNull { it.kind == "cancelled" || it.kind == "missedTransfer" }?.text.orEmpty(),
                    s.dangerSoft, scheme.error)
                if (focus.alternatives.isEmpty()) Text(t(R.string.commute_no_alternative), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                focus.alternatives.take(alternativeCount).forEach { CommuteAlternative(it, board.viaDropped, route.via?.name) }
            }
            FocusKind.MOVED -> {
                CommuteNotice(Icons.Outlined.Update, t(R.string.commute_pin_moved, focus.movedClock), "", s.warningSoft, s.warning)
                focus.main?.let { CommuteTripSummary(it, showArrival = true) }
            }
            else -> focus.main?.let { CommuteTripSummary(it, showArrival = true) }
        }
    }
}

/** "Andere Verbindungen anzeigen" / "ausblenden": the secondary toggle in front of the non-pinned trips. */
@Composable
fun OtherConnectionsToggle(open: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(onClick = onToggle, modifier = modifier) {
        Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(if (open) t(R.string.commute_other_hide) else t(R.string.commute_other_show))
    }
}
