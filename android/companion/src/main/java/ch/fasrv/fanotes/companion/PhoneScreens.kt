@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.schulnetz.presentedNavBar
import ch.fasrv.fanotes.sync.SyncStatus
import java.time.LocalDate
import java.time.temporal.IsoFields

enum class NavMove { Tab, Forward, Back }

@Composable
fun CompanionRoot(model: CompanionModel) {
    val login = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) model.onWebLoginFinished() else model.onWebLoginCancelled()
    }
    val sync by model.graph.engine.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model) { model.graph.loginRequests.collect { login.launch(it) } }
    LaunchedEffect(model) { model.graph.notices.collect { snackbar.showSnackbar(shownText(it)) } }
    LaunchedEffect(model.message) {
        val message = model.message ?: return@LaunchedEffect
        snackbar.showSnackbar(shownText(message))
        if (model.message == message) model.message = null
    }
    if (model.onboardingReplay || (model.onboardingActive && sync.account == null)) {
        Scaffold(snackbarHost = { SnackbarHost(snackbar) }, containerColor = MaterialTheme.colorScheme.background) { padding ->
            OnboardingScreen(model, Modifier.padding(padding).consumeWindowInsets(padding).imePadding())
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
    LaunchedEffect(route.destination, route.page) {
        val token = screenToken(route)
        model.graph.trail.screen(token)
        model.graph.trail.action("screen-$token")
    }
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
        when (kind) { "note" -> noteName = true; "task" -> taskForm = true; "event" -> { if (route.destination == Destination.Today) model.day = LocalDate.now(); eventForm = true } }
    }
    if (route.page == Page.Editor && model.notesAccount) {
        Scaffold(snackbarHost = { SnackbarHost(snackbar) }, contentWindowInsets = WindowInsets.safeDrawing, containerColor = MaterialTheme.colorScheme.background) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) { NoteEditorScreen(model) }
        }
        return
    }
    val creationLabel = when {
        model.notesAccount && route.destination == Destination.Notes -> t(R.string.new_note)
        route.destination == Destination.Planner -> if (model.plannerTasks) t(R.string.new_task) else t(R.string.new_event)
        else -> t(R.string.create)
    }
    fun requestCreation() {
        when {
            model.notesAccount && route.destination == Destination.Notes -> begin("note")
            route.destination == Destination.Planner -> begin(if (model.plannerTasks) "task" else "event")
            else -> create = "choose"
        }
    }
    val motion = LocalKantiMotion.current
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 600.dp
        val primary = barVisible
        val shortWindow = maxHeight < 500.dp
        val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
        val hasCreation = primary && route.page == null && route.destination != Destination.School
        val dockCreation = hasCreation && !wide && LocalDensity.current.fontScale >= 1.3f
        val selectedId = selectedNavId(route, model.plannerTasks, barItems)
        val title = when {
            !model.notesAccount && route.page == Page.Connections -> t(R.string.school)
            else -> selectedId?.let(::navBarLabel) ?: route.page?.uiTitle() ?: route.destination.uiLabel()
        }
        val subtitle = if (primary && route.page == null && route.destination == Destination.Today) todaySubtitle(LocalDate.now()) else ""
        CompositionLocalProvider(LocalPageBottomPadding provides if (hasCreation && !dockCreation && !imeVisible) 112.dp else 32.dp) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
            contentWindowInsets = WindowInsets.safeDrawing,
            topBar = {
                KantiTopBar(
                    title = title,
                    subtitle = subtitle,
                    root = primary,
                    compact = shortWindow,
                    onBack = { model.back() },
                    onSearch = { model.navigate(Page.Search) },
                    onSettings = { model.openSettings() },
                    searchLabel = if (model.notesAccount) t(R.string.search_notes_tasks_and_school) else t(R.string.search_tasks_and_school),
                )
            },
            bottomBar = {
                if (primary && !wide && !imeVisible) {
                    Column {
                        if (dockCreation) {
                            PrimaryButton(creationLabel, ::requestCreation, Modifier.fillMaxWidth().padding(horizontal = Space.page, vertical = 8.dp), icon = Icons.Outlined.Add)
                        }
                        KantiNavBar(barItems, selectedId) { model.selectNav(it) }
                    }
                }
            },
            floatingActionButton = {
                if (hasCreation && !dockCreation && !imeVisible) {
                    ExtendedFloatingActionButton(modifier = Modifier.semantics { contentDescription = creationLabel }, onClick = ::requestCreation,
                        shape = RoundedCornerShape(18.dp),
                        icon = { Icon(Icons.Outlined.Add, null) }, text = { Text(creationLabel, style = MaterialTheme.typography.labelLarge) }, containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary, elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 3.dp, pressedElevation = 6.dp))
                }
            },
            containerColor = MaterialTheme.colorScheme.background,
        ) { padding ->
            Row(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
                if (wide && primary) KantiRail(barItems, selectedId, shortWindow) { model.selectNav(it) }
                Box(Modifier.weight(1f), contentAlignment = Alignment.TopCenter) {
                    Column(Modifier.fillMaxHeight().widthIn(max = 840.dp).fillMaxWidth()) {
                        if (model.busy || sync.status == SyncStatus.SYNCING) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), trackColor = LocalCompanionSemantics.current.sunken)
                        val syncCopy = if (route.destination == Destination.Today) null else faNotesSyncCopy(sync.status, model.notesAccount)
                        if (syncCopy != null) {
                            Box(Modifier.padding(horizontal = Space.page, vertical = 8.dp)) {
                                InfoBanner(t(syncCopy.first), t(syncCopy.second), t(R.string.account_sync), error = syncCopy.third, tone = if (syncCopy.third) StateTone.Error else StateTone.Offline) { model.navigate(Page.Connections) }
                            }
                        }
                        model.loadError?.let { error ->
                            Box(Modifier.padding(horizontal = Space.page, vertical = 8.dp)) { InfoBanner(if (model.notesAccount) t(R.string.library_needs_attention) else t(R.string.tasks_and_calendar_need_attention), shownText(error), t(R.string.try_again), true, onAction = model::reload) }
                        }
                        Box(Modifier.weight(1f)) {
                            AnimatedContent(
                                targetState = route,
                                transitionSpec = {
                                    if (motion.reduced) EnterTransition.None togetherWith ExitTransition.None
                                    else when (model.navMove) {
                                        NavMove.Forward -> (slideInHorizontally(tween(240, easing = KantiEase)) { it / 8 } + fadeIn(tween(200, easing = KantiEase))) togetherWith fadeOut(tween(90))
                                        NavMove.Back -> fadeIn(tween(200, delayMillis = 40)) togetherWith (slideOutHorizontally(tween(200, easing = KantiEase)) { it / 8 } + fadeOut(tween(150)))
                                        NavMove.Tab -> fadeIn(tween(170, delayMillis = 50)) togetherWith fadeOut(tween(90))
                                    }.using(SizeTransform(clip = false))
                                },
                                label = "Screen transition",
                            ) { current ->
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
    if (create != null) KantiSheet(onDismiss = { create = null }) {
        SheetTitle(if (model.notesAccount) t(R.string.make_room_for_an_idea) else t(R.string.add_to_your_day), { create = null })
        Text(t(R.string.create_sheet_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 12.dp))
        Group(color = LocalCompanionSemantics.current.sunken.copy(alpha = 0.55f)) {
            if (model.notesAccount) { CreateRow(Icons.Outlined.EditNote, t(R.string.note), t(R.string.write_draw_or_collect_your_thoughts)) { begin("note") }; FineDivider() }
            CreateRow(Icons.Outlined.CheckCircleOutline, t(R.string.task), t(R.string.homework_or_something_to_get_done)) { begin("task") }
            FineDivider()
            CreateRow(Icons.Outlined.Event, t(R.string.event), t(R.string.put_a_commitment_on_your_calendar)) { begin("event") }
        }
    }
    if (noteName) NameDialog(t(R.string.new_note), t(R.string.note_title), t(R.string.create), onDismiss = { noteName = false }) { title -> noteName = false; model.createNote(title) }
    if (taskForm) TaskForm(model, onDismiss = { taskForm = false })
    if (eventForm) EventForm(model, onDismiss = { eventForm = false })
    if (model.revealQueue.isNotEmpty()) GradeRevealSheet(model)
    if (model.offerUpload) {
        AlertDialog(
            onDismissRequest = model::declineUpload,
            shape = MaterialTheme.shapes.extraLarge,
            title = { Text(t(R.string.upload_tasks_and_calendar_from_this_device), style = MaterialTheme.typography.headlineSmall) },
            text = { Text(t(R.string.they_stay_on_this_device_until_you_upload_them_s), color = MaterialTheme.colorScheme.onSurfaceVariant) },
            confirmButton = { TextButton(onClick = model::acceptUpload) { Text(t(R.string.upload)) } },
            dismissButton = { TextButton(onClick = model::declineUpload) { Text(t(R.string.not_now)) } },
        )
    }
}

@Composable
private fun CreateRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, body: String, onClick: () -> Unit) {
    SettingRow(icon, title, body, tone = StateTone.Accent, chevron = false, onClick = onClick)
}

fun todaySubtitle(today: LocalDate): String =
    t(R.string.date_and_week, formatSchoolDate(today, "EEEE, d MMMM"), today.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR))

@Composable
fun KantiTopBar(
    title: String,
    subtitle: String,
    root: Boolean,
    compact: Boolean,
    onBack: () -> Unit,
    onSearch: () -> Unit,
    onSettings: () -> Unit,
    searchLabel: String,
) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .heightIn(min = if (root && !compact) 72.dp else 60.dp)
            .padding(start = if (root) Space.page else 4.dp, end = 4.dp, top = if (root && !compact) 6.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!root) ActionIcon(Icons.AutoMirrored.Outlined.ArrowBack, t(R.string.back), onClick = onBack)
        Column(Modifier.weight(1f).padding(start = if (root) 0.dp else 4.dp)) {
            Text(title, style = if (root && !compact) MaterialTheme.typography.headlineLarge else MaterialTheme.typography.titleLarge,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
            if (subtitle.isNotBlank() && !compact) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (root) {
            ActionIcon(Icons.Outlined.Search, searchLabel, onClick = onSearch)
            ActionIcon(Icons.Outlined.Settings, t(R.string.settings), onClick = onSettings)
        }
    }
}

@Composable
fun KantiNavBar(items: List<String>, selectedId: String?, onSelect: (String) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().background(scheme.surface)) {
        HorizontalDivider(color = LocalCompanionSemantics.current.hairline)
        Row(Modifier.fillMaxWidth().navigationBarsPadding().heightIn(min = 66.dp).selectableGroup(), verticalAlignment = Alignment.CenterVertically) {
            items.forEach { id ->
                val selected = selectedId == id
                Column(
                    Modifier.weight(1f).heightIn(min = 66.dp).selectable(selected, onClick = { onSelect(id) }, role = Role.Tab).padding(vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
                ) {
                    Box(Modifier.size(width = 56.dp, height = 30.dp).background(if (selected) scheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent, CircleShape), contentAlignment = Alignment.Center) {
                        Icon(navBarIcon(id, selected), null, Modifier.size(22.dp), tint = if (selected) scheme.primary else scheme.onSurfaceVariant)
                    }
                    Text(navBarLabel(id), style = MaterialTheme.typography.labelMedium, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (selected) scheme.onSurface else scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp, start = 2.dp, end = 2.dp))
                }
            }
        }
    }
}

@Composable
fun KantiRail(items: List<String>, selectedId: String?, compact: Boolean, onSelect: (String) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxHeight().width(if (compact) 72.dp else 92.dp).background(scheme.surface).verticalScroll(rememberScrollState()).padding(vertical = 12.dp).selectableGroup(),
        horizontalAlignment = Alignment.CenterHorizontally) {
        items.forEach { id ->
            val selected = selectedId == id
            Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected, onClick = { onSelect(id) }, role = Role.Tab).padding(vertical = if (compact) 4.dp else 8.dp)
                .semantics { if (compact) contentDescription = navBarLabel(id) }, horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(width = 56.dp, height = 32.dp).background(if (selected) scheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(navBarIcon(id, selected), null, Modifier.size(22.dp), tint = if (selected) scheme.primary else scheme.onSurfaceVariant)
                }
                if (!compact) Text(navBarLabel(id), style = MaterialTheme.typography.labelMedium, color = if (selected) scheme.onSurface else scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

fun syncDescription(status: SyncStatus): String = when (status) {
    SyncStatus.IDLE -> t(R.string.up_to_date)
    SyncStatus.SYNCING -> t(R.string.syncing)
    SyncStatus.OFFLINE -> t(R.string.offline_changes_stay_on_this_device)
    SyncStatus.ERROR -> t(R.string.sync_needs_attention)
    SyncStatus.PAUSED -> t(R.string.sync_paused)
    SyncStatus.SIGNED_OUT -> t(R.string.stored_on_this_device)
    SyncStatus.UNAVAILABLE -> t(R.string.sync_unavailable)
}
