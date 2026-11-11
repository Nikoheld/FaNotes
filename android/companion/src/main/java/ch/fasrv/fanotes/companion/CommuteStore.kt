package ch.fasrv.fanotes.companion

import android.content.Context
import ch.fasrv.fanotes.commute.CommuteSettings
import ch.fasrv.fanotes.commute.Provider
import ch.fasrv.fanotes.commute.Route
import ch.fasrv.fanotes.commute.RouteBoard
import ch.fasrv.fanotes.commute.commuteBody
import ch.fasrv.fanotes.commute.connectionsPath
import ch.fasrv.fanotes.commute.hiddenLabelsChanged
import ch.fasrv.fanotes.commute.parseBoardAnswer
import ch.fasrv.fanotes.commute.parseCommuteState
import ch.fasrv.fanotes.commute.relevantBoard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/** What the screens and the widget show of Pendelstrecken. */
data class CommuteUi(
    /** The routes are known (from the cache or the server). Until then Heute shows nothing rather than an empty-state card. */
    val loaded: Boolean = false,
    val routes: List<Route> = emptyList(),
    val settings: CommuteSettings = CommuteSettings(),
    val provider: Provider = Provider(),
    val boards: List<RouteBoard> = emptyList(),
    /** Wall-clock millis of the last successful board answer; 0 when there is none. */
    val boardAt: Long = 0L,
    val refreshing: Boolean = false,
    /** The last board request failed; the boards shown are older. */
    val failed: Boolean = false,
) {
    fun board(routeId: String): RouteBoard? = boards.firstOrNull { it.routeId == routeId }
    fun relevant(nowMs: Long): RouteBoard? = relevantBoard(routes, boards, nowMs)
}

/**
 * Routes, settings and boards of Pendelstrecken. The server owns them; the phone keeps the last answers
 * in two files so Heute and the widget show something before (or without) a network. Every request runs
 * on the IO dispatcher and one at a time. [auth] names the Kanti+ identity (the shown connection's).
 */
class CommuteStore(
    private val dir: File,
    private val client: SchulnetzClient,
    private val auth: suspend () -> SchoolAuth,
    /** The identity the saved answers belong to ([writeAccount] stores it). */
    private val readAccount: () -> String,
    private val writeAccount: (String?) -> Unit,
    private val onBoard: () -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
) {
    val state = MutableStateFlow(CommuteUi())
    private val lock = Mutex()
    private val stateFile get() = File(dir, STATE_FILE)
    private val boardFile get() = File(dir, BOARD_FILE)

    /** Reads the last answers from disk. Safe to call more than once; never touches the network. */
    suspend fun loadCache() = withContext(Dispatchers.IO) {
        if (state.value.loaded) return@withContext
        val cached = readCache(dir)
        if (cached.loaded) state.update { if (it.loaded) it else cached }
    }

    /**
     * Brings the boards up to date. Routes are fetched first when they are not known yet or [withRoutes] asks.
     * Skipped when the boards are younger than [maxAgeSeconds] and [force] is off. Returns false when the
     * request failed (the older answers stay).
     */
    suspend fun refresh(force: Boolean = false, withRoutes: Boolean = false, maxAgeSeconds: Int = 30): Boolean = lock.withLock {
        val now = clock()
        val current = state.value
        if (!force && !withRoutes && current.loaded && current.boardAt > 0 && now - current.boardAt < maxAgeSeconds * 1000L) return true
        state.update { it.copy(refreshing = true) }
        try {
            val session = auth()
            withContext(Dispatchers.IO) {
                if (!state.value.loaded || withRoutes) fetchRoutes(session)
                val routes = state.value.routes
                if (routes.isEmpty()) {
                    boardFile.delete()
                    state.update { it.copy(boards = emptyList(), boardAt = 0L, failed = false) }
                } else {
                    val body = client.commuteBoardRaw(session)
                    val answer = parseBoardAnswer(body) ?: throw java.io.IOException("unreadable board")
                    writeAtomic(boardFile, body)
                    state.update { it.copy(boards = answer.boards, provider = answer.provider.takeIf { p -> p.name.isNotBlank() } ?: it.provider, boardAt = clock(), failed = false) }
                }
            }
            onBoard()
            true
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            state.update { it.copy(failed = true) }
            false
        } finally {
            state.update { it.copy(refreshing = false) }
        }
    }

    /** Saves the whole list (the server cleans it) and shows the new boards. [delayThreshold] null keeps the saved one. */
    suspend fun save(routes: List<Route>, delayThreshold: Int? = null): Result<Unit> = lock.withLock {
        try {
            val session = auth()
            withContext(Dispatchers.IO) {
                val settings = state.value.settings.let { if (delayThreshold == null) it else it.copy(delayThreshold = delayThreshold) }
                store(session, client.saveCommuteRaw(session, commuteBody(routes, settings)))
                boardFile.delete()
                state.update { it.copy(boards = emptyList(), boardAt = 0L) }
            }
            Result.success(Unit)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            Result.failure(error)
        }
    }.also { if (it.isSuccess) refresh(force = true) }

    /** Keeps `settings.hiddenLabels` current. Does nothing without routes or when nothing changed. */
    suspend fun syncHiddenLabels(labels: List<String>): Boolean {
        val current = state.value
        if (!current.loaded || current.routes.isEmpty() || !hiddenLabelsChanged(current.settings.hiddenLabels, labels)) return false
        val result = lock.withLock {
            val now = state.value
            if (now.routes.isEmpty() || !hiddenLabelsChanged(now.settings.hiddenLabels, labels)) return@withLock null
            runCatching {
                val session = auth()
                withContext(Dispatchers.IO) {
                    store(session, client.saveCommuteRaw(session, commuteBody(now.routes, now.settings.copy(hiddenLabels = labels))))
                }
            }.onFailure { if (it is CancellationException) throw it }
        }
        if (result?.isSuccess == true) refresh(force = true)
        return result?.isSuccess == true
    }

    suspend fun searchStops(query: String): List<ch.fasrv.fanotes.commute.Stop> {
        val session = auth()
        return withContext(Dispatchers.IO) { client.commuteStops(session, query) }
    }

    suspend fun trips(routeId: String, at: String, arrive: Boolean): List<ch.fasrv.fanotes.commute.Trip> {
        val session = auth()
        return withContext(Dispatchers.IO) { client.commuteTrips(session, routeId, at, arrive) }
    }

    /**
     * The connection detail of one trip: every stop, real times, platforms and the vehicle position. Runs on the IO
     * dispatcher itself, so any caller (the screen's main-thread coroutine included) may call it. Throws on a failed request.
     */
    suspend fun tripDetail(routeId: String, tripId: String, plannedDeparture: String): ch.fasrv.fanotes.commute.TripDetail {
        val session = auth()
        return withContext(Dispatchers.IO) {
            client.commuteTripDetail(session, routeId, tripId, plannedDeparture) ?: throw java.io.IOException("unreadable trip detail")
        }
    }

    /** The connection picker's trips from [atIso] for the draft's ends and via stops. Nothing is stored. */
    suspend fun connections(route: Route, atIso: String): List<ch.fasrv.fanotes.commute.Trip> {
        val session = auth()
        val path = connectionsPath(route.from, route.to, route.vias, atIso)
        return withContext(Dispatchers.IO) { client.commuteConnections(session, path) }
    }

    /** Forgets everything on this phone (the server keeps its copy). */
    fun clearLocal() {
        stateFile.delete(); boardFile.delete()
        writeAccount(null)
        state.value = CommuteUi()
    }

    private fun fetchRoutes(session: SchoolAuth) {
        val body = client.commuteRaw(session)
        val parsed = parseCommuteState(body) ?: throw java.io.IOException("unreadable routes")
        val previous = readAccount()
        val local = readCache(dir)
        // A new identity (the guest became a FaNotes account) starts with nothing on the server: send the routes back up.
        if (parsed.routes.isEmpty() && local.routes.isNotEmpty() && previous.isNotBlank() && previous != session.accountId) {
            store(session, client.saveCommuteRaw(session, commuteBody(local.routes, local.settings)))
        } else store(session, body)
    }

    private fun store(session: SchoolAuth, body: String) {
        val parsed = parseCommuteState(body) ?: throw java.io.IOException("unreadable routes")
        writeAtomic(stateFile, body)
        writeAccount(session.accountId)
        state.update { it.copy(loaded = true, routes = parsed.routes, settings = parsed.settings, provider = parsed.provider.takeIf { p -> p.name.isNotBlank() } ?: it.provider) }
    }

    companion object {
        const val STATE_FILE = "commute-state.json"
        const val BOARD_FILE = "commute-board.json"

        /** The last answers on disk (blocking file I/O; call off the main thread). Boards are kept only when their routes still exist. */
        fun readCache(dir: File): CommuteUi {
            val routesBody = runCatching { File(dir, STATE_FILE).takeIf { it.isFile }?.readText() }.getOrNull() ?: return CommuteUi()
            val parsed = parseCommuteState(routesBody) ?: return CommuteUi()
            val boardFile = File(dir, BOARD_FILE)
            val answer = runCatching { boardFile.takeIf { it.isFile }?.readText()?.let(::parseBoardAnswer) }.getOrNull()
            val ids = parsed.routes.map { it.id }.toSet()
            return CommuteUi(
                loaded = true, routes = parsed.routes, settings = parsed.settings, provider = parsed.provider,
                boards = answer?.boards.orEmpty().filter { it.routeId in ids },
                boardAt = if (answer != null) boardFile.lastModified() else 0L,
            )
        }

        private fun writeAtomic(target: File, text: String) {
            target.parentFile?.mkdirs()
            val temp = File(target.parentFile, target.name + ".tmp")
            temp.writeText(text)
            if (!temp.renameTo(target)) { target.writeText(text); temp.delete() }
        }
    }
}
