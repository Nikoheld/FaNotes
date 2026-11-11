package ch.fasrv.fanotes.companion

import android.app.Application
import android.os.Looper
import android.os.StrictMode
import androidx.activity.ComponentActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.down
import androidx.compose.ui.test.moveBy
import androidx.compose.ui.test.up
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ApplicationProvider
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.schulnetz.AgendaEvent
import ch.fasrv.fanotes.schulnetz.DeskPrefs
import ch.fasrv.fanotes.schulnetz.PlannedAbsence
import ch.fasrv.fanotes.schulnetz.SchoolAbsence
import ch.fasrv.fanotes.schulnetz.SchoolGrade
import ch.fasrv.fanotes.schulnetz.SchoolHomework
import ch.fasrv.fanotes.schulnetz.SchoolMessage
import ch.fasrv.fanotes.schulnetz.SchoolProfile
import ch.fasrv.fanotes.schulnetz.SchoolVacation
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.detectGroupSets
import ch.fasrv.fanotes.schulnetz.hideSeries
import ch.fasrv.fanotes.schulnetz.preferredEventTitle
import ch.fasrv.fanotes.schulnetz.toNormalizedJson
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters
import java.util.Random
import java.util.concurrent.Executor

/**
 * JVM UI performance harness. Renders the real app UI (theme + CompanionRoot) over a real-size school year
 * and measures the main-thread cost of interactions, with a sampling CPU profile per interaction.
 * It asserts only that the screens rendered; read build/ui-perf.txt for the numbers.
 *
 * Run: cd android && ./gradlew :companion:testDebugUnitTest --tests '*UiPerformanceTest*'
 *
 * Caveats: this is JIT-cold Robolectric on a desktop JVM, not a phone. Absolute milliseconds are not
 * device numbers; compare actions and hotspots with each other, and runs with earlier runs.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiPerformanceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun fullSchoolYear() = runHarness("full year, no group choice", groupChoice = false)

    @Test fun fullSchoolYearWithHalfClassChoice() = runHarness("full year, half-class choice set", groupChoice = true)

    // ---------------------------------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------------------------------

    private class Course(val label: String, val title: String, val room: String, val teacher: String)

    private val courses = listOf(
        Course("D", "Deutsch", "D101", "Lehrperson A"), Course("Ma", "Mathematik", "M204", "Lehrperson B"),
        Course("En", "Englisch", "E112", "Lehrperson C"), Course("Fr", "Französisch", "F108", "Lehrperson D"),
        Course("Bio", "Biologie", "N301", "Lehrperson E"), Course("Ch", "Chemie", "N305", "Lehrperson F"),
        Course("Ph", "Physik", "N310", "Lehrperson G"), Course("Ge", "Geschichte", "G020", "Lehrperson H"),
        Course("Gg", "Geografie", "G024", "Lehrperson I"), Course("WR", "Wirtschaft und Recht", "W015", "Lehrperson J"),
        Course("BG", "Bildnerisches Gestalten", "A001", "Lehrperson K"), Course("Mu", "Musik", "A010", "Lehrperson L"),
        Course("spf", "Sport", "Halle 1", "Lehrperson M"), Course("spm", "Sport", "Halle 2", "Lehrperson N"),
        Course("X-Sem1", "Ergänzungsfach Informatik", "I001", "Lehrperson O"), Course("X-Sem2", "Ergänzungsfach Recht", "I002", "Lehrperson P"),
        Course("Amos 1.1", "Anwendungen der Mathematik", "M210", "Lehrperson B"), Course("Amos 1.2", "Anwendungen der Mathematik", "M211", "Lehrperson Q"),
    ).associateBy { it.label }

    private val slots = listOf(
        "07:45" to "08:30", "08:35" to "09:20", "09:40" to "10:25", "10:30" to "11:15", "11:25" to "12:10",
        "12:15" to "13:00", "13:15" to "14:00", "14:05" to "14:50", "15:00" to "15:45", "15:50" to "16:35",
    )

    /** Pseudo keys: SPORT alternates spf/spm by week, X switches Sem1 to Sem2 mid-year, AMOS alternates 1.1/1.2. */
    private val template: List<List<Pair<Int, String>>> = listOf(
        listOf(0 to "D", 1 to "Ma", 2 to "En", 3 to "En", 4 to "Bio", 6 to "SPORT", 7 to "SPORT", 8 to "X"),
        listOf(0 to "Ma", 1 to "Fr", 2 to "Ge", 3 to "Ch", 4 to "Ch", 6 to "AMOS", 7 to "Ph", 8 to "D"),
        listOf(0 to "Ph", 1 to "D", 2 to "Ma", 3 to "BG", 4 to "BG", 6 to "WR", 7 to "X", 8 to "Gg"),
        listOf(0 to "En", 1 to "Gg", 2 to "D", 3 to "Fr", 4 to "Mu", 5 to "Ma", 6 to "SPORT", 7 to "SPORT", 8 to "AMOS"),
        listOf(0 to "Bio", 1 to "Ma", 2 to "WR", 3 to "Ph", 4 to "Ge", 6 to "Fr", 7 to "En", 8 to "Mu"),
    )

    private fun lesson(day: LocalDate, slot: Int, course: Course, status: String = "", comment: String = "", teacher: String = course.teacher) = AgendaEvent(
        id = "perf-lesson-$day-$slot", start = "${day}T${slots[slot].first}:00", end = "${day}T${slots[slot].second}:00",
        text = course.title, comment = comment, room = course.room, teachers = listOf(teacher),
        courseId = "perf-${course.label}", courseName = course.label, status = status, eventType = "0_stp", color = "", timetableText = course.title,
    )

    private fun exam(day: LocalDate, from: Int, to: Int, course: Course, topic: String) = AgendaEvent(
        id = "perf-exam-$day-${course.label}", start = "${day}T${slots[from].first}:00", end = "${day}T${slots[to].second}:00",
        text = "${course.title}: $topic", comment = topic, room = course.room, teachers = listOf(course.teacher),
        courseId = "perf-${course.label}", courseName = course.label, status = "", eventType = "exam", color = "", timetableText = "Prüfung ${course.title}",
    )

    private fun buildSnapshot(today: LocalDate): SchulnetzSnapshot {
        val random = Random(42)
        val monday = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        val weeks = (-9L..10L).map { monday.plusWeeks(it) }
        val stamp = java.time.Instant.now().toString()
        val lessons = mutableListOf<AgendaEvent>()
        weeks.forEachIndexed { weekIndex, week ->
            template.forEachIndexed { dayIndex, entries ->
                val day = week.plusDays(dayIndex.toLong())
                entries.forEach { (slot, key) ->
                    val label = when (key) {
                        "SPORT" -> if (weekIndex % 2 == 0) "spf" else "spm"
                        "AMOS" -> if (weekIndex % 2 == 0) "Amos 1.1" else "Amos 1.2"
                        "X" -> if (weekIndex < 10) "X-Sem1" else "X-Sem2"
                        else -> key
                    }
                    val course = courses.getValue(label)
                    val roll = random.nextInt(60)
                    lessons += when (roll) {
                        0 -> lesson(day, slot, course, status = "entfällt", comment = "Lektion fällt aus")
                        1 -> lesson(day, slot, course, comment = "Vertretung", teacher = "Lehrperson Z")
                        else -> lesson(day, slot, course)
                    }
                }
            }
        }
        val firstLessonOf = { label: String, after: LocalDate -> lessons.first { it.courseName == label && LocalDate.parse(it.start.take(10)) >= after } }
        // 15 exams: some exactly on one lesson slot, some across two; four of them soon.
        val examSpecs = listOf(-60 to "Ma", -49 to "D", -40 to "En", -33 to "Bio", -25 to "Fr", -18 to "Ge", -11 to "Ch", -4 to "Ph",
            3 to "Ma", 6 to "En", 12 to "Bio", 20 to "D", 27 to "Fr", 38 to "WR", 52 to "Ge")
        val exams = examSpecs.mapIndexed { index, (offset, label) ->
            val base = firstLessonOf(label, today.plusDays(offset.toLong()))
            val day = LocalDate.parse(base.start.take(10))
            val slot = slots.indexOfFirst { base.start.endsWith("T${it.first}:00") }.coerceAtLeast(0)
            exam(day, slot, if (index % 3 == 0) (slot + 1).coerceAtMost(slots.lastIndex) else slot, courses.getValue(label), "Thema ${index + 1}")
        }
        val gradeCourses = listOf("D", "Ma", "En", "Fr", "Bio", "Ch", "Ph", "Ge", "Gg", "WR", "BG", "Mu", "X-Sem1", "Amos 1.1")
        val grades = (0 until 40).map { index ->
            val course = courses.getValue(gradeCourses[index % gradeCourses.size])
            SchoolGrade(
                id = "perf-grade-$index", course = "${course.label}-K26A", courseId = "perf-${course.label}", subject = course.title,
                title = "Prüfung ${index / gradeCourses.size + 1}", date = today.minusDays((5 + index * 2L)).toString(),
                mark = (3 + random.nextInt(13)) * 0.25 + 1.0, weight = if (index % 7 == 0) 0.5 else 1.0, confirmed = true, courseGrade = null, comment = "",
            )
        }
        val absences = (0 until 20).map { index ->
            val day = today.minusDays(3L + index * 5)
            val open = index < 3
            SchoolAbsence(
                id = "perf-absence-$index", dateFrom = day.toString(), dateTo = day.toString(), hourFrom = slots[index % 4].first, hourTo = slots[index % 4].second,
                subject = courses.values.toList()[index % 12].title, reason = if (open) "" else "Krankheit", excused = !open && index % 2 == 0, acknowledged = !open,
                status = if (open) "offen" else "gebucht", excuseUntil = if (open) today.plusDays(4L + index).toString() else "",
                points = if (open) null else 1.0 + index % 3, pending = open,
            )
        }
        val homework = (0 until 12).map { index ->
            val course = courses.values.toList()[index % 12]
            SchoolHomework("perf-hw-$index", "Aufgabe ${index + 1}", "Seiten ${10 + index} bis ${14 + index}", today.plusDays(index * 2L - 3).toString(), "perf-${course.label}", course.title)
        }
        return SchulnetzSnapshot(
            revision = 7, fetchedAt = stamp, profile = SchoolProfile("perf-profile", "Test", "Schüler:in", "K26A", ""),
            grades = grades, events = lessons, exams = exams, absences = absences, homework = homework,
            messages = (0 until 6).map { SchoolMessage("perf-msg-$it", "Mitteilung ${it + 1}", "Text der Mitteilung ${it + 1}", stamp) },
            vacations = listOf(SchoolVacation("perf-vac-1", "Herbstferien", monday.plusWeeks(6).toString(), monday.plusWeeks(7).plusDays(4).toString())),
            weekFetched = weeks.associate { it.toString() to stamp }, weekRead = weeks.associate { it.toString() to stamp },
            examWeekFetched = weeks.associate { it.toString() to stamp },
            weekSpanStart = weeks.first().toString(), weekSpanEnd = weeks.last().plusDays(4).toString(),
            absenceQuota = 30.0, absenceRemaining = 21.0, absenceParser = ch.fasrv.fanotes.schulnetz.ABSENCE_PARSER_VERSION,
        )
    }

    private fun mensaJson(today: LocalDate): String {
        val days = (0 until 14).map { today.plusDays(it - 3L) }.filter { it.dayOfWeek.value < 6 }.joinToString(",") { day ->
            """{"date":"$day","closed":false,"note":"","menus":[
              {"name":"Gemüsecurry","description":"Reis, Kokosmilch, Saisongemüse","label":"Vegi","price":13.5,"studentPrice":10.5},
              {"name":"Pouletgeschnetzeltes","description":"Rahmsauce, Nudeln, Salat","label":"Fleisch","price":15.0,"studentPrice":11.5}]}"""
        }
        return """{"fetchedAt":"${java.time.Instant.now()}","stale":false,"days":[$days]}"""
    }

    // ---------------------------------------------------------------------------------------------
    // Measurement plumbing
    // ---------------------------------------------------------------------------------------------

    private class Result(val name: String) {
        val frames = mutableListOf<Double>()
        var applies = 0
        var changedObjects = 0
        var error: String? = null
        var note = ""
        val strict = linkedMapOf<String, Int>()
        val diskSamples = linkedMapOf<String, Int>()
        val self = hashMapOf<String, Int>()
        val inclusive = hashMapOf<String, Int>()
        val leaf = hashMapOf<String, Int>()
        var samples = 0
    }

    /** Samples the main thread's stack about every millisecond while [active]. Frames are aggregated per [Result]. */
    private class Sampler(private val target: Thread) {
        @Volatile var active = false
        @Volatile var result: Result? = null
        @Volatile private var running = true
        private val diskClasses = listOf("java.io.FileInputStream", "java.io.FileOutputStream", "java.io.RandomAccessFile", "java.io.UnixFileSystem",
            "sun.nio.fs.UnixNativeDispatcher", "sun.nio.ch.FileChannelImpl", "java.io.File.")
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

        private fun key(e: StackTraceElement) = e.className.replace(Regex("\\$\\d+"), "").replace("\$lambda", "") + "." + e.methodName

        private fun record(r: Result, stack: Array<StackTraceElement>) {
            if (stack.isEmpty()) return
            r.samples++
            r.leaf.merge(key(stack[0]), 1, Int::plus)
            val app = stack.filter { it.className.startsWith("ch.fasrv.") }
            if (app.isNotEmpty()) {
                r.self.merge(key(app.first()), 1, Int::plus)
                app.map { key(it) }.toSet().forEach { r.inclusive.merge(it, 1, Int::plus) }
            }
            val io = stack.firstOrNull { e -> diskClasses.any { e.className.startsWith(it) || "${e.className}." .startsWith(it) } }
            if (io != null) r.diskSamples.merge("${io.className}.${io.methodName} <- " + app.take(3).joinToString(" <- ") { key(it).substringAfterLast('.') + "@" + it.className.substringAfterLast('.') }, 1, Int::plus)
        }
    }

    private lateinit var model: CompanionModel
    private lateinit var sampler: Sampler
    private val results = linkedMapOf<String, Result>()
    private var current: Result? = null
    private var strictFires = false
    private val strictCollector = linkedMapOf<String, Int>()

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()

    private fun nanosToMs(n: Long) = n / 1_000_000.0

    /** Times [block] on the main thread; counted into the current result as one "frame". */
    private fun timedFrame(block: () -> Unit) {
        val result = current ?: return
        sampler.result = result
        val start = System.nanoTime()
        sampler.active = true
        try { block() } finally { sampler.active = false }
        result.frames += nanosToMs(System.nanoTime() - start)
    }

    private fun stepFrame() = timedFrame { rule.mainClock.advanceTimeByFrame(); idleMain() }

    /** Lets background work (IO, Default) finish between frames without counting it. */
    private fun settleBackground() = Thread.sleep(3)

    private fun frames(count: Int) { repeat(count) { stepFrame(); settleBackground() } }

    private fun action(name: String, body: () -> Unit) {
        val result = results.getOrPut(name) { Result(name) }
        current = result
        val applyHandle = Snapshot.registerApplyObserver { changed, _ -> result.applies++; result.changedObjects += changed.size }
        strictCollector.clear()
        try { body() } catch (error: Throwable) {
            result.error = (result.error.orEmpty() + " " + error::class.simpleName + ": " + (error.message ?: "").lines().first().take(160)).trim()
        } finally {
            applyHandle.dispose()
            result.note = "${model.route.destination}/${model.route.page} week=${model.planWeek} compact=${model.desk.planCompact} weekend=${model.desk.showWeekend} day=${model.day}"
            strictCollector.forEach { (k, v) -> result.strict.merge(k, v, Int::plus) }
            current = null
        }
    }

    private fun click(match: androidx.compose.ui.test.SemanticsMatcher) {
        // The node may be off screen (list scrolled by an earlier action): scroll like a finger until a tap can be injected.
        var attempt = 0
        while (true) {
            try { timedFrame { rule.onAllNodes(match).onFirst().performClick(); idleMain() }; return }
            catch (e: AssertionError) {
                if (e.message?.contains("inject") != true || attempt >= 5) throw e
                swipe(attempt % 2 == 1, steps = 8); attempt++
            }
        }
    }

    /** Bottom bar items only: Role.Tab with the label (planner filter chips are selectable with the same text). */
    private fun clickTab(label: String) = click(androidx.compose.ui.test.SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Tab) and hasText(label))

    /** Swipes the list up (counted in the action, like a real finger) until the item is composed, then taps it. */
    private fun scrollAndClick(match: androidx.compose.ui.test.SemanticsMatcher) {
        var tries = 0
        while (tries++ < 4 && rule.onAllNodes(match).fetchSemanticsNodes().isEmpty()) swipe(true, steps = 6)
        click(match)
    }

    private fun expect(ok: Boolean, what: String) { if (!ok) current?.let { it.error = (it.error.orEmpty() + " expected: $what").trim() } }

    private fun swipe(up: Boolean, steps: Int = 10) {
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
    // The harness
    // ---------------------------------------------------------------------------------------------

    private fun runHarness(variant: String, groupChoice: Boolean) {
        val app = ApplicationProvider.getApplicationContext<Application>()
        AppLanguage.install(app)
        val today = LocalDate.now()
        val snapshot = buildSnapshot(today)
        // Same path as a real start: the cached snapshot file and the link flag exist before the graph is built.
        slotFile(app, ch.fasrv.fanotes.schulnetz.PRIMARY_SLOT, "schulnetz-snapshot.json").writeText(snapshot.toNormalizedJson())
        app.getSharedPreferences("fanotes-companion", android.content.Context.MODE_PRIVATE).edit().putBoolean("school-linked", true).commit()
        File(app.filesDir, "mensa.json").writeText(mensaJson(today))
        val graph = CompanionGraph(app)
        // Wait for the graph's own cache load (the same coroutine the app runs at start).
        val waitStart = System.currentTimeMillis()
        while (!graph.snapshotReady.value && System.currentTimeMillis() - waitStart < 20_000) { idleMain(); Thread.sleep(10) }
        val sets = detectGroupSets(graph.snapshot.value.events)
        val choices = if (groupChoice) sets.associate { it.key to listOf(it.options.first().label) } else emptyMap()
        graph.saveDeskPrefs(DeskPrefs(theme = "system", showMensa = true, groupChoices = choices))
        val firstTask = today.plusDays(1)
        (0 until 30).forEach { index ->
            val subject = courses.values.toList()[index % 12].title
            graph.saveHomeworkTask(HomeworkTask(id = "perf-task-$index", title = "Aufgabe $index", notes = "Notizen $index", subject = subject,
                dueDate = firstTask.plusDays(index % 14 - 4L).toString(), done = index % 5 == 0, createdAt = "2026-09-01T08:00:00Z"))
        }
        graph.savePlannedAbsences((0 until 4).map { PlannedAbsence("perf-plan-$it", today.plusDays(3L + it * 9).toString(), slots[it].first, slots[it].second, "Mathematik") })
        graph.saveHiddenLessons(hideSeries(snapshot.events.first { it.courseName == "Mu" }, emptyList()))
        check(graph.snapshot.value.events.size >= 750) { "snapshot not loaded: ${graph.snapshot.value.events.size} events" }

        // An existing user: onboarding done, local access on.
        graph.markOnboardingSeen(); graph.setLocalAccess(true)
        model = CompanionModel(graph)
        sampler = Sampler(Thread.currentThread()).also { it.start() }
        // Wait for the model's own reload so every derived list is ready before the first frame.
        val readyStart = System.currentTimeMillis()
        while ((!model.schoolReady || model.loading || model.tasks.isEmpty() || model.desk.groupChoices != choices) && System.currentTimeMillis() - readyStart < 20_000) { idleMain(); Thread.sleep(10) }
        model.mensa = graph.mensaStore.cached()

        val strictSupported = probeStrictMode()
        installStrictPolicy()

        rule.mainClock.autoAdvance = false
        var firstRender = true
        action("A first render Heute (cold)") {
            timedFrame {
                rule.setContent {
                    ch.fasrv.fanotes.companion.CompanionTheme(
                        themeId = model.desk.theme.ifBlank { model.theme }, systemDark = isSystemInDarkTheme(), accent = model.desk.accent,
                        amoled = model.desk.amoled, reducedMotion = false, online = true,
                    ) {
                        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { CompanionRoot(model) }
                    }
                }
            }
            frames(25)
        }
        firstRender = false
        // Rendered check: the Heute title and the tab bar exist.
        runCatching { rule.onAllNodes(isSelectable() and hasText(t(R.string.planner))).assertCountEquals(1) }.onFailure {
            println("SEMANTICS: " + rule.onRoot().printToString(60)); throw it
        }
        assertTrue("Heute must show lessons or tasks", model.snapshot.events.isNotEmpty())

        val todayLabel = t(R.string.today)
        val plannerLabel = t(R.string.planner)
        val schoolLabel = t(R.string.school)
        val upcomingExam = model.snapshot.exams.map { it }.sortedBy { it.start }.first { it.start.take(10) >= today.toString() }
        val examTitle = preferredEventTitle(upcomingExam)
        val workDay = generateSequence(today) { it.plusDays(1) }.first { it.dayOfWeek.value < 6 }

        for (phase in listOf("timing", "profile")) {
            val profile = phase == "profile"
            val tag = if (profile) "P " else "A "
            fun n(name: String) = tag + name
            runPhase(::n, todayLabel, plannerLabel, schoolLabel, examTitle, workDay)
        }

        report(variant, strictSupported)
    }

    private fun runPhase(n: (String) -> String, todayLabel: String, plannerLabel: String, schoolLabel: String, examTitle: String, workDay: LocalDate) {
        timedReset(todayLabel, workDay)
        action(n("b scroll Heute (2 up, 2 down)")) { swipe(true); swipe(true); swipe(false); swipe(false) }
        action(n("d tap exam row on Heute + close sheet")) {
            click(hasClickAction() and hasText(examTitle, substring = true)); frames(20)
            click(hasContentDescription(t(R.string.close))); frames(20)
        }
        repeat(3) {
            action(n("c tab Heute -> Planer")) { clickTab(plannerLabel); frames(22); expect(model.route.destination == Destination.Planner, "Planner") }
            action(n("c tab Planer -> Schule")) { clickTab(schoolLabel); frames(22); expect(model.route.destination == Destination.School, "School") }
            action(n("c tab Schule -> Heute")) { clickTab(todayLabel); frames(22); expect(model.route.destination == Destination.Today, "Today") }
        }
        action(n("c tab Heute -> Planer (single)")) { clickTab(plannerLabel); frames(22) }
        action(n("d tap lesson row in Planer day + close sheet")) {
            val title = preferredEventTitle(model.snapshot.events.first { it.start.startsWith(workDay.toString()) && it.status.isBlank() })
            click(hasClickAction() and hasText(title, substring = true)); frames(20)
            click(hasContentDescription(t(R.string.close))); frames(20)
        }
        action(n("e Planer day -> week toggle")) { click(hasClickAction() and hasText(t(R.string.seg_week))); frames(20) }
        action(n("b scroll Planer week (3 up, 3 down)")) { repeat(3) { swipe(true) }; repeat(3) { swipe(false) } }
        action(n("e Planer next week (chevron)")) {
            click(hasContentDescription(t(R.string.next_week))); frames(20)
            click(hasContentDescription(t(R.string.previous_week))); frames(20)
        }
        action(n("e Planer pick day in week strip")) { click(isSelectable() and hasContentDescription(workDay.dayOfMonth.toString(), substring = true)); frames(20) }
        action(n("e open Settings > Planning")) { timedFrame { model.navigate(Page.Planning) }; frames(25) }
        action(n("f tap toggle Compact rows (on)")) { click(hasClickAction() and hasText(t(R.string.compact_rows))); frames(25); expect(model.desk.planCompact, "compact on") }
        action(n("f tap toggle Compact rows (off)")) { click(hasClickAction() and hasText(t(R.string.compact_rows))); frames(25) }
        action(n("f tap toggle Heute card 'Upcoming exam' (off)")) { click(hasClickAction() and hasText(t(R.string.upcoming_exam))); frames(25); expect("exam" in model.desk.hiddenCards, "exam card hidden") }
        action(n("f tap toggle Heute card 'Upcoming exam' (on)")) { click(hasClickAction() and hasText(t(R.string.upcoming_exam))); frames(25); expect("exam" !in model.desk.hiddenCards, "exam card shown") }
        timedReset(todayLabel, workDay)
    }

    private fun timedReset(todayLabel: String, workDay: LocalDate) {
        results.getOrPut("reset") { Result("reset") }.also { current = it }
        timedFrameNoCount {
            model.selectNav("today"); model.day = workDay; model.planWeek = false
        }
        repeat(25) { rule.mainClock.advanceTimeByFrame(); idleMain(); settleBackground() }
        current = null
    }

    private fun timedFrameNoCount(block: () -> Unit) { block() }

    // ---------------------------------------------------------------------------------------------
    // StrictMode
    // ---------------------------------------------------------------------------------------------

    /** Reads a file on the main thread under a policy; true when StrictMode reports it (it does not under most Robolectric setups). */
    private fun probeStrictMode(): Boolean {
        var fired = false
        StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectDiskReads().detectDiskWrites().penaltyListener(Executor { it.run() }) { fired = true }.build())
        runCatching { File.createTempFile("strict", ".probe").also { it.writeText("x"); it.readText(); it.delete() } }
        StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.LAX)
        strictFires = fired
        return fired
    }

    private fun installStrictPolicy() {
        if (!strictFires) return
        StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectDiskReads().detectDiskWrites().penaltyListener(Executor { it.run() }) { violation ->
            val app = violation.stackTrace.filter { it.className.startsWith("ch.fasrv.") }.take(4).joinToString(" <- ") { it.className.substringAfterLast('.') + "." + it.methodName }
            strictCollector.merge(violation::class.java.simpleName + ": " + app, 1, Int::plus)
        }.build())
    }

    // ---------------------------------------------------------------------------------------------
    // Report
    // ---------------------------------------------------------------------------------------------

    private fun report(variant: String, strictSupported: Boolean) {
        val out = StringBuilder()
        out.appendLine("=== UI performance: $variant ===")
        out.appendLine("Events=${model.snapshot.events.size} exams=${model.snapshot.exams.size} grades=${model.snapshot.grades.size} absences=${model.snapshot.absences.size} " +
            "homework=${model.snapshot.homework.size} tasks=${model.tasks.size} planned=${model.plannedAbsences.size} hidden=${model.hidden.size} " +
            "groupSets=${detectGroupSets(model.snapshot.events).size} groupChoices=${model.desk.groupChoices.size} mensa=${model.mensa?.days?.size ?: 0}d  JVM=${System.getProperty("java.version")}")
        out.appendLine("Phase A = timing without profiler; phase P = same actions with the 1 ms stack sampler (frame times inflated by sampling).")
        out.appendLine()
        fun row(name: String, r: Result): String {
            val f = r.frames.sorted()
            if (f.isEmpty()) return "%-52s  (no frames)%s".format(name, r.error?.let { "  ERROR: $it" } ?: "")
            val median = f[f.size / 2]
            return "%-52s %6d %9.1f %9.1f %9.1f %6d %6d %8d %8d%s".format(name, f.size, f.sum(), median, f.last(), f.count { it > 16 }, f.count { it > 32 }, r.applies, r.changedObjects,
                "  [${r.note}]" + (r.error?.let { "  ERROR: $it" } ?: ""))
        }
        val header = "%-52s %6s %9s %9s %9s %6s %6s %8s %8s".format("action", "frames", "total ms", "median", "max", ">16ms", ">32ms", "applies", "objs")
        listOf("A " to "Phase A (no profiler)", "P " to "Phase P (profiler on)").forEach { (prefix, title) ->
            out.appendLine(title)
            out.appendLine(header)
            results.filterKeys { it.startsWith(prefix) }.forEach { (key, r) -> out.appendLine(row(key.drop(2), r)) }
            out.appendLine()
        }
        out.appendLine("=== Hotspots per action (phase P): top 25 ch.fasrv.* frames; incl = samples with the frame anywhere in the stack, self = samples where it is the topmost app frame ===")
        results.filterKeys { it.startsWith("P ") }.forEach { (key, r) ->
            if (r.samples == 0) return@forEach
            out.appendLine()
            out.appendLine("--- ${key.drop(2)}: ${r.samples} samples (~${r.samples} ms on main) ---")
            out.appendLine("  inclusive:")
            r.inclusive.entries.sortedByDescending { it.value }.take(25).forEach { out.appendLine("    %5d  %s".format(it.value, it.key)) }
            out.appendLine("  self (topmost app frame):")
            r.self.entries.sortedByDescending { it.value }.take(25).forEach { out.appendLine("    %5d  %s".format(it.value, it.key)) }
            out.appendLine("  leaf frames (any package), top 8:")
            r.leaf.entries.sortedByDescending { it.value }.take(8).forEach { out.appendLine("    %5d  %s".format(it.value, it.key)) }
        }
        out.appendLine()
        out.appendLine("=== Main-thread file IO ===")
        out.appendLine(if (strictSupported) "StrictMode fired under Robolectric: violations below." else "StrictMode does NOT fire under Robolectric (libcore BlockGuard is not wired); using stack-sample detection of java.io/nio file frames instead (probabilistic, 1 ms).")
        val strict = results.values.flatMap { it.strict.entries }
        if (strictSupported) {
            if (strict.isEmpty()) out.appendLine("  (no StrictMode violations)") else strict.groupBy({ it.key }, { it.value }).forEach { (k, v) -> out.appendLine("  %5d  %s".format(v.sum(), k)) }
        }
        val disk = results.filterKeys { it.startsWith("P ") }.flatMap { (k, r) -> r.diskSamples.map { Triple(k.drop(2), it.key, it.value) } }
        if (disk.isEmpty()) out.appendLine("  (no file IO frames seen in samples)")
        else disk.sortedByDescending { it.third }.forEach { out.appendLine("  %5d  [%s] %s".format(it.third, it.first, it.second)) }
        out.appendLine()
        print(out)
        val file = File("build/ui-perf-${variant.replace(Regex("[^a-z0-9]+"), "-")}.txt")
        file.parentFile?.mkdirs()
        file.writeText(out.toString())
        synchronized(UiPerformanceTest::class.java) {
            val combined = File("build/ui-perf.txt")
            combined.writeText(File("build").listFiles { f -> f.name.startsWith("ui-perf-") && f.name.endsWith(".txt") }.orEmpty().sortedBy { it.name }.joinToString("\n") { it.readText() })
        }
        sampler.stop()
    }
}
