package ch.fasrv.fanotes.companion

import android.app.Application
import android.os.Looper
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.test.ext.junit.runners.AndroidJUnit4
// PROBE-BEGIN
import ch.fasrv.fanotes.schulnetz.DerivedWorkProbe
import ch.fasrv.fanotes.schulnetz.schoolWeek
import java.time.LocalDate
import java.util.concurrent.ConcurrentLinkedQueue
// PROBE-END
import ch.fasrv.fanotes.schulnetz.preferredEventTitle
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Regression guard for the lag fixed in "Stop recomputing school data on the main thread" (runs in CI with the unit tests).
 * It renders the app over the synthetic full school year of [PerfFixture], waits for the snapshot and the background warm-up,
 * then drives Heute scrolling, three Heute -> Planer -> Schule -> Heute round trips and a tap on an exam row, once as a warm-up
 * and three more times as timed rounds. It checks two things, for no group choice and for a half-class choice.
 *
 * 1. Deterministic: the derived-data builders (widgetRows, absenceTally, provisionalTally, detectGroupSets, agendaForDays)
 *    report to [ch.fasrv.fanotes.schulnetz.DerivedWorkProbe]; none may run on the main thread during these interactions.
 *    A first entry into Planer may legitimately build an agenda week that was never warmed, so agendaForDays only counts when
 *    its days overlap what the model warms in the background: today to +14 days and the current school week.
 * 2. Timing: the best of three rounds of scroll Heute, Schule -> Heute, Planer tab switch (max frame) and Heute tap-to-response
 *    must stay under budgets that are generous against the fixed code on a slow CI machine but far below the pre-fix code.
 *    The budgets are in [BUDGETS]; their derivation is documented there.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiRegressionGuardTest : UiPerfBase() {
    @Test fun fullSchoolYearNoGroupChoice() = guard("no group choice", groupChoice = false)

    @Test fun fullSchoolYearHalfClassChoice() = guard("half-class choice", groupChoice = true)

    // PROBE-BEGIN
    private class Hit(val name: String, val detail: Any?, val where: String, val round: Int, val action: String)
    // PROBE-END

    private fun guard(variant: String, groupChoice: Boolean) {
        launchApp(groupChoice)
        // PROBE-BEGIN
        val mainThread = Looper.getMainLooper().thread
        val mainHits = ConcurrentLinkedQueue<Hit>()
        val workerHits = java.util.concurrent.atomic.AtomicInteger()
        // PROBE-END
        // Background warm-up: the model's snapshot collector and the Heute lesson strip build off the main thread.
        repeat(20) { rule.mainClock.advanceTimeByFrame(); idleMain(); Thread.sleep(10) }
        // PROBE-BEGIN
        val stripBy = System.currentTimeMillis() + 5_000
        while (model.cachedLessonStrip(java.time.Instant.now().epochSecond / 60) == null && System.currentTimeMillis() < stripBy) {
            rule.mainClock.advanceTimeByFrame(); idleMain(); Thread.sleep(10)
        }
        // The model warms its agenda cache in the background; on a JIT-cold JVM that can take seconds, and the first taps
        // would then (legitimately, as at a real app start) build on main. Make sure the cache holds the warmed days first.
        val zone = java.time.ZoneId.systemDefault()
        model.cachedAgenda((0L..14L).map { env.today.plusDays(it) }, zone)
        model.cachedAgenda(schoolWeek(env.today, true), zone)
        model.cachedAgenda(schoolWeek(env.workDay, true), zone)
        repeat(5) { rule.mainClock.advanceTimeByFrame(); idleMain(); Thread.sleep(20) }
        DerivedWorkProbe.listener = { name, detail ->
            if (Thread.currentThread() === mainThread) {
                val where = Throwable().stackTrace.filter { it.className.startsWith("ch.fasrv.") && !it.className.contains("DerivedWorkProbe") }
                    .take(5).joinToString(" <- ") { it.className.substringAfterLast('.') + "." + it.methodName }
                mainHits += Hit(name, detail, where, round, currentActionName())
            } else workerHits.incrementAndGet()
        }
        // PROBE-END
        try {
            round = -1; pass()
            for (r in 0 until ROUNDS) { round = r; pass() }
        } finally {
            // PROBE-BEGIN
            DerivedWorkProbe.listener = null
            // PROBE-END
            stopSampler()
        }

        val failures = mutableListOf<String>()
        // PROBE-BEGIN
        val warmed = (0L..14L).map { env.today.plusDays(it) }.toSet() + schoolWeek(env.today, true) + schoolWeek(env.workDay, true)
        val offenders = mainHits.filter { hit ->
            when (hit.name) {
                "agendaForDays" -> (hit.detail as? List<*>).orEmpty().any { it in warmed }
                else -> true
            }
        }
        val allowed = mainHits.size - offenders.size
        println("[$variant] derived work on main thread: ${offenders.size} offenders, $allowed allowed (agenda days outside the warmed range); off main thread: ${workerHits.get()} calls")
        offenders.forEach { println("  main-thread hit: ${it.name} round=${it.round} action=${it.action} days=${(it.detail as? List<*>)?.let { d -> "${d.firstOrNull()}..${d.lastOrNull()} (${d.size})" }} @ ${it.where}") }
        if (offenders.isNotEmpty()) failures += "derived work ran on the main thread during scroll/tab/tap: " +
            offenders.groupBy { it.name }.map { "${it.key} x${it.value.size}" }.joinToString() + " (first at ${offenders.first().where})"
        // PROBE-END

        val lines = mutableListOf<String>()
        BUDGETS.forEach { (label, budget) ->
            val measured = measure(label)
            lines += "  %-44s measured %7.1f ms   budget %7.1f ms   %s".format(label, measured, budget, if (measured <= budget) "ok" else "OVER")
            if (measured > budget) failures += "$label took %.1f ms (best of $ROUNDS rounds), budget %.1f ms".format(measured, budget)
        }
        val report = StringBuilder("=== UI regression guard: $variant ===\n").append(lines.joinToString("\n")).append("\n")
        report.appendLine("All actions, best round (total ms / max frame ms / frames >16 ms / >32 ms):")
        results.keys.forEach { key ->
            val rounds = results[key].orEmpty().filterKeys { it >= 0 }.values.filter { it.frames.isNotEmpty() }
            if (rounds.isEmpty()) return@forEach
            val best = rounds.minByOrNull { it.total }!!
            report.appendLine("  %-50s %8.1f %8.1f %4d %4d".format(key, best.total, rounds.minOf { it.maxFrame }, best.frames.count { it > 16 }, best.frames.count { it > 32 }))
        }
        print(report)
        File("build/ui-guard-${variant.replace(Regex("[^a-z0-9]+"), "-")}.txt").also { it.parentFile?.mkdirs() }.writeText(report.toString())
        if (failures.isNotEmpty()) fail("UI regression guard [$variant]:\n  " + failures.joinToString("\n  "))
    }

    /** One pass of the guarded interactions. */
    private fun pass() {
        val id = { name: String -> name }
        resetToToday()
        scrollHeute(id)
        tapExamOnHeute(id)
        tabRoundTrips(id, 3)
        action("d tap lesson row in Planer day + close sheet") {
            clickTab(env.plannerLabel); frames(22)
            val title = preferredEventTitle(model.snapshot.events.first { it.start.startsWith(env.workDay.toString()) && it.status.isBlank() })
            tapUntilShown(hasClickAction() and hasText(title, substring = true), hasContentDescription(t(R.string.close)))
            click(hasContentDescription(t(R.string.close))); frames(20)
        }
        resetToToday()
    }

    /** Best round (smallest value) of the metric named by a budget label. */
    private fun measure(label: String): Double {
        val (action, kind) = METRICS.getValue(label)
        val rounds = results[action].orEmpty().filterKeys { it >= 0 }.values.filter { it.frames.isNotEmpty() }
        check(rounds.isNotEmpty()) { "no frames for $action" }
        return when (kind) {
            "max" -> rounds.minOf { it.maxFrame }
            else -> rounds.mapNotNull { it.taps.firstOrNull() }.minOrNull() ?: Double.MAX_VALUE
        }
    }

    companion object {
        const val ROUNDS = 3

        /** Metric label -> (action name, "max" frame or "tap" response). */
        val METRICS = linkedMapOf(
            "scroll Heute, max frame" to ("b scroll Heute (2 up, 2 down)" to "max"),
            "tab Schule -> Heute, max frame" to ("c tab Schule -> Heute" to "max"),
            "tab Heute -> Planer, max frame" to ("c tab Heute -> Planer" to "max"),
            "tap exam row on Heute, tap-to-response" to ("d tap exam row on Heute + close sheet" to "tap"),
        )

        /**
         * Budgets in ms for the best of three warm rounds, from six runs of each version on the dev machine (some under load).
         * Measured best-round max frame, fixed code / pre-fix code:
         *  - scroll Heute: 4-23 ms / 52-76 ms -> 40 (between the slowest fixed run and the fastest pre-fix run; fails every pre-fix run).
         *  - Schule -> Heute: 31-91 ms / 78-138 ms -> 110 (only the heavier pre-fix runs exceed it; the probe check is the sure catch here).
         *  - Heute -> Planer: 9-97 ms / 28-88 ms and tap exam row: 17-42 ms / 22-40 ms are not changed by the fix; their budgets (200, 120)
         *    only catch gross regressions, which is all a noisy CI machine allows.
         */
        val BUDGETS = linkedMapOf(
            "scroll Heute, max frame" to 40.0,
            "tab Schule -> Heute, max frame" to 110.0,
            "tab Heute -> Planer, max frame" to 200.0,
            "tap exam row on Heute, tap-to-response" to 120.0,
        )
    }
}
