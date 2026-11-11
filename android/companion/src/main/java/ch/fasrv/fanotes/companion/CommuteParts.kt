package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.commute.*
import java.time.DayOfWeek
import java.time.format.TextStyle
import java.util.Locale

/*
 * Building blocks of the Pendelstrecken screens: texts, chips and meters shared by the Heute card,
 * the route detail, the settings list and the widget. Pure presentation; no state, no requests.
 */

// ── Texts ────────────────────────────────────────────────────────────────────

fun commuteDaysText(days: List<Int>): String {
    val sorted = days.filter { it in 1..7 }.distinct().sorted()
    return when {
        sorted == listOf(1, 2, 3, 4, 5) -> t(R.string.commute_days_weekdays)
        sorted.size == 7 -> t(R.string.commute_days_daily)
        sorted.isEmpty() -> t(R.string.commute_days_none)
        else -> sorted.joinToString(", ") { DayOfWeek.of(it).getDisplayName(TextStyle.SHORT, Locale.getDefault()).trimEnd('.') }
    }
}

fun commuteScheduleText(schedule: Schedule): String = when (schedule.mode) {
    ScheduleMode.NONE -> t(R.string.commute_schedule_none_summary)
    ScheduleMode.TIMES -> t(R.string.commute_schedule_times_summary, schedule.times.joinToString(", "), commuteDaysText(schedule.days))
    ScheduleMode.FIRST_LESSON -> t(R.string.commute_schedule_first_summary, schedule.bufferMinutes, commuteDaysText(schedule.days))
    ScheduleMode.LAST_LESSON -> t(R.string.commute_schedule_last_summary, schedule.bufferMinutes, commuteDaysText(schedule.days))
}

fun commuteRouteLine(route: Route): String = "${route.from.name} → ${route.to.name}"

fun commuteTargetText(target: TripTarget): String {
    val at = isoClock(target.at)
    val lesson = target.lesson?.let { isoClock(if (target.kind == "lastLesson") it.end else it.start) }.orEmpty()
    return when (target.kind) {
        "firstLesson" -> if (lesson.isNotBlank()) t(R.string.commute_target_first, at, lesson) else t(R.string.commute_target_arrive, at)
        "lastLesson" -> if (lesson.isNotBlank()) t(R.string.commute_target_last, at, lesson) else t(R.string.commute_target_time, at)
        "time" -> t(R.string.commute_target_time, at)
        else -> t(R.string.commute_target_now)
    }
}

fun commuteInText(minutes: Int?): String = when {
    minutes == null -> ""
    minutes <= 0 -> t(R.string.commute_now)
    minutes < 60 -> t(R.string.commute_in_minutes, minutes)
    else -> t(R.string.commute_in_hours_minutes, minutes / 60, minutes % 60)
}

fun commuteDurationText(minutes: Int): String =
    if (minutes < 60) t(R.string.commute_duration_minutes, minutes) else t(R.string.commute_duration_hours, minutes / 60, minutes % 60)

fun commuteTransfersText(count: Int): String = if (count <= 0) t(R.string.commute_direct) else tp(R.plurals.commute_transfers, count, count)

fun commutePlatformText(leg: Leg, point: Point = leg.from): String =
    if (point.platform.isBlank()) "" else t(if (leg.type == StopType.TRAIN) R.string.commute_platform_train else R.string.commute_platform_other, point.platform)

fun commuteOccupancyText(level: Int?): String = when (occupancyLevel(level)) {
    OccupancyLevel.LOW -> t(R.string.commute_occupancy_low)
    OccupancyLevel.MEDIUM -> t(R.string.commute_occupancy_medium)
    OccupancyLevel.HIGH -> t(R.string.commute_occupancy_high)
    null -> t(R.string.commute_occupancy_unknown)
}

fun stopTypeLabel(type: StopType): String = when (type) {
    StopType.TRAIN -> t(R.string.commute_type_train)
    StopType.BUS -> t(R.string.commute_type_bus)
    StopType.TRAM -> t(R.string.commute_type_tram)
    StopType.SHIP -> t(R.string.commute_type_ship)
    StopType.CABLEWAY -> t(R.string.commute_type_cableway)
    StopType.OTHER -> t(R.string.commute_type_other)
}

fun stopTypeIcon(type: StopType): ImageVector = when (type) {
    StopType.TRAIN -> Icons.Outlined.Train
    StopType.BUS -> Icons.Outlined.DirectionsBus
    StopType.TRAM -> Icons.Outlined.Tram
    StopType.SHIP -> Icons.Outlined.DirectionsBoat
    StopType.CABLEWAY -> Icons.Outlined.Terrain
    StopType.OTHER -> Icons.Outlined.Place
}

/** "nimm den Bus um 15:05": the vehicle of the first ride picks the wording. */
fun commuteLessonBanner(board: RouteBoard): Pair<String, String>? {
    val trip = board.trips.firstOrNull() ?: return null
    val clock = isoClock(trip.departure.ifBlank { trip.plannedDeparture })
    val type = trip.firstRide()?.type
    return when (board.target.lessonChange) {
        LessonChange.LAST_CANCELLED -> {
            val title = t(R.string.commute_last_cancelled_title)
            val body = when (type) {
                StopType.BUS -> t(R.string.commute_take_bus, clock)
                StopType.TRAIN -> t(R.string.commute_take_train, clock)
                else -> t(R.string.commute_take_connection, clock)
            }
            title to body
        }
        LessonChange.FIRST_CANCELLED -> t(R.string.commute_first_cancelled_title) to t(R.string.commute_first_cancelled_body, clock)
        LessonChange.NONE -> null
    }
}

// ── Colours ──────────────────────────────────────────────────────────────────

/** Container and content colours of a delay badge: green, quiet, amber, red, solid red. */
@Composable
fun delayColors(cls: DelayClass): Pair<Color, Color> {
    val s = LocalCompanionSemantics.current
    val scheme = MaterialTheme.colorScheme
    return when (cls) {
        DelayClass.ON_TIME -> s.successSoft to s.success
        DelayClass.MINOR -> s.sunken to scheme.onSurface
        DelayClass.MODERATE -> s.warningSoft to s.warning
        DelayClass.MAJOR -> s.dangerSoft to scheme.error
        DelayClass.CANCELLED -> scheme.error to scheme.onError
    }
}

/** Foreground colour of the delay text itself (no container). */
@Composable
fun delayInk(cls: DelayClass): Color = when (cls) {
    DelayClass.ON_TIME -> LocalCompanionSemantics.current.success
    DelayClass.MINOR -> MaterialTheme.colorScheme.onSurface
    DelayClass.MODERATE -> LocalCompanionSemantics.current.warning
    DelayClass.MAJOR, DelayClass.CANCELLED -> MaterialTheme.colorScheme.error
}

/** The line colours the provider sent, with a readable text colour when theirs is missing or too faint. */
fun lineChipColors(bgHex: String, fgHex: String, fallbackBg: Color, fallbackFg: Color): Pair<Color, Color> {
    val bg = expandHexColor(bgHex)?.let { parseHexColor(it) } ?: return fallbackBg to fallbackFg
    val given = expandHexColor(fgHex)?.let { parseHexColor(it) }
    val fg = if (given != null && contrastRatio(given, bg) >= 3.0) given
        else if (contrastRatio(0xFFFFFFFF.toInt(), bg) >= contrastRatio(0xFF000000.toInt(), bg)) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()
    return Color(bg) to Color(fg)
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
fun LineChip(leg: Leg) {
    val scheme = MaterialTheme.colorScheme
    val (bg, fg) = lineChipColors(leg.bgColor, leg.fgColor, scheme.primaryContainer, scheme.primary)
    Text(
        leg.line.ifBlank { stopTypeLabel(leg.type) },
        style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = fg, maxLines = 1,
        modifier = Modifier.background(bg, RoundedCornerShape(7.dp)).padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

/** Delay as a small pill: "+4" on a coloured ground, "Fällt aus" solid red. */
@Composable
fun DelayBadge(cls: DelayClass, delay: Int?, modifier: Modifier = Modifier) {
    val (container, content) = delayColors(cls)
    val text = when (cls) {
        DelayClass.CANCELLED -> t(R.string.commute_cancelled)
        DelayClass.ON_TIME -> t(R.string.commute_on_time)
        else -> t(R.string.commute_delay_minutes, delay ?: 0)
    }
    Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = content, maxLines = 1,
        modifier = modifier.background(container, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 3.dp))
}

/** Planned time struck through next to the real one when they differ. */
@Composable
fun DepartureClock(trip: Trip, large: Boolean = true) {
    val planned = isoClock(trip.plannedDeparture)
    val real = isoClock(trip.departure.ifBlank { trip.plannedDeparture })
    val changed = planned.isNotBlank() && planned != real
    val cancelled = trip.unusable
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (changed) Text(planned, style = if (large) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textDecoration = TextDecoration.LineThrough, modifier = Modifier.padding(bottom = if (large) 4.dp else 0.dp))
        Text(real, style = if (large) MaterialTheme.typography.displaySmall else MaterialTheme.typography.titleMedium,
            color = if (cancelled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            textDecoration = if (cancelled) TextDecoration.LineThrough else TextDecoration.None, maxLines = 1, softWrap = false)
    }
}

/** 1-3 filled person icons for the load level; the class label in front. */
@Composable
fun OccupancyMeter(classLabel: String, level: Int?, modifier: Modifier = Modifier) {
    val s = LocalCompanionSemantics.current
    val on = when (occupancyLevel(level)) {
        OccupancyLevel.LOW -> s.success
        OccupancyLevel.MEDIUM -> s.warning
        OccupancyLevel.HIGH -> MaterialTheme.colorScheme.error
        null -> MaterialTheme.colorScheme.outline
    }
    val description = "$classLabel: ${commuteOccupancyText(level)}"
    Row(modifier.semantics(mergeDescendants = true) { contentDescription = description }, verticalAlignment = Alignment.CenterVertically) {
        Text(classLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 6.dp))
        repeat(3) { index ->
            val filled = level != null && index < level
            Icon(Icons.Outlined.Person, null, Modifier.size(16.dp), tint = if (filled) on else MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@Composable
fun OccupancyRow(occupancy: Occupancy, quietest: Boolean, modifier: Modifier = Modifier) {
    if (!occupancy.known() && !quietest) return
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
        if (occupancy.known()) {
            OccupancyMeter(t(R.string.commute_class_first), occupancy.first)
            OccupancyMeter(t(R.string.commute_class_second), occupancy.second)
        }
        if (quietest) Tag(t(R.string.commute_quieter), LocalCompanionSemantics.current.success)
    }
}

/** "Umsteigen in Knoten · 5 min · Gleis 5": tight in amber, broken in red, a changed platform in amber. [next] is the ride that follows. */
@Composable
fun TransferLine(change: Transfer, next: Leg? = null, modifier: Modifier = Modifier) {
    val s = LocalCompanionSemantics.current
    val platformChanged = next?.from?.platformChanged == true
    val color = when {
        change.broken -> MaterialTheme.colorScheme.error
        change.tight || platformChanged -> s.warning
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val base = when {
        change.broken -> t(R.string.commute_transfer_broken, change.at)
        change.tight -> t(R.string.commute_transfer_tight, change.at, change.minutes)
        else -> t(R.string.commute_transfer, change.at, change.minutes)
    }
    val platform = if (next == null || change.broken) "" else commutePlatformText(next).let { if (it.isNotBlank() && platformChanged) t(R.string.commute_platform_changed, it) else it }
    val text = if (platform.isBlank()) base else "$base · $platform"
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(if (change.broken) Icons.Outlined.ErrorOutline else Icons.Outlined.SyncAlt, null, Modifier.size(16.dp), tint = color)
        Text(text, style = MaterialTheme.typography.bodySmall, color = color, fontWeight = if (change.broken || change.tight || platformChanged) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp))
    }
}

@Composable
fun PlatformText(leg: Leg, point: Point = leg.from, modifier: Modifier = Modifier) {
    val text = commutePlatformText(leg, point)
    if (text.isBlank()) return
    val s = LocalCompanionSemantics.current
    if (point.platformChanged) {
        Row(modifier.background(s.warningSoft, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.ReportProblem, null, Modifier.size(14.dp), tint = s.warning)
            Text(t(R.string.commute_platform_changed, text), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = s.warning, maxLines = 1, modifier = Modifier.padding(start = 4.dp))
        }
    } else Text(text, modifier = modifier, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
}

/** A tinted notice with an icon: lesson changes, cancelled trips, stale data. */
@Composable
fun CommuteNotice(icon: ImageVector, title: String, body: String, container: Color, content: Color, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().background(container, MaterialTheme.shapes.medium).padding(horizontal = 14.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(icon, null, Modifier.padding(top = 1.dp).size(20.dp), tint = content)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
            if (body.isNotBlank()) Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

/** One line for the settings row: how many routes, or an invitation. */
fun commuteSettingsSummary(ui: CommuteUi): String =
    if (ui.routes.isEmpty()) t(R.string.commute_settings_empty) else tp(R.plurals.commute_routes_count, ui.routes.size, ui.routes.size)
