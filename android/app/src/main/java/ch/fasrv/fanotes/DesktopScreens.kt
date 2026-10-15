package ch.fasrv.fanotes

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.measureDocument
import ch.fasrv.fanotes.desk.marginLinesFromTranscript
import ch.fasrv.fanotes.desk.readPdfMarks
import ch.fasrv.fanotes.desk.wikiTargets
import ch.fasrv.fanotes.desk.parseNoteTags
import ch.fasrv.fanotes.desk.Breadcrumb
import ch.fasrv.fanotes.desk.SwitcherNote
import ch.fasrv.fanotes.desk.dueCards
import ch.fasrv.fanotes.desk.fuzzyScore
import ch.fasrv.fanotes.desk.PendingConfirm
import ch.fasrv.fanotes.desk.confirmDialogKeyAction
import ch.fasrv.fanotes.desk.confirmDialogTabTarget
import ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH
import ch.fasrv.fanotes.desk.CalendarEvent
import ch.fasrv.fanotes.desk.LaidOutSpan
import ch.fasrv.fanotes.desk.allDaySpans
import ch.fasrv.fanotes.desk.calendarOccurrenceWindow
import ch.fasrv.fanotes.desk.dragCreateMinutes
import ch.fasrv.fanotes.desk.timedDayLayout
import ch.fasrv.fanotes.desk.parseNoteOutline
import ch.fasrv.fanotes.desk.taskLines
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.YearMonth
import kotlin.math.roundToInt

private val RibbonDestinations = listOf(
    "notes" to "Notizen",
    "search" to "Suchen",
    "tasks" to "Aufgaben",
    "calendar" to "Kalender",
    "overview" to "Übersicht",
    "cards" to "Karten",
    "books" to "Fachbuch",
    "history" to "Verlauf",
    "study" to "Lernzeit",
    "ai" to "AI",
    "settings" to "Einstellungen",
)

@Composable
fun DeskRibbon(
    destination: String,
    focus: Boolean,
    onDestination: (String) -> Unit,
    onPalette: () -> Unit,
    onFocus: () -> Unit,
    onDaily: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().height(44.dp).background(MaterialTheme.colorScheme.surface).horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("F", modifier = Modifier.padding(end = 8.dp), fontWeight = FontWeight.SemiBold)
        Text("FaNotes", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(end = 12.dp))
        if (!focus) {
            RibbonDestinations.forEach { (id, label) ->
                Text(
                    label,
                    modifier = Modifier
                        .padding(horizontal = 2.dp)
                        .background(if (destination == id) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                        .clickable { onDestination(id) }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    fontSize = 13.sp,
                    color = if (destination == id) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f),
                )
            }
        }
        Text("Suchen…", modifier = Modifier.padding(start = 8.dp).clickable(onClick = onPalette).padding(6.dp), fontSize = 13.sp)
        Text("Heute", modifier = Modifier.clickable(onClick = onDaily).padding(6.dp), fontSize = 13.sp)
        Text(if (focus) "Fokus aus" else "Fokus", modifier = Modifier.clickable(onClick = onFocus).padding(6.dp), fontSize = 13.sp)
    }
}

@Composable
fun DeskStatusBar(
    words: Int,
    syncText: String,
    language: String,
    showWords: Boolean,
    conflicts: Int = 0,
    onConflicts: () -> Unit = {},
    crumbs: List<Breadcrumb> = emptyList(),
    onCrumb: (String) -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().height(28.dp).background(MaterialTheme.colorScheme.surface).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(
            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(syncText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            if (conflicts > 0) {
                Text(
                    "$conflicts Konflikte",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(onClick = onConflicts),
                )
            }
            crumbs.forEachIndexed { index, crumb ->
                if (index > 0) Text("›", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f))
                if (crumb.isNote) {
                    Text(crumb.label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                } else {
                    Text(
                        crumb.label,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.primary,
                        maxLines = 1,
                        modifier = Modifier.clickable { onCrumb(crumb.path) },
                    )
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(language, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            if (showWords) Text("$words Wörter", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        }
    }
}

@Composable
fun NoteTabs(
    paths: List<String>,
    selected: String?,
    pinned: Set<String>,
    canBack: Boolean,
    canForward: Boolean,
    onOpen: (String) -> Unit,
    onClose: (String) -> Unit,
    onBack: () -> Unit,
    onForward: () -> Unit,
) {
    if (paths.isEmpty() && !canBack && !canForward) return
    val muted = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "← Zurück",
            fontSize = 12.sp,
            color = if (canBack) MaterialTheme.colorScheme.onSurface else muted,
            modifier = Modifier.padding(end = 4.dp).then(if (canBack) Modifier.clickable(onClick = onBack) else Modifier).padding(horizontal = 6.dp, vertical = 4.dp),
        )
        Text(
            "→",
            fontSize = 12.sp,
            color = if (canForward) MaterialTheme.colorScheme.onSurface else muted,
            modifier = Modifier.padding(end = 8.dp).then(if (canForward) Modifier.clickable(onClick = onForward) else Modifier).padding(horizontal = 6.dp, vertical = 4.dp),
        )
        paths.forEach { path ->
            val name = path.substringAfterLast('/').substringBeforeLast('.')
            Row(
                Modifier.padding(end = 4.dp).background(if (path == selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent).clickable { onOpen(path) }.padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (path in pinned) Text("● ", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                Text(name, fontSize = 12.sp, maxLines = 1)
                Text("  ×", modifier = Modifier.clickable { onClose(path) }, fontSize = 12.sp)
            }
        }
    }
}

@Composable
fun SearchScreen(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val query by model.searchQuery.collectAsStateWithLifecycle()
    val hits by model.searchHits.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        OutlinedTextField(query, { model.searchVaultText(it) }, modifier = Modifier.fillMaxWidth(), label = { Text("Im Vault suchen") }, singleLine = true)
        LazyColumn(Modifier.padding(top = 8.dp)) {
            items(hits, key = { "${it.path}:${it.line}:${it.anchorY}:${it.text}" }) { hit ->
                Column(Modifier.fillMaxWidth().clickable { model.openSearchHit(hit); onOpen(hit.path) }.padding(vertical = 8.dp)) {
                    Text(hit.path + if (hit.anchorY != null) "  · Handschrift" else "", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                    Text(hit.text, maxLines = 2)
                }
            }
        }
    }
}

@Composable
fun HomeworkScreen(model: FaNotesViewModel) {
    val document by model.homework.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val status by model.message.collectAsStateWithLifecycle()
    var title by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var due by remember { mutableStateOf(LocalDate.now().plusDays(1).toString()) }
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Hausaufgaben & Termine", style = MaterialTheme.typography.titleLarge)
        Text("Gespeichert in Hausaufgaben.md, dieselbe Datei wie auf dem Desktop.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Text("Freigabe", modifier = Modifier.padding(top = 12.dp), fontWeight = FontWeight.SemiBold)
        Text("Dieselbe Schnittstelle wie der Desktop: PUT an fanotes.fasrv.ch, Kanal-ID und Geheimnis bleiben auf diesem Tablet.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        OutlinedTextField(
            settings["homework-channel"].orEmpty(),
            { model.updateDesk("homework-channel", it.trim()) },
            label = { Text("Kanal-ID") },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        OutlinedTextField(
            settings["homework-secret"].orEmpty(),
            { model.updateDesk("homework-secret", it.trim()) },
            label = { Text("Geheimnis") },
            modifier = Modifier.fillMaxWidth(),
        )
        Row {
            TextButton(onClick = { model.generateHomeworkAccess() }) { Text("Kanal erzeugen") }
            TextButton(onClick = { model.publishHomework() }) { Text("Veröffentlichen") }
        }
        if (!status.isNullOrBlank()) Text(status.orEmpty(), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
            OutlinedTextField(title, { title = it }, label = { Text("Aufgabe") }, modifier = Modifier.weight(1f))
            OutlinedTextField(subject, { subject = it }, label = { Text("Fach") }, modifier = Modifier.weight(0.6f))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(due, { due = it }, label = { Text("Fällig") })
            TextButton(onClick = {
                if (title.isNotBlank()) {
                    model.addHomework(title, subject, due, "homework")
                    title = ""
                }
            }) { Text("Hinzufügen") }
            TextButton(onClick = {
                if (title.isNotBlank()) {
                    model.addHomework(title, subject, due, "appointment")
                    title = ""
                }
            }) { Text("Termin") }
        }
        document.tasks.forEach { task ->
            Row(Modifier.fillMaxWidth().clickable { model.toggleHomework(task.id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (task.done) "☑" else "☐", modifier = Modifier.padding(end = 8.dp))
                Column {
                    Text(task.title, fontWeight = if (task.priority == "high") FontWeight.Bold else FontWeight.Normal)
                    Text(listOf(task.subject, task.dueDate, if (task.kind == "appointment") "Termin" else "Aufgabe").filter { !it.isNullOrBlank() }.joinToString(" · "), fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
fun CalendarScreen(model: FaNotesViewModel, onOpenNote: (String) -> Unit, onImportIcs: () -> Unit = {}, onExportIcs: () -> Unit = {}) {
    val document by model.calendar.collectAsStateWithLifecycle()
    val status by model.message.collectAsStateWithLifecycle()
    var dismissedReminders by remember { mutableStateOf(setOf<String>()) }
    val reminder = ch.fasrv.fanotes.desk.dueReminders(document, java.time.ZonedDateTime.now()).firstOrNull { it.key !in dismissedReminders }
    var month by remember { mutableStateOf(YearMonth.now()) }
    var title by remember { mutableStateOf("") }
    var time by remember { mutableStateOf("") }
    var anchor by remember { mutableStateOf(LocalDate.now()) }
    var view by remember { mutableStateOf("month") }
    var recurrence by remember { mutableStateOf("none") }
    var calendarQuery by remember { mutableStateOf("") }
    val calendarId = document.calendars.firstOrNull { it.visible }?.id ?: document.calendars.firstOrNull()?.id ?: "personal"
    val shown = document.copy(
        events = ch.fasrv.fanotes.desk.visibleCalendarEvents(document).filter { event ->
            val name = document.calendars.find { it.id == event.calendarId }?.name.orEmpty()
            ch.fasrv.fanotes.desk.calendarEventMatches(event, name, calendarQuery)
        },
    )
    var calendarName by remember { mutableStateOf("") }
    var editor by remember { mutableStateOf<CalendarDraft?>(null) }
    val day = anchor.toString()
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Kalender", style = MaterialTheme.typography.titleLarge)
        Text("Gespeichert in Kalender.md.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        TextButton(onClick = { onOpenNote(CALENDAR_NOTE_PATH) }) { Text("Als Notiz öffnen") }
        CalendarLists(model, document, calendarName) { calendarName = it }
        OutlinedTextField(calendarQuery, { calendarQuery = it }, label = { Text("Im Kalender suchen") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        if (reminder != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${reminder.title} beginnt ${if (reminder.minutesUntil == 0) "jetzt" else "in ${reminder.minutesUntil} min"}.",
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { dismissedReminders = dismissedReminders + reminder.key }) { Text("Schließen") }
            }
        }
        if (!status.isNullOrBlank()) Text(status.orEmpty(), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            listOf("day" to "Tag", "three" to "3 Tage", "week" to "Woche", "month" to "Monat", "agenda" to "Agenda").forEach { (id, label) ->
                TextButton(onClick = {
                    view = id
                    if (id == "month") month = YearMonth.from(anchor)
                }) {
                    Text(label, color = if (view == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, fontWeight = if (view == id) FontWeight.SemiBold else FontWeight.Normal)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = {
                anchor = LocalDate.now()
                month = YearMonth.now()
            }) { Text("Heute") }
            TextButton(onClick = {
                anchor = when (view) {
                    "day" -> anchor.minusDays(1)
                    "three" -> anchor.minusDays(3)
                    "week" -> anchor.minusWeeks(1)
                    "agenda" -> anchor.minusDays(28)
                    else -> month.minusMonths(1).atDay(1).also { month = YearMonth.from(it) }
                }
            }) { Text("‹") }
            Text(if (view == "month") month.toString() else day, modifier = Modifier.padding(horizontal = 8.dp))
            TextButton(onClick = {
                anchor = when (view) {
                    "day" -> anchor.plusDays(1)
                    "three" -> anchor.plusDays(3)
                    "week" -> anchor.plusWeeks(1)
                    "agenda" -> anchor.plusDays(28)
                    else -> month.plusMonths(1).atDay(1).also { month = YearMonth.from(it) }
                }
            }) { Text("›") }
        }
        when (view) {
            "month" -> MonthGrid(month, anchor, shown) { anchor = it }
            "agenda" -> AgendaList(anchor, shown) { event, date -> editor = draftFor(event, date) }
            else -> DayColumns(
                ch.fasrv.fanotes.desk.calendarRange(view, anchor),
                anchor,
                shown,
                { event, date -> editor = draftFor(event, date) },
                { anchor = it },
                { key, start -> model.moveCalendarOccurrence(key, start) },
                { key, end -> model.resizeCalendarOccurrence(key, end) },
                { date, start, end, allDay -> editor = draftForCreate(document, date, start, end, allDay) },
            )
        }
        Text("Am $day", modifier = Modifier.padding(top = 8.dp), fontWeight = FontWeight.SemiBold)
        EventsOn(model, shown, anchor) { editor = draftFor(it, anchor) }
        editor?.let { current ->
            CalendarEventEditor(
                document = document,
                draft = current,
                onChange = { editor = it },
                onDismiss = { editor = null },
                onSave = {
                    model.saveCalendarOccurrence(if (current.creating) null else current.key, current.toEvent())
                    editor = null
                },
                onDuplicate = {
                    model.duplicateCalendarEvent(current.id)
                    editor = null
                },
                onDeleteOne = {
                    model.skipCalendarOccurrence(current.id, current.key.substringAfter('@'))
                    editor = null
                },
                onDeleteSeries = {
                    model.deleteCalendarEvent(current.id)
                    editor = null
                },
                onOpenNote = {
                    if (current.notePath.isNotBlank()) onOpenNote(current.notePath)
                    editor = null
                },
            )
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            listOf("none" to "Einmal", "daily" to "Täglich", "weekly" to "Wöchentlich", "monthly" to "Monatlich", "yearly" to "Jährlich").forEach { (id, label) ->
                TextButton(onClick = { recurrence = id }) {
                    Text(label, color = if (recurrence == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(title, { title = it }, label = { Text("Neuer Termin") }, modifier = Modifier.weight(1f))
            OutlinedTextField(time, { time = it }, label = { Text("Uhrzeit") }, modifier = Modifier.weight(0.5f))
            TextButton(onClick = {
                if (title.isNotBlank()) {
                    model.addCalendarEvent(title, day, calendarId, recurrence, time)
                    title = ""
                }
            }) { Text("Eintragen") }
            TextButton(onClick = onExportIcs) { Text("Exportieren") }
            TextButton(onClick = onImportIcs) { Text("Importieren") }
        }
    }
}

@Composable
private fun MonthGrid(month: YearMonth, anchor: LocalDate, document: ch.fasrv.fanotes.desk.CalendarDocument, onPick: (LocalDate) -> Unit) {
    val start = month.atDay(1)
    val offset = (start.dayOfWeek.value + 6) % 7
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So").forEach { Text(it, fontSize = 12.sp, modifier = Modifier.weight(1f)) }
    }
    val cells = offset + month.lengthOfMonth()
    for (week in 0 until (cells + 6) / 7) {
        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
            for (column in 0 until 7) {
                val index = week * 7 + column
                val date = if (index >= offset && index < offset + month.lengthOfMonth()) month.atDay(index - offset + 1) else null
                val count = if (date == null) 0 else document.events.count { ch.fasrv.fanotes.desk.occurrencesOn(it, date) }
                Text(
                    if (date == null) "" else "${date.dayOfMonth}${if (count > 0) " ·$count" else ""}",
                    modifier = Modifier.weight(1f).clickable(enabled = date != null) { if (date != null) onPick(date) }.padding(4.dp),
                    fontSize = 13.sp,
                    color = if (date == anchor) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

private const val HOUR_DP = 48

@Composable
private fun DayColumns(
    days: List<LocalDate>,
    anchor: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    onPick: (LocalDate) -> Unit,
    onMove: (String, LocalDateTime) -> Unit,
    onResize: (String, LocalDateTime) -> Unit,
    onCreate: (LocalDate, LocalDateTime, LocalDateTime, Boolean) -> Unit,
) {
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    LaunchedEffect(days) {
        scroll.scrollTo(with(density) { (7 * HOUR_DP).dp.roundToPx() })
    }
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Row {
            Box(Modifier.width(44.dp))
            days.forEach { date ->
                Column(Modifier.width(148.dp).padding(end = 4.dp).padding(bottom = 4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "${date.dayOfMonth}. ${date.monthValue}.",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp,
                            color = if (date == anchor) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f).clickable { onPick(date) },
                        )
                        Text(
                            "+",
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.clickable {
                                onCreate(date, date.atStartOfDay(), date.plusDays(1).atStartOfDay(), true)
                            }.padding(horizontal = 6.dp),
                        )
                    }
                    allDaySpans(document, date).forEach { span ->
                        val tint = document.calendars.find { it.id == span.event.calendarId }?.color ?: "#7f6df2"
                        Text(
                            span.event.title,
                            fontSize = 12.sp,
                            color = inkOn(tint),
                            modifier = Modifier.fillMaxWidth().padding(top = 2.dp).background(calendarSwatch(tint)).clickable { onEdit(span.event, date) }.padding(horizontal = 4.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
        Row(Modifier.height(420.dp).verticalScroll(scroll)) {
            Column(Modifier.width(44.dp)) {
                for (hour in 0..23) {
                    Text(
                        "%02d:00".format(hour),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f),
                        modifier = Modifier.height(HOUR_DP.dp),
                    )
                }
            }
            days.forEach { date ->
                HourColumn(date, timedDayLayout(document, date), document, onEdit, onMove, onResize, onCreate)
            }
        }
    }
}

@Composable
private fun HourColumn(
    day: LocalDate,
    slices: List<LaidOutSpan>,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    onMove: (String, LocalDateTime) -> Unit,
    onResize: (String, LocalDateTime) -> Unit,
    onCreate: (LocalDate, LocalDateTime, LocalDateTime, Boolean) -> Unit,
) {
    var draftRange by remember(day) { mutableStateOf<Pair<Int, Int>?>(null) }
    Box(Modifier.width(148.dp).height((24 * HOUR_DP).dp).padding(end = 4.dp)) {
        for (hour in 0..23) {
            Box(
                Modifier.fillMaxWidth().height(1.dp).offset(y = (hour * HOUR_DP).dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)),
            )
        }
        if (day == LocalDate.now()) {
            val minutes = java.time.LocalTime.now().hour * 60 + java.time.LocalTime.now().minute
            Box(
                Modifier.fillMaxWidth().height(2.dp).offset(y = (minutes / 60f * HOUR_DP).dp).background(MaterialTheme.colorScheme.primary),
            )
        }
        BoxWithConstraints(
            Modifier.fillMaxWidth().height((24 * HOUR_DP).dp).pointerInput(day, slices) {
                val hourPx = HOUR_DP.dp.toPx()
                val minHeight = 18.dp.toPx()
                val slop = viewConfiguration.touchSlop
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (coversSlice(down.position.x, down.position.y, slices, size.width.toFloat(), hourPx, minHeight)) {
                        return@awaitEachGesture
                    }
                    val origin = ((down.position.y / hourPx) * 60f).toInt().coerceIn(0, 24 * 60 - 1)
                    var pointer = origin
                    var total = Offset.Zero
                    var moved = false
                    draftRange = dragCreateMinutes(origin, pointer, false)
                    val finished = drag(down.id) { change ->
                        total += change.positionChange()
                        pointer = (((down.position.y + total.y) / hourPx) * 60f).toInt()
                        if (total.getDistance() > slop) {
                            moved = true
                            change.consume()
                        }
                        draftRange = dragCreateMinutes(origin, pointer, moved)
                    }
                    val range = dragCreateMinutes(origin, pointer, finished && moved)
                    draftRange = null
                    if (!finished) return@awaitEachGesture
                    onCreate(day, minutesOn(day, range.first), minutesOn(day, range.second), false)
                }
            },
        ) {
            draftRange?.let { (startMin, endMin) ->
                val visualEnd = endMin.coerceAtMost(24 * 60)
                val top = startMin / 60f * HOUR_DP
                val block = ((visualEnd - startMin) / 60f * HOUR_DP).coerceAtLeast(18f)
                Box(
                    Modifier.fillMaxWidth().offset(y = top.dp).height(block.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.28f)),
                )
            }
            slices.forEach { slice ->
                TimedBlock(slice, maxWidth, day, document, onEdit, onMove, onResize)
            }
        }
    }
}

@Composable
private fun TimedBlock(
    slice: LaidOutSpan,
    width: androidx.compose.ui.unit.Dp,
    day: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    onMove: (String, LocalDateTime) -> Unit,
    onResize: (String, LocalDateTime) -> Unit,
) {
    val density = LocalDensity.current
    var dragOffset by remember(slice.key, slice.start, slice.end) { mutableStateOf(Offset.Zero) }
    var extraPx by remember(slice.key, slice.start, slice.end) { mutableFloatStateOf(0f) }
    val minutes = slice.start.hour * 60 + slice.start.minute
    val duration = java.time.Duration.between(slice.start, slice.end).toMinutes().coerceAtLeast(15)
    val top = minutes / 60f * HOUR_DP
    val height = (duration / 60f * HOUR_DP).coerceAtLeast(18f)
    val extra = with(density) { extraPx.toDp() }
    val columnWidth = width / slice.columns
    val tint = document.calendars.find { it.id == slice.event.calendarId }?.color ?: "#7f6df2"
    Box(
        Modifier
            .offset { IntOffset((columnWidth * slice.column).roundToPx(), top.dp.roundToPx()) }
            .offset { IntOffset(dragOffset.x.roundToInt(), dragOffset.y.roundToInt()) }
            .width(columnWidth)
            .height((height.dp + extra).coerceAtLeast(18.dp))
            .background(calendarSwatch(tint).copy(alpha = 0.9f))
            .pointerInput(slice.key, slice.originStart, slice.originEnd) {
                val hourPx = HOUR_DP.dp.toPx()
                val columnPx = size.width.toFloat().coerceAtLeast(1f)
                val handlePx = 16.dp.toPx()
                val slop = viewConfiguration.touchSlop
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val resizing = down.position.y >= size.height - handlePx
                    var total = Offset.Zero
                    var moved = false
                    val finished = drag(down.id) { change ->
                        total += change.positionChange()
                        if (total.getDistance() > slop) {
                            moved = true
                            if (resizing) extraPx = total.y else dragOffset = total
                            change.consume()
                        }
                    }
                    dragOffset = Offset.Zero
                    extraPx = 0f
                    if (!finished || !moved) {
                        if (!moved) onEdit(slice.event, day)
                        return@awaitEachGesture
                    }
                    val deltaMinutes = (total.y / hourPx * 60f).toInt()
                    if (resizing) {
                        val nextEnd = slice.originEnd.plusMinutes(deltaMinutes.toLong())
                        val earliest = slice.originStart.plusMinutes(15)
                        onResize(slice.key, if (nextEnd.isBefore(earliest)) earliest else nextEnd)
                    } else {
                        val dayDelta = (total.x / columnPx).roundToInt()
                        if (kotlin.math.abs(deltaMinutes) >= 15 || dayDelta != 0) {
                            onMove(slice.key, slice.originStart.plusDays(dayDelta.toLong()).plusMinutes(deltaMinutes.toLong()))
                        }
                    }
                }
            }
            .padding(horizontal = 4.dp, vertical = 2.dp),
    ) {
        Text(slice.event.title, color = inkOn(tint), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
        Text("%02d:%02d".format(slice.originStart.hour, slice.originStart.minute), color = inkOn(tint), fontSize = 11.sp)
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp).background(inkOn(tint).copy(alpha = 0.45f)))
    }
}

private fun inkOn(hex: String): Color {
    val color = calendarSwatch(hex)
    val luminance = 0.2126f * color.red + 0.7152f * color.green + 0.0722f * color.blue
    return if (luminance > 0.62f) Color(0xFF1A1A1A) else Color.White
}

@Composable
private fun AgendaList(anchor: LocalDate, document: ch.fasrv.fanotes.desk.CalendarDocument, onEdit: (CalendarEvent, LocalDate) -> Unit) {
    ch.fasrv.fanotes.desk.calendarRange("agenda", anchor).forEach { date ->
        val events = document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, date) }
        if (events.isNotEmpty()) {
            Text(date.toString(), fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
            events.forEach { event ->
                val clock = ch.fasrv.fanotes.desk.eventClock(event)?.let { "$it " }.orEmpty()
                Text(
                    clock + event.title,
                    color = calendarSwatch(document.calendars.find { it.id == event.calendarId }?.color ?: "#2a6f97"),
                    modifier = Modifier.clickable { onEdit(event, date) }.padding(vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun CalendarLists(
    model: FaNotesViewModel,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    calendarName: String,
    onName: (String) -> Unit,
) {
    val focus = LocalFocusManager.current
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp).background(MaterialTheme.colorScheme.surfaceVariant).padding(8.dp),
    ) {
        Text("Kalender", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        document.calendars.forEach { calendar ->
            var name by remember(calendar.id) { mutableStateOf(calendar.name) }
            var focused by remember(calendar.id) { mutableStateOf(false) }
            LaunchedEffect(calendar.name, focused) {
                if (!focused) name = calendar.name
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.padding(end = 8.dp).size(12.dp).clip(CircleShape).background(calendarSwatch(calendar.color)),
                )
                Checkbox(
                    checked = calendar.visible,
                    onCheckedChange = { model.toggleCalendarVisible(calendar.id) },
                )
                OutlinedTextField(
                    name,
                    { name = it.take(80) },
                    label = { Text("Umbenennen") },
                    modifier = Modifier.weight(1f).onFocusChanged { state ->
                        val wasFocused = focused
                        focused = state.isFocused
                        if (wasFocused && !state.isFocused) {
                            val clean = name.replace(Regex("""\s+"""), " ").trim()
                            if (clean.isEmpty()) name = calendar.name
                            else if (clean != calendar.name) model.renameCalendarList(calendar.id, clean)
                        }
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                )
                if (document.calendars.size > 1) {
                    TextButton(onClick = { model.deleteCalendarList(calendar.id) }) { Text("Entfernen") }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                calendarName,
                { onName(it.take(80)) },
                label = { Text("Neuer Kalender") },
                modifier = Modifier.weight(1f),
                singleLine = true,
            )
            TextButton(onClick = {
                if (calendarName.isNotBlank()) {
                    model.createCalendarList(calendarName)
                    onName("")
                }
            }) { Text("Hinzufügen") }
        }
    }
}

private fun calendarSwatch(hex: String): Color = runCatching {
    Color(android.graphics.Color.parseColor(hex))
}.getOrDefault(Color(0xFF2A6F97))

@Composable
private fun EventsOn(
    model: FaNotesViewModel,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    day: LocalDate,
    onEdit: (CalendarEvent) -> Unit,
) {
    document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, day) }.forEach { event ->
        val repeat = when (event.recurrence) {
            "daily" -> " · täglich"
            "weekly" -> " · wöchentlich"
            "monthly" -> " · monatlich"
            "yearly" -> " · jährlich"
            else -> ""
        }
        val clock = ch.fasrv.fanotes.desk.eventClock(event)?.let { "$it " }.orEmpty()
        val swatch = document.calendars.find { it.id == event.calendarId }?.color
        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (swatch != null) {
                    Box(Modifier.padding(end = 8.dp).size(10.dp).clip(CircleShape).background(calendarSwatch(swatch)))
                }
                Text(
                    clock + event.title + repeat + if (event.notePath.isNotBlank()) "  →" else "",
                    modifier = Modifier.weight(1f).clickable { onEdit(event) },
                )
            }
            Row(Modifier.horizontalScroll(rememberScrollState())) {
                TextButton(onClick = { onEdit(event) }) { Text("Bearbeiten") }
                TextButton(onClick = { model.shiftCalendarEvent(event.id, 1) }) { Text("+1 Tag") }
                TextButton(onClick = { model.duplicateCalendarEvent(event.id) }) { Text("Kopie") }
                if (event.recurrence != "none" && event.recurrence.isNotBlank()) {
                    TextButton(onClick = { model.skipCalendarOccurrence(event.id, day.toString()) }) { Text("Auslassen") }
                }
                TextButton(onClick = { model.deleteCalendarEvent(event.id) }) { Text("Löschen") }
            }
        }
    }
}

private data class CalendarDraft(
    val key: String,
    val id: String,
    val calendarId: String,
    val title: String,
    val startDate: String,
    val endDate: String,
    val startTime: String,
    val endTime: String,
    val allDay: Boolean,
    val location: String,
    val notes: String,
    val notePath: String,
    val recurrence: String,
    val recurrenceUntil: String,
    val exceptionDates: List<String>,
    val detaches: Boolean,
    val creating: Boolean = false,
)

private fun draftFor(event: CalendarEvent, day: LocalDate): CalendarDraft {
    val window = calendarOccurrenceWindow(event, day)
    val start = window.first
    val end = window.second
    val allDay = event.allDay || !start.contains('T')
    val repeating = event.recurrence == "daily" || event.recurrence == "weekly" || event.recurrence == "monthly" || event.recurrence == "yearly"
    return CalendarDraft(
        key = "${event.id}@$day",
        id = event.id,
        calendarId = event.calendarId,
        title = event.title,
        startDate = start.take(10),
        endDate = end.take(10),
        startTime = if (allDay) "09:00" else start.substringAfter('T').take(5).ifBlank { "09:00" },
        endTime = if (allDay) "10:00" else end.substringAfter('T').take(5).ifBlank { "10:00" },
        allDay = allDay,
        location = event.location,
        notes = event.notes,
        notePath = event.notePath,
        recurrence = if (repeating) event.recurrence else "none",
        recurrenceUntil = event.recurrenceUntil.orEmpty(),
        exceptionDates = event.exceptionDates,
        detaches = repeating && day.toString() != event.start.take(10),
    )
}

private fun draftForCreate(
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    day: LocalDate,
    start: LocalDateTime,
    end: LocalDateTime,
    allDay: Boolean,
): CalendarDraft {
    val calendarId = document.calendars.firstOrNull { it.visible }?.id ?: document.calendars.firstOrNull()?.id ?: "personal"
    val id = java.util.UUID.randomUUID().toString()
    return CalendarDraft(
        key = "$id@$day",
        id = id,
        calendarId = calendarId,
        title = "Neuer Termin",
        startDate = if (allDay) day.toString() else start.toLocalDate().toString(),
        endDate = if (allDay) day.toString() else end.toLocalDate().toString(),
        startTime = "%02d:%02d".format(start.hour, start.minute),
        endTime = "%02d:%02d".format(end.hour, end.minute),
        allDay = allDay,
        location = "",
        notes = "",
        notePath = "",
        recurrence = "none",
        recurrenceUntil = "",
        exceptionDates = emptyList(),
        detaches = false,
        creating = true,
    )
}

private fun minutesOn(day: LocalDate, minute: Int): LocalDateTime {
    val dayMinutes = 24 * 60
    val extra = minute.floorDiv(dayMinutes)
    val clock = minute.mod(dayMinutes)
    return day.plusDays(extra.toLong()).atStartOfDay().plusMinutes(clock.toLong())
}

private fun coversSlice(
    x: Float,
    y: Float,
    slices: List<LaidOutSpan>,
    widthPx: Float,
    hourPx: Float,
    minHeightPx: Float,
): Boolean {
    if (widthPx <= 0f || hourPx <= 0f) return false
    return slices.any { slice ->
        val startMin = slice.start.hour * 60 + slice.start.minute
        val top = startMin / 60f * hourPx
        val duration = java.time.Duration.between(slice.start, slice.end).toMinutes().coerceAtLeast(15)
        val height = (duration / 60f * hourPx).coerceAtLeast(minHeightPx)
        val column = widthPx / slice.columns
        val left = column * slice.column
        x in left..(left + column) && y in top..(top + height)
    }
}

private fun CalendarDraft.toEvent(): CalendarEvent {
    val cleanTitle = title.replace(Regex("""\s+"""), " ").trim().ifEmpty { "Neuer Termin" }
    return CalendarEvent(
        id = id,
        calendarId = calendarId,
        title = cleanTitle,
        start = if (allDay) startDate.trim() else "${startDate.trim()}T${startTime.trim()}",
        end = if (allDay) endDate.trim() else "${endDate.trim()}T${endTime.trim()}",
        allDay = allDay,
        location = location,
        notes = notes,
        notePath = notePath,
        recurrence = recurrence,
        recurrenceUntil = recurrenceUntil.trim().ifBlank { null },
        exceptionDates = exceptionDates,
    )
}

@Composable
private fun CalendarEventEditor(
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    draft: CalendarDraft,
    onChange: (CalendarDraft) -> Unit,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    onDuplicate: () -> Unit,
    onDeleteOne: () -> Unit,
    onDeleteSeries: () -> Unit,
    onOpenNote: () -> Unit,
) {
    var error by remember(draft.key) { mutableStateOf("") }
    val calendarName = document.calendars.find { it.id == draft.calendarId }?.name ?: "Kalender"
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                val dates = runCatching {
                    LocalDate.parse(draft.startDate.trim())
                    LocalDate.parse(draft.endDate.trim())
                    if (!draft.allDay) {
                        java.time.LocalTime.parse(draft.startTime.trim())
                        java.time.LocalTime.parse(draft.endTime.trim())
                    }
                }
                if (dates.isFailure) {
                    error = "Beginn oder Ende ist kein Datum."
                } else {
                    onSave()
                }
            }) { Text("Speichern") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
        title = {
            Text(
                when {
                    draft.creating -> "Neuer Termin"
                    draft.detaches -> "Diesen Termin"
                    else -> "Termin"
                },
            )
        },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                if (draft.detaches) {
                    Text("Dieser Termin wird aus der Serie gelöst.", fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp))
                }
                OutlinedTextField(draft.title, { onChange(draft.copy(title = it.take(240))) }, label = { Text("Neuer Termin") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                TextButton(onClick = {
                    val ids = document.calendars
                    if (ids.isEmpty()) return@TextButton
                    val index = ids.indexOfFirst { it.id == draft.calendarId }.let { if (it < 0) 0 else it }
                    onChange(draft.copy(calendarId = ids[(index + 1) % ids.size].id))
                }) { Text("Kalender: $calendarName") }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = draft.allDay, onCheckedChange = { onChange(draft.copy(allDay = it)) })
                    Text("Ganztägig")
                }
                OutlinedTextField(draft.startDate, { onChange(draft.copy(startDate = it.take(10))) }, label = { Text("Beginn") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                if (!draft.allDay) {
                    OutlinedTextField(draft.startTime, { onChange(draft.copy(startTime = it.take(5))) }, label = { Text("Beginn Uhrzeit") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                }
                OutlinedTextField(draft.endDate, { onChange(draft.copy(endDate = it.take(10))) }, label = { Text("Ende") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                if (!draft.allDay) {
                    OutlinedTextField(draft.endTime, { onChange(draft.copy(endTime = it.take(5))) }, label = { Text("Ende Uhrzeit") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                }
                if (!draft.detaches) {
                    Row(Modifier.horizontalScroll(rememberScrollState())) {
                        listOf("none" to "Nie", "daily" to "Täglich", "weekly" to "Wöchentlich", "monthly" to "Monatlich", "yearly" to "Jährlich").forEach { (id, label) ->
                            TextButton(onClick = { onChange(draft.copy(recurrence = id)) }) {
                                Text(label, color = if (draft.recurrence == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                            }
                        }
                    }
                    if (draft.recurrence != "none") {
                        OutlinedTextField(draft.recurrenceUntil, { onChange(draft.copy(recurrenceUntil = it.take(10))) }, label = { Text("Bis") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    }
                }
                OutlinedTextField(draft.location, { onChange(draft.copy(location = it.take(160))) }, label = { Text("Ort") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(draft.notes, { onChange(draft.copy(notes = it.take(4000))) }, label = { Text("Notizen") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(draft.notePath, { onChange(draft.copy(notePath = it.take(400))) }, label = { Text("Notizpfad") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                if (!draft.creating) {
                    Row(Modifier.horizontalScroll(rememberScrollState())) {
                        TextButton(onClick = onDuplicate) { Text("Duplizieren") }
                        if (draft.notePath.isNotBlank()) TextButton(onClick = onOpenNote) { Text("Notiz öffnen") }
                        TextButton(onClick = onDeleteOne) { Text("Nur diesen löschen") }
                        if (draft.recurrence != "none") TextButton(onClick = onDeleteSeries) { Text("Serie löschen") }
                    }
                }
            }
        },
    )
}

@Composable
fun BugReportDialog(model: FaNotesViewModel) {
    val status by model.bugReportMessage.collectAsStateWithLifecycle()
    var description by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { model.closeBugReport() },
        title = { Text("Fehler melden") },
        text = {
            Column {
                Text("Die letzten fünf Minuten (Stift, Notiz, Werkzeug) werden automatisch angehängt und nur an fanotes.fasrv.ch geschickt.", fontSize = 13.sp)
                OutlinedTextField(
                    description,
                    { description = it.take(2000) },
                    label = { Text("Was ist passiert?") },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
                if (!status.isNullOrBlank() && status != "Bericht gesendet.") {
                    Text(status.orEmpty(), color = MaterialTheme.colorScheme.error, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { model.sendBugReport(description) }, enabled = description.isNotBlank()) { Text("Bericht senden") }
        },
        dismissButton = { TextButton(onClick = { model.closeBugReport() }) { Text("Abbrechen") } },
    )
}

@Composable
fun FaNotesConfirmDialog(request: PendingConfirm, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val cancel = remember { FocusRequester() }
    val confirm = remember { FocusRequester() }
    var focused by remember(request.message) { mutableStateOf(0) }
    LaunchedEffect(request.message) { runCatching { cancel.requestFocus() } }
    Dialog(onDismissRequest = onDismiss) {
        Surface(Modifier.widthIn(max = 440.dp).onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            val keyName = when (event.key) {
                Key.Escape -> "Escape"
                else -> ""
            }
            if (confirmDialogKeyAction(keyName) == "cancel") {
                onDismiss()
                return@onPreviewKeyEvent true
            }
            if (event.key != Key.Tab) return@onPreviewKeyEvent false
            val next = confirmDialogTabTarget(2, focused, event.isShiftPressed) ?: return@onPreviewKeyEvent false
            focused = next
            if (next == 0) cancel.requestFocus() else confirm.requestFocus()
            true
        }) {
            Column(Modifier.padding(20.dp)) {
                Text("Achtung", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                Text(request.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 4.dp))
                Text(request.message, modifier = Modifier.padding(top = 12.dp, bottom = 16.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(
                        onClick = onDismiss,
                        modifier = Modifier.focusRequester(cancel).onFocusChanged { if (it.isFocused) focused = 0 },
                    ) { Text(request.cancelLabel) }
                    TextButton(
                        onClick = onConfirm,
                        modifier = Modifier.focusRequester(confirm).onFocusChanged { if (it.isFocused) focused = 1 },
                    ) { Text(request.confirmLabel, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

@Composable
fun OverviewScreen(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val tree by model.tree.collectAsStateWithLifecycle()
    val colors by model.folderColors.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Vault-Übersicht", style = MaterialTheme.typography.titleLarge)
        tree.forEach { node ->
            val tint = colors[node.path]
            Text("${node.name}${if (node.children.isNotEmpty()) "  (${node.children.size})" else ""}${tint?.let { "  $it" } ?: ""}", modifier = Modifier.clickable { if (node.kind.name != "FOLDER") onOpen(node.path) }.padding(vertical = 6.dp))
        }
    }
}

@Composable
fun CardsScreen(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val today = LocalDate.now().toString()
    val cards = dueCards(model.cardsToday(), today).ifEmpty { model.cardsToday() }
    var index by remember(markdown) { mutableStateOf(0) }
    var showBack by remember(markdown, index) { mutableStateOf(false) }
    val card = cards.getOrNull(index)
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Karteikarten", style = MaterialTheme.typography.titleLarge)
        Text("Fragen stehen unter ## Lernfragen, der Plan in fanotes-cards-v1.", fontSize = 13.sp)
        if (card == null) {
            Text("In dieser Notiz sind keine Karten fällig.")
        } else {
            Text(if (showBack) card.back.ifBlank { "Keine Antwort" } else card.front, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.clickable { showBack = !showBack }.padding(vertical = 24.dp))
            Row {
                listOf("again" to "Nochmal", "hard" to "Schwer", "good" to "Gut", "easy" to "Leicht").forEach { (grade, label) ->
                    TextButton(onClick = {
                        model.reviewFlashcard(card.id, grade)
                        showBack = false
                    }) { Text(label) }
                }
            }
        }
    }
}

@Composable
fun BooksScreen(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val books by model.books.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    var folder by remember { mutableStateOf("") }
    var pdf by remember { mutableStateOf("") }
    val placement = settings["book-placement"].orEmpty().ifBlank { "rechts" }
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Fachbuch", style = MaterialTheme.typography.titleLarge)
        Text("Dieselbe Liste wie .fanotes/subject-books.json. Die Seite bleibt erhalten.", fontSize = 13.sp)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            listOf("links" to "Links", "rechts" to "Rechts", "oben" to "Oben", "unten" to "Unten", "popout" to "Auspoppen").forEach { (id, label) ->
                TextButton(onClick = { model.updateDesk("book-placement", id) }) {
                    Text(label, color = if (placement == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        OutlinedTextField(folder, { folder = it }, label = { Text("Ordner") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(pdf, { pdf = it }, label = { Text("PDF") }, modifier = Modifier.fillMaxWidth())
        TextButton(onClick = {
            if (folder.isNotBlank() && pdf.isNotBlank()) {
                model.attachSubjectBook(folder, pdf)
                folder = ""
                pdf = ""
            }
        }) { Text("Verbinden") }
        books.forEach { book ->
            Column(Modifier.clickable { onOpen(book.bookPath) }.padding(vertical = 10.dp)) {
                Text(book.subjectPath, fontWeight = FontWeight.SemiBold)
                Text("${book.bookPath} · Seite ${book.lastPage}", fontSize = 13.sp)
            }
        }
        if (books.isEmpty()) Text("Noch kein Fachbuch mit einem Ordner verbunden.", modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
fun BookPane(model: FaNotesViewModel, modifier: Modifier = Modifier, onOpen: (String) -> Unit) {
    val pane by model.bookPane.collectAsStateWithLifecycle()
    val page = pane ?: return
    Column(modifier.padding(8.dp)) {
        Text(page.title, maxLines = 1, fontWeight = FontWeight.SemiBold)
        Text("Seite ${page.page} / ${page.pageCount}", fontSize = 12.sp)
        page.bitmap?.let { bitmap ->
            Image(
                bitmap.asImageBitmap(),
                contentDescription = page.title,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentScale = ContentScale.Fit,
            )
        }
        Row {
            TextButton(onClick = { model.turnBook(-1) }) { Text("‹") }
            TextButton(onClick = { model.turnBook(1) }) { Text("›") }
            TextButton(onClick = { onOpen(page.bookPath) }) { Text("Öffnen") }
        }
    }
}

@Composable
fun HistoryScreen(model: FaNotesViewModel) {
    val history by model.noteHistory.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val comparison by model.historyComparison.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Versionsverlauf", style = MaterialTheme.typography.titleLarge)
        Text(open?.path ?: "Keine Notiz geöffnet.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Text("Dieselbe Ablage wie auf dem Desktop: .fanotes/history, höchstens 30 Fassungen je Notiz.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        if (history.isEmpty()) {
            Text("Für diese Notiz liegt noch keine ältere Fassung vor. Sie entsteht, sobald die Notiz erneut gespeichert wird.", modifier = Modifier.padding(top = 12.dp))
        }
        history.forEach { snapshot ->
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(snapshot.createdAt, fontSize = 14.sp)
                        Text("${snapshot.bytes} Bytes", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    }
                    TextButton(onClick = { model.compareHistory(snapshot.id) }) { Text("Vergleichen") }
                    TextButton(onClick = { model.restoreHistory(snapshot.id) }) { Text("Wiederherstellen") }
                }
                if (comparison?.first == snapshot.id) {
                    val diff = comparison?.second.orEmpty()
                    diff.lineSequence().forEach { line ->
                        val color = when {
                            line.startsWith("+") -> MaterialTheme.colorScheme.primary
                            line.startsWith("-") -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.onSurface
                        }
                        Text(line, color = color, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                    }
                    if (ch.fasrv.fanotes.desk.timelineHasInk(diff)) {
                        Text("Enthält Handschrift.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    }
                }
            }
        }
        val backupsOn = model.deskSettings.collectAsStateWithLifecycle().value["experimental-backup"] == "on"
        if (backupsOn && open != null) {
            val backups = ch.fasrv.fanotes.desk.parseNoteBackups(open?.payload?.array("noteBackups")).filter { it.notePath == open?.path }.asReversed()
            Text("Sicherungen", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
            Text("Liegen in der Notiz selbst, höchstens 40, wie auf dem Desktop.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            TextButton(onClick = { model.snapshotNote() }) { Text("Sicherung anlegen") }
            backups.forEach { backup ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(backup.createdAt, modifier = Modifier.weight(1f), fontSize = 13.sp)
                    TextButton(onClick = { model.restoreNoteBackup(backup.id) }) { Text("Wiederherstellen") }
                }
            }
        }
    }
}

@Composable
fun StudyScreen(model: FaNotesViewModel) {
    val picture by model.study.collectAsStateWithLifecycle()
    val overview = picture
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Lernzeit", style = MaterialTheme.typography.titleLarge)
        Text("Aus den stillen Seitenstatistiken auf diesem Gerät. Nichts wird gesendet.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        if (overview == null) {
            Text("Wird gelesen …", modifier = Modifier.padding(top = 12.dp))
        } else {
            Text("${overview.notes} Seiten", modifier = Modifier.padding(top = 12.dp))
            Text("Auf Seiten  ${ch.fasrv.fanotes.desk.formatStudyDuration(overview.dwellMs)}", modifier = Modifier.padding(top = 8.dp))
            Text("Tippen  ${ch.fasrv.fanotes.desk.formatStudyDuration(overview.typingMs)}")
            Text("Handschrift  ${ch.fasrv.fanotes.desk.formatStudyDuration(overview.inkMs)}")
            Text("Tinte  ${kotlin.math.round(overview.inkMm).toInt()} mm")
            val peak = overview.dwellByWeekday.maxOrNull()?.coerceAtLeast(1) ?: 1L
            Row(Modifier.fillMaxWidth().padding(top = 16.dp).height(120.dp), verticalAlignment = Alignment.Bottom) {
                listOf("So", "Mo", "Di", "Mi", "Do", "Fr", "Sa").forEachIndexed { index, label ->
                    val value = overview.dwellByWeekday.getOrElse(index) { 0L }
                    val bar = (4 + (value.toFloat() / peak.toFloat()) * 88).dp
                    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp).height(bar).background(MaterialTheme.colorScheme.primary))
                        Text(label, fontSize = 11.sp)
                    }
                }
            }
            Text("Fächer", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
            if (overview.subjects.isEmpty()) Text("Noch keine Seitenstatistik.")
            overview.subjects.forEach { row ->
                Text("${row.subject}  ·  ${row.notes}  ·  ${ch.fasrv.fanotes.desk.formatStudyDuration(row.dwellMs)}  ·  ${ch.fasrv.fanotes.desk.formatStudyDuration(row.inkMs)} Stift")
            }
        }
    }
}

@Composable
fun ConflictList(model: FaNotesViewModel) {
    val sync by model.sync.collectAsStateWithLifecycle()
    if (sync.conflicts.isEmpty()) {
        Text("Keine offenen Konflikte.", fontSize = 13.sp)
        return
    }
    sync.conflicts.forEach { conflict ->
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text(conflict.path, fontSize = 14.sp)
            Text(conflict.copyPath, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            Row {
                TextButton(onClick = { model.resolveConflict(conflict, "remote") }) { Text("Server") }
                TextButton(onClick = { model.resolveConflict(conflict, "local") }) { Text("Tablet") }
                if (ch.fasrv.fanotes.desk.isMarkdownConflictPath(conflict.path)) {
                    TextButton(onClick = { model.resolveConflict(conflict, "both") }) { Text("Beide") }
                }
            }
        }
    }
}

@Composable
fun AiScreen(model: FaNotesViewModel) {
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val status by model.aiStatus.collectAsStateWithLifecycle()
    val preview by model.aiPreview.collectAsStateWithLifecycle()
    val models by model.aiModels.collectAsStateWithLifecycle()
    val provider = settings["ai-provider"].orEmpty().ifBlank { "lmstudio" }
    val definition = ch.fasrv.fanotes.desk.AI_PROVIDERS.firstOrNull { it.id == provider } ?: ch.fasrv.fanotes.desk.AI_PROVIDERS.first()
    var actions by remember { mutableStateOf(setOf("spelling")) }
    var instruction by remember { mutableStateOf("") }
    fun setting(field: String) = settings["ai-$provider-$field"].orEmpty()
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("AI", style = MaterialTheme.typography.titleLarge)
        Text("Dieselbe Auswahl wie auf dem Desktop. Der Schlüssel bleibt auf diesem Tablet.", fontSize = 13.sp)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ch.fasrv.fanotes.desk.AI_PROVIDERS.forEach { entry ->
                Text(
                    entry.title,
                    fontWeight = if (entry.id == provider) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (entry.id == provider) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.clickable {
                        model.aiModels.value = emptyList()
                        model.updateDesk("ai-provider", entry.id)
                    }.padding(vertical = 6.dp, horizontal = 4.dp),
                )
            }
        }
        Text(definition.description, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        if (definition.local) {
            OutlinedTextField(
                setting("url").ifBlank { ch.fasrv.fanotes.desk.defaultAiBaseUrl(provider) },
                { model.updateDesk("ai-$provider-url", it) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Adresse") },
                singleLine = true,
            )
        }
        OutlinedTextField(setting("model"), { model.updateDesk("ai-$provider-model", it) }, modifier = Modifier.fillMaxWidth(), label = { Text("Modell") }, singleLine = true)
        TextButton(onClick = { model.loadAiModels(provider, setting("url"), setting("key"), setting("user")) }) { Text("Modelle laden") }
        models.forEach { listed ->
            Column(
                Modifier.fillMaxWidth().clickable { model.updateDesk("ai-$provider-model", listed.key) }.padding(vertical = 4.dp),
            ) {
                Text(listed.title, fontWeight = if (setting("model") == listed.key) FontWeight.SemiBold else FontWeight.Normal)
                if (listed.detail.isNotBlank()) Text(listed.detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
            }
        }
        if (provider == "opencode") {
            OutlinedTextField(setting("user").ifBlank { "opencode" }, { model.updateDesk("ai-$provider-user", it) }, modifier = Modifier.fillMaxWidth(), label = { Text("Benutzer") }, singleLine = true)
        }
        OutlinedTextField(setting("key"), { model.updateDesk("ai-$provider-key", it) }, modifier = Modifier.fillMaxWidth(), label = { Text(if (definition.local) "Schlüssel, optional" else "API-Schlüssel") }, singleLine = true)
        Text("Aktionen", fontWeight = FontWeight.SemiBold)
        ch.fasrv.fanotes.desk.AI_ACTIONS.forEach { action ->
            val selected = action.id in actions
            Text(
                "${if (selected) "☑" else "☐"} ${action.title}",
                modifier = Modifier.clickable {
                    actions = if (selected) actions - action.id else actions + action.id
                }.padding(vertical = 4.dp),
            )
        }
        if ("instruction" in actions) {
            OutlinedTextField(instruction, { instruction = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Freier Auftrag") })
        }
        Row {
            TextButton(onClick = {
                model.runAi(provider, setting("url"), setting("model"), setting("key"), setting("user"), actions.toList(), instruction)
            }) { Text("Ausführen") }
            if (preview != null) TextButton(onClick = { model.applyAiPreview() }) { Text("Übernehmen") }
        }
        if (status.isNotBlank()) Text(status, fontSize = 13.sp)
        if (preview != null) Text(preview.orEmpty(), fontSize = 13.sp)
    }
}

@Composable
private fun EditorSlider(title: String, value: Float, min: Float, max: Float, step: Float, suffix: String, onChange: (Float) -> Unit) {
    val shown = if (step < 1f) "%.2f".format(java.util.Locale.US, value) else value.toInt().toString()
    Text("$title: $shown$suffix")
    Slider(
        value = value.coerceIn(min, max),
        onValueChange = { raw ->
            val steps = kotlin.math.round((raw - min) / step)
            onChange((min + steps * step).coerceIn(min, max))
        },
        valueRange = min..max,
    )
}

@Composable
fun SettingsScreen(model: FaNotesViewModel, onSync: () -> Unit, onOpenVault: () -> Unit, onPrivate: () -> Unit) {
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val update by model.updateLabel.collectAsStateWithLifecycle()
    val sections = listOf(
        "appearance" to "Erscheinungsbild",
        "editor" to "Editor",
        "drawing" to "Zeichnen",
        "files" to "Dateien",
        "sync" to "Sync",
        "addons" to "Add-ons",
        "updates" to "Updates",
        "accessibility" to "Bedienung",
        "experimental" to "Experimentell",
        "advanced" to "Erweitert",
    )
    var section by remember { mutableStateOf("appearance") }
    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(0.38f).verticalScroll(rememberScrollState()).padding(8.dp)) {
            sections.forEach { (id, label) ->
                Text(label, modifier = Modifier.fillMaxWidth().background(if (section == id) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent).clickable { section = id }.padding(10.dp))
            }
        }
        Column(Modifier.weight(0.62f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(sections.first { it.first == section }.second, style = MaterialTheme.typography.titleLarge)
            when (section) {
                "appearance" -> {
                    listOf("dark" to "Dunkel", "light" to "Hell", "sepia" to "Sepia").forEach { (id, label) ->
                        Text(label, modifier = Modifier.clickable { model.updateDesk("theme", id) }.padding(vertical = 6.dp), fontWeight = if (settings["theme"] == id || (id == "dark" && settings["theme"] == null)) FontWeight.Bold else FontWeight.Normal)
                    }
                    listOf("clean", "gradient", "mesh", "paper").forEach { id ->
                        Text(id, modifier = Modifier.clickable { model.updateDesk("background", id) }.padding(vertical = 4.dp))
                    }
                }
                "editor" -> {
                    val metrics = ch.fasrv.fanotes.desk.editorMetrics(settings)
                    Text("Wörter in der Statusleiste: ${settings["words"] != "off"}", modifier = Modifier.clickable { model.updateDesk("words", if (settings["words"] == "off") "on" else "off") })
                    Text("Gliederung: ${settings["outline"] != "off"}", modifier = Modifier.clickable { model.updateDesk("outline", if (settings["outline"] == "off") "on" else "off") })
                    Text("Täglicher Ordner: ${settings["daily-folder"].orEmpty().ifBlank { "Tagesnotizen" }}")
                    OutlinedTextField(
                        settings["daily-folder"].orEmpty(),
                        { model.updateDesk("daily-folder", it) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Ordner der Tagesnotiz") },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        settings["date-format"].orEmpty().ifBlank { "YYYY-MM-DD" },
                        { model.updateDesk("date-format", it) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Datumsformat") },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        settings["default-folder"] ?: "Eingang",
                        { model.updateDesk("default-folder", it) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Standardordner neuer Notizen") },
                        singleLine = true,
                    )
                    EditorSlider("Editor-Schriftgröße", metrics.fontSizePx.toFloat(), 12f, 26f, 1f, " px") { model.updateDesk("editor-font", it.toInt().toString()) }
                    EditorSlider("Zeilenhöhe", metrics.lineHeight.toFloat(), 1.3f, 2.2f, 0.05f, "") { model.updateDesk("line-height", "%.2f".format(java.util.Locale.US, it)) }
                    EditorSlider("Maximale Inhaltsbreite", metrics.contentWidthPx.toFloat(), 560f, 1200f, 20f, " px") { model.updateDesk("content-width", it.toInt().toString()) }
                    EditorSlider("Maximaler Zoom", (metrics.zoomMax * 100).toFloat(), 50f, 600f, 5f, " %") { model.updateDesk("zoom-max", it.toInt().toString()) }
                    EditorSlider("Automatisch speichern", metrics.autosaveMs.toFloat(), 250f, 3000f, 250f, " ms") { model.updateDesk("autosave", it.toInt().toString()) }
                }
                "drawing" -> {
                    val pen = ch.fasrv.fanotes.desk.penSettings(settings)
                    Text("Druckempfindlichkeit: ${if (pen.pressure) "an" else "aus"}", modifier = Modifier.clickable { model.setPenPressure(!pen.pressure) })
                    EditorSlider("Stiftbreite", pen.width.toFloat(), 1f, 18f, 0.5f, " px") { model.setPenWidth(it.toDouble()) }
                    EditorSlider("Form-Erkennung", pen.shapeSnap.toFloat(), 0f, 100f, 5f, " %") { model.updateDesk("shape-snap", it.toInt().toString()) }
                    EditorSlider("Durchkritzel-Empfindlichkeit", pen.scribble.toFloat(), 0f, 100f, 5f, " %") { model.updateDesk("scribble", it.toInt().toString()) }
                    EditorSlider("Strichglättung", pen.smoothing.toFloat(), 0f, 1f, 0.05f, "") { model.updateDesk("smoothing", "%.2f".format(java.util.Locale.US, it)) }
                    Text("Papier neuer Notizen", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    listOf("dots" to "Punkte", "lines" to "Linien", "grid" to "Karo", "squares" to "Quadrat", "blank" to "Leer", "millimeter" to "Millimeter").forEach { (id, label) ->
                        Text(
                            label,
                            fontWeight = if (pen.paper == id) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clickable { model.updateDesk("paper", id) }.padding(vertical = 4.dp),
                        )
                    }
                    Text("Stiftfarbe", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    listOf("#202333", "#2457d6", "#d23b4a", "#1f8a4c", "#e2a21b", "#7a4dd6").forEach { color ->
                        Text(
                            color,
                            color = Color(android.graphics.Color.parseColor(color)),
                            fontWeight = if (pen.color == color) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clickable { model.setPenColor(color) }.padding(vertical = 4.dp),
                        )
                    }
                }
                "files" -> {
                    TextButton(onClick = onOpenVault) { Text("Vault-Ordner öffnen") }
                    TextButton(onClick = onPrivate) { Text("Tablet-Vault verwenden") }
                    Text("Profil", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    listOf("school" to "Schule", "university" to "UNI", "private" to "Privat", "work" to "Arbeit").forEach { (id, label) ->
                        Text(
                            label,
                            modifier = Modifier.clickable { model.applyProfile(id) }.padding(vertical = 4.dp),
                            fontWeight = if (settings["profile"] == id) FontWeight.Bold else FontWeight.Normal,
                        )
                    }
                }
                "sync" -> {
                    TextButton(onClick = onSync) { Text("Konto und Abgleich") }
                    var deviceName by remember { mutableStateOf(model.syncDeviceName()) }
                    var automatic by remember { mutableStateOf(model.syncAutomatic()) }
                    OutlinedTextField(
                        deviceName,
                        {
                            deviceName = it.take(80)
                            model.setSyncDeviceName(it.take(80))
                        },
                        label = { Text("Name dieses Geräts") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Text("Erscheint in der Geräteliste und im Namen von Konfliktkopien.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    Text(
                        "Automatisch synchronisieren: ${if (automatic) "an" else "aus"}",
                        modifier = Modifier.clickable {
                            automatic = !automatic
                            model.setSyncAutomatic(automatic)
                        }.padding(vertical = 6.dp),
                        fontWeight = if (automatic) FontWeight.Bold else FontWeight.Normal,
                    )
                    Text("Nach jedem Speichern und im Hintergrund. Aus: nur über Konto und Abgleich.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    Text("Ein Konflikt behält die Serverfassung auf dem ursprünglichen Pfad. Die Tablet-Fassung liegt daneben.", fontSize = 13.sp)
                    OutlinedTextField(
                        settings["sync-excluded"].orEmpty(),
                        { model.updateDesk("sync-excluded", it) },
                        label = { Text("Ordner nur auf diesem Gerät") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("Ein Ordner je Zeile. Dateien darunter bleiben auf diesem Tablet.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    val historySync = settings["sync-history"] == "on"
                    Text(
                        "Versionsverlauf synchronisieren: ${if (historySync) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("sync-history", if (historySync) "off" else "on") }.padding(vertical = 6.dp),
                        fontWeight = if (historySync) FontWeight.Bold else FontWeight.Normal,
                    )
                    Text("Die lokalen Sicherungen unter .fanotes/history mitnehmen. Aus: der Verlauf bleibt auf diesem Gerät.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    ConflictList(model)
                }
                "addons" -> Text("Add-ons des Desktops bleiben Dateien im Vault. GlyphenWerk ist auf dem Tablet nicht enthalten. Andere Erweiterungen werden nicht ausgeführt.")
                "updates" -> {
                    Text("Installiert: 2026.10.7")
                    Text(update)
                    TextButton(onClick = { model.checkUpdate() }) { Text("Nach einem Release suchen") }
                }
                "accessibility" -> Text("Größere Ziele: ${settings["large"] == "on"}", modifier = Modifier.clickable { model.updateDesk("large", if (settings["large"] == "on") "off" else "on") })
                "experimental" -> {
                    Text("Geteilte Ansicht ist über die Befehlsleiste erreichbar. Bewegungen lassen sich mit Fokus beruhigen.")
                    val backups = settings["experimental-backup"] == "on"
                    Text(
                        "Notiz-Sicherungen: ${if (backups) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("experimental-backup", if (backups) "off" else "on") }.padding(vertical = 6.dp),
                        fontWeight = if (backups) FontWeight.Bold else FontWeight.Normal,
                    )
                }
                "advanced" -> Text("Der Gerätename für Konfliktdateien steht in den Sync-Einstellungen. Secrets liegen im Android-Keystore, nicht im Vault.")
            }
            TextButton(onClick = { model.openBugReport() }) { Text("Fehler melden") }
            Text("Die letzten fünf Minuten (Stift, Notiz, Werkzeug) werden an fanotes.fasrv.ch geschickt.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        }
    }
}

@Composable
fun NoteTagBar(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val tags = parseNoteTags(markdown)
    var draft by remember(model.open.collectAsStateWithLifecycle().value?.path) { mutableStateOf("") }
    fun addTag() {
        if (draft.isBlank()) return
        model.setNoteTags(tags + draft)
        draft = ""
    }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        tags.forEach { tag ->
            Text(
                "#$tag  ×",
                fontSize = 12.sp,
                modifier = Modifier
                    .padding(end = 4.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { model.setNoteTags(tags.filter { it != tag }) }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
        OutlinedTextField(
            draft,
            { draft = it.take(40) },
            modifier = Modifier.width(180.dp),
            singleLine = true,
            label = { Text("Tag hinzufügen") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { addTag() }),
        )
        TextButton(onClick = { addTag() }) { Text("Hinzufügen") }
    }
}

@Composable
fun MarginTranscript(model: FaNotesViewModel) {
    val token by model.canvasToken.collectAsStateWithLifecycle()
    val path = model.open.collectAsStateWithLifecycle().value?.path
    val transcript = remember(token, path) { model.session.document.extras.string("searchTranscript").orEmpty() }
    val lines = marginLinesFromTranscript(transcript)
    if (lines.isEmpty()) return
    var editing by remember(token, path) { mutableStateOf<String?>(null) }
    var draft by remember(token, path) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text("Randtranskript", fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        lines.forEachIndexed { index, line ->
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                line.text.split(Regex("""(\s+)""")).forEach { part ->
                    if (part.isBlank()) {
                        Text(part)
                    } else if (editing == "$index:$part") {
                        OutlinedTextField(
                            draft,
                            { draft = it },
                            modifier = Modifier.width(140.dp),
                            singleLine = true,
                            label = { Text("Wort korrigieren") },
                        )
                        TextButton(onClick = {
                            model.correctTranscriptWord(part, draft)
                            editing = null
                        }) { Text("OK") }
                    } else {
                        Text(
                            part,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable {
                                editing = "$index:$part"
                                draft = part
                            }.padding(horizontal = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun PdfQuoteMarks(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val marks = readPdfMarks(markdown)
    var page by remember { mutableStateOf("1") }
    var quote by remember { mutableStateOf("") }
    var underline by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text("PDF-Markierungen", fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        Text("Zitate bleiben in der Notiz, dieselbe Datei wie auf dem Desktop.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
        marks.forEach { mark ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "S. ${mark.page}  ${if (mark.kind == "underline") "Unterstrichen" else "Markiert"}  ${mark.quote}",
                    modifier = Modifier.weight(1f),
                    fontSize = 13.sp,
                    maxLines = 2,
                )
                TextButton(onClick = { model.removePdfQuote(mark.id) }) { Text("Entfernen") }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(page, { page = it.take(4) }, label = { Text("Seite") }, modifier = Modifier.width(88.dp), singleLine = true)
            OutlinedTextField(quote, { quote = it.take(400) }, label = { Text("Zitat") }, modifier = Modifier.weight(1f), singleLine = true)
        }
        Row {
            TextButton(onClick = { underline = !underline }) { Text(if (underline) "Unterstreichen" else "Markieren") }
            TextButton(onClick = {
                val number = page.toIntOrNull() ?: return@TextButton
                if (quote.isNotBlank()) {
                    model.addPdfQuote(number, quote, if (underline) "underline" else "highlight")
                    quote = ""
                }
            }) { Text("Hinzufügen") }
        }
    }
}

@Composable
fun NoteRelations(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val incoming by model.backlinks.collectAsStateWithLifecycle()
    val outgoing = wikiTargets(markdown)
    if (outgoing.isEmpty() && incoming.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        if (outgoing.isNotEmpty()) {
            Text("Verweise", fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
            outgoing.forEach { target ->
                Text(
                    "[[$target]]",
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = 13.sp,
                    modifier = Modifier.clickable { model.openWikiTarget(target) }.padding(vertical = 2.dp),
                )
            }
        }
        Text("Rückverweise", fontWeight = FontWeight.SemiBold, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        if (incoming.isEmpty()) {
            Text("Keine Wiki-Links auf diese Notiz.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
        incoming.forEach { link ->
            Column(Modifier.fillMaxWidth().clickable { onOpen(link.path) }.padding(vertical = 4.dp)) {
                Text(link.title, fontSize = 13.sp)
                if (link.excerpt.isNotEmpty()) {
                    Text(link.excerpt, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f), maxLines = 2)
                }
            }
        }
    }
}

@Composable
fun Inspector(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val path = model.open.collectAsStateWithLifecycle().value?.path
    if (settings["outline"] == "off") return
    Column(Modifier.fillMaxSize().padding(12.dp).verticalScroll(rememberScrollState())) {
        val stats = measureDocument(markdown)
        Text("Dokument", fontWeight = FontWeight.SemiBold)
        Text("${stats.words} Wörter", fontSize = 13.sp)
        Text("${stats.characters} Zeichen", fontSize = 13.sp)
        Text("Lesezeit ~ ${stats.readingMinutes} min", fontSize = 13.sp)
        Text("${stats.headings} Überschriften · ${stats.tasksDone}/${stats.tasks} Aufgaben", fontSize = 13.sp)
        if (path != null) Text(path, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
        Text("Gliederung", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
        val headings = parseNoteOutline(markdown)
        if (headings.isEmpty()) {
            Text("Überschriften erscheinen hier automatisch.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
        headings.forEach { heading ->
            val inset = (10 + (heading.level - 1).coerceAtLeast(0) * 12).dp
            Text(
                "› ${heading.title}",
                modifier = Modifier.padding(start = inset, top = 4.dp).clickable { model.jumpToOutline(heading.line) },
                fontSize = 13.sp,
            )
        }
        Text("Tags", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
        val tags = parseNoteTags(markdown)
        if (tags.isEmpty()) {
            Text("Noch keine Tags.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        } else {
            Text(tags.joinToString("  ") { "#$it" }, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        }
        Text("Aufgaben", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
        taskLines(markdown).forEach { (index, done, text) ->
            Text("${if (done) "☑" else "☐"} $text", modifier = Modifier.clickable { model.updateMarkdown(ch.fasrv.fanotes.desk.toggleTask(markdown, index)) }.padding(vertical = 4.dp), fontSize = 13.sp)
        }
        NoteRelations(model, onOpen)
    }
}

@Composable
fun CommandPalette(
    onDismiss: () -> Unit,
    rankNotes: (String) -> List<SwitcherNote>,
    onOpenNote: (String) -> Unit,
    onRun: (String) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val notes = if (query.isBlank()) emptyList() else rankNotes(query)
    val actions = listOf(
        "notes" to "Notizen",
        "search" to "Im Vault suchen",
        "tasks" to "Hausaufgaben & Termine",
        "calendar" to "Kalender",
        "overview" to "Vault-Übersicht",
        "cards" to "Karteikarten",
        "books" to "Fachbuch",
        "history" to "Versionsverlauf",
        "study" to "Lernzeit",
        "nav-back" to "Zurück",
        "nav-forward" to "Vorwärts",
        "reopen-tab" to "Geschlossenen Tab wieder öffnen",
        "pin-tab" to "Tab anheften",
        "close-others" to "Andere Tabs schließen",
        "close-right" to "Tabs rechts schließen",
        "cycle-tab" to "Nächster Tab",
        "template-protocol" to "Vorlage: Protokoll",
        "template-proof" to "Vorlage: Beweis",
        "template-cornell" to "Vorlage: Cornell",
        "template-vocabulary" to "Vorlage: Vokabeln",
        "template-journal" to "Vorlage: Tagebuch",
        "template-meeting" to "Vorlage: Besprechung",
        "ai" to "AI",
        "settings" to "Einstellungen",
        "daily" to "Tägliche Notiz",
        "split" to "Zweite Spalte",
        "split-orient" to "Teilung drehen",
        "split-swap" to "Geteilte Ansicht tauschen",
        "note-here" to "Notiz in diesem Ordner",
        "subfolder" to "Unterordner",
        "focus" to "Fokusmodus",
        "sync" to "Sync",
        "bug-report" to "Fehler melden",
        "export-pdf" to "Notiz als PDF exportieren",
        "download-note" to "Notiz herunterladen",
    )
    val commands = if (query.isBlank()) actions else actions.filter { (_, label) -> fuzzyScore(query, label) > 0 }
    Column(Modifier.fillMaxWidth().heightIn(max = 480.dp).verticalScroll(rememberScrollState()).background(MaterialTheme.colorScheme.surface).padding(12.dp)) {
        OutlinedTextField(query, { query = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Notiz oder Befehl") }, singleLine = true)
        if (notes.isNotEmpty()) {
            Text("Notizen", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp), fontSize = 12.sp)
            notes.forEach { note ->
                Column(Modifier.fillMaxWidth().clickable { onOpenNote(note.path); onDismiss() }.padding(vertical = 6.dp)) {
                    Text(note.title)
                    if (note.folder.isNotEmpty()) Text(note.folder, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                }
            }
        }
        Text("Befehle", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp), fontSize = 12.sp)
        commands.forEach { (id, label) ->
            Text(label, modifier = Modifier.fillMaxWidth().clickable { onRun(id); onDismiss() }.padding(vertical = 8.dp))
        }
    }
}
