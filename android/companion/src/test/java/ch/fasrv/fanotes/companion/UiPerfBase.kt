package ch.fasrv.fanotes.companion

import android.app.Application
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.down
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.moveBy
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.up
import androidx.test.core.app.ApplicationProvider
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.schulnetz.DeskPrefs
import ch.fasrv.fanotes.schulnetz.PlannedAbsence
import ch.fasrv.fanotes.schulnetz.hideSeries
import ch.fasrv.fanotes.schulnetz.preferredEventTitle
import ch.fasrv.fanotes.schulnetz.toNormalizedJson
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.time.LocalDate

/**
 * Shared plumbing of the JVM UI tests: builds the app over the synthetic school year (see [PerfFixture]), renders the
 * real UI (theme + CompanionRoot) with Compose test, drives it with taps and swipes and times every frame on the main thread.
 *
 * Caveat: this is Robolectric on a desktop JVM, not a phone. Absolute milliseconds are not device numbers; compare
 * actions with each other and runs with earlier runs on the same machine.
 */
abstract class UiPerfBase {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    // ---------------------------------------------------------------------------------------------
    // Measurement plumbing
    // ---------------------------------------------------------------------------------------------

    class Result(val name: String) {
        val frames = mutableListOf<Double>()
        /** Milliseconds from a tap's injection to the first frame in which its target is visible. */
        val taps = mutableListOf<Double>()
        var applies = 0
        var changedObjects = 0
        var error: String? = null
        var note = ""
        val self = hashMapOf<String, Int>()
        val inclusive = hashMapOf<String, Int>()
        val leaf = hashMapOf<String, Int>()
        val tagged = hashMapOf<String, Int>()
        var samples = 0
        val total get() = frames.sum()
        val maxFrame get() = frames.maxOrNull() ?: 0.0
    }

    /** Samples the main thread's stack about every millisecond while [active]. Frames are aggregated per [Result]. */
    private class Sampler(private val target: Thread) {
        @Volatile var active = false
        @Volatile var result: Result? = null
        @Volatile private var running = true
        private val thread = Thread {
            while (running) {
                val current = result
                if (active && current != null) {
                    val stack = target.stackTrace
                    synchronized(current) { record(current, stack) }
                }
                try { Thread.sleep(1) } catch (_: InterruptedException) { return@Thread }
            }
        }.also { it.isDaemon = true; it.name = "ui-perf-sampler" }

        fun start() = thread.start()
        fun stop() { running = false; thread.interrupt() }

        private val digits = Regex("\\$\\d+")
        private fun key(e: StackTraceElement) = e.className.replace(digits, "").replace("\$lambda", "") + "." + e.methodName

        private fun record(r: Result, stack: Array<StackTraceElement>) {
            if (stack.isEmpty()) return
            r.samples++
            r.leaf.merge(key(stack[0]), 1, Int::plus)
            val app = stack.filter { it.className.startsWith("ch.fasrv.") }
            if (app.isNotEmpty()) {
                r.self.merge(key(app.first()), 1, Int::plus)
                app.map { key(it) }.toSet().forEach { r.inclusive.merge(it, 1, Int::plus) }
            }
            // Share of samples with a known derived-work function (or the language helper) anywhere on the stack.
            val tags = hashSetOf<String>()
            for (e in app) {
                if (e.methodName in TAG_METHODS) tags += e.methodName
                if (e.className.substringAfterLast('.').startsWith("AppLanguage")) tags += "AppLanguage"
            }
            tags.forEach { r.tagged.merge(it, 1, Int::plus) }
        }
    }

    protected lateinit var model: CompanionModel
    private lateinit var sampler: Sampler
    /** action name -> round -> result. Round -1 is the discarded warm-up pass. */
    protected val results = linkedMapOf<String, MutableMap<Int, Result>>()
    private var current: Result? = null
    protected var round = 0
    protected var profiling = false
    protected lateinit var env: Env

    class Env(val today: LocalDate, val workDay: LocalDate, val todayLabel: String, val plannerLabel: String, val schoolLabel: String, val examTitle: String)

    protected fun idleMain() = shadowOf(Looper.getMainLooper()).idle()

    private fun nanosToMs(n: Long) = n / 1_000_000.0

    /** Times [block] on the main thread; counted into the current result as one "frame". */
    protected fun timedFrame(block: () -> Unit) {
        val result = current ?: return
        sampler.result = result
        val start = System.nanoTime()
        sampler.active = profiling
        try { block() } finally { sampler.active = false }
        result.frames += nanosToMs(System.nanoTime() - start)
    }

    private fun stepFrame() = timedFrame { rule.mainClock.advanceTimeByFrame(); idleMain() }

    /** Lets background work (IO, Default) finish between frames without counting it. */
    private fun settleBackground() = Thread.sleep(3)

    protected fun frames(count: Int) { repeat(count) { stepFrame(); settleBackground() } }

    protected fun action(name: String, body: () -> Unit) {
        val result = results.getOrPut(name) { linkedMapOf() }.getOrPut(round) { Result(name) }
        current = result
        val applyHandle = Snapshot.registerApplyObserver { changed, _ -> result.applies++; result.changedObjects += changed.size }
        try { body() } catch (error: Throwable) {
            result.error = (result.error.orEmpty() + " " + error::class.simpleName + ": " + (error.message ?: "").lines().first().take(160)).trim()
        } finally {
            applyHandle.dispose()
            result.note = "${model.route.destination}/${model.route.page} week=${model.planWeek} compact=${model.desk.planCompact} weekend=${model.desk.showWeekend} day=${model.day}"
            current = null
        }
    }

    protected fun currentActionName() = current?.name ?: "(between actions)"

    private var lastClickFrame = 0

    protected fun click(match: SemanticsMatcher) {
        // The node may be off screen (list scrolled by an earlier action): scroll like a finger until a tap can be injected.
        var attempt = 0
        while (true) {
            try { lastClickFrame = current?.frames?.size ?: 0; timedFrame { rule.onAllNodes(match).onFirst().performClick(); idleMain() }; return }
            catch (e: AssertionError) {
                if (e.message?.contains("inject") != true || attempt >= 5) throw e
                swipe(attempt % 2 == 1, steps = 8); attempt++
            }
        }
    }

    /**
     * Taps [match], then steps frames until [shown] is on screen; the time from the injection to that frame (all frames
     * in between, background waits excluded) is recorded as the tap-to-response time. Then pads to [total] frames.
     */
    protected fun tapUntilShown(match: SemanticsMatcher, shown: SemanticsMatcher, total: Int = 20) {
        click(match)
        val result = current ?: return
        val visible = { rule.onAllNodes(shown).fetchSemanticsNodes().isNotEmpty() }
        var steps = 1
        while (!visible() && steps < total) { stepFrame(); settleBackground(); steps++ }
        if (visible()) result.taps += result.frames.drop(lastClickFrame).sum()
        else result.error = (result.error.orEmpty() + " tap target not shown").trim()
        if (steps < total) frames(total - steps)
    }

    /** Bottom bar items only: Role.Tab with the label (planner filter chips are selectable with the same text). */
    protected fun clickTab(label: String) = click(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab) and hasText(label))

    /** Swipes the list up (counted in the action, like a real finger) until the item is composed, then taps it. */
    protected fun scrollAndClick(match: SemanticsMatcher) {
        var tries = 0
        while (tries++ < 4 && rule.onAllNodes(match).fetchSemanticsNodes().isEmpty()) swipe(true, steps = 6)
        click(match)
    }

    protected fun expect(ok: Boolean, what: String) { if (!ok) current?.let { it.error = (it.error.orEmpty() + " expected: $what").trim() } }

    protected fun swipe(up: Boolean, steps: Int = 10) {
        val width = 411f * 2.625f
        val height = 891f * 2.625f
        val startY = height * (if (up) 0.75f else 0.35f)
        timedFrame { rule.onRoot().performTouchInput { down(Offset(width / 2, startY)) }; idleMain() }
        repeat(steps) {
            timedFrame { rule.onRoot().performTouchInput { moveBy(Offset(0f, if (up) -70f else 70f)) }; rule.mainClock.advanceTimeByFrame(); idleMain() }
        }
        timedFrame { rule.onRoot().performTouchInput { up() }; idleMain() }
        frames(12)
    }

    // ---------------------------------------------------------------------------------------------
    // App set-up
    // ---------------------------------------------------------------------------------------------

    /**
     * Builds the graph and model over the synthetic year (as a real start does: cached snapshot file and link flag exist
     * first), waits until the model has loaded, and renders Heute.
     */
    protected fun launchApp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        AppLanguage.install(app)
        val today = LocalDate.now()
        val snapshot = PerfFixture.buildSnapshot(today)
        slotFile(app, ch.fasrv.fanotes.schulnetz.PRIMARY_SLOT, "schulnetz-snapshot.json").writeText(snapshot.toNormalizedJson())
        app.getSharedPreferences("fanotes-companion", android.content.Context.MODE_PRIVATE).edit().putBoolean("school-linked", true).commit()
        File(app.filesDir, "mensa.json").writeText(PerfFixture.mensaJson(today))
        // A saved commute route with its last board, so Heute carries the commute card. The first trip leaves in 45 minutes:
        // outside the 30-minute window, so the screen runs no refresh timer, and nothing here may reach the commute server.
        val (commuteState, commuteBoard) = CommuteSamples.fixtureFiles(java.time.ZonedDateTime.now(), 45)
        File(app.filesDir, "commute").also { dir ->
            dir.mkdirs()
            File(dir, CommuteStore.STATE_FILE).writeText(commuteState)
            File(dir, CommuteStore.BOARD_FILE).writeText(commuteBoard)
        }
        val graph = CompanionGraph(app)
        graph.commuteRequestsAllowed = false
        val waitStart = System.currentTimeMillis()
        while (!graph.snapshotReady.value && System.currentTimeMillis() - waitStart < 20_000) { idleMain(); Thread.sleep(10) }
        graph.saveDeskPrefs(DeskPrefs(theme = "system", showMensa = true))
        val firstTask = today.plusDays(1)
        (0 until 30).forEach { index ->
            val subject = PerfFixture.courses.values.toList()[index % 12].title
            graph.saveHomeworkTask(HomeworkTask(id = "perf-task-$index", title = "Aufgabe $index", notes = "Notizen $index", subject = subject,
                dueDate = firstTask.plusDays(index % 14 - 4L).toString(), done = index % 5 == 0, createdAt = "2026-09-01T08:00:00Z"))
        }
        val slots = PerfFixture.slots
        graph.savePlannedAbsences((0 until 4).map { PlannedAbsence("perf-plan-$it", today.plusDays(3L + it * 9).toString(), slots[it].first, slots[it].second, "Mathematik") })
        graph.saveHiddenLessons(hideSeries(snapshot.events.first { it.courseName == "Mu" }, emptyList()))
        check(graph.snapshot.value.events.size >= 750) { "snapshot not loaded: ${graph.snapshot.value.events.size} events" }

        // An existing user: onboarding done, local access on.
        graph.markOnboardingSeen(); graph.setLocalAccess(true)
        model = CompanionModel(graph)
        sampler = Sampler(Thread.currentThread()).also { it.start() }
        val readyStart = System.currentTimeMillis()
        while ((!model.schoolReady || model.loading || model.tasks.isEmpty()) && System.currentTimeMillis() - readyStart < 20_000) { idleMain(); Thread.sleep(10) }
        model.mensa = graph.mensaStore.cached()
        val commuteBy = System.currentTimeMillis() + 10_000
        while (!model.commute.loaded && System.currentTimeMillis() < commuteBy) { idleMain(); Thread.sleep(10) }
        check(model.commute.relevant(System.currentTimeMillis()) != null) { "commute fixture not loaded" }

        rule.mainClock.autoAdvance = false
        round = 0
        action("A first render Heute (cold)") {
            timedFrame {
                rule.setContent {
                    CompanionTheme(
                        themeId = model.desk.theme.ifBlank { model.theme }, systemDark = isSystemInDarkTheme(), accent = model.desk.accent,
                        amoled = model.desk.amoled, reducedMotion = false, online = true,
                    ) {
                        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { CompanionRoot(model) }
                    }
                }
            }
            frames(25)
        }
        runCatching { rule.onAllNodes(isSelectable() and hasText(t(R.string.planner))).assertCountEquals(1) }.onFailure {
            println("SEMANTICS: " + rule.onRoot().printToString(60)); throw it
        }
        assertTrue("Heute must show lessons or tasks", model.snapshot.events.isNotEmpty())
        val upcomingExam = model.snapshot.exams.sortedBy { it.start }.first { it.start.take(10) >= today.toString() }
        env = Env(
            today, generateSequence(today) { it.plusDays(1) }.first { it.dayOfWeek.value < 6 },
            t(R.string.today), t(R.string.planner), t(R.string.school), preferredEventTitle(upcomingExam),
        )
    }

    protected fun stopSampler() = sampler.stop()

    // ---------------------------------------------------------------------------------------------
    // Interactions shared by the harness and the guard
    // ---------------------------------------------------------------------------------------------

    protected fun resetToToday() {
        model.selectNav("today"); model.day = env.workDay; model.planWeek = false
        repeat(25) { rule.mainClock.advanceTimeByFrame(); idleMain(); settleBackground() }
    }

    protected fun scrollHeute(n: (String) -> String) =
        action(n("b scroll Heute (2 up, 2 down)")) { swipe(true); swipe(true); swipe(false); swipe(false) }

    protected fun tapExamOnHeute(n: (String) -> String) = action(n("d tap exam row on Heute + close sheet")) {
        // The commute card sits above the rows this action taps, so they start below the fold: swipe like a finger until the
        // exam row (its title and the Exam tag) is on screen well clear of the bottom bar, then tap it.
        val exam = hasClickAction() and hasText(env.examTitle, substring = true) and hasText(AgendaKind.Exam.uiLabel())
        var scrolls = 0
        while (scrolls++ < 8 && rule.onAllNodes(exam).fetchSemanticsNodes().firstOrNull()?.boundsInRoot?.let { it.top > 0f && it.bottom < 1950f } != true) swipe(true, steps = 4)
        // Let the fling die out: a tap during a fling only stops the list.
        if (scrolls > 1) frames(40)
        tapUntilShown(exam, hasContentDescription(t(R.string.close)))
        click(hasContentDescription(t(R.string.close))); frames(20)
    }

    /** Heute -> Planer -> Schule -> Heute, [times] round trips. */
    protected fun tabRoundTrips(n: (String) -> String, times: Int = 3) = repeat(times) {
        action(n("c tab Heute -> Planer")) { clickTab(env.plannerLabel); frames(22); expect(model.route.destination == Destination.Planner, "Planner") }
        action(n("c tab Planer -> Schule")) { clickTab(env.schoolLabel); frames(22); expect(model.route.destination == Destination.School, "School") }
        action(n("c tab Schule -> Heute")) { clickTab(env.todayLabel); frames(22); expect(model.route.destination == Destination.Today, "Today") }
    }

    companion object {
        val TAG_METHODS = setOf("widgetRows", "absenceTally", "provisionalTally", "cleanSchulnetzText")
    }
}
