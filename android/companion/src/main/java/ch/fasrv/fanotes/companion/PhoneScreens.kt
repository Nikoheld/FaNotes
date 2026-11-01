@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ch.fasrv.fanotes.companion

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.School
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import ch.fasrv.fanotes.desk.THEME_CHOICES
import ch.fasrv.fanotes.ink.DEFAULT_PEN_COLOR
import ch.fasrv.fanotes.schulnetz.courseSummaries
import ch.fasrv.fanotes.schulnetz.displayColor
import ch.fasrv.fanotes.schulnetz.endsAt
import ch.fasrv.fanotes.schulnetz.eventsOn
import ch.fasrv.fanotes.schulnetz.formatMark
import ch.fasrv.fanotes.schulnetz.formatPluspunkte
import ch.fasrv.fanotes.schulnetz.isCancelled
import ch.fasrv.fanotes.schulnetz.isExamLike
import ch.fasrv.fanotes.schulnetz.isLesson
import ch.fasrv.fanotes.schulnetz.isSubstitution
import ch.fasrv.fanotes.schulnetz.startsAt
import ch.fasrv.fanotes.schulnetz.nextUp
import ch.fasrv.fanotes.schulnetz.overallAverage
import ch.fasrv.fanotes.schulnetz.overallPluspunkte
import ch.fasrv.fanotes.schulnetz.schoolWeek
import ch.fasrv.fanotes.schulnetz.todayChanges
import ch.fasrv.fanotes.schulnetz.wunschnote
import ch.fasrv.fanotes.sync.SyncStatus
import ch.fasrv.fanotes.sync.syncStatusLabel
import ch.fasrv.fanotes.vault.OpenNote
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

@Composable
fun CompanionRoot(model: CompanionModel) {
    val sync by model.graph.engine.state.collectAsState()
    if (sync.account == null) {
        LoginScreen(model, busy = model.busy || sync.status == SyncStatus.SYNCING)
        return
    }
    if (model.section == PhoneSection.Editor && model.editorPath != null) {
        EditorScreen(model, model.editorPath!!)
        return
    }
    val tabs = listOf(
        PhoneTab.Heute to Icons.Filled.Home,
        PhoneTab.Plan to Icons.Filled.CalendarMonth,
        PhoneTab.Noten to Icons.Filled.School,
        PhoneTab.Notizen to Icons.Filled.Edit,
        PhoneTab.Mehr to Icons.Filled.MoreHoriz,
    )
    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEach { (tab, icon) ->
                    NavigationBarItem(
                        selected = model.tab == tab,
                        onClick = { model.tab = tab; model.section = PhoneSection.Menu },
                        icon = { Icon(icon, contentDescription = tab.name) },
                        label = { Text(tab.name) },
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp)) {
            model.message?.let { text ->
                Text(text, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
            }
            when (model.tab) {
                PhoneTab.Heute -> TodayScreen(model)
                PhoneTab.Plan -> PlanScreen(model)
                PhoneTab.Noten -> GradesScreen(model)
                PhoneTab.Notizen -> NotesScreen(model)
                PhoneTab.Mehr -> MoreScreen(model)
            }
        }
    }
}

@Composable
private fun LoginScreen(model: CompanionModel, busy: Boolean) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("FaNotes", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Text("Companion für das Telefon. Notizen, Kalender und Schulnetz an einem Konto.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(model.email, { model.email = it }, label = { Text("E-Mail") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(model.password, { model.password = it }, label = { Text("Passwort") }, modifier = Modifier.fillMaxWidth(), singleLine = true, visualTransformation = PasswordVisualTransformation())
        model.message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(16.dp))
        Button(onClick = { model.login(false) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Bitte warten …" else "Anmelden") }
        TextButton(onClick = { model.login(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Konto erstellen") }
    }
}

@Composable
private fun TodayScreen(model: CompanionModel) {
    val zone = ZoneId.systemDefault()
    val now = Instant.now()
    val next = nextUp(model.snapshot.events, now, zone)
    val changes = todayChanges(model.snapshot.events, LocalDate.now(zone), zone)
    val openTasks = model.tasks.filter { !it.done }.take(5)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxSize()) {
        item { Spacer(Modifier.height(12.dp)) }
        item {
            CardBlock {
                Text(if (next?.isExamLike() == true) "Nächste Prüfung" else "Nächste Lektion", color = MaterialTheme.colorScheme.primary)
                Text(next?.label ?: "Nichts weiter heute", style = MaterialTheme.typography.headlineSmall)
                Text(next?.let { lessonLine(it, zone) } ?: "Stundenplan öffnen, sobald Schulnetz verbunden ist.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (changes.isNotEmpty()) {
            item { Text("Änderungen heute", fontWeight = FontWeight.SemiBold) }
            items(changes) { event ->
                CardBlock {
                    Text(event.label, fontWeight = FontWeight.Medium)
                    Text(listOf(lessonLine(event, zone), if (event.isCancelled()) "fällt aus" else "Vertretung").filter { it.isNotBlank() }.joinToString(" · "))
                }
            }
        }
        item { Text("Hausaufgaben", fontWeight = FontWeight.SemiBold) }
        if (openTasks.isEmpty()) item { Text("Nichts offen.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(openTasks) { task ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Checkbox(checked = false, onCheckedChange = { model.toggleTask(task) })
                Column {
                    Text(task.title)
                    Text(listOf(task.subject, task.dueDate).filter { !it.isNullOrBlank() }.joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (model.snapshot.messages.isNotEmpty() || model.snapshot.startMessages.isNotEmpty()) {
            item { Text("Mitteilungen", fontWeight = FontWeight.SemiBold) }
            items(model.snapshot.messages.take(5)) { message -> Text(message.body.ifBlank { message.title }) }
            items(model.snapshot.startMessages) { line -> Text(line) }
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}

@Composable
private fun PlanScreen(model: CompanionModel) {
    val zone = ZoneId.systemDefault()
    val days = schoolWeek(model.day)
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.day = model.day.minusWeeks(1) }) { Text("Zurück") }
            Text(days.first().format(DateTimeFormatter.ofPattern("d. MMM", Locale.GERMAN)) + " – " + days.last().format(DateTimeFormatter.ofPattern("d. MMM", Locale.GERMAN)))
            TextButton(onClick = { model.day = model.day.plusWeeks(1) }) { Text("Weiter") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
            days.forEach { date ->
                FilterChip(
                    selected = date == model.day,
                    onClick = { model.day = date },
                    label = { Text(date.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.GERMAN)) },
                )
            }
        }
        val lessons = eventsOn(model.snapshot.events, model.day, zone)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
            if (lessons.isEmpty()) item { Text("Keine Lektionen.", modifier = Modifier.padding(top = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(lessons) { event ->
                Row(Modifier.fillMaxWidth().padding(top = 8.dp).background(paletteColor(event.displayColor()).copy(alpha = 0.18f), RoundedCornerShape(10.dp)).padding(12.dp)) {
                    Column {
                        Text(event.label, fontWeight = FontWeight.SemiBold)
                        Text(lessonLine(event, zone))
                        if (event.isCancelled()) Text("fällt aus", color = MaterialTheme.colorScheme.error)
                        if (event.isSubstitution()) Text("Vertretung")
                        if (event.comment.isNotBlank()) Text(event.comment, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun GradesScreen(model: CompanionModel) {
    val courses = courseSummaries(model.snapshot.grades, model.hypothetical)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxSize()) {
        item {
            Text("Schnitt ${formatMark(overallAverage(courses))} · Pluspunkte ${formatPluspunkte(overallPluspunkte(courses))}", modifier = Modifier.padding(top = 12.dp), fontWeight = FontWeight.SemiBold)
        }
        items(courses) { course -> CourseCard(model, course) }
        if (courses.isEmpty()) item { Text("Noch keine Noten. Schulnetz unter Mehr verbinden.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun CourseCard(model: CompanionModel, course: ch.fasrv.fanotes.schulnetz.CourseSummary) {
    var target by remember(course.courseId) { mutableStateOf("5.0") }
    var weight by remember(course.courseId) { mutableStateOf("1") }
    var guess by remember(course.courseId) { mutableStateOf("") }
    val wish = wunschnote(course.marks, target.replace(',', '.').toDoubleOrNull() ?: 5.0, weight.replace(',', '.').toDoubleOrNull() ?: 1.0)
    CardBlock {
        Text(course.label, fontWeight = FontWeight.SemiBold)
        Text("Schnitt ${formatMark(course.average)} · Pluspunkte ${formatPluspunkte(course.pluspunkte)}")
        course.marks.forEach { mark ->
            Text("${mark.label.ifBlank { "Note" }} · ${formatMark(mark.mark)} · Gewicht ${formatMark(mark.weight)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(guess, { guess = it }, label = { Text("Hypothese") }, modifier = Modifier.weight(1f), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedButton(onClick = {
                val mark = guess.replace(',', '.').toDoubleOrNull()
                if (mark != null && mark in 1.0..6.0) model.addHypothetical(course.courseId, "Hypothese", mark, 1.0)
            }) { Text("Dazu") }
        }
        if (model.hypothetical.any { it.courseId == course.courseId }) {
            TextButton(onClick = { model.clearHypothetical(course.courseId) }) { Text("Hypothesen löschen") }
        }
        Text(when {
            !wish.achievable -> wish.reason
            wish.alreadyMet -> wish.reason
            else -> "Wunschnote ${formatMark(wish.needed)} (halbe Note ${formatMark(wish.neededHalf)})"
        })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(target, { target = it }, label = { Text("Ziel") }, modifier = Modifier.weight(1f))
            OutlinedTextField(weight, { weight = it }, label = { Text("Gewicht") }, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun NotesScreen(model: CompanionModel) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Notizen", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = { model.createNote("Notiz") }) { Text("Neu") }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(model.notes) { note ->
                Text(
                    note.name,
                    modifier = Modifier.fillMaxWidth().clickable {
                        model.editorPath = note.path
                        model.section = PhoneSection.Editor
                    }.padding(vertical = 12.dp),
                    style = MaterialTheme.typography.titleMedium,
                )
            }
        }
    }
}

@Composable
private fun EditorScreen(model: CompanionModel, path: String) {
    var note by remember(path) { mutableStateOf<OpenNote?>(null) }
    var markdown by remember(path) { mutableStateOf("") }
    var document by remember(path) { mutableStateOf<ch.fasrv.fanotes.ink.InkDocument?>(null) }
    var eraser by remember { mutableStateOf(false) }
    var panning by remember { mutableStateOf(false) }
    var color by remember { mutableStateOf(DEFAULT_PEN_COLOR) }
    LaunchedEffect(path) {
        val loaded = withContext(Dispatchers.IO) { model.graph.store.readNote(path) }
        note = loaded
        markdown = loaded.markdown.lineSequence().filterNot { it.contains("fanotes-ink:") }.joinToString("\n")
        document = loaded.document
        model.graph.busyPaths = model.graph.busyPaths + path
    }
    DisposableEffect(path) {
        onDispose { model.graph.busyPaths = model.graph.busyPaths - path }
    }
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.section = PhoneSection.Menu }) { Text("Zurück") }
            Text(note?.title ?: "Notiz", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            TextButton(onClick = {
                val ink = document ?: return@TextButton
                model.saveNote(path, ink, markdown)
            }) { Text("Sichern") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !eraser && !panning, onClick = { eraser = false; panning = false }, label = { Text("Stift") })
            FilterChip(selected = eraser, onClick = { eraser = true; panning = false }, label = { Text("Radierer") })
            FilterChip(selected = panning, onClick = { panning = true; eraser = false }, label = { Text("Blättern") })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 6.dp)) {
            listOf("#202333", "#2a6f97", "#c4554d", "#0f7b6c").forEach { swatch ->
                Spacer(Modifier.width(28.dp).height(28.dp).background(paletteColor(swatch), RoundedCornerShape(8.dp)).clickable { color = swatch })
            }
        }
        val ink = document
        if (ink != null) {
            AndroidView(
                factory = { context ->
                    CompanionInkView(context, ink) { updated -> document = updated }.apply {
                        this.eraser = eraser
                        this.panning = panning
                        this.penColor = color
                    }
                },
                update = { view ->
                    view.eraser = eraser
                    view.panning = panning
                    view.penColor = color
                },
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        }
        OutlinedTextField(markdown, { markdown = it }, modifier = Modifier.fillMaxWidth().height(120.dp), label = { Text("Text") }, textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
    }
}

@Composable
private fun MoreScreen(model: CompanionModel) {
    when (model.section) {
        PhoneSection.Hausaufgaben -> HomeworkScreen(model)
        PhoneSection.Kalender -> CalendarScreen(model)
        PhoneSection.Absenzen -> SimpleList("Absenzen", model.snapshot.absences.map { "${it.dateFrom} · ${it.subject.ifBlank { "Absenz" }} · ${it.reason} · ${if (it.excused) "entschuldigt" else "offen"}" }) { model.section = PhoneSection.Menu }
        PhoneSection.Pruefungen -> ExamScreen(model)
        PhoneSection.Termine -> SimpleList("Termine", model.snapshot.events.filter { !it.isLesson() }.map { "${it.label} · ${it.start}" } + model.snapshot.vacations.map { "${it.name} · ${it.start}" }) { model.section = PhoneSection.Menu }
        PhoneSection.Konto -> SimpleList(
            "Kontoauszug",
            model.snapshot.konto.map { "${it.date} · ${it.label} · ${it.amount} · Saldo ${it.balance}" }.ifEmpty { listOf("Der mobile Zugang liefert keinen Kontoauszug. Die Seite wird nur gelesen, wenn Schulnetz sie als HTML mitschickt.") },
        ) { model.section = PhoneSection.Menu }
        PhoneSection.Einstellungen -> SettingsScreen(model)
        else -> MenuScreen(model)
    }
}

@Composable
private fun MenuScreen(model: CompanionModel) {
    val rows = listOf(
        PhoneSection.Hausaufgaben to "Hausaufgaben",
        PhoneSection.Kalender to "Kalender",
        PhoneSection.Absenzen to "Absenzen",
        PhoneSection.Pruefungen to "Prüfungen",
        PhoneSection.Termine to "Termine",
        PhoneSection.Konto to "Kontoauszug",
        PhoneSection.Einstellungen to "Einstellungen",
    )
    LazyColumn {
        item { Text(syncLine(model), modifier = Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(rows) { (section, label) ->
            Text(label, modifier = Modifier.fillMaxWidth().clickable { model.section = section }.padding(vertical = 16.dp), style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
private fun HomeworkScreen(model: CompanionModel) {
    Column(Modifier.fillMaxSize()) {
        TextButton(onClick = { model.section = PhoneSection.Menu }) { Text("Zurück") }
        Text("FaNotes", fontWeight = FontWeight.SemiBold)
        LazyColumn(Modifier.weight(1f)) {
            items(model.tasks) { task ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(task.done, onCheckedChange = { model.toggleTask(task) })
                    Column {
                        Text(task.title)
                        Text(listOf(task.subject, task.dueDate).filter { !it.isNullOrBlank() }.joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            item { Text("Schulnetz", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
            items(model.snapshot.homework) { item ->
                Column(Modifier.padding(vertical = 8.dp)) {
                    Text(item.title)
                    Text(listOf(item.courseName, item.dueDate).filter { it.isNotBlank() }.joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = { model.importHomework(item.title, item.courseName, item.dueDate, item.description) }) { Text("In FaNotes übernehmen") }
                }
            }
        }
    }
}

@Composable
private fun CalendarScreen(model: CompanionModel) {
    SimpleList("Kalender", model.calendar.events.map { "${it.title} · ${it.start}" + if (it.location.isBlank()) "" else " · ${it.location}" }.ifEmpty { listOf("Keine Termine in Kalender.md.") }) {
        model.section = PhoneSection.Menu
    }
}

@Composable
private fun ExamScreen(model: CompanionModel) {
    Column(Modifier.fillMaxSize()) {
        TextButton(onClick = { model.section = PhoneSection.Menu }) { Text("Zurück") }
        LazyColumn {
            items(model.snapshot.exams) { exam ->
                Column(Modifier.padding(vertical = 8.dp)) {
                    Text(exam.label, fontWeight = FontWeight.Medium)
                    Text(listOf(exam.start, exam.room).filter { it.isNotBlank() }.joinToString(" · "))
                    TextButton(onClick = { model.importExam(exam) }) { Text("In den Kalender") }
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(model: CompanionModel) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) model.onWebLoginFinished()
        else model.message = "Schulnetz-Anmeldung abgebrochen."
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TextButton(onClick = { model.section = PhoneSection.Menu }) { Text("Zurück") }
        Text("Erscheinung", fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
            THEME_CHOICES.take(4).forEach { choice ->
                FilterChip(selected = model.theme == choice.id || (model.theme == "system" && choice.id == "system"), onClick = { model.chooseTheme(choice.id) }, label = { Text(choice.label) })
            }
        }
        Text("Schulnetz", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
        Text(if (model.link.linked) "Verbunden${if (model.link.needsReauth) " · bitte neu anmelden" else ""}" else "Nicht verbunden")
        OutlinedTextField(model.baseUrl, { model.baseUrl = it }, label = { Text("Schulnetz-Adresse") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { model.schulnetzIntent(context)?.let(launcher::launch) }, modifier = Modifier.fillMaxWidth()) { Text(if (model.link.linked) "Neu verbinden" else "Mit Microsoft anmelden") }
        if (model.link.linked) TextButton(onClick = { model.unlink() }) { Text("Trennen") }
        model.snapshot.readErrors.forEach { Text(it, color = MaterialTheme.colorScheme.error) }
        if (model.snapshot.readErrors.isNotEmpty() || model.debugHtml.isNotBlank()) {
            OutlinedButton(onClick = { model.shareDebug(context) }, modifier = Modifier.fillMaxWidth()) { Text("HTML teilen") }
        }
        Text("Benachrichtigungen", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
        SettingSwitch("Neue Note", model.settings.grades) { model.toggleSetting("grades") }
        SettingSwitch("Stundenplan", model.settings.timetable) { model.toggleSetting("timetable") }
        SettingSwitch("Prüfungen", model.settings.exams) { model.toggleSetting("exams") }
        SettingSwitch("Absenzen", model.settings.absences) { model.toggleSetting("absences") }
        SettingSwitch("Termine und Mitteilungen", model.settings.events) { model.toggleSetting("events") }
        SettingSwitch("Sofort über ntfy", model.instant) { model.chooseInstant(it) }
        OutlinedButton(onClick = { model.enablePush(context) }, modifier = Modifier.fillMaxWidth()) { Text("UnifiedPush aktivieren") }
        OutlinedButton(onClick = { model.testPush() }, modifier = Modifier.fillMaxWidth()) { Text("Testbenachrichtigung") }
        if (model.link.pushUrl.isNotBlank()) Text("Push: ${model.link.pushUrl}", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        Button(onClick = { model.sync() }, modifier = Modifier.fillMaxWidth()) { Text("Jetzt synchronisieren") }
        TextButton(onClick = { model.logout() }) { Text("Abmelden") }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label)
        Switch(checked, onCheckedChange = onChange)
    }
}

@Composable
private fun SimpleList(title: String, lines: List<String>, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        TextButton(onClick = onBack) { Text("Zurück") }
        Text(title, style = MaterialTheme.typography.titleLarge)
        LazyColumn {
            items(lines) { line -> Text(line, modifier = Modifier.padding(vertical = 8.dp)) }
        }
    }
}

@Composable
private fun CardBlock(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(12.dp)) { content() }
}

@Composable
private fun syncLine(model: CompanionModel): String {
    val sync by model.graph.engine.state.collectAsState()
    val schul = when {
        model.link.needsReauth -> "Schulnetz neu anmelden"
        model.link.linked -> "Schulnetz verbunden"
        model.link.reachable -> "Schulnetz nicht verbunden"
        else -> "Schulnetz-Server noch nicht eingerichtet"
    }
    return "${sync.account?.email.orEmpty()} · ${syncStatusLabel(sync)} · $schul"
}

private fun lessonLine(event: ch.fasrv.fanotes.schulnetz.AgendaEvent, zone: ZoneId): String {
    val start = event.startsAt(zone)?.atZone(zone)?.toLocalTime()?.toString()?.take(5).orEmpty()
    val end = event.endsAt(zone)?.atZone(zone)?.toLocalTime()?.toString()?.take(5).orEmpty()
    val time = if (start.isBlank()) "" else if (end.isBlank() || end == start) start else "$start–$end"
    val room = if (event.room.isBlank()) "" else "Raum ${event.room}"
    val teacher = event.teachers.joinToString(", ")
    return listOf(time, room, teacher).filter { it.isNotBlank() }.joinToString(" · ")
}
