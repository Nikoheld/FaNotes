package ch.fasrv.fanotes

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.study.SortData
import ch.fasrv.fanotes.study.StudyKind
import ch.fasrv.fanotes.study.StudyTask
import ch.fasrv.fanotes.study.TermData
import ch.fasrv.fanotes.study.TermEntry
import ch.fasrv.fanotes.study.defaultSortData
import ch.fasrv.fanotes.study.defaultTermData
import ch.fasrv.fanotes.study.formatClock
import ch.fasrv.fanotes.study.groupMarksByPage
import ch.fasrv.fanotes.study.marksToMarkdown
import ch.fasrv.fanotes.study.newStudyId
import ch.fasrv.fanotes.study.parseSortData
import ch.fasrv.fanotes.study.parseTermData
import ch.fasrv.fanotes.study.readTaskList
import ch.fasrv.fanotes.study.removeSortCard
import ch.fasrv.fanotes.study.sortDataJson
import ch.fasrv.fanotes.study.taskProgress
import ch.fasrv.fanotes.study.termDataJson
import ch.fasrv.fanotes.study.unsortedCards
import ch.fasrv.fanotes.study.addSortCards
import ch.fasrv.fanotes.study.moveCard
import kotlinx.coroutines.delay

private fun ui(text: String) = ChromeText.ui(text)

/** Sentences with numbers cannot come from the catalog; they follow the UI language here. */
private fun counted(german: String, english: String) = if (ChromeText.language == "en") english else german

/** The Aufträge and Markierungen panel of an open PDF (menu `study-tasks` / `study-marks`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StudyPanel(model: FaNotesViewModel, initialTab: String) {
    var tab by remember(initialTab) { mutableStateOf(initialTab) }
    Column(Modifier.fillMaxWidth().heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
        Row {
            TextButton(onClick = { tab = "study-tasks"; model.openEditorMenu("study-tasks") }) {
                Text(ui("Aufträge"), fontWeight = if (tab == "study-tasks") FontWeight.Bold else FontWeight.Normal)
            }
            TextButton(onClick = { tab = "study-marks"; model.openEditorMenu("study-marks") }) {
                Text(ui("Markierungen"), fontWeight = if (tab == "study-marks") FontWeight.Bold else FontWeight.Normal)
            }
        }
        if (tab == "study-marks") StudyMarksTab(model) else StudyTasksTab(model)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StudyTasksTab(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val timer by model.studyTimer.collectAsStateWithLifecycle()
    val scanning by model.studyScanning.collectAsStateWithLifecycle()
    val editing by model.studyEditingTask.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val stored = remember(markdown) { readTaskList(markdown) }
    val tasks = stored?.tasks.orEmpty()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    // First visit: detect the assignments once, like the desktop panel does.
    LaunchedEffect(open?.path) {
        if (stored == null) model.scanStudyTasks()
    }
    LaunchedEffect(timer) {
        while (timer != null) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val progress = taskProgress(tasks)
    LinearProgressIndicator(progress = { progress.ratio.toFloat() }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
    val summary = counted("${progress.done} von ${progress.total} erledigt", "${progress.done} of ${progress.total} done") +
        if (progress.plannedMinutes > 0) counted(" · noch ca. ${progress.remainingMinutes} von ${progress.plannedMinutes} Min.", " · about ${progress.remainingMinutes} of ${progress.plannedMinutes} min left") else ""
    Text(summary, fontSize = 13.sp)
    Row {
        TextButton(onClick = { model.scanStudyTasks() }, enabled = !scanning) { Text(ui(if (scanning) "Suche …" else "Neu erkennen")) }
        TextButton(onClick = { model.addStudyTask() }) { Text(ui("Auftrag hinzufügen")) }
    }
    if (tasks.isEmpty() && !scanning) {
        Text(ui("Keine Aufträge. Zeilen wie „Auftrag 3: …“ werden automatisch erkannt, sonst füge sie von Hand hinzu."), fontSize = 13.sp)
    }
    tasks.forEach { task ->
        val running = timer?.second == task.id
        val seconds = task.spentSec + if (running) Math.round((now - (timer?.third ?: now)) / 1000.0).toInt().coerceAtLeast(0) else 0
        TaskRow(model, task, seconds, running, editing == task.id)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TaskRow(model: FaNotesViewModel, task: StudyTask, seconds: Int, running: Boolean, editing: Boolean) {
    val over = task.minutes > 0 && seconds > task.minutes * 60
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Checkbox(
            checked = task.done,
            onCheckedChange = { checked ->
                if (checked && running) model.stopStudyTimer()
                model.updateStudyTask(task.id) { it.copy(done = checked) }
            },
        )
        Column(Modifier.weight(1f)) {
            if (editing) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    EditField(task.id + "n", task.number, ui("Nummer"), Modifier.width(84.dp)) { value -> model.updateStudyTask(task.id) { it.copy(number = value.take(6), manual = true) } }
                    EditField(task.id + "t", task.title, ui("Was ist zu tun?"), Modifier.weight(1f)) { value -> model.updateStudyTask(task.id) { it.copy(title = value.take(400), manual = true) } }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    EditField(task.id + "m", task.minutes.takeIf { it > 0 }?.toString().orEmpty(), ui("Min."), Modifier.width(96.dp), numeric = true) { value ->
                        model.updateStudyTask(task.id) { it.copy(minutes = (value.toIntOrNull() ?: 0).coerceIn(0, 600), manual = true) }
                    }
                    EditField(task.id + "p", task.page.toString(), ui("Seite"), Modifier.width(96.dp), numeric = true) { value ->
                        model.updateStudyTask(task.id) { it.copy(page = (value.toIntOrNull() ?: 1).coerceAtLeast(1), manual = true) }
                    }
                }
            } else {
                Text(
                    (if (task.number.isNotEmpty()) "${ui("Auftrag")} ${task.number}  " else "${ui("Auftrag")}  ") + task.title.ifEmpty { ui("ohne Text") },
                    modifier = Modifier.clickable { model.jumpToStudyPage(task.page) },
                    fontSize = 14.sp,
                    fontWeight = if (task.done) FontWeight.Normal else FontWeight.SemiBold,
                    color = if (task.done) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f) else MaterialTheme.colorScheme.onSurface,
                )
            }
            FlowRow(verticalArrangement = Arrangement.Center) {
                TextButton(onClick = { model.jumpToStudyPage(task.page) }) { Text("${ui("S.")} ${task.page}") }
                Text(
                    formatClock(seconds) + if (task.minutes > 0) " / ${task.minutes} min" else "",
                    color = if (over) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
                )
                TextButton(onClick = { model.toggleStudyTimer(task.id) }) { Text(ui(if (running) "Timer anhalten" else "Timer starten")) }
                TextButton(onClick = { model.studyEditingTask.value = if (editing) null else task.id }) { Text(ui(if (editing) "Fertig" else "Bearbeiten")) }
                TextButton(onClick = { model.removeStudyTask(task.id) }) { Text(ui("Entfernen")) }
            }
        }
    }
}

@Composable
private fun EditField(key: String, initial: String, label: String, modifier: Modifier, numeric: Boolean = false, onChange: (String) -> Unit) {
    var value by remember(key) { mutableStateOf(initial) }
    OutlinedTextField(
        value = value,
        onValueChange = {
            value = it
            onChange(it)
        },
        label = { Text(label) },
        modifier = modifier,
        singleLine = true,
        keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StudyMarksTab(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val marks = remember(markdown) { ch.fasrv.fanotes.desk.readPdfMarks(markdown) }
    val grouped = remember(marks) { groupMarksByPage(marks) }
    Text(counted("${marks.size} Markierungen auf ${grouped.size} Seiten", "${marks.size} highlights on ${grouped.size} pages"), fontSize = 13.sp)
    TextButton(
        enabled = marks.isNotEmpty(),
        onClick = {
            val title = open?.title ?: "PDF"
            val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText(title, marksToMarkdown(title, marks)))
            model.message.value = "Markierungen als Notiz kopiert."
        },
    ) { Text(ui("Als Notiz kopieren")) }
    if (marks.isEmpty()) Text(ui("Markiere Text im PDF mit dem Textmarker. Alle Stellen erscheinen hier nach Seite sortiert."), fontSize = 13.sp)
    grouped.forEach { group ->
        TextButton(onClick = { model.jumpToStudyPage(group.page) }) { Text("${ui("Seite")} ${group.page}", fontWeight = FontWeight.SemiBold) }
        group.marks.forEach { mark ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text(
                    mark.quote,
                    modifier = Modifier.weight(1f).clickable { model.jumpToStudyPage(mark.page) }.padding(start = 12.dp),
                    fontSize = 13.sp,
                    textDecoration = if (mark.kind == "underline") androidx.compose.ui.text.style.TextDecoration.Underline else null,
                    maxLines = 3,
                )
                TextButton(onClick = { model.removePdfQuote(mark.id) }) { Text(ui("Entfernen")) }
            }
        }
    }
}

// -- study blocks -------------------------------------------------------------------------

/** Editor for a tapped study block: the sorting board and definition cards are editable, the rest explain where to edit. */
@Composable
fun StudyBlockDialog(model: FaNotesViewModel) {
    val edit by model.studyEdit.collectAsStateWithLifecycle()
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val (kindId, index) = edit ?: return
    val ref = remember(markdown, index) { model.studyBlockAt(index) }
    if (ref == null || ref.kind.id != kindId) {
        model.closeStudyBlock()
        return
    }
    val title = when (ref.kind) {
        StudyKind.SORT -> "Sortier-Board"
        StudyKind.TERM -> "Definitionskarten"
        StudyKind.KEY -> "Tabelle und Bestimmungsschlüssel"
        StudyKind.MAP -> "Begriffsnetz (Ursache und Wirkung)"
        StudyKind.PLATE -> "Bildtafel"
    }
    AlertDialog(
        onDismissRequest = { model.closeStudyBlock() },
        title = { Text(ui(title)) },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
                when (ref.kind) {
                    StudyKind.SORT -> SortBoardEditor(parseSortData(ref.body) ?: defaultSortData()) { model.writeStudyBlock(index, sortDataJson(it)) }
                    StudyKind.TERM -> TermEditor(parseTermData(ref.body) ?: defaultTermData()) { model.writeStudyBlock(index, termDataJson(it)) }
                    else -> Text(ui("Diesen Block bearbeitest du am Computer (am Computer bearbeiten). Hier siehst du ihn in der Notiz; Änderungen vom Computer kommen per Sync."))
                }
            }
        },
        confirmButton = { TextButton(onClick = { model.closeStudyBlock() }) { Text(ui("Fertig")) } },
        dismissButton = { TextButton(onClick = { model.showStudySource(index) }) { Text(ui("Quelltext zeigen")) } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SortBoardEditor(data: SortData, onChange: (SortData) -> Unit) {
    val groupBounds = remember { mutableStateMapOf<String, Rect>() }
    val cardBounds = remember { mutableStateMapOf<String, Rect>() }
    var selected by remember { mutableStateOf<String?>(null) }
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragDelta by remember { mutableStateOf(Offset.Zero) }
    var pointer by remember { mutableStateOf(Offset.Zero) }
    var draft by remember { mutableStateOf("") }
    val text = data.cards.associate { it.id to it.text }
    val poolKey = "\u0000pool"

    fun targetAt(point: Offset): String? = groupBounds.entries.firstOrNull { it.value.contains(point) }?.key

    fun drop(cardId: String, point: Offset) {
        val target = targetAt(point) ?: return
        val group = data.groups.firstOrNull { it.id == target }
        val index = group?.cards?.filter { it != cardId }?.count { other ->
            val bounds = cardBounds[other]
            bounds != null && bounds.center.y < point.y
        }
        onChange(moveCard(data, cardId, if (target == poolKey) null else target, index))
    }

    @Composable
    fun CardChip(id: String, label: String) {
        val isDragging = dragging == id
        Surface(
            shape = RoundedCornerShape(8.dp),
            tonalElevation = if (isDragging) 6.dp else 1.dp,
            border = BorderStroke(if (selected == id) 2.dp else 1.dp, if (selected == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
            modifier = Modifier
                .padding(2.dp)
                .onGloballyPositioned { cardBounds[id] = it.boundsInRoot() }
                .graphicsLayer {
                    translationX = if (isDragging) dragDelta.x else 0f
                    translationY = if (isDragging) dragDelta.y else 0f
                }
                .clickable { selected = if (selected == id) null else id }
                .pointerInput(id, data) {
                    detectDragGestures(
                        onDragStart = { start ->
                            dragging = id
                            selected = id
                            dragDelta = Offset.Zero
                            pointer = (cardBounds[id]?.topLeft ?: Offset.Zero) + start
                        },
                        onDrag = { change, amount ->
                            change.consume()
                            dragDelta += amount
                            pointer += amount
                        },
                        onDragEnd = {
                            drop(id, pointer)
                            dragging = null
                            dragDelta = Offset.Zero
                        },
                        onDragCancel = {
                            dragging = null
                            dragDelta = Offset.Zero
                        },
                    )
                },
        ) {
            Text(label, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp), fontSize = 14.sp)
        }
    }

    val hover = if (dragging != null) targetAt(pointer) else null
    Text(ui("Karten mit dem Finger oder Stift in eine Gruppe ziehen. Oder eine Karte antippen und unten die Gruppe wählen."), fontSize = 13.sp)
    val pool = unsortedCards(data)
    Column(
        Modifier.fillMaxWidth().padding(vertical = 6.dp)
            .onGloballyPositioned { groupBounds[poolKey] = it.boundsInRoot() }
            .border(BorderStroke(if (hover == poolKey) 2.dp else 1.dp, if (hover == poolKey) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant), RoundedCornerShape(10.dp))
            .padding(6.dp),
    ) {
        Text(ui("Noch nicht eingeordnet"), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
        FlowRow { pool.forEach { CardChip(it.id, it.text) } }
    }
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        data.groups.forEach { group ->
            Column(
                Modifier.width(if (data.sequence) 320.dp else 190.dp)
                    .onGloballyPositioned { groupBounds[group.id] = it.boundsInRoot() }
                    .border(BorderStroke(if (hover == group.id) 2.dp else 1.dp, if (hover == group.id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant), RoundedCornerShape(10.dp))
                    .padding(6.dp),
            ) {
                Text(group.title.ifEmpty { ui("Gruppe") }, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                group.cards.forEachIndexed { position, id ->
                    CardChip(id, (if (data.sequence) "${position + 1}. " else "") + text[id].orEmpty())
                }
            }
        }
    }
    val chosen = selected
    if (chosen != null && data.cards.any { it.id == chosen }) {
        Text(ui("Verschieben nach:"), fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        FlowRow {
            data.groups.forEach { group ->
                TextButton(onClick = { onChange(moveCard(data, chosen, group.id)) }) { Text(group.title.ifEmpty { ui("Gruppe") }) }
            }
            TextButton(onClick = { onChange(moveCard(data, chosen, null)) }) { Text(ui("Zurück zu „Noch nicht eingeordnet“")) }
            TextButton(onClick = {
                selected = null
                onChange(removeSortCard(data, chosen))
            }) { Text(ui("Karte löschen")) }
        }
    }
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
        OutlinedTextField(draft, { draft = it }, label = { Text(ui("Neue Karte")) }, modifier = Modifier.weight(1f))
        TextButton(
            enabled = draft.isNotBlank(),
            onClick = {
                val lines = draft.lines().map { it.trim() }.filter { it.isNotEmpty() }
                onChange(addSortCards(data, lines))
                draft = ""
            },
        ) { Text(ui("Hinzufügen")) }
    }
}

@Composable
private fun TermEditor(data: TermData, onChange: (TermData) -> Unit) {
    fun change(id: String, edit: (TermEntry) -> TermEntry) = onChange(TermData(data.terms.map { if (it.id == id) edit(it) else it }))
    data.terms.forEach { term ->
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            EditField(term.id + "t", term.term, ui("Begriff"), Modifier.fillMaxWidth()) { value -> change(term.id) { it.copy(term = value.take(160)) } }
            EditField(term.id + "d", term.definition, ui("Definition"), Modifier.fillMaxWidth()) { value -> change(term.id) { it.copy(definition = value.take(2000)) } }
            EditField(term.id + "e", term.example, ui("Beispiel"), Modifier.fillMaxWidth()) { value -> change(term.id) { it.copy(example = value.take(1000)) } }
            EditField(term.id + "s", term.source, ui("Quelle"), Modifier.fillMaxWidth()) { value -> change(term.id) { it.copy(source = value.take(300)) } }
            TextButton(onClick = { onChange(TermData(data.terms.filter { it.id != term.id })) }) { Text(ui("Entfernen")) }
        }
    }
    TextButton(
        enabled = data.terms.size < 30,
        onClick = { onChange(TermData(data.terms + TermEntry(newStudyId("t"), "", "", "", ""))) },
    ) { Text(ui("Begriff hinzufügen")) }
}
