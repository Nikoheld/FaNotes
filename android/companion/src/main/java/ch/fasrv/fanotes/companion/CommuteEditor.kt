@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.commute.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.time.DayOfWeek
import java.time.format.TextStyle
import java.util.Locale

/** Wait after the last keystroke before asking for stops. */
const val STOP_SEARCH_DEBOUNCE_MS = 250L
const val STOP_SEARCH_MIN_CHARS = 2

/**
 * The route editor: stops with autocomplete, name, schedule, alert threshold. The draft lives with the
 * caller ([onChange]); [searchStops] asks the server. Nothing here talks to the network by itself.
 */
@Composable
fun CommuteEditor(
    route: Route,
    isNew: Boolean,
    defaultThreshold: Int,
    saving: Boolean,
    searchStops: suspend (String) -> List<Stop>,
    onChange: (Route) -> Unit,
    onSave: () -> Unit,
    onDelete: (() -> Unit)?,
    modifier: Modifier = Modifier,
    /** Trips from an ISO time for the draft's stops (the connection picker). */
    loadConnections: suspend (Route, String) -> List<Trip> = { _, _ -> emptyList() },
    /** Open the picker at once ("Neu wählen" on a missing connection). */
    openPicker: Boolean = false,
    onPickerHandled: () -> Unit = {},
) {
    var confirmDelete by remember { mutableStateOf(false) }
    var pinsCleared by remember { mutableStateOf(false) }
    // Changing the stops or vias invalidates fixed connections: drop them and say so.
    val change: (Route) -> Unit = { next ->
        val kept = withPinsKeptOnlyIfJourneySame(route, next)
        if (kept.pins.size != next.pins.size) pinsCleared = true
        onChange(kept)
    }
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = Space.page).padding(top = 4.dp, bottom = LocalPageBottomPadding.current),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        PageIntro(if (isNew) t(R.string.commute_new_route) else t(R.string.commute_edit_route), t(R.string.commute_editor_intro))

        StopField(t(R.string.commute_from), route.from.takeIf { it.name.isNotBlank() }, searchStops, { change(route.copy(from = it ?: Stop())) })
        StopField(t(R.string.commute_to), route.to.takeIf { it.name.isNotBlank() }, searchStops, { change(route.copy(to = it ?: Stop())) })
        StopField(t(R.string.commute_via), route.vias.getOrNull(0), searchStops, { change(withViaAt(route, 0, it)) }, optional = true)
        if (route.vias.isNotEmpty()) StopField(t(R.string.commute_via_second), route.vias.getOrNull(1), searchStops, { change(withViaAt(route, 1, it)) }, optional = true)

        PinSection(route, pinsCleared, loadConnections, openPicker, onPickerHandled, onChange)

        OutlinedTextField(route.name, { onChange(route.copy(name = it.take(MAX_ROUTE_NAME))) }, Modifier.fillMaxWidth(),
            label = { Text(t(R.string.commute_name)) }, placeholder = { Text(t(R.string.commute_name_hint)) }, singleLine = true,
            shape = MaterialTheme.shapes.medium, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done))

        SectionLabel(t(R.string.commute_when))
        ScheduleEditor(route.schedule) { onChange(route.copy(schedule = it)) }

        SectionLabel(t(R.string.commute_alerts))
        Group {
            ToggleRow(t(R.string.commute_alerts_for_route), t(R.string.commute_alerts_for_route_body), route.notify) { onChange(route.copy(notify = it)) }
        }
        Text(t(R.string.commute_threshold_route), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        ChoiceRow(
            listOf("" to t(R.string.commute_threshold_default, defaultThreshold)) + DELAY_THRESHOLD_CHOICES.map { it.toString() to t(R.string.commute_minutes_short, it) },
            route.delayThreshold?.toString().orEmpty(),
            { onChange(route.copy(delayThreshold = it.toIntOrNull())) },
        )

        PrimaryButton(t(R.string.save), onSave, Modifier.fillMaxWidth().padding(top = 8.dp), enabled = routeSavable(route) && !saving)
        if (!routeSavable(route)) Text(t(R.string.commute_save_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (onDelete != null) SecondaryButton(t(R.string.commute_delete_route), { confirmDelete = true }, Modifier.fillMaxWidth(), enabled = !saving, icon = Icons.Outlined.DeleteOutline, danger = true)
    }
    if (confirmDelete && onDelete != null) ConfirmDialog(t(R.string.commute_delete_title, routeTitle(route)), t(R.string.commute_delete_body), t(R.string.delete), { confirmDelete = false }) { confirmDelete = false; onDelete() }
}

// ── Stop with autocomplete ───────────────────────────────────────────────────

private sealed interface StopSearch {
    data object Idle : StopSearch
    data object Loading : StopSearch
    data class Found(val stops: List<Stop>) : StopSearch
    data object Failed : StopSearch
}

/**
 * A chosen stop shows as a card with a clear button. Otherwise a text field: after [STOP_SEARCH_DEBOUNCE_MS]
 * of quiet and at least [STOP_SEARCH_MIN_CHARS] characters the matching stops are listed below it,
 * each with an icon for its kind (train, bus, tram, ...).
 */
@Composable
fun StopField(label: String, stop: Stop?, search: suspend (String) -> List<Stop>, onPick: (Stop?) -> Unit, optional: Boolean = false) {
    if (stop != null) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.medium).padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Icon(stopTypeIcon(stop.type), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(stop.name, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            ActionIcon(Icons.Outlined.Close, t(R.string.commute_clear_stop, label)) { onPick(null) }
        }
        return
    }
    var query by rememberSaveable(label) { mutableStateOf("") }
    var state by remember { mutableStateOf<StopSearch>(StopSearch.Idle) }
    LaunchedEffect(query) {
        val text = query.trim()
        if (text.length < STOP_SEARCH_MIN_CHARS) { state = StopSearch.Idle; return@LaunchedEffect }
        state = StopSearch.Loading
        delay(STOP_SEARCH_DEBOUNCE_MS)
        state = try { StopSearch.Found(search(text)) } catch (error: CancellationException) { throw error } catch (_: Exception) { StopSearch.Failed }
    }
    Column(Modifier.fillMaxWidth()) {
        OutlinedTextField(query, { query = it.take(60) }, Modifier.fillMaxWidth(),
            label = { Text(if (optional) t(R.string.commute_optional, label) else label) },
            placeholder = { Text(t(R.string.commute_stop_hint)) },
            leadingIcon = { Icon(Icons.Outlined.Search, null) },
            trailingIcon = if (query.isNotEmpty()) ({ IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, t(R.string.clear_search)) } }) else null,
            singleLine = true, shape = MaterialTheme.shapes.medium, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search))
        when (val result = state) {
            StopSearch.Idle -> Unit
            StopSearch.Loading -> LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 6.dp, start = 4.dp, end = 4.dp).height(2.dp))
            StopSearch.Failed -> Text(t(R.string.commute_search_failed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
            is StopSearch.Found -> if (result.stops.isEmpty()) {
                Text(t(R.string.commute_no_stops), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
            } else Group(Modifier.padding(top = 6.dp)) {
                result.stops.forEachIndexed { index, item ->
                    if (index > 0) FineDivider()
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(role = Role.Button) { query = ""; state = StopSearch.Idle; onPick(item) }.padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(stopTypeIcon(item.type), null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Column(Modifier.weight(1f)) {
                            Text(item.name, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(stopTypeLabel(item.type), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

// ── Schedule ─────────────────────────────────────────────────────────────────

@Composable
fun ScheduleEditor(schedule: Schedule, onChange: (Schedule) -> Unit) {
    ChoiceRow(
        listOf(
            ScheduleMode.NONE.wire to t(R.string.commute_mode_none), ScheduleMode.TIMES.wire to t(R.string.commute_mode_times),
            ScheduleMode.FIRST_LESSON.wire to t(R.string.commute_mode_first), ScheduleMode.LAST_LESSON.wire to t(R.string.commute_mode_last),
        ),
        schedule.mode.wire, { onChange(schedule.copy(mode = ScheduleMode.of(it))) },
    )
    Text(
        when (schedule.mode) {
            ScheduleMode.NONE -> t(R.string.commute_mode_none_body)
            ScheduleMode.TIMES -> t(R.string.commute_mode_times_body)
            ScheduleMode.FIRST_LESSON -> t(R.string.commute_mode_first_body)
            ScheduleMode.LAST_LESSON -> t(R.string.commute_mode_last_body)
        },
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (schedule.mode == ScheduleMode.TIMES) TimesEditor(schedule.times) { onChange(schedule.copy(times = it)) }
    if (schedule.mode != ScheduleMode.NONE) WeekdayPicker(schedule.days) { onChange(schedule.copy(days = it)) }
    if (schedule.mode == ScheduleMode.FIRST_LESSON || schedule.mode == ScheduleMode.LAST_LESSON) {
        BufferStepper(
            if (schedule.mode == ScheduleMode.FIRST_LESSON) t(R.string.commute_buffer_first, schedule.bufferMinutes) else t(R.string.commute_buffer_last, schedule.bufferMinutes),
            schedule.bufferMinutes,
        ) { onChange(schedule.copy(bufferMinutes = it)) }
    }
}

@Composable
private fun TimesEditor(times: List<String>, onChange: (List<String>) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        times.forEach { time ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).background(LocalCompanionSemantics.current.sunken, MaterialTheme.shapes.medium).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Schedule, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(time, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 12.dp).weight(1f))
                ActionIcon(Icons.Outlined.Close, t(R.string.commute_remove_time, time)) { onChange(times - time) }
            }
        }
        if (times.size < MAX_SCHEDULE_TIMES) {
            var adding by remember { mutableStateOf(false) }
            SecondaryButton(t(R.string.commute_add_time), { adding = true }, Modifier.fillMaxWidth(), icon = Icons.Outlined.Add)
            if (adding) {
                val state = rememberTimePickerState(initialHour = 7, initialMinute = 5, is24Hour = true)
                AlertDialog(onDismissRequest = { adding = false }, modifier = Modifier.imePadding(), shape = MaterialTheme.shapes.extraLarge,
                    title = { Text(t(R.string.commute_add_time), style = MaterialTheme.typography.headlineSmall) }, text = { TimeInput(state) },
                    confirmButton = { TextButton(onClick = { onChange(normalizedTimes(times + "%02d:%02d".format(state.hour, state.minute))); adding = false }) { Text(t(R.string.choose)) } },
                    dismissButton = { TextButton(onClick = { adding = false }) { Text(t(R.string.cancel)) } })
            }
        } else Text(t(R.string.commute_times_limit, MAX_SCHEDULE_TIMES), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun WeekdayPicker(days: List<Int>, onChange: (List<Int>) -> Unit) {
    Row(Modifier.fillMaxWidth().semantics { contentDescription = t(R.string.commute_weekdays) }, horizontalArrangement = Arrangement.SpaceBetween) {
        (1..7).forEach { day ->
            val on = day in days
            val name = DayOfWeek.of(day).getDisplayName(TextStyle.SHORT, Locale.getDefault()).trimEnd('.')
            val full = DayOfWeek.of(day).getDisplayName(TextStyle.FULL, Locale.getDefault())
            Box(Modifier.size(48.dp).toggleable(on, role = Role.Checkbox, onValueChange = { next -> onChange((if (next) days + day else days - day).distinct().sorted()) })
                .semantics { contentDescription = full }, contentAlignment = Alignment.Center) {
                Box(Modifier.size(40.dp).background(if (on) MaterialTheme.colorScheme.onSurface else LocalCompanionSemantics.current.sunken, CircleShape), contentAlignment = Alignment.Center) {
                    Text(name.take(2), style = MaterialTheme.typography.labelLarge, color = if (on) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.onSurface, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun BufferStepper(label: String, minutes: Int, onChange: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).background(LocalCompanionSemantics.current.sunken, MaterialTheme.shapes.medium).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
        ActionIcon(Icons.Outlined.Remove, t(R.string.commute_less), enabled = minutes > 0) { onChange((minutes - 5).coerceAtLeast(0)) }
        ActionIcon(Icons.Outlined.Add, t(R.string.commute_more), enabled = minutes < MAX_BUFFER_MINUTES) { onChange((minutes + 5).coerceAtMost(MAX_BUFFER_MINUTES)) }
    }
}

// ── Fixed connection ─────────────────────────────────────────────────────────

private fun weekdayName(day: Int) = DayOfWeek.of(day).getDisplayName(TextStyle.FULL, Locale.getDefault())

/** What the picker is choosing for: [days] get the picked pin; [weekday] picks the travel date. */
private data class PickerTarget(val days: List<Int>, val weekday: Int)

/**
 * "Feste Verbindung": none, the same every day, or one per weekday. The picker lists real connections for the
 * draft's stops and stores the chosen trip's pin on the draft; nothing is saved until the route is.
 */
@Composable
private fun PinSection(
    route: Route,
    cleared: Boolean,
    loadConnections: suspend (Route, String) -> List<Trip>,
    openPicker: Boolean,
    onPickerHandled: () -> Unit,
    onChange: (Route) -> Unit,
) {
    val ready = route.from.name.isNotBlank() && route.to.name.isNotBlank()
    val days = dailyPinDays(route.schedule)
    var mode by rememberSaveable { mutableStateOf(pinModeOf(route.pins).name) }
    val current = PinMode.valueOf(mode)
    var target by remember { mutableStateOf<PickerTarget?>(null) }
    LaunchedEffect(openPicker, ready) {
        if (!openPicker || !ready) return@LaunchedEffect
        onPickerHandled()
        val pin = route.pins.firstOrNull()
        val day = pin?.days?.firstOrNull() ?: days.first()
        if (pinModeOf(route.pins) == PinMode.NONE) mode = PinMode.DAILY.name
        target = if (current == PinMode.PER_DAY || pinModeOf(route.pins) == PinMode.PER_DAY) PickerTarget(listOf(day), day) else PickerTarget(days, days.first())
    }
    SectionLabel(t(R.string.commute_pin_title))
    Text(t(R.string.commute_pin_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    ChoiceRow(
        listOf(PinMode.NONE.name to t(R.string.commute_pin_none), PinMode.DAILY.name to t(R.string.commute_pin_daily), PinMode.PER_DAY.name to t(R.string.commute_pin_per_day)),
        mode,
        { picked ->
            val next = PinMode.valueOf(picked)
            mode = picked
            when (next) {
                PinMode.NONE -> onChange(route.copy(pins = emptyList()))
                PinMode.DAILY -> onChange(route.copy(pins = route.pins.firstOrNull()?.let { listOf(it.copy(days = days)) }.orEmpty()))
                PinMode.PER_DAY -> Unit
            }
        },
    )
    if (cleared && route.pins.isEmpty()) Text(t(R.string.commute_pin_cleared), style = MaterialTheme.typography.bodySmall, color = LocalCompanionSemantics.current.warning)
    if (current != PinMode.NONE && !ready) {
        Text(t(R.string.commute_pin_need_stops), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else if (current == PinMode.DAILY) {
        PinRow(null, route.pins.firstOrNull(), onChoose = { target = PickerTarget(days, days.first()) }, onRemove = { onChange(route.copy(pins = emptyList())) })
    } else if (current == PinMode.PER_DAY) {
        days.forEach { day ->
            PinRow(weekdayName(day), pinForWeekday(route.pins, day), onChoose = { target = PickerTarget(listOf(day), day) }, onRemove = { onChange(route.copy(pins = withoutPinDay(route.pins, day))) })
        }
    }
    target?.let { picker ->
        ConnectionPicker(route, picker.weekday, loadConnections, { target = null }) { trip ->
            val pin = pinFromTrip(trip, picker.days)
            if (pin != null) onChange(route.copy(pins = if (current == PinMode.DAILY) listOf(pin) else withPin(route.pins, pin)))
            target = null
        }
    }
}

@Composable
private fun PinRow(day: String?, pin: Pin?, onChoose: () -> Unit, onRemove: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(LocalCompanionSemantics.current.sunken, MaterialTheme.shapes.medium).padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (day != null) Text(day, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Text(if (pin == null) t(R.string.commute_pin_none_day) else commutePinSummary(pin), style = MaterialTheme.typography.bodyLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (pin == null) SecondaryButton(t(R.string.commute_pin_choose), onChoose, icon = Icons.Outlined.PushPin)
            else {
                SecondaryButton(t(R.string.commute_pin_change), onChoose, icon = Icons.Outlined.Edit)
                TextButton(onClick = onRemove) { Text(t(R.string.commute_pin_remove)) }
            }
        }
    }
}

private sealed interface PickerLoad {
    data object Loading : PickerLoad
    data class Done(val trips: List<Trip>, val emptyPage: Boolean = false) : PickerLoad
    data object Failed : PickerLoad
}

/**
 * Bottom sheet with real connections on the next [weekday]: from a start time, "earlier"/"later" paging,
 * tap one to take it. Every request goes through [loadConnections] off the main thread.
 */
@Composable
private fun ConnectionPicker(route: Route, weekday: Int, loadConnections: suspend (Route, String) -> List<Trip>, onDismiss: () -> Unit, onPick: (Trip) -> Unit) {
    val date = remember(weekday) { nextDateWithWeekday(java.time.LocalDate.now(COMMUTE_ZONE), weekday) }
    var clock by rememberSaveable { mutableStateOf(defaultPickerTime(route.schedule)) }
    var at by remember { mutableStateOf(pickerAtIso(date, clock)) }
    var load by remember { mutableStateOf<PickerLoad>(PickerLoad.Loading) }
    var shown by remember { mutableStateOf(emptyList<Trip>()) }
    var editingTime by remember { mutableStateOf(false) }
    LaunchedEffect(at) {
        load = PickerLoad.Loading
        load = try {
            val trips = loadConnections(route, at)
            if (trips.isEmpty() && shown.isNotEmpty()) PickerLoad.Done(shown, emptyPage = true).also { } else PickerLoad.Done(trips).also { shown = trips }
        } catch (error: CancellationException) { throw error } catch (_: Exception) { PickerLoad.Failed }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Space.page).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(t(R.string.commute_pin_picker_title), style = MaterialTheme.typography.headlineSmall)
            Text(t(R.string.commute_pin_picker_day, weekdayName(weekday), commutePinDayText(date.toString())), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).background(LocalCompanionSemantics.current.sunken, MaterialTheme.shapes.medium).clickable(role = Role.Button) { editingTime = true }.padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Schedule, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(t(R.string.commute_pin_start_time), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 12.dp).weight(1f))
                Text(clock, style = MaterialTheme.typography.titleMedium)
            }
            val loading = load is PickerLoad.Loading
            TextButton(onClick = { pickerPageAt(shown, later = false)?.let { at = it } }, enabled = !loading && shown.isNotEmpty()) {
                Icon(Icons.Outlined.KeyboardArrowUp, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(t(R.string.commute_earlier))
            }
            when (val state = load) {
                PickerLoad.Loading -> LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                PickerLoad.Failed -> Text(t(R.string.commute_pin_failed), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                is PickerLoad.Done -> if (state.trips.isEmpty() || state.emptyPage) Text(t(R.string.commute_pin_no_trips), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            shown.forEach { trip ->
                val pickable = trip.pin != null
                Surface(onClick = { onPick(trip) }, enabled = pickable, color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = commuteTripBrief(trip) + ", " + t(R.string.commute_pin_pick) }) {
                    CommuteTripSummary(trip, showArrival = true, modifier = Modifier.padding(16.dp))
                }
            }
            TextButton(onClick = { pickerPageAt(shown, later = true)?.let { at = it } }, enabled = !loading && shown.isNotEmpty()) {
                Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(t(R.string.commute_later))
            }
        }
    }
    if (editingTime) {
        val parts = clock.split(':')
        val state = rememberTimePickerState(initialHour = parts.getOrNull(0)?.toIntOrNull() ?: 6, initialMinute = parts.getOrNull(1)?.toIntOrNull() ?: 30, is24Hour = true)
        AlertDialog(onDismissRequest = { editingTime = false }, modifier = Modifier.imePadding(), shape = MaterialTheme.shapes.extraLarge,
            title = { Text(t(R.string.commute_pin_start_time), style = MaterialTheme.typography.headlineSmall) }, text = { TimeInput(state) },
            confirmButton = { TextButton(onClick = { clock = "%02d:%02d".format(state.hour, state.minute); at = pickerAtIso(date, clock); shown = emptyList(); editingTime = false }) { Text(t(R.string.choose)) } },
            dismissButton = { TextButton(onClick = { editingTime = false }) { Text(t(R.string.cancel)) } })
    }
}
