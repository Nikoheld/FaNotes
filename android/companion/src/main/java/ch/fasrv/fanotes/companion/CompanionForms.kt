@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.desk.CalendarEvent
import ch.fasrv.fanotes.desk.HomeworkTask
import java.time.*
import java.util.UUID

@Composable
fun AccountScreen(model: CompanionModel, onboarding: Boolean = false, modifier: Modifier = Modifier) {
    var register by rememberSaveable { mutableStateOf(false) }
    var visible by rememberSaveable { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    Column(modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(Space.xl).widthIn(max = 480.dp), verticalArrangement = Arrangement.Center) {
        IconTile(Icons.Outlined.EditNote, StateTone.Accent, 56.dp)
        Spacer(Modifier.height(24.dp))
        Text(if (register) t(R.string.a_place_for_your_work) else t(R.string.your_day_your_notes), style = MaterialTheme.typography.headlineLarge)
        Text(if (register) t(R.string.create_your_fanotes_account) else t(R.string.a_calmer_school_day_with_everything_you_need_clo),
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 28.dp))
        OutlinedTextField(model.email, { model.email = it }, Modifier.fillMaxWidth(), label = { Text(t(R.string.email)) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), shape = MaterialTheme.shapes.medium)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(model.password, { model.password = it }, Modifier.fillMaxWidth(), label = { Text(t(R.string.password)) }, singleLine = true,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = { ActionIcon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) t(R.string.hide_password) else t(R.string.show_password)) { visible = !visible } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); if (!model.busy) model.login(register) }), shape = MaterialTheme.shapes.medium)
        if (register) Box(Modifier.padding(top = 14.dp)) {
            InfoBanner(t(R.string.end_to_end_title), t(R.string.your_notes_are_end_to_end_encrypted_keep_your_pa), tone = StateTone.Accent)
        }
        Button(onClick = { focus.clearFocus(); model.login(register) }, enabled = !model.busy && model.email.isNotBlank() && model.password.isNotBlank(), shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(top = 24.dp).heightIn(min = Space.button)) {
            if (model.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            else Text(if (register) t(R.string.create_account) else t(R.string.sign_in))
        }
        TextButton(onClick = { register = !register; model.message = null }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text(if (register) t(R.string.already_have_an_account_sign_in) else t(R.string.create_an_account)) }
        if (onboarding) {
            FineDivider()
            TextButton(onClick = model::continueLocally, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text(t(R.string.continue_on_this_device)) }
            Text(t(R.string.you_can_connect_notes_later_school_features_stay), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
fun NameDialog(title: String, label: String, confirm: String, initial: String = "", onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var value by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), shape = MaterialTheme.shapes.extraLarge, title = { Text(title, style = MaterialTheme.typography.headlineSmall) }, text = {
        OutlinedTextField(value, { value = it.take(120) }, label = { Text(label) }, singleLine = true, shape = MaterialTheme.shapes.medium,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { if (value.isNotBlank()) onConfirm(value.trim()) }))
    }, confirmButton = { TextButton(onClick = { onConfirm(value.trim()) }, enabled = value.isNotBlank()) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(t(R.string.cancel)) } })
}

@Composable
fun DateControl(label: String, value: LocalDate?, allowClear: Boolean = false, onDate: (LocalDate?) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        FieldButton(Icons.Outlined.CalendarToday, label, value?.let { dueLabel(it.toString()) } ?: t(R.string.none), Modifier.weight(1f)) { picking = true }
        if (allowClear && value != null) ActionIcon(Icons.Outlined.Close, t(R.string.clear, label)) { onDate(null) }
    }
    if (picking) {
        val state = rememberDatePickerState(initialSelectedDateMillis = (value ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(onDismissRequest = { picking = false }, confirmButton = {
            TextButton(onClick = { state.selectedDateMillis?.let { onDate(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }; picking = false }) { Text(t(R.string.choose)) }
        }, dismissButton = { TextButton(onClick = { picking = false }) { Text(t(R.string.cancel)) } }) { DatePicker(state, showModeToggle = true) }
    }
}

@Composable
fun TimeControl(label: String, value: String, allowClear: Boolean = false, onTime: (String) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        FieldButton(Icons.Outlined.Schedule, label, value.ifBlank { t(R.string.none) }, Modifier.weight(1f)) { picking = true }
        if (allowClear && value.isNotBlank()) ActionIcon(Icons.Outlined.Close, t(R.string.clear, label)) { onTime("") }
    }
    if (picking) {
        val initial = runCatching { LocalTime.parse(value) }.getOrDefault(LocalTime.of(9, 0))
        val state = rememberTimePickerState(initialHour = initial.hour, initialMinute = initial.minute, is24Hour = true)
        AlertDialog(onDismissRequest = { picking = false }, modifier = Modifier.imePadding(), shape = MaterialTheme.shapes.extraLarge, title = { Text(label, style = MaterialTheme.typography.headlineSmall) }, text = { TimeInput(state) },
            confirmButton = { TextButton(onClick = { onTime("%02d:%02d".format(state.hour, state.minute)); picking = false }) { Text(t(R.string.choose)) } },
            dismissButton = { TextButton(onClick = { picking = false }) { Text(t(R.string.cancel)) } })
    }
}

@Composable
fun TaskForm(model: CompanionModel, task: HomeworkTask? = null, onDismiss: () -> Unit) {
    val id = rememberSaveable(task?.id) { task?.id ?: UUID.randomUUID().toString() }
    var title by rememberSaveable(id) { mutableStateOf(task?.title.orEmpty()) }
    var subject by rememberSaveable(id) { mutableStateOf(task?.subject.orEmpty()) }
    var date by rememberSaveable(id) { mutableStateOf(task?.dueDate.orEmpty()) }
    var time by rememberSaveable(id) { mutableStateOf(task?.dueTime.orEmpty()) }
    var notes by rememberSaveable(id) { mutableStateOf(task?.notes.orEmpty()) }
    var important by rememberSaveable(id) { mutableStateOf(task?.priority == "high") }
    var appointment by rememberSaveable(id) { mutableStateOf(task?.kind == "appointment") }
    var confirm by remember { mutableStateOf(false) }
    var discard by remember { mutableStateOf(false) }
    var formError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val dirty = taskDraftDirty(
        task != null,
        title,
        subject,
        date,
        time,
        notes,
        important,
        appointment,
        task?.title.orEmpty(),
        task?.subject.orEmpty(),
        task?.dueDate.orEmpty(),
        task?.dueTime.orEmpty(),
        task?.notes.orEmpty(),
        task?.priority == "high",
        task?.kind == "appointment",
    )
    fun requestClose() {
        if (dirty) discard = true else onDismiss()
    }
    KantiSheet(onDismiss = { requestClose() }, full = true) {
        SheetTitle(if (task == null) t(R.string.new_task) else t(R.string.task_details)) { requestClose() }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(title, { title = it.take(240) }, label = { Text(t(R.string.what_needs_doing)) }, modifier = Modifier.fillMaxWidth(), minLines = 2, shape = MaterialTheme.shapes.medium, textStyle = MaterialTheme.typography.titleMedium)
            OutlinedTextField(subject, { subject = it.take(80) }, label = { Text(t(R.string.subject)) }, modifier = Modifier.fillMaxWidth(), singleLine = true, shape = MaterialTheme.shapes.medium)
            DateControl(t(R.string.due), parseDisplayDate(date), true) { date = it?.toString().orEmpty() }
            if (date.isNotBlank()) TimeControl(t(R.string.time_label), time, true) { time = it }
            Group(color = LocalCompanionSemantics.current.sunken.copy(alpha = 0.55f)) {
                ToggleRow(t(R.string.important), t(R.string.keep_this_task_easy_to_spot), important) { important = it }
                FineDivider()
                ToggleRow(t(R.string.appointment), t(R.string.an_appointment_rather_than_homework), appointment) { appointment = it }
            }
            OutlinedTextField(notes, { notes = it.take(4000) }, label = { Text(t(R.string.details)) }, modifier = Modifier.fillMaxWidth(), minLines = 4, shape = MaterialTheme.shapes.medium)
            if (task != null) TextButton(onClick = { confirm = true }) { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error); Spacer(Modifier.width(8.dp)); Text(t(R.string.delete_task), color = MaterialTheme.colorScheme.error) }
            Spacer(Modifier.height(16.dp))
        }
        formError?.let { Text(shownText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        PrimaryButton(if (saving) t(R.string.saving) else t(R.string.save_task), { saving = true; model.saveTask((task ?: HomeworkTask(id, title)).copy(title = title.trim(), subject = subject.trim(), dueDate = date.ifBlank { null }, dueTime = time.takeIf { date.isNotBlank() && it.isNotBlank() }, notes = notes, priority = if (important) "high" else "normal", kind = if (appointment) "appointment" else "homework"), onDismiss, { formError = it; saving = false }) },
            Modifier.fillMaxWidth().padding(vertical = 16.dp), enabled = title.isNotBlank() && !saving)
    }
    if (confirm && task != null) ConfirmDialog(t(R.string.delete_this_task), t(R.string.this_removes_it_from_your_kanti_task_list), t(R.string.delete), { confirm = false }) { model.deleteTask(task); onDismiss() }
    if (discard) ConfirmDialog(t(R.string.discard_task_title), t(R.string.discard_task_body), t(R.string.discard), { discard = false }) { discard = false; onDismiss() }
}

@Composable
fun EventForm(model: CompanionModel, event: CalendarEvent? = null, onDismiss: () -> Unit) {
    val id = rememberSaveable(event?.id) { event?.id ?: UUID.randomUUID().toString() }
    var title by rememberSaveable(id) { mutableStateOf(event?.title.orEmpty()) }
    var start by rememberSaveable(id) { mutableStateOf(event?.start?.take(10) ?: model.day.toString()) }
    var end by rememberSaveable(id) { mutableStateOf(event?.end?.take(10) ?: model.day.toString()) }
    var allDay by rememberSaveable(id) { mutableStateOf(event?.allDay ?: true) }
    var startTime by rememberSaveable(id) { mutableStateOf(event?.start?.substringAfter('T', "09:00")?.take(5) ?: "09:00") }
    var endTime by rememberSaveable(id) { mutableStateOf(event?.end?.substringAfter('T', "10:00")?.take(5) ?: "10:00") }
    var location by rememberSaveable(id) { mutableStateOf(event?.location.orEmpty()) }
    var notes by rememberSaveable(id) { mutableStateOf(event?.notes.orEmpty()) }
    var calendar by rememberSaveable(id) { mutableStateOf(event?.calendarId ?: model.calendar.calendars.first().id) }
    var confirm by remember { mutableStateOf(false) }
    var formError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val startValue = if (allDay) start else "${start}T$startTime"
    val endValue = if (allDay) end else "${end}T$endTime"
    val valid = title.isNotBlank() && endValue >= startValue
    KantiSheet(onDismiss = onDismiss, full = true) {
            SheetTitle(if (event == null) t(R.string.new_event) else t(R.string.edit_event), onDismiss)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(title, { title = it.take(240) }, label = { Text(t(R.string.event_title)) }, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium, textStyle = MaterialTheme.typography.titleMedium)
                ChoiceRow(model.calendar.calendars.map { it.id to it.name }, calendar, { calendar = it })
                Group(color = LocalCompanionSemantics.current.sunken.copy(alpha = 0.55f)) { ToggleRow(t(R.string.all_day), checked = allDay) { allDay = it } }
                DateControl(t(R.string.starts), parseDisplayDate(start)) { it?.let { day -> start = day.toString(); if (end < start) end = start } }
                if (!allDay) TimeControl(t(R.string.starts_at), startTime) { startTime = it }
                DateControl(t(R.string.ends), parseDisplayDate(end)) { it?.let { day -> end = day.toString() } }
                if (!allDay) TimeControl(t(R.string.ends_at), endTime) { endTime = it }
                if (endValue < startValue) Text(t(R.string.end_must_be_after_the_start), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(location, { location = it }, label = { Text(t(R.string.location)) }, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium, leadingIcon = { Icon(Icons.Outlined.Place, null) })
                OutlinedTextField(notes, { notes = it }, label = { Text(t(R.string.details)) }, modifier = Modifier.fillMaxWidth(), minLines = 3, shape = MaterialTheme.shapes.medium)
                if (event != null && event.recurrence != "none") Text(t(R.string.repeats_changes_apply_to_the_series, recurrenceLabel(event.recurrence)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (event != null) TextButton(onClick = { confirm = true }) { Text(t(R.string.delete_2, if (event.recurrence != "none") t(R.string.series_noun) else t(R.string.event_noun)), color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.height(16.dp))
            }
            formError?.let { Text(shownText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            PrimaryButton(if (saving) t(R.string.saving) else t(R.string.save_event), { saving = true; model.saveEvent((event ?: CalendarEvent(id, calendar, title, startValue, endValue)).copy(title = title.trim(), calendarId = calendar, start = startValue, end = endValue, allDay = allDay, location = location, notes = notes), onDismiss, { formError = it; saving = false }) },
                Modifier.fillMaxWidth().padding(vertical = 16.dp), enabled = valid && !saving)
    }
    if (confirm && event != null) ConfirmDialog(t(R.string.delete_3, if (event.recurrence != "none") t(R.string.this_series) else t(R.string.this_event)), t(R.string.this_removes_it_from_your_kanti_calendar), t(R.string.delete), { confirm = false }) { model.deleteEvent(event); onDismiss() }
}

/** A tappable value that looks like a form field: date and time pickers. */
@Composable
fun FieldButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Row(modifier.heightIn(min = 56.dp).clip(MaterialTheme.shapes.medium).border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.medium)
        .clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
