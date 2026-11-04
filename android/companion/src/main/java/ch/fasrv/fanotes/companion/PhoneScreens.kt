@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.schulnetz.presentedNavBar
import ch.fasrv.fanotes.sync.SyncStatus

@Composable
fun CompanionRoot(model: CompanionModel) {
    val login = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) model.onWebLoginFinished() else model.onWebLoginCancelled()
    }
    val sync by model.graph.engine.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model) { model.graph.loginRequests.collect { login.launch(it) } }
    LaunchedEffect(model) { model.graph.notices.collect { snackbar.showSnackbar(it) } }
    LaunchedEffect(model.message) {
        val message = model.message ?: return@LaunchedEffect
        snackbar.showSnackbar(message)
        if (model.message == message) model.message = null
    }
    if (sync.account == null && !model.localAccess) {
        Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
            WelcomeScreen(model, Modifier.padding(padding).consumeWindowInsets(padding).imePadding())
        }
        return
    }
    LaunchedEffect(model.pendingSchoolConnect) {
        if (model.pendingSchoolConnect) {
            model.pendingSchoolConnect = false
            model.requestVisibleLogin("welcome")
        }
    }
    val route = model.route
    val savedScreens = rememberSaveableStateHolder()
    val barItems = presentedNavBar(model.desk.navBar, model.notesAccount)
    val barVisible = showsNavBar(route, model.plannerTasks, barItems)
    BackHandler(route.page == Page.Editor || !model.atNavRoot()) {
        if (route.page == Page.Editor) model.closeEditor() else model.back()
    }
    var create by rememberSaveable { mutableStateOf<String?>(null) }
    var noteName by rememberSaveable { mutableStateOf(false) }
    var taskForm by rememberSaveable { mutableStateOf(false) }
    var eventForm by rememberSaveable { mutableStateOf(false) }
    fun begin(kind: String) {
        create = null
        when (kind) { "note" -> noteName = true; "task" -> taskForm = true; "event" -> { if (route.destination == Destination.Today) model.day = java.time.LocalDate.now(); eventForm = true } }
    }
    if (route.page == Page.Editor && model.notesAccount) {
        Scaffold(snackbarHost = { SnackbarHost(snackbar) }, contentWindowInsets = WindowInsets.safeDrawing) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) { NoteEditorScreen(model) }
        }
        return
    }
    val creationLabel = when {
        model.notesAccount && route.destination == Destination.Notes -> "New note"
        route.destination == Destination.Planner -> if (model.plannerTasks) "New task" else "New event"
        else -> "Create"
    }
    fun requestCreation() {
        when {
            model.notesAccount && route.destination == Destination.Notes -> begin("note")
            route.destination == Destination.Planner -> begin(if (model.plannerTasks) "task" else "event")
            else -> create = "choose"
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 600.dp
        val primary = barVisible
        val shortWindow = maxHeight < 500.dp
        val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
        val hasCreation = primary && route.page == null && route.destination != Destination.School
        val dockCreation = hasCreation && !wide && LocalDensity.current.fontScale >= 1.3f
        val selectedId = selectedNavId(route, model.plannerTasks, barItems)
        val title = when {
            !model.notesAccount && route.page == Page.Connections -> "School"
            else -> selectedId?.let(::navBarLabel) ?: route.page?.title ?: route.destination.label
        }
        CompositionLocalProvider(LocalPageBottomPadding provides if (hasCreation && !dockCreation && !imeVisible) 100.dp else 24.dp) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
            contentWindowInsets = WindowInsets.safeDrawing,
            topBar = {
                TopAppBar(
                    title = { Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = { if (!primary) ActionIcon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") { model.back() } },
                    actions = {
                        if (primary) {
                            ActionIcon(Icons.Outlined.Search, if (model.notesAccount) "Search notes, tasks and school" else "Search tasks and school") { model.navigate(Page.Search) }
                            ActionIcon(Icons.Outlined.Settings, "Settings") { model.openSettings() }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
            },
            bottomBar = {
                if (primary && !wide && !imeVisible) {
                    Column {
                        if (dockCreation) {
                            Button(onClick = ::requestCreation, modifier = Modifier.fillMaxWidth().padding(horizontal = Space.page, vertical = 8.dp).heightIn(min = 50.dp)) {
                                Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text(creationLabel)
                            }
                        }
                        FineDivider()
                        NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
                            barItems.forEach { id -> NavigationBarItem(
                                selected = selectedId == id, onClick = { model.selectNav(id) },
                                icon = { Icon(navBarIcon(id), null, Modifier.size(23.dp)) }, label = { Text(navBarLabel(id), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.primaryContainer),
                            ) }
                        }
                    }
                }
            },
            floatingActionButton = {
                if (hasCreation && !dockCreation && !imeVisible) {
                    ExtendedFloatingActionButton(modifier = Modifier.semantics { contentDescription = creationLabel }, onClick = ::requestCreation,
                        icon = { Icon(Icons.Outlined.Add, null) }, text = { Text(creationLabel) }, containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary, elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 2.dp, pressedElevation = 4.dp))
                }
            },
            containerColor = MaterialTheme.colorScheme.background,
        ) { padding ->
            Row(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
                if (wide && primary) {
                    NavigationRail(containerColor = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxHeight().verticalScroll(rememberScrollState())) {
                        Spacer(Modifier.height(12.dp))
                        barItems.forEach { id -> NavigationRailItem(
                            selected = selectedId == id, onClick = { model.selectNav(id) },
                            icon = { Icon(navBarIcon(id), navBarLabel(id)) },
                            label = if (shortWindow) null else ({ Text(navBarLabel(id)) }), modifier = Modifier.padding(vertical = if (shortWindow) 2.dp else 6.dp),
                        ) }
                    }
                }
                Box(Modifier.weight(1f), contentAlignment = Alignment.TopCenter) {
                    Column(Modifier.fillMaxHeight().widthIn(max = 840.dp).fillMaxWidth()) {
                        if (model.busy || sync.status == SyncStatus.SYNCING) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                        if ((sync.status == SyncStatus.OFFLINE || sync.status == SyncStatus.ERROR) && route.destination != Destination.Today) {
                            Box(Modifier.padding(horizontal = Space.page, vertical = 8.dp)) {
                                InfoBanner(
                                    if (sync.status == SyncStatus.OFFLINE) "You're offline" else if (model.notesAccount) "Sync needs attention" else "Connection needs attention",
                                    "Keep working. Changes are saved on this device.",
                                    if (model.notesAccount) "Account & sync" else "School",
                                    error = sync.status == SyncStatus.ERROR,
                                ) { model.navigate(Page.Connections) }
                            }
                        }
                        model.loadError?.let { error ->
                            Box(Modifier.padding(horizontal = Space.page, vertical = 8.dp)) { InfoBanner(if (model.notesAccount) "Library needs attention" else "Tasks and calendar need attention", error, "Try again", true, model::reload) }
                        }
                        Box(Modifier.weight(1f)) {
                            Crossfade(targetState = route, animationSpec = tween(120), label = "Screen transition") { current ->
                            savedScreens.SaveableStateProvider("${current.destination}:${current.page}:${if (current.page == Page.Course) model.focusCourseId else ""}") {
                            when (current.page) {
                                Page.Search -> CompanionSearchScreen(model)
                                Page.Auth -> AccountScreen(model)
                                Page.Grades -> GradesScreen(model)
                                Page.ArchivedSubjects -> ArchivedSubjectsScreen(model)
                                Page.Course -> CourseScreen(model)
                                Page.Exams, Page.Absences, Page.Updates, Page.Statement -> SchoolRecordScreen(model, current.page)
                                Page.Settings, Page.Connections, Page.Appearance, Page.Navigation, Page.Planning, Page.Notifications, Page.Diagnostics, Page.Profile -> SettingsScreen(model, current.page)
                                Page.Trash -> if (model.notesAccount) TrashScreen(model) else TodayScreen(model)
                                else -> when (current.destination) {
                                    Destination.Today -> TodayScreen(model)
                                    Destination.Planner -> PlannerScreen(model)
                                    Destination.Notes -> if (model.notesAccount) NotesScreen(model) else TodayScreen(model)
                                    Destination.School -> SchoolScreen(model)
                                }
                            }
                            }
                            }
                        }
                    }
                }
            }
        }
    }
    }
    if (create != null) ModalBottomSheet(onDismissRequest = { create = null }) {
        Column(Modifier.fillMaxWidth().sheetKeyboardPadding().padding(horizontal = Space.page).padding(bottom = Space.xl)) {
            SheetTitle(if (model.notesAccount) "Make room for an idea" else "Add to your day", { create = null })
            if (model.notesAccount) SettingRow(Icons.Outlined.EditNote, "Note", "Write, draw or collect your thoughts") { begin("note") }
            SettingRow(Icons.Outlined.CheckCircleOutline, "Task", "Homework or something to get done") { begin("task") }
            SettingRow(Icons.Outlined.Event, "Event", "Put a commitment on your calendar") { begin("event") }
        }
    }
    if (noteName) NameDialog("New note", "Note title", "Create", onDismiss = { noteName = false }) { title -> noteName = false; model.createNote(title) }
    if (taskForm) TaskForm(model, onDismiss = { taskForm = false })
    if (eventForm) EventForm(model, onDismiss = { eventForm = false })
    if (model.revealQueue.isNotEmpty()) GradeRevealSheet(model)
    if (model.offerUpload) {
        AlertDialog(
            onDismissRequest = model::declineUpload,
            title = { Text("Upload tasks and calendar from this device?") },
            text = { Text("They stay on this device until you upload them. School data is already connected.") },
            confirmButton = { TextButton(onClick = model::acceptUpload) { Text("Upload") } },
            dismissButton = { TextButton(onClick = model::declineUpload) { Text("Not now") } },
        )
    }
}

fun syncDescription(status: SyncStatus): String = when (status) {
    SyncStatus.IDLE -> "Up to date"
    SyncStatus.SYNCING -> "Syncing…"
    SyncStatus.OFFLINE -> "Offline · changes stay on this device"
    SyncStatus.ERROR -> "Sync needs attention"
    SyncStatus.PAUSED -> "Sync paused"
    SyncStatus.SIGNED_OUT -> "Stored on this device"
    SyncStatus.UNAVAILABLE -> "Sync unavailable"
}
