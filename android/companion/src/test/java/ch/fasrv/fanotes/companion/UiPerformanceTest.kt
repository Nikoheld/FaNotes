package ch.fasrv.fanotes.companion

import android.app.Application
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.schulnetz.preferredEventTitle
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * JVM UI performance harness. Renders the real app UI over a real-size school year and measures the main-thread cost
 * of interactions. Method: one cold render, one discarded warm-up pass of all actions (JIT), then phase A: [ROUNDS]
 * timed rounds without profiler, then phase P: one round with a 1 ms stack sampler (frame times inflated by sampling).
 * It asserts only that the screens rendered; read build/ui-perf.txt for the numbers.
 *
 * Run: cd android && ./gradlew :companion:testDebugUnitTest --tests '*UiPerformanceTest*'
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiPerformanceTest : UiPerfBase() {
    @Test fun fullSchoolYear() = runHarness("full year")

    private fun runHarness(variant: String) {
        launchApp()
        // Warm-up pass: every action once, discarded, so the JIT is warm for the measured rounds.
        round = -1; profiling = false
        runPass("A ")
        for (r in 0 until ROUNDS) { round = r; runPass("A ") }
        round = 0; profiling = true
        runPass("P ")
        profiling = false
        report(variant)
        stopSampler()
    }

    private fun runPass(tag: String) {
        fun n(name: String) = tag + name
        resetToToday()
        scrollHeute(::n)
        tapExamOnHeute(::n)
        tabRoundTrips(::n, 3)
        action(n("c tab Heute -> Planer (single)")) { clickTab(env.plannerLabel); frames(22) }
        action(n("d tap lesson row in Planer day + close sheet")) {
            val title = preferredEventTitle(model.snapshot.events.first { it.start.startsWith(env.workDay.toString()) && it.status.isBlank() })
            tapUntilShown(hasClickAction() and hasText(title, substring = true), hasContentDescription(t(R.string.close)))
            click(hasContentDescription(t(R.string.close))); frames(20)
        }
        action(n("e Planer day -> week toggle")) { click(hasClickAction() and hasText(t(R.string.seg_week))); frames(20) }
        action(n("b scroll Planer week (3 up, 3 down)")) { repeat(3) { swipe(true) }; repeat(3) { swipe(false) } }
        action(n("e Planer next week (chevron)")) {
            click(hasContentDescription(t(R.string.next_week))); frames(20)
            click(hasContentDescription(t(R.string.previous_week))); frames(20)
        }
        action(n("e Planer pick day in week strip")) { click(isSelectable() and hasContentDescription(env.workDay.dayOfMonth.toString(), substring = true)); frames(20) }
        action(n("e open Settings > Planning")) { timedFrame { model.navigate(Page.Planning) }; frames(25) }
        action(n("f tap toggle Compact rows (on)")) { click(hasClickAction() and hasText(t(R.string.compact_rows))); frames(25); expect(model.desk.planCompact, "compact on") }
        action(n("f tap toggle Compact rows (off)")) { click(hasClickAction() and hasText(t(R.string.compact_rows))); frames(25) }
        action(n("f tap toggle Heute card 'Upcoming exam' (off)")) { click(hasClickAction() and hasText(t(R.string.upcoming_exam))); frames(25); expect("exam" in model.desk.hiddenCards, "exam card hidden") }
        action(n("f tap toggle Heute card 'Upcoming exam' (on)")) { click(hasClickAction() and hasText(t(R.string.upcoming_exam))); frames(25); expect("exam" !in model.desk.hiddenCards, "exam card shown") }
        resetToToday()
    }

    private fun report(variant: String) {
        val out = StringBuilder()
        out.appendLine("=== UI performance: $variant ===")
        out.appendLine("Events=${model.snapshot.events.size} exams=${model.snapshot.exams.size} grades=${model.snapshot.grades.size} absences=${model.snapshot.absences.size} " +
            "homework=${model.snapshot.homework.size} tasks=${model.tasks.size} planned=${model.plannedAbsences.size} hidden=${model.hidden.size} " +
            "mensa=${model.mensa?.days?.size ?: 0}d  JVM=${System.getProperty("java.version")}")
        out.appendLine("Method: 1 discarded warm-up pass, then $ROUNDS timed rounds (phase A, no profiler), then 1 profiled round (phase P, frame times inflated).")
        out.appendLine("best/median = total frame ms of the best / median round; max, >16, >32 are those of the best round; tap = best tap-to-response ms (injection to the first frame with the sheet visible).")
        out.appendLine()
        fun roundsOf(prefix: String, key: String) = results[key]?.filterKeys { it >= 0 }?.values.orEmpty().toList()
        val header = "%-52s %6s %9s %9s %8s %6s %6s %8s".format("action", "frames", "best ms", "median ms", "max ms", ">16ms", ">32ms", "tap ms")
        out.appendLine("Phase A ($ROUNDS rounds)")
        out.appendLine(header)
        results.keys.filter { it.startsWith("A ") }.forEach { key ->
            val rounds = roundsOf("A ", key).filter { it.frames.isNotEmpty() }
            if (rounds.isEmpty()) { out.appendLine("%-52s  (no frames)".format(key.drop(2))); return@forEach }
            val byTotal = rounds.sortedBy { it.total }
            val best = byTotal.first()
            val median = byTotal[byTotal.size / 2]
            val tap = rounds.flatMap { it.taps.take(1) }.minOrNull()
            val errors = rounds.mapNotNull { it.error }.distinct().joinToString("; ")
            out.appendLine("%-52s %6d %9.1f %9.1f %8.1f %6d %6d %8s%s".format(key.drop(2), best.frames.size, best.total, median.total, best.maxFrame,
                best.frames.count { it > 16 }, best.frames.count { it > 32 }, tap?.let { "%.1f".format(it) } ?: "-",
                if (errors.isNotEmpty()) "  ERROR: $errors" else ""))
        }
        out.appendLine()
        out.appendLine("Phase P (profiler on)")
        val profiled = results.filterKeys { it.startsWith("P ") }.mapValues { it.value[0] }.filterValues { it != null && it.samples > 0 }.mapValues { it.value!! }
        val totalSamples = profiled.values.sumOf { it.samples }
        out.appendLine("%-52s %8s %7s %s".format("action", "samples", "tap ms", TAG_COLUMNS.joinToString(" ") { "%10s".format(it) }))
        profiled.forEach { (key, r) ->
            out.appendLine("%-52s %8d %7s %s".format(key.drop(2), r.samples, r.taps.firstOrNull()?.let { "%.0f".format(it) } ?: "-",
                TAG_COLUMNS.joinToString(" ") { "%9.1f%%".format(100.0 * (r.tagged[it] ?: 0) / r.samples) }))
        }
        out.appendLine("%-52s %8d %7s %s".format("ALL ACTIONS (share of main-thread samples)", totalSamples, "",
            TAG_COLUMNS.joinToString(" ") { tag -> "%9.1f%%".format(100.0 * profiled.values.sumOf { it.tagged[tag] ?: 0 } / maxOf(1, totalSamples)) }))
        out.appendLine()
        out.appendLine("=== Hotspots per action (phase P): top 15 ch.fasrv.* frames; incl = samples with the frame anywhere in the stack ===")
        profiled.forEach { (key, r) ->
            out.appendLine()
            out.appendLine("--- ${key.drop(2)}: ${r.samples} samples ---")
            r.inclusive.entries.sortedByDescending { it.value }.take(15).forEach { out.appendLine("    %5d  %s".format(it.value, it.key)) }
        }
        out.appendLine()
        print(out)
        val file = File("build/ui-perf-${variant.replace(Regex("[^a-z0-9]+"), "-")}.txt")
        file.parentFile?.mkdirs()
        file.writeText(out.toString())
        synchronized(UiPerformanceTest::class.java) {
            val combined = File("build/ui-perf.txt")
            combined.writeText(File("build").listFiles { f -> f.name.startsWith("ui-perf-") && f.name.endsWith(".txt") }.orEmpty().sortedBy { it.name }.joinToString("\n") { it.readText() })
        }
    }

    companion object {
        const val ROUNDS = 3
        val TAG_COLUMNS = listOf("widgetRows", "absenceTally", "provisionalTally", "cleanSchulnetzText", "AppLanguage")
    }
}
