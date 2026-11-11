package ch.fasrv.fanotes.companion

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import ch.fasrv.fanotes.commute.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The three Pendelstrecken pages: route list, editor and route detail. */
@Composable
fun CommuteScreen(model: CompanionModel, page: Page) {
    when (page) {
        Page.CommuteEdit -> CommuteEditPage(model)
        Page.CommuteDetail -> CommuteDetailPage(model)
        else -> CommuteListPage(model)
    }
}

/**
 * Refreshes the boards every 60 s, but only while the screen is on top (resumed) and a trip leaves within
 * 30 minutes. Otherwise no timer exists at all.
 */
@Composable
fun CommuteRefreshTimer(model: CompanionModel, board: RouteBoard?, nowMs: Long) {
    val owner = LocalLifecycleOwner.current
    val due = departsWithin(board, nowMs)
    LaunchedEffect(due, owner) {
        if (!due) return@LaunchedEffect
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                delay(COMMUTE_TICK_MS)
                model.refreshCommute(force = true)
            }
        }
    }
}

const val COMMUTE_TICK_MS = 60_000L

@Composable
private fun CommuteListPage(model: CompanionModel) {
    // Opening the list is a deliberate use of the feature: ask the server even for an install that never linked a school.
    LaunchedEffect(Unit) { model.refreshCommute(force = true, withRoutes = true) }
    CommuteListContent(
        ui = model.commute,
        onOpen = { model.editCommuteRoute(it.id) },
        onMove = { route, delta -> model.moveCommuteRoute(route.id, delta) },
        onAdd = { model.editCommuteRoute(null) },
        onThreshold = model::setCommuteThreshold,
        onNotifications = { model.navigate(Page.Notifications) },
    )
}

@Composable
private fun CommuteEditPage(model: CompanionModel) {
    val draft = model.commuteDraft
    if (draft == null) {
        // Nothing to edit (the draft was saved or dropped): leave, except inside the onboarding dialog, which closes itself.
        if (!model.onboardingCommute) LaunchedEffect(Unit) { model.back() }
        return
    }
    CommuteEditor(
        route = draft, isNew = model.commuteDraftNew, defaultThreshold = model.commute.settings.delayThreshold, saving = model.commuteSaving,
        searchStops = { model.graph.commute.searchStops(it) },
        onChange = { model.commuteDraft = it },
        onSave = model::saveCommuteDraft,
        onDelete = if (model.commuteDraftNew) null else ({ model.deleteCommuteRoute(draft.id) }),
    )
}

@Composable
private fun CommuteDetailPage(model: CompanionModel) {
    val ui = model.commute
    val route = ui.routes.firstOrNull { it.id == model.commuteDetailId }
    if (route == null) {
        // Unknown or deleted route (an old notice): the list is the place to look.
        LaunchedEffect(ui.loaded) { if (ui.loaded) model.back() }
        return
    }
    val now = rememberNow().toEpochMilli()
    val board = ui.board(route.id)
    var extra by remember(route.id) { mutableStateOf(emptyList<Trip>()) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun more(earlier: Boolean) {
        val shown = (board?.trips.orEmpty() + extra)
        val anchor = if (earlier) shown.minByOrNull { isoMillis(it.plannedDeparture) ?: Long.MAX_VALUE }?.plannedArrival
            else shown.maxByOrNull { isoMillis(it.plannedDeparture) ?: 0L }?.plannedDeparture
        val at = anchor?.takeIf { it.isNotBlank() } ?: board?.target?.at ?: return
        loading = true; failed = false
        scope.launch {
            try {
                // Earlier: trips that arrive before the earliest shown one does. Later: trips leaving after the last.
                val found = model.graph.commute.trips(route.id, at, arrive = earlier)
                extra = (extra + found).distinctBy { it.id }
            } catch (error: CancellationException) { throw error } catch (_: Exception) { failed = true }
            loading = false
        }
    }
    CommuteRefreshTimer(model, board, now)
    RefreshableScreenList(model.commute.refreshing, { model.refreshCommute(force = true, withRoutes = true) }) {
        commuteDetailItems(route, board, extra, ui.provider, now, loading, failed, { more(true) }, { more(false) }, { model.editCommuteRoute(route.id) })
    }
}
