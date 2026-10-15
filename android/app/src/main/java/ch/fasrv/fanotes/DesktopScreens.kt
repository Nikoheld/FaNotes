package ch.fasrv.fanotes

import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.math.abs
import kotlinx.coroutines.withTimeoutOrNull
import ch.fasrv.fanotes.desk.DeskTab
import ch.fasrv.fanotes.desk.measureDocument
import ch.fasrv.fanotes.desk.moveTab
import ch.fasrv.fanotes.desk.tabsToClose
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
    notice: String? = null,
    onDismissNotice: () -> Unit = {},
    sidebarOpen: Boolean = true,
    onToggleSidebar: (() -> Unit)? = null,
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
            if (onToggleSidebar != null) {
                Text(
                    if (sidebarOpen) "Leiste zu" else "Leiste",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(
                        onClickLabel = if (sidebarOpen) "Seitenleiste einklappen" else "Seitenleiste einblenden",
                        onClick = onToggleSidebar,
                    ),
                )
            }
            Text(syncText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            if (!notice.isNullOrBlank()) {
                Text(
                    notice,
                    fontSize = 12.sp,
                    maxLines = 1,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(onClick = onDismissNotice),
                )
            }
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
    onOpenSplit: (String) -> Unit = {},
    splitPath: String? = null,
    unsavedPaths: Set<String> = emptySet(),
    onMove: (String, String?, String) -> Unit = { _, _, _ -> },
    onTogglePin: (String) -> Unit = {},
    onCloseScope: (String, String) -> Unit = { _, _ -> },
    onCopyPath: (String) -> Unit = {},
    onReveal: (String) -> Unit = {},
) {
    if (paths.isEmpty() && !canBack && !canForward) return
    val muted = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    val scroll = rememberScrollState()
    var dragging by remember { mutableStateOf<String?>(null) }
    var dropOn by remember { mutableStateOf<Pair<String?, String>?>(null) }
    val bounds = remember { androidx.compose.runtime.mutableStateMapOf<String, androidx.compose.ui.geometry.Rect>() }
    val deskTabs = paths.map { DeskTab(it, it in pinned) }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(scroll, enabled = dragging == null).background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 2.dp),
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
            NoteTabChip(
                path = path,
                selected = path == selected,
                pinned = path in pinned,
                inSplit = path == splitPath,
                unsaved = path in unsavedPaths,
                dragging = dragging == path,
                dropSide = dropOn?.takeIf { it.first == path && dragging != null && dragging != path }?.second,
                canCloseOthers = tabsToClose(deskTabs, path, "others").isNotEmpty(),
                canCloseRight = tabsToClose(deskTabs, path, "right").isNotEmpty(),
                onOpen = { onOpen(path) },
                onClose = { onClose(path) },
                onOpenSplit = { onOpenSplit(path) },
                onTogglePin = { onTogglePin(path) },
                onCloseOthers = { onCloseScope(path, "others") },
                onCloseRight = { onCloseScope(path, "right") },
                onCopyPath = { onCopyPath(path) },
                onReveal = { onReveal(path) },
                onPosition = { bounds[path] = it },
                restartKey = paths to pinned,
                onDragStart = {
                    dragging = path
                    dropOn = null
                },
                onDrag = { rootX ->
                    val candidate = tabDropTarget(bounds, rootX)
                    val next = moveTab(deskTabs, path, candidate.first, candidate.second)
                    dropOn = if (next.map { it.path } == paths) null else candidate
                },
                onDragEnd = {
                    val from = dragging
                    val drop = dropOn
                    dragging = null
                    dropOn = null
                    if (from != null && drop != null) onMove(from, drop.first, drop.second)
                },
                onDragCancel = {
                    dragging = null
                    dropOn = null
                },
            )
        }
    }
}

private fun tabDropTarget(
    bounds: Map<String, androidx.compose.ui.geometry.Rect>,
    rootX: Float,
): Pair<String?, String> {
    val hit = bounds.entries.firstOrNull { rootX >= it.value.left && rootX <= it.value.right }
    if (hit != null) {
        val mid = (hit.value.left + hit.value.right) / 2f
        return hit.key to if (rootX < mid) "before" else "after"
    }
    val leftmost = bounds.minByOrNull { it.value.left } ?: return null to "after"
    return if (rootX < leftmost.value.left) leftmost.key to "before" else null to "after"
}

@Composable
private fun NoteTabChip(
    path: String,
    selected: Boolean,
    pinned: Boolean,
    inSplit: Boolean,
    unsaved: Boolean,
    dragging: Boolean,
    dropSide: String?,
    canCloseOthers: Boolean,
    canCloseRight: Boolean,
    onOpen: () -> Unit,
    onClose: () -> Unit,
    onOpenSplit: () -> Unit,
    onTogglePin: () -> Unit,
    onCloseOthers: () -> Unit,
    onCloseRight: () -> Unit,
    onCopyPath: () -> Unit,
    onReveal: () -> Unit,
    restartKey: Any,
    onPosition: (androidx.compose.ui.geometry.Rect) -> Unit,
    onDragStart: () -> Unit,
    onDrag: (Float) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val textLeft = remember { floatArrayOf(0f) }
    val name = path.substringAfterLast('/').substringBeforeLast('.')
    Box {
        Row(
            Modifier
                .padding(end = 4.dp)
                .onGloballyPositioned { onPosition(it.boundsInRoot()) }
                .background(
                    when {
                        dragging -> MaterialTheme.colorScheme.primary.copy(alpha = 0.28f)
                        selected -> MaterialTheme.colorScheme.surfaceVariant
                        else -> Color.Transparent
                    },
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (dropSide == "before") {
                Box(Modifier.padding(end = 2.dp).width(2.dp).height(16.dp).background(MaterialTheme.colorScheme.primary))
            }
            Text(
                buildString {
                    if (pinned) append("● ")
                    append(name)
                    if (inSplit) append(" ‖")
                },
                fontSize = 12.sp,
                color = if (inSplit && !selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                modifier = Modifier
                    .onGloballyPositioned { textLeft[0] = it.boundsInRoot().left }
                    .pointerInput(path, restartKey) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        val slop = viewConfiguration.touchSlop
                        val held = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: return@withTimeoutOrNull "cancel"
                                val dx = change.position.x - down.position.x
                                val dy = change.position.y - down.position.y
                                if (dx * dx + dy * dy > slop * slop) return@withTimeoutOrNull "scroll"
                                if (!change.pressed) return@withTimeoutOrNull "tap"
                            }
                            "tap"
                        }
                        when (held) {
                            "tap" -> onOpen()
                            "scroll", "cancel" -> Unit
                            else -> {
                                onDragStart()
                                var moved = false
                                var ended = false
                                while (true) {
                                    val event = awaitPointerEvent()
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                    change.consume()
                                    onDrag(textLeft[0] + change.position.x)
                                    if (abs(change.position.x - down.position.x) > slop || abs(change.position.y - down.position.y) > slop) moved = true
                                    if (!change.pressed) {
                                        ended = true
                                        break
                                    }
                                }
                                if (ended && moved) onDragEnd() else if (ended) {
                                    onDragCancel()
                                    menu = true
                                } else onDragCancel()
                            }
                        }
                    }
                }.padding(horizontal = 8.dp, vertical = 4.dp),
            )
            if (unsaved) {
                Box(
                    Modifier
                        .padding(end = 4.dp)
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                        .semantics { contentDescription = "Noch nicht gespeichert" },
                )
            }
            if (!pinned) {
                Text("  ×", modifier = Modifier.clickable(onClick = onClose).padding(end = 6.dp), fontSize = 12.sp)
            }
            if (dropSide == "after") {
                Box(Modifier.padding(start = 2.dp).width(2.dp).height(16.dp).background(MaterialTheme.colorScheme.primary))
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Rechts öffnen") },
                enabled = !inSplit,
                onClick = { menu = false; onOpenSplit() },
            )
            DropdownMenuItem(
                text = { Text(if (pinned) "Lösen" else "Anheften") },
                onClick = { menu = false; onTogglePin() },
            )
            DropdownMenuItem(text = { Text("Pfad kopieren") }, onClick = { menu = false; onCopyPath() })
            DropdownMenuItem(text = { Text("Im Dateimanager zeigen") }, onClick = { menu = false; onReveal() })
            DropdownMenuItem(
                text = { Text("Schließen") },
                enabled = !pinned,
                onClick = { menu = false; onClose() },
            )
            DropdownMenuItem(
                text = { Text("Andere schließen") },
                enabled = canCloseOthers,
                onClick = { menu = false; onCloseOthers() },
            )
            DropdownMenuItem(
                text = { Text("Rechts davon schließen") },
                enabled = canCloseRight,
                onClick = { menu = false; onCloseRight() },
            )
        }
    }
}

@Composable
fun SearchScreen(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val query by model.searchQuery.collectAsStateWithLifecycle()
    val hits by model.searchHits.collectAsStateWithLifecycle()
    var selected by remember(query) { mutableIntStateOf(-1) }
    val listState = rememberLazyListState()
    androidx.compose.runtime.LaunchedEffect(selected, hits.size) {
        if (selected in hits.indices) listState.animateScrollToItem(selected)
    }
    fun openSelected() {
        val hit = hits.getOrNull(selected) ?: return
        model.openSearchHit(hit)
        onOpen(hit.path)
    }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Notizen durchsuchen", style = MaterialTheme.typography.titleLarge)
        Text("Im gesamten Vault", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        OutlinedTextField(
            query,
            { model.searchVaultText(it) },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp).onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionDown -> {
                        selected = ch.fasrv.fanotes.desk.searchResultMove(selected, hits.size, true)
                        true
                    }
                    Key.DirectionUp -> {
                        selected = ch.fasrv.fanotes.desk.searchResultMove(selected, hits.size, false)
                        true
                    }
                    Key.Enter, Key.NumPadEnter -> {
                        if (selected in hits.indices) openSelected()
                        selected in hits.indices
                    }
                    else -> false
                }
            },
            label = { Text("Im Vault suchen") },
            singleLine = true,
        )
        Text(
            if (query.trim().length >= 2) "${hits.size} Treffer" else "Text und unsichtbare Handschrift",
            modifier = Modifier.padding(top = 8.dp),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        if (query.trim().length < 2) {
            Text("Tippe mindestens zwei Zeichen. Auch noch nicht konvertierte Handschrift wird durchsucht.", modifier = Modifier.padding(top = 12.dp), fontSize = 13.sp)
        } else if (hits.isEmpty()) {
            Text("Keine Treffer für „${query.trim()}“.", modifier = Modifier.padding(top = 12.dp), fontSize = 13.sp)
        }
        LazyColumn(state = listState, modifier = Modifier.padding(top = 8.dp).weight(1f)) {
            itemsIndexed(hits, key = { _, hit -> "${hit.kind}:${hit.path}:${hit.line}:${hit.anchorY}" }) { index, hit ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(if (index == selected) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f) else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable {
                            selected = index
                            model.openSearchHit(hit)
                            onOpen(hit.path)
                        }
                        .padding(vertical = 8.dp, horizontal = 8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            hit.title.ifBlank { hit.path.substringAfterLast('/') },
                            modifier = Modifier.weight(1f),
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text("${hit.matches}", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                    }
                    Text(
                        if (hit.kind == "drawing" || hit.anchorY != null) "Handschrift-Seite · unsichtbar transkribiert" else hit.path,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
                    )
                    Text(hit.text, maxLines = 2)
                }
            }
        }
        Text("↑ ↓ Ergebnis wählen · Esc schließen", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
    }
}

@Composable
fun HomeworkScreen(model: FaNotesViewModel) {
    val document by model.homework.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val status by model.message.collectAsStateWithLifecycle()
    val tree by model.tree.collectAsStateWithLifecycle()
    val subjectChoices = ch.fasrv.fanotes.desk.homeworkSubjectOptions(
        tree.filter { it.kind == ch.fasrv.fanotes.vault.NoteKind.FOLDER }.map { it.name },
        document.tasks,
    )
    var title by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var due by remember { mutableStateOf(LocalDate.now().plusDays(1).toString()) }
    var planner by remember { mutableStateOf("list") }
    var filter by remember { mutableStateOf("open") }
    var cursor by remember { mutableStateOf(LocalDate.now()) }
    var dueTime by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf("normal") }
    val stats = ch.fasrv.fanotes.desk.homeworkStats(document.tasks)
    val shownTasks = ch.fasrv.fanotes.desk.visibleHomeworkTasks(document.tasks, filter)
    Column(
        Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
            .pointerInput(planner) {
                detectDeskSwipe { direction ->
                    if (planner == "list") return@detectDeskSwipe
                    val step = ch.fasrv.fanotes.desk.calendarSwipeStep(direction) ?: return@detectDeskSwipe
                    cursor = ch.fasrv.fanotes.desk.homeworkPlannerShift(cursor, planner, step)
                }
            },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Hausaufgaben & Termine", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = { model.openHomeworkNote() }) { Text("Als Notiz öffnen") }
        }
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
        val offered = subjectChoices.filter { choice ->
            subject.isBlank() || choice.startsWith(subject, ignoreCase = true)
        }.take(8)
        if (offered.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                offered.forEach { choice ->
                    TextButton(onClick = { subject = choice }) { Text(choice) }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(due, { due = it }, label = { Text("Fällig") })
            OutlinedTextField(dueTime, { dueTime = it }, label = { Text("Uhrzeit") }, modifier = Modifier.padding(start = 8.dp))
            TextButton(onClick = { priority = if (priority == "high") "normal" else "high" }) {
                Text(if (priority == "high") "Wichtig" else "Normal", fontWeight = if (priority == "high") FontWeight.Bold else FontWeight.Normal)
            }
        }
        OutlinedTextField(notes, { notes = it }, label = { Text("Notizen") }, modifier = Modifier.fillMaxWidth())
        Row {
            TextButton(onClick = {
                if (title.isNotBlank()) {
                    model.addHomework(title, subject, due, "homework", dueTime, notes, priority)
                    title = ""
                    notes = ""
                    dueTime = ""
                    priority = "normal"
                }
            }) { Text("Hinzufügen") }
            TextButton(onClick = {
                if (title.isNotBlank()) {
                    model.addHomework(title, subject, due, "appointment", dueTime, notes, priority)
                    title = ""
                    notes = ""
                    dueTime = ""
                    priority = "normal"
                }
            }) { Text("Termin") }
        }
        Text(
            "${stats.open} offen · ${stats.overdue} überfällig · ${stats.today} heute · ${stats.appointments} Termine · ${stats.done} erledigt",
            modifier = Modifier.padding(top = 8.dp),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp)) {
            listOf("list" to "Liste", "week" to "Woche", "month" to "Monat").forEach { (id, label) ->
                TextButton(onClick = { planner = id }) {
                    Text(label, color = if (planner == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, fontWeight = if (planner == id) FontWeight.SemiBold else FontWeight.Normal)
                }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            listOf("open" to "Offen", "homework" to "Hausaufgaben", "appointment" to "Termine", "done" to "Erledigt", "all" to "Alle").forEach { (id, label) ->
                TextButton(onClick = { filter = id }) {
                    Text(label, color = if (filter == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, fontWeight = if (filter == id) FontWeight.SemiBold else FontWeight.Normal)
                }
            }
        }
        if (planner != "list") {
            val days = ch.fasrv.fanotes.desk.homeworkPlannerDays(cursor, planner)
            val byDate = shownTasks.filter { it.dueDate != null }.groupBy { it.dueDate }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                TextButton(onClick = { cursor = ch.fasrv.fanotes.desk.homeworkPlannerShift(cursor, planner, -1) }) { Text("‹") }
                Text(ch.fasrv.fanotes.desk.homeworkPlannerLabel(cursor, planner), modifier = Modifier.padding(horizontal = 8.dp), fontWeight = FontWeight.SemiBold)
                TextButton(onClick = { cursor = ch.fasrv.fanotes.desk.homeworkPlannerShift(cursor, planner, 1) }) { Text("›") }
                TextButton(onClick = { cursor = LocalDate.now() }) { Text("Heute") }
            }
            Row(Modifier.fillMaxWidth()) {
                ch.fasrv.fanotes.desk.homeworkWeekdays().forEach { label ->
                    Text(label, modifier = Modifier.weight(1f), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                }
            }
            days.chunked(7).forEach { week ->
                Row(Modifier.fillMaxWidth()) {
                    week.forEach { day ->
                        val items = byDate[day.date.toString()].orEmpty()
                        Column(
                            Modifier
                                .weight(1f)
                                .heightIn(min = if (planner == "week") 72.dp else 48.dp)
                                .clickable { due = day.date.toString() }
                                .padding(2.dp),
                        ) {
                            Text(
                                day.date.dayOfMonth.toString(),
                                fontSize = 12.sp,
                                color = when {
                                    day.date == LocalDate.now() -> MaterialTheme.colorScheme.primary
                                    day.outside -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f)
                                    else -> MaterialTheme.colorScheme.onSurface
                                },
                                fontWeight = if (day.date == LocalDate.now()) FontWeight.Bold else FontWeight.Normal,
                            )
                            items.take(if (planner == "week") 8 else 3).forEach { task ->
                                val clock = task.dueTime?.takeIf { it.isNotBlank() }
                                Text(
                                    if (clock == null) task.title else "$clock · ${task.title}",
                                    fontSize = 10.sp,
                                    maxLines = 1,
                                    fontWeight = if (task.priority == "high") FontWeight.Bold else FontWeight.Normal,
                                    textDecoration = if (task.done) TextDecoration.LineThrough else null,
                                    color = if (task.done) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f) else MaterialTheme.colorScheme.onSurface,
                                )
                            }
                            val hidden = items.size - (if (planner == "week") 8 else 3)
                            if (hidden > 0) Text("+$hidden", fontSize = 10.sp, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
        val ordered = ch.fasrv.fanotes.desk.sortHomeworkTasks(shownTasks)
        if (ordered.isEmpty()) {
            Text("Noch keine Einträge", modifier = Modifier.padding(top = 12.dp), fontWeight = FontWeight.SemiBold)
            Text("Lege deine erste Hausaufgabe oder den nächsten Termin oben an.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        }
        listOf("overdue" to "Überfällig", "today" to "Heute", "upcoming" to "Demnächst", "undated" to "Ohne Termin", "done" to "Erledigt").forEach { (bucket, label) ->
            val items = ordered.filter { ch.fasrv.fanotes.desk.classifyHomeworkTask(it) == bucket }
            if (items.isEmpty()) return@forEach
            Text("$label ${items.size}", modifier = Modifier.padding(top = 12.dp), fontWeight = FontWeight.SemiBold)
            items.forEach { task ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f).clickable { model.toggleHomework(task.id) }) {
                        Text(task.title, fontWeight = if (task.priority == "high") FontWeight.Bold else FontWeight.Normal, textDecoration = if (task.done) TextDecoration.LineThrough else null)
                        Text(
                            listOf(
                                if (task.done) "☑" else "☐",
                                task.subject,
                                task.dueDate ?: "Kein Termin",
                                task.dueTime,
                                if (task.kind == "appointment") "Termin" else "Aufgabe",
                                if (task.priority == "high") "Wichtig" else null,
                            ).filter { !it.isNullOrBlank() }.joinToString(" · "),
                            fontSize = 12.sp,
                            color = if (bucket == "overdue") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                        )
                        if (task.notes.isNotBlank()) {
                            Text(task.notes, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f))
                        }
                    }
                    TextButton(onClick = { model.removeHomework(task.id) }) { Text("Löschen") }
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
    fun shiftCalendar(step: Int) {
        anchor = when (view) {
            "day" -> anchor.plusDays(step.toLong())
            "three" -> anchor.plusDays(3L * step)
            "week" -> anchor.plusWeeks(step.toLong())
            "agenda" -> anchor.plusDays(28L * step)
            else -> {
                val next = if (step < 0) month.minusMonths(1) else month.plusMonths(1)
                month = next
                next.atDay(1)
            }
        }
    }
    Column(
        Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
            .pointerInput(view) {
                detectDeskSwipe { direction ->
                    ch.fasrv.fanotes.desk.calendarSwipeStep(direction)?.let(::shiftCalendar)
                }
            },
    ) {
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
fun FaNotesConfirmDialog(request: PendingConfirm, onConfirm: () -> Unit, onDismiss: () -> Unit, glass: Boolean = false, radiusDp: Int? = null) {
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
        }, color = if (glass) MaterialTheme.colorScheme.surface.copy(alpha = 0.88f) else MaterialTheme.colorScheme.surface, shape = androidx.compose.foundation.shape.RoundedCornerShape((radiusDp ?: 12).dp)) {
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
    Column(
        Modifier.fillMaxSize().padding(24.dp).pointerInput(card?.id, showBack) {
            detectDeskSwipe { direction ->
                val current = card ?: return@detectDeskSwipe
                when (ch.fasrv.fanotes.desk.cardSwipeAction(showBack, direction)) {
                    "reveal" -> showBack = true
                    else -> {
                        val grade = ch.fasrv.fanotes.desk.cardSwipeAction(true, direction)
                        model.reviewFlashcard(current.id, grade)
                        showBack = false
                    }
                }
            }
        },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).clickable { onOpen(book.bookPath) }.padding(vertical = 10.dp)) {
                    Text(book.subjectPath, fontWeight = FontWeight.SemiBold)
                    Text("${book.bookPath} · Seite ${book.lastPage}", fontSize = 13.sp)
                }
                TextButton(onClick = { model.detachSubjectBook(book.subjectPath) }) { Text("Buch entfernen") }
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
        if (page.needsPassword) {
            val rejected by model.bookPasswordRejected.collectAsStateWithLifecycle()
            var draft by remember(page.bookPath) { mutableStateOf("") }
            val supported = ch.fasrv.fanotes.desk.pdfPasswordSupported(android.os.Build.VERSION.SDK_INT)
            Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_TITLE, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
            if (!supported) {
                Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_NEEDS_ANDROID_15, fontSize = 13.sp)
            } else {
                OutlinedTextField(
                    draft,
                    { draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    label = { Text("Passwort") },
                )
                if (rejected) Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_WRONG, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { model.submitBookPassword(draft) }) { Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_ACTION) }
            }
            return@Column
        }
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
    var pretty by remember { mutableStateOf(true) }
    val note by model.open.collectAsStateWithLifecycle()
    val live by model.markdown.collectAsStateWithLifecycle()
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
        val result = preview
        if (result == null) {
            Text("Deine Notiz bleibt unverändert", fontWeight = FontWeight.SemiBold)
            Text(
                "FaNotes erstellt zuerst eine Vorschau. Erst „Ergebnis übernehmen“ ersetzt den Inhalt der geöffneten Markdown-Datei.",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            if (note != null) {
                Text("Aktuelle Notiz", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                Text(note?.path.orEmpty(), fontWeight = FontWeight.SemiBold)
                Text("${live.length} Zeichen", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { pretty = true }) {
                    Text("Schön", fontWeight = if (pretty) FontWeight.SemiBold else FontWeight.Normal, color = if (pretty) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
                TextButton(onClick = { pretty = false }) {
                    Text("Markdown", fontWeight = if (!pretty) FontWeight.SemiBold else FontWeight.Normal, color = if (!pretty) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
            val base = ch.fasrv.fanotes.desk.editorMetrics(settings).previewFontPx
            if (!pretty) {
                Text(result, fontFamily = FontFamily.Monospace, fontSize = base.sp)
            } else {
                ch.fasrv.fanotes.desk.aiPreviewLines(result).forEach { line ->
                    val shown = ch.fasrv.fanotes.desk.aiPreviewLineText(line)
                    if (line.kind == ch.fasrv.fanotes.text.PaperKind.SPACER) {
                        Spacer(Modifier.height(8.dp))
                    } else if (shown.isNotEmpty() || line.kind == ch.fasrv.fanotes.text.PaperKind.RULE) {
                        Text(
                            if (line.kind == ch.fasrv.fanotes.text.PaperKind.RULE) "—" else shown,
                            fontSize = (base * ch.fasrv.fanotes.desk.aiPreviewScale(line.kind)).sp,
                            fontWeight = if (ch.fasrv.fanotes.desk.aiPreviewHeading(line.kind)) FontWeight.Bold else FontWeight.Normal,
                            fontFamily = if (line.kind == ch.fasrv.fanotes.text.PaperKind.CODE) FontFamily.Monospace else FontFamily.Default,
                        )
                    }
                }
            }
        }
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
    val css by model.customCss.collectAsStateWithLifecycle()
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
                    ch.fasrv.fanotes.desk.THEME_CHOICES.forEach { choice ->
                        val selected = ch.fasrv.fanotes.desk.themeChoiceSelected(settings["theme"], choice.id)
                        Text(
                            "${choice.label} · ${choice.detail}",
                            modifier = Modifier.clickable { model.updateDesk("theme", choice.id) }.padding(vertical = 6.dp),
                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                        )
                    }
                    Text("Arbeitsflächen-Design", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    val background = ch.fasrv.fanotes.desk.workspaceBackground(settings["background"])
                    ch.fasrv.fanotes.desk.WORKSPACE_BACKGROUNDS.forEach { (id, label) ->
                        Text(
                            label,
                            fontWeight = if (background == id) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clickable { model.updateDesk("background", id) }.padding(vertical = 4.dp),
                        )
                    }
                    Text(
                        "Kompakte Oberfläche: ${if (ch.fasrv.fanotes.desk.compactChrome(settings["compact"])) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("compact", if (ch.fasrv.fanotes.desk.compactChrome(settings["compact"])) "off" else "on") }.padding(vertical = 4.dp),
                    )
                    Text(
                        "Glas-Effekte: ${if (ch.fasrv.fanotes.desk.glassChrome(settings["glass"])) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("glass", if (ch.fasrv.fanotes.desk.glassChrome(settings["glass"])) "off" else "on") }.padding(vertical = 4.dp),
                    )
                    Text("Oberflächen-Schrift", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    val uiFont = ch.fasrv.fanotes.desk.uiFontId(settings["ui-font"])
                    ch.fasrv.fanotes.desk.UI_FONTS.forEach { face ->
                        Text(
                            face.label,
                            fontWeight = if (uiFont == face.id) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clickable { model.updateDesk("ui-font", face.stack) }.padding(vertical = 4.dp),
                        )
                    }
                    Text("Akzentfarbe", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    val accent = ch.fasrv.fanotes.desk.normalizeAccent(settings["accent"])
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ch.fasrv.fanotes.desk.ACCENT_COLORS.forEach { color ->
                            val selected = color == accent
                            Box(
                                Modifier
                                    .size(28.dp)
                                    .border(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.onSurface else Color(0x33000000), CircleShape)
                                    .padding(3.dp)
                                    .clip(CircleShape)
                                    .background(Color(android.graphics.Color.parseColor(color)))
                                    .clickable { model.updateDesk("accent", color) },
                            )
                        }
                    }
                    var customAccent by remember(accent) { mutableStateOf(accent) }
                    OutlinedTextField(
                        customAccent,
                        { next ->
                            customAccent = next
                            ch.fasrv.fanotes.desk.parseAccent(next)?.let { model.updateDesk("accent", it) }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Eigene Akzentfarbe") },
                        singleLine = true,
                    )
                    Text(accent, fontSize = 12.sp)
                    Text("Zweite Akzentfarbe", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    val secondary = ch.fasrv.fanotes.desk.normalizeAccentSecondary(settings["accent-secondary"])
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ch.fasrv.fanotes.desk.ACCENT_COLORS.forEach { color ->
                            val selected = color == secondary
                            Box(
                                Modifier
                                    .size(28.dp)
                                    .border(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.onSurface else Color(0x33000000), CircleShape)
                                    .padding(3.dp)
                                    .clip(CircleShape)
                                    .background(Color(android.graphics.Color.parseColor(color)))
                                    .clickable { model.updateDesk("accent-secondary", color) },
                            )
                        }
                    }
                    var customSecondary by remember(secondary) { mutableStateOf(secondary) }
                    OutlinedTextField(
                        customSecondary,
                        { next ->
                            customSecondary = next
                            ch.fasrv.fanotes.desk.parseAccent(next)?.let { model.updateDesk("accent-secondary", it) }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Eigene zweite Akzentfarbe") },
                        singleLine = true,
                    )
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
                    Text("Editor-Schrift", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    ch.fasrv.fanotes.desk.EDITOR_FONTS.forEach { face ->
                        Text(
                            face.label,
                            fontWeight = if (metrics.editorFontId == face.id) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clickable { model.updateDesk("editor-face", face.stack) }.padding(vertical = 4.dp),
                        )
                    }
                    EditorSlider("Editor-Schriftgröße", metrics.fontSizePx.toFloat(), 12f, 26f, 1f, " px") { model.updateDesk("editor-font", it.toInt().toString()) }
                    EditorSlider("KI-Vorschau-Schriftgröße", metrics.previewFontPx.toFloat(), 13f, 28f, 1f, " px") { model.updateDesk("preview-font", it.toInt().toString()) }
                    Text(
                        "Zeilennummern: ${if (metrics.showLineNumbers) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("line-numbers", if (metrics.showLineNumbers) "off" else "on") },
                    )
                    EditorSlider("Zeilenhöhe", metrics.lineHeight.toFloat(), 1.3f, 2.2f, 0.05f, "") { model.updateDesk("line-height", "%.2f".format(java.util.Locale.US, it)) }
                    Text(
                        "Lesbare Zeilenlänge: ${if (metrics.readableLineLength) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("readable-lines", if (metrics.readableLineLength) "off" else "on") },
                    )
                    EditorSlider("Maximale Inhaltsbreite", metrics.contentWidthPx.toFloat(), 560f, 1200f, 20f, " px") { model.updateDesk("content-width", it.toInt().toString()) }
                    EditorSlider("Zoom-Geschwindigkeit", metrics.zoomSpeed.toFloat(), 1f, 10f, 1f, "") { model.updateDesk("zoom-speed", it.toInt().toString()) }
                    EditorSlider("Maximaler Zoom", (metrics.zoomMax * 100).toFloat(), 50f, 600f, 5f, " %") { model.updateDesk("zoom-max", it.toInt().toString()) }
                    EditorSlider("Automatisch speichern", metrics.autosaveMs.toFloat(), 250f, 3000f, 250f, " ms") { model.updateDesk("autosave", it.toInt().toString()) }
                }
                "drawing" -> {
                    val pen = ch.fasrv.fanotes.desk.penSettings(settings)
                    Text("Druckempfindlichkeit: ${if (pen.pressure) "an" else "aus"}", modifier = Modifier.clickable { model.setPenPressure(!pen.pressure) })
                    val penOnly = ch.fasrv.fanotes.input.penOnlyEnabled(settings["pen-only"])
                    Text(
                        "Nur Stift: ${if (penOnly) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("pen-only", if (penOnly) "off" else "on") }.padding(vertical = 4.dp),
                    )
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
                    Text("Grafiktablett", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    Text("Belegt die Tasten, die FaNotes vom Stift und vom Tablett empfängt.", fontSize = 12.sp)
                    val tabletMap = ch.fasrv.fanotes.input.parseTabletButtonMap(settings["tablet-buttons"])
                    listOf("pen" to "Stift", "tablet" to "Tablett").forEach { (group, title) ->
                        Text(title, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
                        ch.fasrv.fanotes.input.TABLET_BUTTON_CONTROLS.filter { it.group == group }.forEach { control ->
                            val action = tabletMap[control.id].orEmpty()
                            Text(
                                "${control.label}: ${ch.fasrv.fanotes.input.TABLET_BUTTON_ACTION_LABELS[action] ?: action}",
                                modifier = Modifier.clickable {
                                    val next = tabletMap + (control.id to ch.fasrv.fanotes.input.nextTabletButtonAction(action))
                                    model.updateDesk("tablet-buttons", ch.fasrv.fanotes.input.serializeTabletButtonMap(next))
                                }.padding(vertical = 4.dp),
                            )
                            Text(control.hint, fontSize = 12.sp)
                        }
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
                "accessibility" -> {
                    Text("Größere Ziele: ${settings["large"] == "on"}", modifier = Modifier.clickable { model.updateDesk("large", if (settings["large"] == "on") "off" else "on") })
                    EditorSlider("Seitenleiste", ch.fasrv.fanotes.desk.sidebarWidthDp(settings["sidebar-width"]).toFloat(), 210f, 430f, 10f, " px") {
                        model.updateDesk("sidebar-width", it.toInt().toString())
                    }
                    EditorSlider("Informationsleiste", ch.fasrv.fanotes.desk.rightPanelWidthDp(settings["panel-width"]).toFloat(), 220f, 430f, 10f, " px") {
                        model.updateDesk("panel-width", it.toInt().toString())
                    }
                }
                "experimental" -> {
                    Text("Geteilte Ansicht ist über die Befehlsleiste erreichbar. Bewegungen lassen sich mit Fokus beruhigen.")
                    val backups = settings["experimental-backup"] == "on"
                    Text(
                        "Notiz-Sicherungen: ${if (backups) "an" else "aus"}",
                        modifier = Modifier.clickable { model.updateDesk("experimental-backup", if (backups) "off" else "on") }.padding(vertical = 6.dp),
                        fontWeight = if (backups) FontWeight.Bold else FontWeight.Normal,
                    )
                }
                "advanced" -> {
                    Text("Der Gerätename für Konfliktdateien steht in den Sync-Einstellungen. Secrets liegen im Android-Keystore, nicht im Vault.")
                    Text("Eigenes CSS", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    Text("Wird nur innerhalb der Oberfläche angewandt. Damit kannst du Abstände, Farben und Markdown-Elemente weiter personalisieren.", fontSize = 12.sp)
                    OutlinedTextField(
                        css,
                        { model.updateCustomCss(it) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
                        label = { Text("CSS") },
                        placeholder = { Text(":root {\n  --radius: 14px;\n}") },
                    )
                }
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
fun PdfThumbStrip(model: FaNotesViewModel) {
    val open by model.pdfThumbOpen.collectAsStateWithLifecycle()
    val thumbs by model.pdfThumbs.collectAsStateWithLifecycle()
    val active by model.pdfThumbPage.collectAsStateWithLifecycle()
    val total by model.pdfPageCount.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
        TextButton(onClick = { model.togglePdfThumbs() }) { Text(if (open) "Miniaturen ●" else "Miniaturen") }
        if (open) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                thumbs.forEachIndexed { index, bitmap ->
                    if (bitmap.isRecycled) return@forEachIndexed
                    val page = index + 1
                    val selected = page == active
                    Column(
                        Modifier
                            .width(76.dp)
                            .border(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline)
                            .clickable { model.showPdfThumb(page) }
                            .padding(2.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Image(
                            bitmap.asImageBitmap(),
                            contentDescription = "Seite $page",
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        )
                        Text("$page", fontSize = 11.sp)
                    }
                }
            }
            if (total > thumbs.size && thumbs.isNotEmpty()) {
                Text("Erste ${thumbs.size} Seiten", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
            }
        }
    }
}

@Composable
private fun SearchFlag(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, onChange)
        Text(label, fontSize = 13.sp)
    }
}

@Composable
fun NoteSearchBar(model: FaNotesViewModel) {
    val query by model.noteSearchQuery.collectAsStateWithLifecycle()
    val hits by model.noteSearchHits.collectAsStateWithLifecycle()
    val index by model.noteSearchIndex.collectAsStateWithLifecycle()
    val caseSensitive by model.noteSearchCaseSensitive.collectAsStateWithLifecycle()
    val regexp by model.noteSearchRegexp.collectAsStateWithLifecycle()
    val wholeWord by model.noteSearchWholeWord.collectAsStateWithLifecycle()
    val focusToken by model.noteSearchFocus.collectAsStateWithLifecycle()
    val searchFocus = androidx.compose.runtime.remember { FocusRequester() }
    androidx.compose.runtime.LaunchedEffect(focusToken) {
        if (focusToken > 0) runCatching { searchFocus.requestFocus() }
    }
    var replacement by remember { mutableStateOf("") }
    val status = when {
        query.trim().isEmpty() -> ""
        hits.isEmpty() -> "Keine Treffer"
        else -> "${index + 1} / ${hits.size}"
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                query,
                { model.updateNoteSearch(it) },
                modifier = Modifier.weight(1f).focusRequester(searchFocus).onPreviewKeyEvent { event ->
                    if (event.type == KeyEventType.KeyDown && event.key == Key.Escape && query.isNotEmpty()) {
                        model.updateNoteSearch("")
                        true
                    } else {
                        false
                    }
                },
                singleLine = true,
                label = { Text("Im Text suchen …") },
            )
            if (status.isNotEmpty()) Text(status, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp))
        }
        if (query.isNotEmpty()) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { model.stepNoteSearch(-1) }, enabled = hits.isNotEmpty()) { Text("Vorheriger Treffer") }
                TextButton(onClick = { model.stepNoteSearch(1) }, enabled = hits.isNotEmpty()) { Text("Nächster Treffer") }
                SearchFlag("Groß-/Kleinschreibung", caseSensitive, model::setNoteSearchCaseSensitive)
                SearchFlag("Regulärer Ausdruck", regexp, model::setNoteSearchRegexp)
                SearchFlag("Ganzes Wort", wholeWord, model::setNoteSearchWholeWord)
            }
            OutlinedTextField(
                replacement,
                { replacement = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Ersetzen") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { model.replaceCurrentNoteSearch(replacement) }),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { model.replaceCurrentNoteSearch(replacement) }, enabled = hits.isNotEmpty()) { Text("Ersetzen") }
                TextButton(onClick = { model.replaceAllNoteSearch(replacement) }, enabled = hits.isNotEmpty()) { Text("Alle ersetzen") }
            }
            val windowStart = (index - 2).coerceAtLeast(0)
            hits.drop(windowStart).take(6).forEachIndexed { offset, hit ->
                val hitIndex = windowStart + offset
                val selected = hitIndex == index
                Text(
                    hit.excerpt,
                    fontSize = 13.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    modifier = Modifier.fillMaxWidth().clickable { model.showNoteSearchHit(hitIndex) }.padding(vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
fun PdfPasswordPrompt(model: FaNotesViewModel) {
    val needed by model.pdfNeedsPassword.collectAsStateWithLifecycle()
    val rejected by model.pdfPasswordRejected.collectAsStateWithLifecycle()
    if (!needed) return
    var draft by remember { mutableStateOf("") }
    val supported = ch.fasrv.fanotes.desk.pdfPasswordSupported(android.os.Build.VERSION.SDK_INT)
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_TITLE, fontWeight = FontWeight.SemiBold)
        if (!supported) {
            Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_NEEDS_ANDROID_15, fontSize = 13.sp)
            return@Column
        }
        OutlinedTextField(
            draft,
            { draft = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
            label = { Text("Passwort") },
        )
        if (rejected) Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_WRONG, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = { model.submitPdfPassword(draft) }) { Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_ACTION) }
    }
}

@Composable
fun PdfSearchBar(model: FaNotesViewModel) {
    val query by model.pdfSearchQuery.collectAsStateWithLifecycle()
    val hits by model.pdfSearchHits.collectAsStateWithLifecycle()
    val index by model.pdfSearchIndex.collectAsStateWithLifecycle()
    val busy by model.pdfSearchBusy.collectAsStateWithLifecycle()
    val status = when {
        busy -> "Sucht …"
        query.trim().isEmpty() -> ""
        hits.isEmpty() -> "Keine Treffer"
        else -> "${index + 1} / ${hits.size}"
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                query,
                { model.updatePdfSearch(it) },
                modifier = Modifier.weight(1f),
                singleLine = true,
                label = { Text("Im PDF suchen …") },
            )
            if (status.isNotEmpty()) {
                Text(status, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.stepPdfSearch(-1) }, enabled = hits.isNotEmpty()) { Text("Vorheriger Treffer") }
            TextButton(onClick = { model.stepPdfSearch(1) }, enabled = hits.isNotEmpty()) { Text("Nächster Treffer") }
        }
        val windowStart = (index - 2).coerceAtLeast(0)
        hits.drop(windowStart).take(6).forEachIndexed { offset, hit ->
            val hitIndex = windowStart + offset
            val selected = hitIndex == index
            Text(
                "S. ${hit.page}  ${hit.excerpt}",
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                modifier = Modifier.fillMaxWidth().clickable { model.showPdfSearchHit(hitIndex) }.padding(vertical = 2.dp),
            )
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
        val live = ch.fasrv.fanotes.desk.inspectorDocument(markdown)
        val stats = measureDocument(markdown)
        Text("Dokument", fontWeight = FontWeight.SemiBold)
        Text("${live.words} Wörter", fontSize = 13.sp)
        Text("${live.characters} Zeichen", fontSize = 13.sp)
        Text("Lesezeit ~ ${live.readingMinutes} min", fontSize = 13.sp)
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
    rankNotes: (String, Int) -> List<SwitcherNote>,
    onOpenNote: (String) -> Unit,
    onOpenNoteInSplit: (String) -> Unit = {},
    splitOpen: Boolean = false,
    notesOnly: Boolean = false,
    onRun: (String) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableIntStateOf(0) }
    val notes = if (notesOnly) rankNotes(query, 40) else if (query.isBlank()) emptyList() else rankNotes(query, 6)
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
        "split" to if (splitOpen) "Geteilte Ansicht schließen" else "Geteilte Ansicht öffnen",
        "split-orient" to "Teilung drehen",
        "split-swap" to "Geteilte Ansicht tauschen",
        "note-here" to "Notiz in diesem Ordner",
        "subfolder" to "Unterordner",
        "focus" to "Fokusmodus",
        "sidebar" to "Dateileiste umschalten",
        "inspector" to "Gliederung umschalten",
        "sync" to "Sync",
        "bug-report" to "Fehler melden",
        "export-pdf" to "Notiz als PDF exportieren",
        "download-note" to "Notiz herunterladen",
    )
    val commands = if (notesOnly) emptyList() else if (query.isBlank()) actions else actions.filter { (_, label) -> fuzzyScore(query, label) > 0 }
    val rows = commands.map { PaletteRow.Command(it.first, it.second) } + notes.map { PaletteRow.Note(it.path, it.title, it.folder) }
    androidx.compose.runtime.LaunchedEffect(query, notesOnly) { selected = 0 }
    val listState = rememberLazyListState()
    androidx.compose.runtime.LaunchedEffect(selected, rows.size) {
        if (rows.isNotEmpty()) listState.animateScrollToItem(selected.coerceIn(0, rows.lastIndex))
    }
    fun openRow(index: Int, split: Boolean) {
        val row = rows.getOrNull(index) ?: return
        when (row) {
            is PaletteRow.Command -> onRun(row.id)
            is PaletteRow.Note -> if (ch.fasrv.fanotes.desk.paletteOpensInSplit("note", split)) onOpenNoteInSplit(row.path) else onOpenNote(row.path)
        }
        onDismiss()
    }
    Column(Modifier.fillMaxWidth().heightIn(max = 480.dp).background(MaterialTheme.colorScheme.surface).padding(12.dp)) {
        OutlinedTextField(
            query,
            { query = it },
            modifier = Modifier.fillMaxWidth().onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionDown -> {
                        selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, 1)
                        true
                    }
                    Key.DirectionUp -> {
                        selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, -1)
                        true
                    }
                    Key.PageDown -> {
                        selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, 8)
                        true
                    }
                    Key.PageUp -> {
                        selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, -8)
                        true
                    }
                    Key.Enter, Key.NumPadEnter -> {
                        openRow(selected, event.isShiftPressed)
                        true
                    }
                    else -> false
                }
            },
            label = { Text(if (notesOnly) "Notiz öffnen …" else "Befehl suchen …") },
            singleLine = true,
        )
        if (rows.isEmpty()) {
            Text(
                if (notesOnly) "Keine passende Notiz" else "Kein passender Befehl",
                modifier = Modifier.padding(top = 12.dp),
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        }
        LazyColumn(state = listState, modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).padding(top = 8.dp)) {
            itemsIndexed(rows) { index, row ->
                val group = when (row) {
                    is PaletteRow.Command -> "Befehle"
                    is PaletteRow.Note -> if (notesOnly && query.isBlank()) "Zuletzt geöffnet" else "Notizen"
                }
                val previous = rows.getOrNull(index - 1)
                val previousGroup = when (previous) {
                    is PaletteRow.Command -> "Befehle"
                    is PaletteRow.Note -> if (notesOnly && query.isBlank()) "Zuletzt geöffnet" else "Notizen"
                    null -> null
                }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(if (index == selected) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f) else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable { openRow(index, false) }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    if (group != previousGroup) {
                        Text(group, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp))
                    }
                    when (row) {
                        is PaletteRow.Command -> Text(row.label)
                        is PaletteRow.Note -> {
                            Text(row.title)
                            if (row.folder.isNotEmpty()) Text(row.folder, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                        }
                    }
                }
            }
        }
        Text(
            if (notesOnly || notes.isNotEmpty()) "↑ ↓ auswählen · Enter öffnen · Umschalt+Enter rechts · Esc schließen" else "↑ ↓ auswählen · Enter öffnen · Esc schließen",
            modifier = Modifier.padding(top = 8.dp),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
    }
}

private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.detectDeskSwipe(
    onSwipe: (ch.fasrv.fanotes.desk.SwipeDirection) -> Unit,
) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        var end = down.position
        val pointer = down.id
        while (true) {
            val event = awaitPointerEvent()
            val change = event.changes.firstOrNull { it.id == pointer } ?: break
            end = change.position
            if (!change.pressed) break
        }
        val direction = ch.fasrv.fanotes.desk.swipeDirection(end.x - down.position.x, end.y - down.position.y)
            ?: return@awaitEachGesture
        onSwipe(direction)
    }
}

private sealed class PaletteRow {
    data class Command(val id: String, val label: String) : PaletteRow()
    data class Note(val path: String, val title: String, val folder: String) : PaletteRow()
}
