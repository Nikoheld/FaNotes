package ch.fasrv.fanotes

import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
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
import ch.fasrv.fanotes.desk.outlineOf
import ch.fasrv.fanotes.desk.taskLines
import java.time.LocalDate
import java.time.YearMonth

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
    val calendarId = document.calendars.firstOrNull { it.visible }?.id ?: document.calendars.firstOrNull()?.id ?: "personal"
    val shown = document.copy(events = ch.fasrv.fanotes.desk.visibleCalendarEvents(document))
    var calendarName by remember { mutableStateOf("") }
    val day = anchor.toString()
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Kalender", style = MaterialTheme.typography.titleLarge)
        Text("Gespeichert in Kalender.md.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            document.calendars.forEach { calendar ->
                Text(
                    calendar.name,
                    fontSize = 13.sp,
                    fontWeight = if (calendar.visible) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (calendar.visible) androidx.compose.ui.graphics.Color(android.graphics.Color.parseColor(calendar.color)) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                    modifier = Modifier.clickable { model.toggleCalendarVisible(calendar.id) }.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(calendarName, { calendarName = it.take(80) }, label = { Text("Neue Liste") }, modifier = Modifier.weight(1f), singleLine = true)
            TextButton(onClick = {
                if (calendarName.isNotBlank()) {
                    model.createCalendarList(calendarName)
                    calendarName = ""
                }
            }) { Text("Hinzufügen") }
        }
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
            "agenda" -> AgendaList(anchor, shown, onOpenNote)
            else -> DayColumns(ch.fasrv.fanotes.desk.calendarRange(view, anchor), anchor, shown, onOpenNote) { anchor = it }
        }
        Text("Am $day", modifier = Modifier.padding(top = 8.dp), fontWeight = FontWeight.SemiBold)
        EventsOn(model, shown, anchor, onOpenNote)
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

@Composable
private fun DayColumns(
    days: List<LocalDate>,
    anchor: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onOpenNote: (String) -> Unit,
    onPick: (LocalDate) -> Unit,
) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        days.forEach { date ->
            Column(
                Modifier.width(148.dp).padding(end = 8.dp).clickable { onPick(date) }.background(if (date == anchor) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent).padding(6.dp),
            ) {
                Text("${date.dayOfMonth}. ${date.monthValue}", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, date) && it.allDay }.forEach { event ->
                    Text(event.title, fontSize = 12.sp, modifier = Modifier.clickable(enabled = event.notePath.isNotBlank()) { onOpenNote(event.notePath) })
                }
                for (hour in 7..20) {
                    val hits = document.events.filter { event ->
                        ch.fasrv.fanotes.desk.occurrencesOn(event, date) && ch.fasrv.fanotes.desk.eventClock(event)?.startsWith("%02d".format(hour)) == true
                    }
                    Text(
                        "$hour ${hits.joinToString { it.title }}".trim(),
                        fontSize = 11.sp,
                        color = if (hits.isEmpty()) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f) else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(vertical = 1.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun AgendaList(anchor: LocalDate, document: ch.fasrv.fanotes.desk.CalendarDocument, onOpenNote: (String) -> Unit) {
    ch.fasrv.fanotes.desk.calendarRange("agenda", anchor).forEach { date ->
        val events = document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, date) }
        if (events.isNotEmpty()) {
            Text(date.toString(), fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
            events.forEach { event ->
                val clock = ch.fasrv.fanotes.desk.eventClock(event)?.let { "$it " }.orEmpty()
                Text(
                    clock + event.title + if (event.notePath.isNotBlank()) "  →" else "",
                    modifier = Modifier.clickable(enabled = event.notePath.isNotBlank()) { onOpenNote(event.notePath) }.padding(vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun EventsOn(model: FaNotesViewModel, document: ch.fasrv.fanotes.desk.CalendarDocument, day: LocalDate, onOpenNote: (String) -> Unit) {
    document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, day) }.forEach { event ->
        val repeat = when (event.recurrence) {
            "daily" -> " · täglich"
            "weekly" -> " · wöchentlich"
            "monthly" -> " · monatlich"
            "yearly" -> " · jährlich"
            else -> ""
        }
        val clock = ch.fasrv.fanotes.desk.eventClock(event)?.let { "$it " }.orEmpty()
        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Text(
                clock + event.title + repeat + if (event.notePath.isNotBlank()) "  →" else "",
                modifier = Modifier.clickable(enabled = event.notePath.isNotBlank()) { onOpenNote(event.notePath) },
            )
            Row(Modifier.horizontalScroll(rememberScrollState())) {
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
    val reply by model.aiReply.collectAsStateWithLifecycle()
    val markdown by model.markdown.collectAsStateWithLifecycle()
    var prompt by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("AI", style = MaterialTheme.typography.titleLarge)
        Text("Der Schlüssel bleibt in den Einstellungen dieses Tablets. Es wird derselbe Chat-Endpunkt wie bei einem selbst gewählten Anbieter benutzt.", fontSize = 13.sp)
        OutlinedTextField(prompt, { prompt = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Frage") })
        Row {
            TextButton(onClick = { model.askAi(prompt.ifBlank { "Fasse diese Notiz zusammen:\n\n${markdown.take(6000)}" }) }) { Text("Fragen") }
            TextButton(onClick = { model.askAi("Formuliere Lernfragen als Markdown mit ## Lernfragen und details/summary zu:\n\n${markdown.take(6000)}") }) { Text("Lernfragen") }
        }
        Text(reply)
    }
}

@Composable
fun SettingsScreen(model: FaNotesViewModel, onSync: () -> Unit, onOpenVault: () -> Unit, onPrivate: () -> Unit) {
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val update by model.updateLabel.collectAsStateWithLifecycle()
    val context = LocalContext.current
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
                    Text("Wörter in der Statusleiste: ${settings["words"] != "off"}", modifier = Modifier.clickable { model.updateDesk("words", if (settings["words"] == "off") "on" else "off") })
                    Text("Gliederung: ${settings["outline"] != "off"}", modifier = Modifier.clickable { model.updateDesk("outline", if (settings["outline"] == "off") "on" else "off") })
                    Text("Täglicher Ordner: ${settings["daily-folder"].orEmpty().ifBlank { "Daily Notes" }}")
                }
                "drawing" -> Text("Stift, Radierer, Auswahl, Druck und Papier sitzen auf der Notiz. Der Finger blättert, bis du das in der Leiste umschaltest.")
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
            TextButton(onClick = {
                val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:support@fanotes.fasrv.ch?subject=FaNotes%20Android%202026.10.7"))
                runCatching { context.startActivity(intent) }
            }) { Text("Fehler melden") }
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
        outlineOf(markdown).forEach { (level, text) ->
            Text(text, modifier = Modifier.padding(start = (level * 8).dp, top = 4.dp), fontSize = 13.sp)
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
        "focus" to "Fokusmodus",
        "sync" to "Sync",
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
