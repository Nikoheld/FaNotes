package ch.fasrv.fanotes

import android.content.Context
import androidx.work.*
import ch.fasrv.fanotes.ink.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.util.concurrent.TimeUnit

/** Private model state is deliberately outside the vault and its sync/backup paths. */
data class HandwritingLearningState(
    val model: PersonalHandwritingModel = PersonalHandwritingModel(),
    val busy: Boolean = false, val enabled: Boolean = true, val error: String? = null,
)
class HandwritingLearning(private val context: Context, private val graph: AppGraph) {
    val state = MutableStateFlow(HandwritingLearningState())
    private val mutex = Mutex()
    private val preferences = context.getSharedPreferences("handwriting-learning", Context.MODE_PRIVATE)
    private val manager get() = WorkManager.getInstance(context)
    private fun enabled(id: String) = preferences.getBoolean("enabled-$id", true)
    private val stores = java.util.concurrent.ConcurrentHashMap<String, WritingLearningStore>()
    private fun store(id: String) = stores.getOrPut(id) { WritingLearningStore(File(context.filesDir, "personal-handwriting-v2/$id")) }
    fun attach() {
        val id = graph.vaultId
        state.value = HandwritingLearningState(enabled = enabled(id))
        graph.scope.launch {
            val model = mutex.withLock { withContext(Dispatchers.IO) { store(id).load() } }
            if (id == graph.vaultId) state.value = state.value.copy(model = model)
        }
        val constraints = Constraints.Builder().setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build()
        manager.enqueueUniquePeriodicWork("handwriting-learning-periodic", ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<HandwritingLearningWorker>(6, TimeUnit.HOURS).setConstraints(constraints).build())
        request()
    }
    fun changed(path: String) = changed(listOf(path))
    fun changed(paths: List<String>) {
        val id = graph.vaultId
        synchronized(preferences) {
            val pending = preferences.getStringSet("dirty-$id", emptySet()).orEmpty().toMutableSet()
            for (path in paths) {
                val stem = path.substringBeforeLast('.', path)
                pending.removeAll { it.substringBefore('\t').substringBeforeLast('.') == stem }
                for (extension in listOf(".famd", ".md", ".markdown")) pending += "$stem$extension\t${java.util.UUID.randomUUID()}"
            }
            preferences.edit().putStringSet("dirty-$id", pending).apply()
        }
        request()
    }
    fun request() {
        if (!enabled(graph.vaultId)) return
        val work = OneTimeWorkRequestBuilder<HandwritingLearningWorker>()
            .setInitialDelay(25, TimeUnit.SECONDS)
            .setConstraints(Constraints.Builder().setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        manager.enqueueUniqueWork("handwriting-learning-changed", ExistingWorkPolicy.REPLACE, work)
    }
    fun setEnabled(value: Boolean) {
        preferences.edit().putBoolean("enabled-${graph.vaultId}", value).apply()
        state.value = state.value.copy(enabled = value)
        if (value) request() else manager.cancelUniqueWork("handwriting-learning-changed")
    }
    suspend fun run(): Boolean = mutex.withLock {
        val id = graph.vaultId; val vault = graph.vault; val job = currentCoroutineContext().job
        if (!enabled(id)) return@withLock true
        val dirty = synchronized(preferences) { preferences.getStringSet("dirty-$id", emptySet()).orEmpty().toSet() }
        state.value = state.value.copy(busy = true, error = null)
        try {
            val templates = withContext(Dispatchers.IO) { glyphsForSynthesis(decodeGlyphLibrary(graph.readGlyphLibrary())) }
            val learningStore = store(id)
            val model = withContext(Dispatchers.IO) {
                learningStore.scan(vault, templates,
                    cancelled = { !job.isActive || id != graph.vaultId || !enabled(id) },
                    onCheckpoint = { model -> if (id == graph.vaultId) state.value = state.value.copy(model = model) },
                    forcePages = dirty.map { it.substringBefore('\t') }.toSet())
            }
            if (id == graph.vaultId) state.value = state.value.copy(model = model)
            if (job.isActive && id == graph.vaultId && enabled(id)) synchronized(preferences) {
                val failedStems = learningStore.failedPages.map { it.substringBeforeLast('.') }.toSet()
                val consumed = dirty.filter { it.substringBefore('\t').substringBeforeLast('.') !in failedStems }.toSet()
                val remaining = preferences.getStringSet("dirty-$id", emptySet()).orEmpty() - consumed
                preferences.edit().putStringSet("dirty-$id", remaining).apply()
            }
            if (learningStore.failedPages.isNotEmpty() && id == graph.vaultId) state.value = state.value.copy(error = "Some handwritten pages could not be processed. Learning will retry.")
            learningStore.failedPages.isEmpty()
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            if (id == graph.vaultId) state.value = state.value.copy(error = "Some handwritten pages could not be processed. Learning will retry.")
            false
        } finally { if (id == graph.vaultId) state.value = state.value.copy(busy = false) }
    }
}
class HandwritingLearningWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as FaNotesApplication).graph
        return if (graph.handwritingLearning.run()) Result.success() else Result.retry()
    }
}
