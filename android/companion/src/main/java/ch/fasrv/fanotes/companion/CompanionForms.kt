@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.clickable
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
fun WelcomeScreen(model: CompanionModel, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Space.xl).widthIn(max = 480.dp), verticalArrangement = Arrangement.Center) {
        Surface(color = MaterialTheme.colorScheme.primary, shape = MaterialTheme.shapes.large, modifier = Modifier.size(52.dp)) {
            Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.School, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(30.dp)) }
        }
        Spacer(Modifier.height(24.dp))
        Text(t(R.string.kanti), style = MaterialTheme.typography.headlineLarge)
        Text(t(R.string.grades_timetable_exams_and_absences_ready_on_thi),
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 28.dp))
        Button(onClick = { model.finishWelcome(connectSchool = true, openNotes = false) }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text(t(R.string.connect_schulnetz)) }
        OutlinedButton(onClick = { model.finishWelcome(connectSchool = false, openNotes = true) }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().padding(top = 12.dp).heightIn(min = 50.dp)) { Text(t(R.string.sync_notes_with_fanotes)) }
        TextButton(onClick = { model.finishWelcome(connectSchool = false, openNotes = false) }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.continue_action)) }
        Text(t(R.string.school_features_work_without_an_account_notes_sy),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
fun AccountScreen(model: CompanionModel, onboarding: Boolean = false, modifier: Modifier = Modifier) {
    var register by rememberSaveable { mutableStateOf(false) }
    var visible by rememberSaveable { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    Column(modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(Space.xl).widthIn(max = 480.dp), verticalArrangement = Arrangement.Center) {
        Surface(color = MaterialTheme.colorScheme.primary, shape = MaterialTheme.shapes.large, modifier = Modifier.size(52.dp)) {
            Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.EditNote, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(30.dp)) }
        }
        Spacer(Modifier.height(24.dp))
        Text(if (register) t(R.string.a_place_for_your_work) else t(R.string.your_day_your_notes), style = MaterialTheme.typography.headlineLarge)
        Text(if (register) t(R.string.create_your_fanotes_account) else t(R.string.a_calmer_school_day_with_everything_you_need_clo),
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 28.dp))
        OutlinedTextField(model.email, { model.email = it }, Modifier.fillMaxWidth(), label = { Text(t(R.string.email)) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), shape = MaterialTheme.shapes.small)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(model.password, { model.password = it }, Modifier.fillMaxWidth(), label = { Text(t(R.string.password)) }, singleLine = true,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = { ActionIcon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) t(R.string.hide_password) else t(R.string.show_password)) { visible = !visible } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); if (!model.busy) model.login(register) }), shape = MaterialTheme.shapes.small)
        if (register) {
            Text(t(R.string.your_notes_are_end_to_end_encrypted_keep_your_pa),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
        }
        Button(onClick = { focus.clearFocus(); model.login(register) }, enabled = !model.busy && model.email.isNotBlank() && model.password.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 24.dp).heightIn(min = 50.dp)) {
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
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), title = { Text(title) }, text = {
        OutlinedTextField(value, { value = it.take(120) }, label = { Text(label) }, singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { if (value.isNotBlank()) onConfirm(value.trim()) }))
    }, confirmButton = { TextButton(onClick = { onConfirm(value.trim()) }, enabled = value.isNotBlank()) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(t(R.string.cancel)) } })
}

@Composable
fun DateControl(label: String, value: LocalDate?, allowClear: Boolean = false, onDate: (LocalDate?) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { picking = true }, modifier = Modifier.weight(1f).heightIn(min = 52.dp), shape = MaterialTheme.shapes.small, contentPadding = PaddingValues(horizontal = 12.dp)) {
            Icon(Icons.Outlined.CalendarToday, null, Modifier.size(18.dp)); Spacer(Modifier.width(10.dp))
            Text(t(R.string.text_4, label, value?.let { dueLabel(it.toString()) } ?: t(R.string.none)), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
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
        OutlinedButton(onClick = { picking = true }, modifier = Modifier.weight(1f).heightIn(min = 52.dp), shape = MaterialTheme.shapes.small) {
            Icon(Icons.Outlined.Schedule, null, Modifier.size(18.dp)); Spacer(Modifier.width(10.dp)); Text(t(R.string.text_4, label, value.ifBlank { t(R.string.none) }), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (allowClear && value.isNotBlank()) ActionIcon(Icons.Outlined.Close, t(R.string.clear, label)) { onTime("") }
    }
    if (picking) {
        val initial = runCatching { LocalTime.parse(value) }.getOrDefault(LocalTime.of(9, 0))
        val state = rememberTimePickerState(initialHour = initial.hour, initialMinute = initial.minute, is24Hour = true)
        AlertDialog(onDismissRequest = { picking = false }, modifier = Modifier.imePadding(), title = { Text(label) }, text = { TimeInput(state) },
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
    ModalBottomSheet(onDismissRequest = { requestClose() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).sheetKeyboardPadding().padding(horizontal = Space.page)) {
            SheetTitle(if (task == null) t(R.string.new_task) else t(R.string.task_details)) { requestClose() }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(title, { title = it.take(240) }, label = { Text(t(R.string.what_needs_doing)) }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                OutlinedTextField(subject, { subject = it.take(80) }, label = { Text(t(R.string.subject)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                DateControl(t(R.string.due), parseDisplayDate(date), true) { date = it?.toString().orEmpty() }
                if (date.isNotBlank()) TimeControl(t(R.string.time_label), time, true) { time = it }
                ToggleRow(t(R.string.important), t(R.string.keep_this_task_easy_to_spot), important) { important = it }
                ToggleRow(t(R.string.appointment), t(R.string.an_appointment_rather_than_homework), appointment) { appointment = it }
                OutlinedTextField(notes, { notes = it.take(4000) }, label = { Text(t(R.string.details)) }, modifier = Modifier.fillMaxWidth(), minLines = 4)
                if (task != null) TextButton(onClick = { confirm = true }) { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(t(R.string.delete_task), color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.height(16.dp))
            }
            formError?.let { Text(shownText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(onClick = { saving = true; model.saveTask((task ?: HomeworkTask(id, title)).copy(title = title.trim(), subject = subject.trim(), dueDate = date.ifBlank { null }, dueTime = time.takeIf { date.isNotBlank() && it.isNotBlank() }, notes = notes, priority = if (important) "high" else "normal", kind = if (appointment) "appointment" else "homework"), onDismiss, { formError = it; saving = false }) },
                enabled = title.isNotBlank() && !saving, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp).heightIn(min = 50.dp)) { Text(if (saving) t(R.string.saving) else t(R.string.save_task)) }
        }
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
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).sheetKeyboardPadding().padding(horizontal = Space.page)) {
            SheetTitle(if (event == null) t(R.string.new_event) else t(R.string.edit_event), onDismiss)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(title, { title = it.take(240) }, label = { Text(t(R.string.event_title)) }, modifier = Modifier.fillMaxWidth())
                ChoiceRow(model.calendar.calendars.map { it.id to it.name }, calendar, { calendar = it })
                ToggleRow(t(R.string.all_day), checked = allDay) { allDay = it }
                DateControl(t(R.string.starts), parseDisplayDate(start)) { it?.let { day -> start = day.toString(); if (end < start) end = start } }
                if (!allDay) TimeControl(t(R.string.starts_at), startTime) { startTime = it }
                DateControl(t(R.string.ends), parseDisplayDate(end)) { it?.let { day -> end = day.toString() } }
                if (!allDay) TimeControl(t(R.string.ends_at), endTime) { endTime = it }
                if (endValue < startValue) Text(t(R.string.end_must_be_after_the_start), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(location, { location = it }, label = { Text(t(R.string.location)) }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(notes, { notes = it }, label = { Text(t(R.string.details)) }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                if (event != null && event.recurrence != "none") Text(t(R.string.repeats_changes_apply_to_the_series, recurrenceLabel(event.recurrence)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (event != null) TextButton(onClick = { confirm = true }) { Text(t(R.string.delete_2, if (event.recurrence != "none") t(R.string.series_noun) else t(R.string.event_noun)), color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.height(16.dp))
            }
            formError?.let { Text(shownText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(onClick = { saving = true; model.saveEvent((event ?: CalendarEvent(id, calendar, title, startValue, endValue)).copy(title = title.trim(), calendarId = calendar, start = startValue, end = endValue, allDay = allDay, location = location, notes = notes), onDismiss, { formError = it; saving = false }) },
                enabled = valid && !saving, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp).heightIn(min = 50.dp)) { Text(if (saving) t(R.string.saving) else t(R.string.save_event)) }
        }
    }
    if (confirm && event != null) ConfirmDialog(t(R.string.delete_3, if (event.recurrence != "none") t(R.string.this_series) else t(R.string.this_event)), t(R.string.this_removes_it_from_your_kanti_calendar), t(R.string.delete), { confirm = false }) { model.deleteEvent(event); onDismiss() }
}
