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
        Surface(color = MaterialTheme.colorScheme.primary, shape = MaterialTheme.shapes.large, modifier = Modifier.size(52.dp)) {
            Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.EditNote, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(30.dp)) }
        }
        Spacer(Modifier.height(24.dp))
        Text(if (register) "A place for your work." else "Your day. Your notes.", style = MaterialTheme.typography.headlineLarge)
        Text(if (register) "Create your FaNotes account." else "A calmer school day, with everything you need close at hand.",
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 28.dp))
        OutlinedTextField(model.email, { model.email = it }, Modifier.fillMaxWidth(), label = { Text("Email") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), shape = MaterialTheme.shapes.small)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(model.password, { model.password = it }, Modifier.fillMaxWidth(), label = { Text("Password") }, singleLine = true,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = { ActionIcon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) "Hide password" else "Show password") { visible = !visible } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); if (!model.busy) model.login(register) }), shape = MaterialTheme.shapes.small)
        if (register) {
            Text("Your notes are end-to-end encrypted. Keep your password safe: a forgotten password cannot be recovered.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
        }
        Button(onClick = { focus.clearFocus(); model.login(register) }, enabled = !model.busy && model.email.isNotBlank() && model.password.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 24.dp).heightIn(min = 50.dp)) {
            if (model.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            else Text(if (register) "Create account" else "Sign in")
        }
        TextButton(onClick = { register = !register; model.message = null }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text(if (register) "Already have an account? Sign in" else "Create an account") }
        if (onboarding) {
            FineDivider()
            TextButton(onClick = model::continueLocally, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("Continue on this device") }
            Text("You can connect an account later to sync your work and link Schulnetz.", style = MaterialTheme.typography.bodySmall,
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
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
fun DateControl(label: String, value: LocalDate?, allowClear: Boolean = false, onDate: (LocalDate?) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { picking = true }, modifier = Modifier.weight(1f).heightIn(min = 52.dp), shape = MaterialTheme.shapes.small, contentPadding = PaddingValues(horizontal = 12.dp)) {
            Icon(Icons.Outlined.CalendarToday, null, Modifier.size(18.dp)); Spacer(Modifier.width(10.dp))
            Text("$label: ${value?.let { dueLabel(it.toString()) } ?: "None"}", modifier = Modifier.weight(1f))
        }
        if (allowClear && value != null) ActionIcon(Icons.Outlined.Close, "Clear $label") { onDate(null) }
    }
    if (picking) {
        val state = rememberDatePickerState(initialSelectedDateMillis = (value ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(onDismissRequest = { picking = false }, confirmButton = {
            TextButton(onClick = { state.selectedDateMillis?.let { onDate(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }; picking = false }) { Text("Choose") }
        }, dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } }) { DatePicker(state, showModeToggle = true) }
    }
}

@Composable
fun TimeControl(label: String, value: String, allowClear: Boolean = false, onTime: (String) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { picking = true }, modifier = Modifier.weight(1f).heightIn(min = 52.dp), shape = MaterialTheme.shapes.small) {
            Icon(Icons.Outlined.Schedule, null, Modifier.size(18.dp)); Spacer(Modifier.width(10.dp)); Text("$label: ${value.ifBlank { "None" }}", Modifier.weight(1f))
        }
        if (allowClear && value.isNotBlank()) ActionIcon(Icons.Outlined.Close, "Clear $label") { onTime("") }
    }
    if (picking) {
        val initial = runCatching { LocalTime.parse(value) }.getOrDefault(LocalTime.of(9, 0))
        val state = rememberTimePickerState(initialHour = initial.hour, initialMinute = initial.minute, is24Hour = true)
        AlertDialog(onDismissRequest = { picking = false }, modifier = Modifier.imePadding(), title = { Text(label) }, text = { TimeInput(state) },
            confirmButton = { TextButton(onClick = { onTime("%02d:%02d".format(state.hour, state.minute)); picking = false }) { Text("Choose") } },
            dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } })
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
    var formError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).sheetKeyboardPadding().padding(horizontal = Space.page)) {
            SheetTitle(if (task == null) "New task" else "Task details", onDismiss)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(title, { title = it.take(240) }, label = { Text("What needs doing?") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                OutlinedTextField(subject, { subject = it.take(80) }, label = { Text("Subject") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                DateControl("Due", parseDisplayDate(date), true) { date = it?.toString().orEmpty() }
                if (date.isNotBlank()) TimeControl("Time", time, true) { time = it }
                ToggleRow("Important", "Keep this task easy to spot", important) { important = it }
                ToggleRow("Appointment", "An appointment rather than homework", appointment) { appointment = it }
                OutlinedTextField(notes, { notes = it.take(4000) }, label = { Text("Details") }, modifier = Modifier.fillMaxWidth(), minLines = 4)
                if (task != null) TextButton(onClick = { confirm = true }) { Icon(Icons.Outlined.DeleteOutline, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Delete task", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.height(16.dp))
            }
            formError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(onClick = { saving = true; model.saveTask((task ?: HomeworkTask(id, title)).copy(title = title.trim(), subject = subject.trim(), dueDate = date.ifBlank { null }, dueTime = time.takeIf { date.isNotBlank() && it.isNotBlank() }, notes = notes, priority = if (important) "high" else "normal", kind = if (appointment) "appointment" else "homework"), onDismiss, { formError = it; saving = false }) },
                enabled = title.isNotBlank() && !saving, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp).heightIn(min = 50.dp)) { Text(if (saving) "Saving…" else "Save task") }
        }
    }
    if (confirm && task != null) ConfirmDialog("Delete this task?", "This removes it from your Kanti+ task list.", "Delete", { confirm = false }) { model.deleteTask(task); onDismiss() }
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
            SheetTitle(if (event == null) "New event" else "Edit event", onDismiss)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(title, { title = it.take(240) }, label = { Text("Event title") }, modifier = Modifier.fillMaxWidth())
                ChoiceRow(model.calendar.calendars.map { it.id to it.name }, calendar, { calendar = it })
                ToggleRow("All day", checked = allDay) { allDay = it }
                DateControl("Starts", parseDisplayDate(start)) { it?.let { day -> start = day.toString(); if (end < start) end = start } }
                if (!allDay) TimeControl("Starts at", startTime) { startTime = it }
                DateControl("Ends", parseDisplayDate(end)) { it?.let { day -> end = day.toString() } }
                if (!allDay) TimeControl("Ends at", endTime) { endTime = it }
                if (endValue < startValue) Text("End must be after the start.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(location, { location = it }, label = { Text("Location") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(notes, { notes = it }, label = { Text("Details") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                if (event != null && event.recurrence != "none") Text("Repeats ${event.recurrence}. Changes apply to the series.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (event != null) TextButton(onClick = { confirm = true }) { Text("Delete ${if (event.recurrence != "none") "series" else "event"}", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.height(16.dp))
            }
            formError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(onClick = { saving = true; model.saveEvent((event ?: CalendarEvent(id, calendar, title, startValue, endValue)).copy(title = title.trim(), calendarId = calendar, start = startValue, end = endValue, allDay = allDay, location = location, notes = notes), onDismiss, { formError = it; saving = false }) },
                enabled = valid && !saving, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp).heightIn(min = 50.dp)) { Text(if (saving) "Saving…" else "Save event") }
        }
    }
    if (confirm && event != null) ConfirmDialog("Delete ${if (event.recurrence != "none") "this series" else "this event"}?", "This removes it from your Kanti+ calendar.", "Delete", { confirm = false }) { model.deleteEvent(event); onDismiss() }
}
