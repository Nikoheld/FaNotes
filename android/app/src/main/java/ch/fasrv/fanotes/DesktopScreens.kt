package ch.fasrv.fanotes

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.dueCards
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
fun DeskStatusBar(words: Int, syncText: String, language: String, showWords: Boolean, conflicts: Int = 0, onConflicts: () -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().height(28.dp).background(MaterialTheme.colorScheme.surface).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(syncText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            if (conflicts > 0) {
                Text(
                    "$conflicts Konflikte",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(onClick = onConflicts),
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(language, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            if (showWords) Text("$words Wörter", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        }
    }
}

@Composable
fun NoteTabs(paths: List<String>, selected: String?, onOpen: (String) -> Unit, onClose: (String) -> Unit) {
    if (paths.isEmpty()) return
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 2.dp)) {
        paths.forEach { path ->
            val name = path.substringAfterLast('/').substringBeforeLast('.')
            Row(
                Modifier.padding(end = 4.dp).background(if (path == selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent).clickable { onOpen(path) }.padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
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
            items(hits, key = { "${it.path}:${it.line}:${it.text}" }) { hit ->
                Column(Modifier.fillMaxWidth().clickable { onOpen(hit.path) }.padding(vertical = 8.dp)) {
                    Text(hit.path, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
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
fun CalendarScreen(model: FaNotesViewModel, onOpenNote: (String) -> Unit) {
    val document by model.calendar.collectAsStateWithLifecycle()
    var month by remember { mutableStateOf(YearMonth.now()) }
    var title by remember { mutableStateOf("") }
    var day by remember { mutableStateOf(LocalDate.now().toString()) }
    var recurrence by remember { mutableStateOf("none") }
    val calendarId = document.calendars.firstOrNull()?.id ?: "personal"
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Kalender", style = MaterialTheme.typography.titleLarge)
        Text("Gespeichert in Kalender.md.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { month = month.minusMonths(1) }) { Text("‹") }
            Text(month.toString(), modifier = Modifier.padding(horizontal = 8.dp))
            TextButton(onClick = { month = month.plusMonths(1) }) { Text("›") }
        }
        val start = month.atDay(1)
        val offset = (start.dayOfWeek.value + 6) % 7
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So").forEach { Text(it, fontSize = 12.sp) }
        }
        val cells = offset + month.lengthOfMonth()
        for (week in 0 until (cells + 6) / 7) {
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                for (column in 0 until 7) {
                    val index = week * 7 + column
                    val date = if (index >= offset && index < offset + month.lengthOfMonth()) month.atDay(index - offset + 1) else null
                    val key = date?.toString()
                    val count = if (date == null) 0 else document.events.count { ch.fasrv.fanotes.desk.occurrencesOn(it, date) }
                    Text(
                        if (date == null) "" else "${date.dayOfMonth}${if (count > 0) " ·$count" else ""}",
                        modifier = Modifier.weight(1f).clickable(enabled = date != null) { if (key != null) day = key }.padding(4.dp),
                        fontSize = 13.sp,
                        color = if (key == day) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
        Text("Am $day", modifier = Modifier.padding(top = 8.dp), fontWeight = FontWeight.SemiBold)
        document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, java.time.LocalDate.parse(day)) }.forEach { event ->
            val repeat = when (event.recurrence) {
                "daily" -> " · täglich"
                "weekly" -> " · wöchentlich"
                "monthly" -> " · monatlich"
                "yearly" -> " · jährlich"
                else -> ""
            }
            Text(
                event.title + repeat + if (event.notePath.isNotBlank()) "  →" else "",
                modifier = Modifier.clickable(enabled = event.notePath.isNotBlank()) { onOpenNote(event.notePath) }.padding(vertical = 4.dp),
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
            OutlinedTextField(title, { title = it }, label = { Text("Neuer Termin") })
            TextButton(onClick = {
                if (title.isNotBlank()) {
                    model.addCalendarEvent(title, day, calendarId, recurrence)
                    title = ""
                }
            }) { Text("Eintragen") }
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
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Fachbuch", style = MaterialTheme.typography.titleLarge)
        Text("Dieselbe Liste wie .fanotes/subject-books.json.", fontSize = 13.sp)
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
fun HistoryScreen(model: FaNotesViewModel) {
    val history by model.noteHistory.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Versionsverlauf", style = MaterialTheme.typography.titleLarge)
        Text(open?.path ?: "Keine Notiz geöffnet.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Text("Dieselbe Ablage wie auf dem Desktop: .fanotes/history, höchstens 30 Fassungen je Notiz.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        if (history.isEmpty()) {
            Text("Für diese Notiz liegt noch keine ältere Fassung vor. Sie entsteht, sobald die Notiz erneut gespeichert wird.", modifier = Modifier.padding(top = 12.dp))
        }
        history.forEach { snapshot ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(snapshot.createdAt, fontSize = 14.sp)
                    Text("${snapshot.bytes} Bytes", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                }
                TextButton(onClick = { model.restoreHistory(snapshot.id) }) { Text("Wiederherstellen") }
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
                }
                "sync" -> {
                    TextButton(onClick = onSync) { Text("Konto und Abgleich") }
                    Text("Ein Konflikt behält die Serverfassung auf dem ursprünglichen Pfad. Die Tablet-Fassung liegt daneben.", fontSize = 13.sp)
                    ConflictList(model)
                }
                "addons" -> Text("Add-ons des Desktops bleiben Dateien im Vault. GlyphenWerk ist auf dem Tablet nicht enthalten. Andere Erweiterungen werden nicht ausgeführt.")
                "updates" -> {
                    Text("Installiert: 2026.10.7")
                    Text(update)
                    TextButton(onClick = { model.checkUpdate() }) { Text("Nach einem Release suchen") }
                }
                "accessibility" -> Text("Größere Ziele: ${settings["large"] == "on"}", modifier = Modifier.clickable { model.updateDesk("large", if (settings["large"] == "on") "off" else "on") })
                "experimental" -> Text("Geteilte Ansicht ist über die Befehlsleiste erreichbar. Bewegungen lassen sich mit Fokus beruhigen.")
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
fun Inspector(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    if (settings["outline"] == "off") return
    Column(Modifier.fillMaxSize().padding(12.dp).verticalScroll(rememberScrollState())) {
        Text("Gliederung", fontWeight = FontWeight.SemiBold)
        outlineOf(markdown).forEach { (level, text) ->
            Text(text, modifier = Modifier.padding(start = (level * 8).dp, top = 4.dp), fontSize = 13.sp)
        }
        Text("Aufgaben", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
        taskLines(markdown).forEach { (index, done, text) ->
            Text("${if (done) "☑" else "☐"} $text", modifier = Modifier.clickable { model.updateMarkdown(ch.fasrv.fanotes.desk.toggleTask(markdown, index)) }.padding(vertical = 4.dp), fontSize = 13.sp)
        }
        Text("Verweise", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
        model.linksNow().forEach { target ->
            Text("[[$target]]", modifier = Modifier.clickable { model.searchVaultText(target); model.showDestination("search") }.padding(vertical = 4.dp), color = MaterialTheme.colorScheme.primary, fontSize = 13.sp)
        }
        TextButton(onClick = { model.findBacklinks(); model.showDestination("search") }) { Text("Rückverweise suchen") }
    }
}

@Composable
fun CommandPalette(onDismiss: () -> Unit, onRun: (String) -> Unit) {
    val actions = listOf(
        "notes" to "Notizen",
        "search" to "Im Vault suchen",
        "tasks" to "Hausaufgaben & Termine",
        "calendar" to "Kalender",
        "overview" to "Vault-Übersicht",
        "cards" to "Karteikarten",
        "books" to "Fachbuch",
        "history" to "Versionsverlauf",
        "ai" to "AI",
        "settings" to "Einstellungen",
        "daily" to "Tägliche Notiz",
        "split" to "Zweite Spalte",
        "focus" to "Fokusmodus",
        "sync" to "Sync",
    )
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(12.dp)) {
        Text("Befehle", fontWeight = FontWeight.SemiBold)
        actions.forEach { (id, label) ->
            Text(label, modifier = Modifier.fillMaxWidth().clickable { onRun(id); onDismiss() }.padding(vertical = 8.dp))
        }
    }
}
