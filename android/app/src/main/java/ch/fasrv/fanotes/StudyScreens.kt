package ch.fasrv.fanotes

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import ch.fasrv.fanotes.study.liveSeconds
import ch.fasrv.fanotes.study.marksToMarkdown
import ch.fasrv.fanotes.study.newStudyId
import ch.fasrv.fanotes.study.sortEditable
import ch.fasrv.fanotes.study.termEditable
import ch.fasrv.fanotes.study.readTaskList
import ch.fasrv.fanotes.study.removeSortCard
import ch.fasrv.fanotes.study.sortDataJson
import ch.fasrv.fanotes.study.studySheetCompact
import ch.fasrv.fanotes.study.studySheetMaxHeightDp
import ch.fasrv.fanotes.study.taskProgress
import ch.fasrv.fanotes.study.termDataJson
import ch.fasrv.fanotes.study.unsortedCards
import ch.fasrv.fanotes.study.addSortCards
import ch.fasrv.fanotes.study.moveCard
import ch.fasrv.fanotes.study.crypto.cryptoDataJson
import ch.fasrv.fanotes.study.crypto.cryptoEditable
import ch.fasrv.fanotes.study.keyDataJson
import ch.fasrv.fanotes.study.keyEditable
import ch.fasrv.fanotes.study.mapDataJson
import ch.fasrv.fanotes.study.mapEditable
import ch.fasrv.fanotes.study.plateDataJson
import ch.fasrv.fanotes.study.plateEditable
import kotlinx.coroutines.delay


/** Sentences with numbers cannot come from the catalog; they follow the UI language here. */
private fun counted(german: String, english: String) = if (ChromeText.language == "en") english else german

/** The header row of the folded sheet; everything below it is the scrolling body. */
private val SheetHeader = 48.dp

/**
 * The Aufträge and Markierungen panel of an open PDF (menu `study-tasks` / `study-marks`) as a bottom sheet. It takes at
 * most 40 % of the window, so the page above stays readable and usable. In small windows (phone, landscape, split screen)
 * it folds up to its header after a jump, so the page it jumped to shows in full. The task timer is not part of the
 * sheet: closing it does not stop the timer.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StudySheet(model: FaNotesViewModel, initialTab: String, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier) {
        val windowWidth = maxWidth.value.toInt()
        val windowHeight = maxHeight.value.toInt()
        val compact = studySheetCompact(windowWidth, windowHeight)
        var folded by rememberSaveable { mutableStateOf(false) }
        var tab by remember(initialTab) { mutableStateOf(initialTab) }
        val jump: (Int) -> Unit = { page -> if (model.jumpToStudyPage(page) && compact) folded = true }
        Surface(
            modifier = Modifier
                // Edge to edge at the bottom of the page area: no floating card over the page.
                .fillMaxWidth()
                .heightIn(max = if (folded) SheetHeader + 12.dp else studySheetMaxHeightDp(windowHeight).dp),
            shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 10.dp,
        ) {
            Column {
                Box(
                    Modifier
                        .align(Alignment.CenterHorizontally)
                        .padding(top = 6.dp)
                        .width(36.dp)
                        .height(4.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f)),
                )
                Row(
                    Modifier.fillMaxWidth().heightIn(min = SheetHeader).clickable { folded = !folded }.padding(start = 16.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(ui(if (tab == "study-marks") "Markierungen" else "Aufträge"), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    SheetTimerText(model)
                    TextButton(onClick = { folded = !folded }) { Text(ui(if (folded) "Aufklappen" else "Einklappen")) }
                    TextButton(onClick = { model.openEditorMenu(null) }) { Text(ui("Schliessen")) }
                }
                if (!folded) {
                    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                        Row {
                            TextButton(onClick = { tab = "study-tasks"; model.openEditorMenu("study-tasks") }) {
                                Text(ui("Aufträge"), fontWeight = if (tab == "study-tasks") FontWeight.Bold else FontWeight.Normal)
                            }
                            TextButton(onClick = { tab = "study-marks"; model.openEditorMenu("study-marks") }) {
                                Text(ui("Markierungen"), fontWeight = if (tab == "study-marks") FontWeight.Bold else FontWeight.Normal)
                            }
                        }
                        if (tab == "study-marks") StudyMarksTab(model, jump) else StudyTasksTab(model, jump)
                    }
                }
            }
        }
    }
}

/** The running timer in the sheet's header, so it shows while the sheet is folded. */
@Composable
private fun SheetTimerText(model: FaNotesViewModel) {
    val timer by model.studyTimer.collectAsStateWithLifecycle()
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val running = timer ?: return
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(running) {
        while (true) {
            now = android.os.SystemClock.elapsedRealtime()
            delay(1000)
        }
    }
    val spent = remember(markdown, running.taskId) { readTaskList(markdown)?.tasks?.firstOrNull { it.id == running.taskId }?.spentSec ?: 0 }
    Text("■ " + formatClock(spent + running.liveSeconds(now)), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StudyTasksTab(model: FaNotesViewModel, onJump: (Int) -> Unit) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val timer by model.studyTimer.collectAsStateWithLifecycle()
    val scanning by model.studyScanning.collectAsStateWithLifecycle()
    val detectionAvailable by model.studyDetectionAvailable.collectAsStateWithLifecycle()
    val editing by model.studyEditingTask.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val stored = remember(markdown) { readTaskList(markdown) }
    val tasks = stored?.tasks.orEmpty()
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    // First visit: detect the assignments once, like the desktop panel does.
    LaunchedEffect(open?.path) {
        if (stored == null) model.scanStudyTasks(automatic = true)
    }
    LaunchedEffect(timer) {
        while (timer != null) {
            now = android.os.SystemClock.elapsedRealtime()
            delay(1000)
        }
    }
    val progress = taskProgress(tasks)
    LinearProgressIndicator(progress = { progress.ratio.toFloat() }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
    val summary = counted("${progress.done} von ${progress.total} erledigt", "${progress.done} of ${progress.total} done") +
        if (progress.plannedMinutes > 0) counted(" · noch ca. ${progress.remainingMinutes} von ${progress.plannedMinutes} Min.", " · about ${progress.remainingMinutes} of ${progress.plannedMinutes} min left") else ""
    Text(summary, fontSize = 13.sp)
    Row {
        TextButton(onClick = { model.scanStudyTasks() }, enabled = !scanning && detectionAvailable) { Text(ui(if (scanning) "Suche …" else "Neu erkennen")) }
        TextButton(onClick = { model.addStudyTask() }) { Text(ui("Auftrag hinzufügen")) }
    }
    if (!detectionAvailable) {
        // The list the computer detected still shows below (it syncs with the note); only the scan is missing here.
        Text(ui("Auf diesem Gerät fehlt die PDF-Textfunktion. Erkenne die Aufträge am Computer (Sync) oder füge sie von Hand hinzu."), fontSize = 13.sp)
    } else if (tasks.isEmpty() && !scanning) {
        Text(ui("Keine Aufträge. Zeilen wie „Auftrag 3: …“ werden automatisch erkannt, sonst füge sie von Hand hinzu."), fontSize = 13.sp)
    }
    tasks.forEach { task ->
        val run = timer?.takeIf { it.taskId == task.id }
        val seconds = task.spentSec + (run?.liveSeconds(now) ?: 0)
        TaskRow(model, task, seconds, run != null, editing == task.id, onJump)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TaskRow(model: FaNotesViewModel, task: StudyTask, seconds: Int, running: Boolean, editing: Boolean, onJump: (Int) -> Unit) {
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
                    modifier = Modifier.clickable { onJump(task.page) },
                    fontSize = 14.sp,
                    fontWeight = if (task.done) FontWeight.Normal else FontWeight.SemiBold,
                    color = if (task.done) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f) else MaterialTheme.colorScheme.onSurface,
                )
            }
            FlowRow(verticalArrangement = Arrangement.Center) {
                TextButton(onClick = { onJump(task.page) }) { Text("${ui("S.")} ${task.page}") }
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
internal fun EditField(key: String, initial: String, label: String, modifier: Modifier, numeric: Boolean = false, onChange: (String) -> Unit) {
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
private fun StudyMarksTab(model: FaNotesViewModel, onJump: (Int) -> Unit) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val marks = remember(markdown) { ch.fasrv.fanotes.desk.readPdfMarks(markdown) }
    val grouped = remember(marks) { groupMarksByPage(marks) }
    if (marks.isEmpty()) {
        // One honest line instead of "0 Markierungen auf 0 Seiten" plus a disabled copy button.
        Text(ui("Noch keine Markierungen. Markiere Text im PDF mit dem Textmarker; alle Stellen erscheinen hier nach Seite sortiert."), fontSize = 13.sp, modifier = Modifier.padding(vertical = 8.dp))
    } else {
        Text(counted("${marks.size} Markierungen auf ${grouped.size} Seiten", "${marks.size} highlights on ${grouped.size} pages"), fontSize = 13.sp)
        TextButton(
            onClick = {
                val title = open?.title ?: "PDF"
                val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText(title, marksToMarkdown(title, marks)))
                model.message.value = "Markierungen als Notiz kopiert."
            },
        ) { Text(ui("Als Notiz kopieren")) }
    }
    grouped.forEach { group ->
        TextButton(onClick = { onJump(group.page) }) { Text("${ui("Seite")} ${group.page}", fontWeight = FontWeight.SemiBold) }
        group.marks.forEach { mark ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                VerbatimText(
                    mark.quote,
                    modifier = Modifier.weight(1f).clickable { onJump(mark.page) }.padding(start = 12.dp),
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

/** Holds the block's model in state that changes at once; every change is also written into the note. */
@Composable
private fun <T> Mirrored(initial: T, write: (T) -> Unit, content: @Composable (T, ((T) -> T) -> Unit) -> Unit) {
    var local by remember { mutableStateOf(initial) }
    content(local) { transform ->
        val next = transform(local)
        if (next != local) {
            local = next
            write(next)
        }
    }
}

/**
 * Editor for a tapped study block. All six kinds can be edited here: sorting boards, definition cards, key tables and
 * trees, concept maps, picture plates and the crypto tools. A block that cannot be read back without loss stays
 * untouched and shows only the way to its source text.
 */
@Composable
fun StudyBlockDialog(model: FaNotesViewModel) {
    val edit by model.studyEdit.collectAsStateWithLifecycle()
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val target = edit ?: return
    val ref = remember(markdown, target) { model.studyBlockFor(target) }
    if (ref == null) {
        model.closeStudyBlock()
        model.message.value = "Deine Änderung wurde nicht gespeichert, weil sich die Notiz geändert hat. Öffne den Block neu."
        return
    }
    // Reading the block is keyed by the kind and the block's place, not by its text: the editors keep their own live copy.
    val sort = if (ref.kind == StudyKind.SORT) remember(ref.body) { sortEditable(ref.body) } else null
    val terms = if (ref.kind == StudyKind.TERM) remember(ref.body) { termEditable(ref.body) } else null
    val key = if (ref.kind == StudyKind.KEY) remember(target.kind, target.from) { keyEditable(ref.body) } else null
    val map = if (ref.kind == StudyKind.MAP) remember(target.kind, target.from) { mapEditable(ref.body) } else null
    val plate = if (ref.kind == StudyKind.PLATE) remember(target.kind, target.from) { plateEditable(ref.body) } else null
    val crypto = if (ref.kind == StudyKind.CRYPTO) remember(target.kind, target.from) { cryptoEditable(ref.body) } else null
    val title = when (ref.kind) {
        StudyKind.SORT -> "Sortier-Board"
        StudyKind.TERM -> "Definitionskarten"
        StudyKind.KEY -> "Tabelle und Bestimmungsschlüssel"
        StudyKind.MAP -> "Begriffsnetz (Ursache und Wirkung)"
        StudyKind.PLATE -> "Bildtafel"
        StudyKind.CRYPTO -> "Krypto-Werkzeug"
    }
    val unreadable = "Dieser Block ist nicht lesbar oder zu gross für das Tablet. Er bleibt unverändert; du siehst und bearbeitest ihn über „Quelltext zeigen“."
    val screenHeight = androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp
    AlertDialog(
        onDismissRequest = { model.closeStudyBlock() },
        modifier = Modifier.fillMaxWidth(0.96f).widthIn(max = 920.dp),
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        title = { Text(title) },
        text = {
            Column(Modifier.heightIn(max = (screenHeight * 0.68f).dp).verticalScroll(rememberScrollState())) {
                when (ref.kind) {
                    StudyKind.SORT -> if (sort != null) SortBoardEditor(sort) { model.writeStudyBlock(sortDataJson(it)) } else Text(unreadable)
                    StudyKind.TERM -> if (terms != null) TermEditor(terms) { model.writeStudyBlock(termDataJson(it)) } else Text(unreadable)
                    StudyKind.KEY -> if (key != null) Mirrored(key, { model.writeStudyBlock(keyDataJson(it)) }) { data, update -> KeyEditor(model, data, update) } else Text(unreadable)
                    StudyKind.MAP -> if (map != null) Mirrored(map, { model.writeStudyBlock(mapDataJson(it)) }) { data, update -> MapEditor(data, update) } else Text(unreadable)
                    StudyKind.PLATE -> if (plate != null) Mirrored(plate, { model.writeStudyBlock(plateDataJson(it)) }) { data, update -> PlateEditor(model, data, update) } else Text(unreadable)
                    StudyKind.CRYPTO -> if (crypto != null) Mirrored(crypto, { model.writeStudyBlock(cryptoDataJson(it)) }) { data, update -> CryptoEditor(data) { next -> update { next } } } else Text(unreadable)
                }
            }
        },
        confirmButton = { ActionButton("Fertig") { model.closeStudyBlock() } },
        dismissButton = { ActionButton("Quelltext zeigen") { model.showStudySource() } },
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
                VerbatimText(group.title.ifEmpty { ui("Gruppe") }, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
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
                TextButton(onClick = { onChange(moveCard(data, chosen, group.id)) }) { VerbatimText(group.title.ifEmpty { ui("Gruppe") }) }
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

/** The insert menu for every study block (and the six crypto tools), as large buttons under the editor's top bar. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StudyInsertMenu(model: FaNotesViewModel) {
    var crypto by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState()).padding(vertical = 4.dp)) {
        Muted("Der Block kommt ans Ende der Notiz und bleibt reiner Text. Tippe ihn danach an, um ihn zu bearbeiten.")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                StudyKind.KEY to "Tabelle und Schlüssel",
                StudyKind.SORT to "Sortier-Board",
                StudyKind.MAP to "Begriffsnetz",
                StudyKind.PLATE to "Bildtafel",
                StudyKind.TERM to "Definitionskarten",
            ).forEach { (kind, label) -> ActionButton(label) { model.insertStudyTemplate(kind) } }
            StudyChoice("Krypto-Werkzeug …", crypto, { crypto = !crypto })
        }
        if (crypto) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                ch.fasrv.fanotes.study.crypto.CryptoTool.entries.forEach { tool ->
                    ActionButton(tool.label) { model.insertStudyTemplate(StudyKind.CRYPTO, tool) }
                }
            }
        }
    }
}
