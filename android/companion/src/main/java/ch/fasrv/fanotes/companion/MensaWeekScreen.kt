package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.MensaDay
import ch.fasrv.fanotes.schulnetz.MensaFeed
import ch.fasrv.fanotes.schulnetz.MensaMenu
import ch.fasrv.fanotes.schulnetz.MensaWeekSlot
import ch.fasrv.fanotes.schulnetz.mensaPreselectedDate
import ch.fasrv.fanotes.schulnetz.mensaPrice
import ch.fasrv.fanotes.schulnetz.mensaWeekSlots
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** "Monday, 16. November": the heading of a Mensa day. */
fun mensaDayTitle(date: LocalDate): String = date.format(DateTimeFormatter.ofPattern("EEEE, d. MMMM", Locale.getDefault()))

/** One dish: optional label chip, name, short description and the student price. Shared by the Today card and the week page. */
@Composable
fun MensaDishRow(menu: MensaMenu) {
    val scheme = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (menu.label.isNotBlank()) Surface(color = scheme.secondaryContainer, shape = MaterialTheme.shapes.small) {
                    Text(menu.label, style = MaterialTheme.typography.labelSmall, color = scheme.onSecondaryContainer, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                }
                Text(menu.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f, fill = false))
            }
            if (menu.description.isNotBlank()) Text(menu.description, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        }
        menu.studentPrice?.let { Text(t(R.string.mensa_student_price, mensaPrice(it)), style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant) }
    }
}

/** The whole-week Mensa page. */
@Composable
fun MensaWeekScreen(model: CompanionModel) {
    val zone = remember { ZoneId.of("Europe/Zurich") }
    val now = remember { LocalDateTime.now(zone) }
    LaunchedEffect(Unit) { model.refreshMensa() }
    MensaWeekContent(model.mensa, now, LocalOnline.current, model.mensaRefreshing) { model.refreshMensa(force = true) }
}

/** Stateless-ish body of the page (keeps only the selected day), so screenshots and tests can drive it with fixed data. */
@Composable
fun MensaWeekContent(feed: MensaFeed?, now: LocalDateTime, online: Boolean, refreshing: Boolean, onRefresh: () -> Unit) {
    val slots = remember(feed, now.toLocalDate()) { feed?.let { mensaWeekSlots(it.days, now.toLocalDate()) }.orEmpty() }
    val preselected = remember(slots, now) { mensaPreselectedDate(slots, now) }
    var chosen by rememberSaveable { mutableStateOf<String?>(null) }
    val selected = slots.firstOrNull { it.date.toString() == chosen }?.date ?: preselected
    val selectedIndex = slots.indexOfFirst { it.date == selected }
    val move: (Int) -> Unit = { step -> slots.getOrNull(selectedIndex + step)?.let { chosen = it.date.toString() } }
    val empty = feed == null || slots.all { it.day == null }
    RefreshableScreenList(refreshing, onRefresh) {
        if (feed != null && feed.fetchedAt.isNotBlank()) item(key = "stamp") {
            val stamp = updatedLabel(feed.fetchedAt)
            StatusLine(if (online) t(R.string.mensa_updated, stamp) else t(R.string.offline_last_updated, stamp), if (online) StateTone.Neutral else StateTone.Offline, Modifier.padding(bottom = 8.dp))
        }
        if (feed?.stale == true) item(key = "stale") {
            StatusLine(t(R.string.mensa_stale_note), StateTone.Warning, Modifier.padding(bottom = 8.dp))
        }
        if (empty) {
            item(key = "empty") {
                EmptyState(Icons.Outlined.Restaurant, t(R.string.mensa_empty_title), if (online) t(R.string.mensa_empty_body) else t(R.string.mensa_offline_body), tone = if (online) StateTone.Neutral else StateTone.Offline)
            }
        } else {
            item(key = "chips") { MensaDayChips(slots, now.toLocalDate(), selected) { chosen = it.toString() } }
            item(key = "day") {
                val slot = slots.getOrNull(selectedIndex)
                val threshold = with(LocalDensity.current) { 64.dp.toPx() }
                Column(
                    Modifier.fillMaxWidth().heightIn(min = 320.dp).padding(top = 12.dp)
                        .pointerInput(selectedIndex, slots) {
                            var total = 0f
                            detectHorizontalDragGestures(onDragStart = { total = 0f }, onDragEnd = { if (total > threshold) move(-1) else if (total < -threshold) move(1) }, onDragCancel = { total = 0f }) { _, amount -> total += amount }
                        },
                ) {
                    if (slot != null) MensaDayBody(slot)
                }
            }
        }
    }
}

@Composable
private fun MensaDayBody(slot: MensaWeekSlot) {
    val day: MensaDay? = slot.day
    Text(mensaDayTitle(slot.date), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 8.dp).semantics { heading() })
    Group {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                day == null -> Text(t(R.string.mensa_no_menu_day), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                day.closed -> Text(day.note.ifBlank { t(R.string.mensa_closed) }, style = MaterialTheme.typography.bodyMedium)
                else -> day.menus.forEach { MensaDishRow(it) }
            }
        }
    }
}

/** Day chips, grouped under a "This week" / "Next week" label. Past days are muted but stay selectable. */
@Composable
private fun MensaDayChips(slots: List<MensaWeekSlot>, today: LocalDate, selected: LocalDate?, onSelect: (LocalDate) -> Unit) {
    val groups = remember(slots) { slots.groupBy { it.nextWeek }.toList() }
    val state = rememberLazyListState()
    val selectedGroup = groups.indexOfFirst { (_, list) -> list.any { it.date == selected } }
    LaunchedEffect(selectedGroup) { if (selectedGroup > 0) state.scrollToItem(selectedGroup) }
    LazyRow(state = state, horizontalArrangement = Arrangement.spacedBy(20.dp), modifier = Modifier.fillMaxWidth()) {
        items(groups, key = { it.first }) { (next, list) ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(if (next) t(R.string.mensa_next_week) else t(R.string.mensa_this_week), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { heading() })
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    list.forEach { slot -> MensaDayChip(slot, past = slot.date < today, selected = slot.date == selected) { onSelect(slot.date) } }
                }
            }
        }
    }
}

@Composable
private fun MensaDayChip(slot: MensaWeekSlot, past: Boolean, selected: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val container = if (selected) scheme.onSurface else LocalCompanionSemantics.current.sunken
    val content = if (selected) scheme.surface else scheme.onSurface
    val weekday = slot.date.format(DateTimeFormatter.ofPattern("EEE", Locale.getDefault()))
    val description = t(R.string.mensa_day_chip, weekday, slot.date.format(DateTimeFormatter.ofPattern("d. MMMM", Locale.getDefault())))
    Column(
        Modifier.defaultMinSize(minWidth = 52.dp, minHeight = 56.dp).background(container, RoundedCornerShape(16.dp))
            .alpha(if (past && !selected) 0.55f else 1f)
            .clickable(role = Role.Tab, onClick = onClick)
            .semantics(mergeDescendants = true) { this.selected = selected; contentDescription = description }
            .padding(horizontal = 8.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Text(weekday, style = MaterialTheme.typography.labelMedium, color = content, maxLines = 1, textAlign = TextAlign.Center)
        Text(slot.date.dayOfMonth.toString(), style = MaterialTheme.typography.titleMedium, color = content, maxLines = 1)
    }
}
