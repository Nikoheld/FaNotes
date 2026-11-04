@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.vault.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun NoteRow(model: CompanionModel, node: VaultNode, onMore: (() -> Unit)? = null, onClick: () -> Unit) {
    val preview by produceState<NotePreview?>(null, node.path, node.modifiedAt) { value = runCatching { model.loadPreview(node) }.getOrNull() }
    Column {
        Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable(onClick = onClick).padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(Modifier.size(58.dp, 68.dp).clip(MaterialTheme.shapes.small).background(LocalCompanionSemantics.current.paper), contentAlignment = Alignment.Center) {
                val ink = preview?.ink
                if (ink != null && ink.strokes.isNotEmpty()) InkThumbnail(ink, Modifier.fillMaxSize().padding(5.dp), cacheKey = "${node.path}:${node.modifiedAt}")
                else Icon(if (node.kind == NoteKind.PDF) Icons.Outlined.PictureAsPdf else Icons.AutoMirrored.Outlined.Article, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.primary)
            }
            Column(Modifier.weight(1f)) {
                Text(node.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val excerpt = preview?.text.orEmpty()
                if (excerpt.isNotBlank()) Text(excerpt, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(listOf(node.path.substringBeforeLast('/', "").ifBlank { "My notes" }, Instant.ofEpochMilli(node.modifiedAt).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH))).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 3.dp))
            }
            if (onMore != null) ActionIcon(Icons.Outlined.MoreVert, "Actions for ${node.name}", onClick = onMore)
        }
        FineDivider()
    }
}

@Composable
fun InkThumbnail(document: InkDocument, modifier: Modifier = Modifier, cacheKey: String = document.updatedAt) {
    val density = LocalDensity.current
    val bitmap by produceState(null as android.graphics.Bitmap?, cacheKey, document.updatedAt, document.strokes.size) {
        val width = with(density) { 116.dp.roundToPx() }
        val height = with(density) { 136.dp.roundToPx() }
        val cached = CompanionImageCache.ink(cacheKey, width, height)
        value = cached ?: rasterizeInkThumbnail(document, width, height).also {
            CompanionImageCache.putInk(cacheKey, width, height, it)
        }
    }
    val image = bitmap
    if (image != null) Image(image.asImageBitmap(), null, modifier)
}

@Composable
fun InkPreview(document: InkDocument, modifier: Modifier = Modifier) {
    val session = remember { InkSession(document) }
    AndroidView(
        factory = { context -> CompanionInkView(context, session) {}.also { it.readOnly = true } },
        update = { view -> view.readOnly = true; view.bindDocument(document) },
        modifier = modifier.clipToBounds(),
    )
}

@Composable
fun NotesScreen(model: CompanionModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf("browse") }
    var results by remember { mutableStateOf<List<NoteResult>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var searchError by remember { mutableStateOf<String?>(null) }
    var folderDialog by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<VaultNode?>(null) }
    LaunchedEffect(query, model.tree) {
        if (query.isBlank()) { searching = false; results = emptyList(); return@LaunchedEffect }
        searching = true; searchError = null
        delay(250)
        try { results = model.findNotes(query.trim()) } catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; searchError = "Could not search your notes. Try again." }
        searching = false
    }
    Column {
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.page, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            SearchField(query, { query = it }, "Search all notes", Modifier.weight(1f))
            Box {
                ActionIcon(Icons.Outlined.MoreVert, "Library options") { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("New folder") }, leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null) }, onClick = { menu = false; folderDialog = true })
                    DropdownMenuItem(text = { Text("Recently deleted") }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null) }, onClick = { menu = false; model.navigate(Page.Trash) })
                }
            }
        }
        ChoiceRow(listOf("browse" to "Library", "recent" to "Recently edited"), mode, { mode = it }, Modifier.padding(horizontal = Space.page))
        if (model.loading) { LoadingState("Opening your library…"); return }
        val nodes = remember(mode, model.notes, model.tree) { if (mode == "browse") model.notes else flattenNotes(model.tree).sortedByDescending { it.modifiedAt } }
        ScreenList {
            if (query.isNotBlank()) {
                if (searching) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 12.dp)) }
                if (searchError != null) item { InfoBanner("Search unavailable", searchError.orEmpty()) }
                if (!searching && results.isEmpty() && searchError == null) item { EmptyState(Icons.Outlined.SearchOff, "No matching notes", "Search by title, note text, or an existing handwriting transcript.") }
                items(results, key = { it.node.path }) { result -> NoteRow(model, result.node, { selected = result.node }) { model.openNote(result.node.path) } }
            } else {
                if (mode == "browse" && model.noteFolder.isNotBlank()) item {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { model.openFolder("") }) { Text("My notes") }
                        val crumbs = model.noteFolder.split('/')
                        crumbs.forEachIndexed { index, crumb ->
                            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(14.dp))
                            TextButton(onClick = { model.openFolder(crumbs.take(index + 1).joinToString("/")) }) { Text(crumb) }
                        }
                    }
                }
                if (nodes.isEmpty()) item { EmptyState(Icons.Outlined.AutoStories, if (model.noteFolder.isBlank()) "A home for your notes" else "This folder is ready", "Create a note to start writing. Everything saves on this device, even offline.") }
                items(nodes, key = { it.path }) { node ->
                    if (node.kind == NoteKind.FOLDER) {
                        Row(Modifier.fillMaxWidth().clickable { model.openFolder(node.path) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Icon(Icons.Outlined.Folder, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(8.dp).size(24.dp))
                            Column(Modifier.weight(1f)) {
                                Text(node.name, style = MaterialTheme.typography.titleMedium)
                                Text(flattenNotes(node.children).size.let { "$it ${if (it == 1) "note" else "notes"}" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            ActionIcon(Icons.Outlined.MoreVert, "Actions for ${node.name}") { selected = node }
                        }
                        FineDivider()
                    } else NoteRow(model, node, { selected = node }) { model.openNote(node.path) }
                }
            }
        }
    }
    if (folderDialog) NameDialog("New folder", "Folder name", "Create", onDismiss = { folderDialog = false }) { model.createFolder(it); folderDialog = false }
    selected?.let { NoteActions(model, it) { selected = null } }
}

@Composable
private fun NoteActions(model: CompanionModel, node: VaultNode, onDismiss: () -> Unit) {
    var action by remember { mutableStateOf("") }
    if (action == "rename") {
        NameDialog("Rename", "Name", "Save", node.name, onDismiss) { model.renameNote(node, it); onDismiss() }; return
    }
    if (action == "trash") {
        ConfirmDialog("Move ${if (node.kind == NoteKind.FOLDER) "folder" else "note"} to recently deleted?", "You can restore it from this device's library menu.", "Move", onDismiss) { model.trashNote(node); onDismiss() }; return
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().sheetKeyboardPadding().padding(horizontal = Space.page).padding(bottom = 24.dp)) {
            SheetTitle(if (action == "move") "Move to folder" else node.name, onDismiss)
            if (action == "move") {
                val folders = flattenFolders(model.tree).filterNot { it.path == node.path || it.path.startsWith("${node.path}/") }
                Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
                    SettingRow(Icons.Outlined.FolderOpen, "My notes") { model.moveNote(node, ""); onDismiss() }
                    folders.forEach { folder -> SettingRow(Icons.Outlined.Folder, folder.name, folder.path) { model.moveNote(node, folder.path); onDismiss() } }
                }
            } else {
                SettingRow(Icons.Outlined.DriveFileRenameOutline, "Rename") { action = "rename" }
                SettingRow(Icons.AutoMirrored.Outlined.DriveFileMove, "Move to folder") { action = "move" }
                if (node.kind == NoteKind.MARKDOWN) SettingRow(Icons.Outlined.ContentCopy, "Duplicate") { model.duplicateNote(node); onDismiss() }
                SettingRow(Icons.Outlined.DeleteOutline, "Move to recently deleted") { action = "trash" }
            }
        }
    }
}

@Composable
fun TrashScreen(model: CompanionModel) {
    var trash by remember { mutableStateOf<List<TrashItem>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(model.tree) {
        try { trash = withContext(Dispatchers.IO) { model.graph.store.listTrash() } } catch (failure: Exception) { error = "Could not read recently deleted notes." }
    }
    if (trash == null && error == null) { LoadingState(); return }
    ScreenList {
        item { Text("Deleted notes stay on this device. Restoring adds them back to your library.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
        if (error != null) item { InfoBanner("Recently deleted unavailable", error.orEmpty()) }
        if (trash?.isEmpty() == true) item { EmptyState(Icons.Outlined.DeleteOutline, "Nothing here", "Notes you remove from the library will appear here.") }
        items(trash.orEmpty(), key = { it.id }) { item ->
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(item.name, style = MaterialTheme.typography.titleMedium); Text(item.path, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                TextButton(onClick = { model.restoreNote(item.id) { trash = trash.orEmpty().filterNot { it.id == item.id } } }) { Text("Restore") }
            }
            FineDivider()
        }
    }
}

@Composable
fun NoteEditorScreen(model: CompanionModel) {
    val editor = model.editor ?: return
    var mode by rememberSaveable(editor.path) { mutableStateOf("read") }
    var tool by rememberSaveable(editor.path) { mutableStateOf("pen") }
    var color by rememberSaveable(editor.path) { mutableStateOf("#202333") }
    val owner = LocalLifecycleOwner.current
    val focus = LocalFocusManager.current
    DisposableEffect(owner, editor) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) editor.flush() }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); editor.flush() }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.AutoMirrored.Outlined.ArrowBack, "Save and go back") { model.closeEditor() }
            Column(Modifier.weight(1f)) {
                Text(editor.note?.title ?: "Opening note…", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(when { editor.error != null -> "Save needs attention"; editor.saving -> "Saving…"; editor.dirty -> "Unsaved changes"; else -> "Saved on this device" },
                    style = MaterialTheme.typography.bodySmall, color = if (editor.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            ActionIcon(Icons.Outlined.Done, "Save note", enabled = editor.note != null) { editor.flush() }
        }
        if (editor.loading) { LoadingState("Opening note…"); return }
        if (editor.error != null) {
            Box(Modifier.padding(Space.md)) { InfoBanner("Note needs attention", editor.error.orEmpty(), if (editor.note == null) "Try again" else "Save again", true) { if (editor.note == null) editor.load() else editor.flush() } }
        }
        if (editor.note == null) return
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = Space.page, vertical = 8.dp)) {
            listOf("read" to "Read", "text" to "Text", "ink" to "Ink").forEachIndexed { index, (id, title) ->
                SegmentedButton(selected = mode == id, onClick = { focus.clearFocus(); mode = id }, shape = SegmentedButtonDefaults.itemShape(index, 3)) { Text(title) }
            }
        }
        FineDivider()
        when (mode) {
            "text" -> {
                Box(Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(Space.page)) {
                    if (editor.markdown.isEmpty()) Text("Start writing…", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    BasicTextField(editor.markdown, editor::editText, Modifier.fillMaxSize(),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface, fontFamily = CompanionMono),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary))
                }
            }
            "ink" -> {
                val session = editor.session
                if (session != null) Box(Modifier.weight(1f).fillMaxWidth().clipToBounds()) {
                    key(editor.path) {
                        AndroidView(factory = { context -> CompanionInkView(context, session, editor::inkChanged) },
                            update = { view ->
                                view.penColor = color
                                view.eraser = tool == "eraser"
                                view.panning = tool == "pan"
                                view.syncFromSession()
                            },
                            modifier = Modifier.fillMaxSize())
                    }
                }
                Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 1.dp) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            ChoiceRow(listOf("pen" to "Pen", "eraser" to "Eraser", "pan" to "Move"), tool, { tool = it }, Modifier.weight(1f))
                            ActionIcon(Icons.AutoMirrored.Outlined.Undo, "Undo stroke", editor.canUndo, editor::undo)
                            ActionIcon(Icons.AutoMirrored.Outlined.Redo, "Redo stroke", editor.canRedo, editor::redo)
                        }
                        if (tool == "pen") ColorChoices(listOf("#202333", "#2a6f97", "#c4554d", "#0f7b6c"), color, { color = it })
                        Text("Two fingers move and zoom the page", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
                    }
                }
            }
            else -> Box(Modifier.weight(1f).fillMaxWidth()) { NoteReading(model, editor) { mode = "ink" } }
        }
    }
}
