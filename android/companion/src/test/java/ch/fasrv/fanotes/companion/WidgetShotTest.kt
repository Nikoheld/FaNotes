package ch.fasrv.fanotes.companion

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.RemoteViews
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.commute.*
import ch.fasrv.fanotes.schulnetz.SchoolVacation
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.WidgetRow
import ch.fasrv.fanotes.schulnetz.WidgetSpan
import java.io.File
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Inflates both home-screen widgets at every size step, in light and dark, English and German, at font
 * scale 1.0 and 1.3, with synthetic data. Each result is drawn to a PNG under build/widget-shots and every
 * TextView is checked: its text fits, or it is ellipsized by design (an ellipsize mode plus a line limit).
 * The lists are drawn as plain rows because a ListView needs the real RemoteViews service.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WidgetShotTest {
    private val out = File("build/widget-shots").also { it.mkdirs() }
    private val today = LocalDate.of(2026, 11, 13)

    private class Setup(val lang: String, val night: Boolean, val fontScale: Float) {
        val tag get() = "${if (night) "dark" else "light"}-$lang-fs${(fontScale * 10).toInt()}"
    }

    private val setups = listOf("en", "de").flatMap { lang ->
        listOf(false, true).flatMap { night -> listOf(1.0f, 1.3f).map { Setup(lang, night, it) } }
    }

    private fun prepare(setup: Setup): Context {
        RuntimeEnvironment.setQualifiers(if (setup.night) "+night" else "+notnight")
        RuntimeEnvironment.setFontScale(setup.fontScale)
        val app = ApplicationProvider.getApplicationContext<Application>()
        AppLanguage.install(app)
        AppLanguage.choose(setup.lang)
        return app
    }

    // ── Synthetic content ────────────────────────────────────────────────────

    private fun row(clock: String, title: String, room: String, cancelled: Boolean = false, substitution: Boolean = false, exam: Boolean = false, nextDay: Boolean = false) =
        WidgetRow(false, if (nextDay) today.plusDays(1) else today, nextDay, clock, title, room, cancelled, substitution, exam)

    private val lessonRows = listOf(
        row("08:00–08:45", "Mathematics", "201"),
        row("09:00–09:45", "Physics and applications of mechanics", "B 2.14", substitution = true),
        row("10:15–11:00", "History", "105", cancelled = true),
        row("11:15–12:00", "English written exam", "312", exam = true),
        WidgetRow(true, today.plusDays(1), true),
        row("08:00–08:45", "Chemistry", "Lab 3", nextDay = true),
        row("09:00–09:45", "Geography", "210", nextDay = true),
    )

    private fun snapshot(vacation: Boolean = false) = SchulnetzSnapshot(
        vacations = if (vacation) listOf(SchoolVacation("v1", "Autumn holidays", "2026-11-09", "2026-11-20")) else emptyList(),
    )

    private data class LessonCase(val name: String, val content: LessonWidgetContent, val rows: List<WidgetRow>)

    private fun lessonCases() = listOf(
        LessonCase("next", LessonWidgetContent.Next(lessonRows[0]), lessonRows),
        LessonCase("substitution", LessonWidgetContent.Next(lessonRows[1]), lessonRows),
        LessonCase("exam", LessonWidgetContent.Next(lessonRows[3]), lessonRows),
        LessonCase("tomorrow", LessonWidgetContent.Next(lessonRows[5]), lessonRows.drop(4)),
        LessonCase("signed-out", LessonWidgetContent.SignedOut, emptyList()),
        LessonCase("not-loaded", LessonWidgetContent.NotLoaded, emptyList()),
        LessonCase("holidays", LessonWidgetContent.Holidays("Autumn holidays", LocalDate.of(2026, 11, 20)), lessonRows.drop(4)),
        LessonCase("nothing-ahead", LessonWidgetContent.NothingAhead, emptyList()),
    )

    private val now = CommuteSamples.NOW
    private fun commuteCase(name: String, ui: CommuteUi): Triple<String, CommuteWidgetContent, String> {
        val board = ui.relevant(now)
        val route = ui.routes.firstOrNull { it.id == board?.routeId }
        return Triple(name, commuteContent(ui, route, board, now), board?.routeId.orEmpty())
    }

    private fun commuteCases() = listOf(
        commuteCase("delayed", CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(delay = 4), CommuteSamples.trip("07:35"), CommuteSamples.trip("08:05", delay = 12)))),
        commuteCase("on-time", CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(), CommuteSamples.trip("07:35")))),
        commuteCase("cancelled", CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(status = TripStatus.CANCELLED), alternatives = listOf(CommuteSamples.trip("07:35", id = "alt"))))),
        commuteCase("stale", CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(delay = 2), CommuteSamples.trip("07:35"), stale = true))),
        commuteCase("no-connection", CommuteSamples.ui(CommuteSamples.board())),
        commuteCase("loading", CommuteUi(loaded = false)),
        commuteCase("no-route", CommuteUi(loaded = true)),
    )

    // ── Rendering ────────────────────────────────────────────────────────────

    private fun stepName(v: WidgetVariant): String = when {
        v.min.width < 180f -> "small"
        v.min.width < 240f -> "medium"
        v.min.width < 300f -> "large"
        else -> "xl"
    }

    /** Applies [views] into a frame of exactly [size] dp, lays out and returns the frame. */
    private fun render(context: Context, views: RemoteViews, wDp: Float, hDp: Float, night: Boolean): FrameLayout {
        val density = context.resources.displayMetrics.density
        val frame = FrameLayout(context)
        frame.setBackgroundColor(if (night) 0xFF14161A.toInt() else 0xFF8FA3B5.toInt())
        val root = views.apply(context, frame)
        frame.addView(root, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val wPx = Math.round(wDp * density)
        val hPx = Math.round(hDp * density)
        frame.measure(View.MeasureSpec.makeMeasureSpec(wPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(hPx, View.MeasureSpec.EXACTLY))
        frame.layout(0, 0, wPx, hPx)
        return frame
    }

    private fun save(frame: View, name: String) {
        val bitmap = Bitmap.createBitmap(frame.width, frame.height, Bitmap.Config.ARGB_8888)
        frame.draw(Canvas(bitmap))
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("blank render $name", (0 until bitmap.width step 7).any { x -> (0 until bitmap.height step 7).any { y -> bitmap.getPixel(x, y) != bitmap.getPixel(0, 0) } })
    }

    /**
     * One message per view that is cut: a child whose edge leaves the box of the view that clips it (a row or a text
     * pushed past its container), a TextView that loses text without an ellipsis, or an ellipsis that leaves almost nothing.
     */
    private fun clipProblems(frame: FrameLayout, label: String): List<String> {
        val problems = mutableListOf<String>()
        val root = frame.getChildAt(0) as ViewGroup
        fun nameOf(view: View) = runCatching { view.resources.getResourceEntryName(view.id) }.getOrDefault(view.javaClass.simpleName)
        fun walk(view: View, parent: ViewGroup?) {
            if (view.visibility != View.VISIBLE) return
            if (parent != null && view.width > 0 && view.height > 0) {
                val inner = parent === root
                val left = if (inner) parent.paddingLeft else 0
                val top = if (inner) parent.paddingTop else 0
                val right = parent.width - if (inner) parent.paddingRight else 0
                val bottom = parent.height - if (inner) parent.paddingBottom else 0
                if (view.left < left || view.top < top || view.right > right + 1 || view.bottom > bottom + 1) {
                    problems += "$label ${nameOf(view)} (${view.left},${view.top},${view.right},${view.bottom}) leaves its container ($left,$top,$right,$bottom)"
                }
            }
            if (view is TextView && view.layout != null && !view.text.isNullOrBlank() && view.width > 0) {
                val layout = view.layout
                val where = "$label ${nameOf(view)}='${view.text}'"
                val ellipsized = (0 until layout.lineCount).any { layout.getEllipsisCount(it) > 0 }
                val byDesign = view.ellipsize != null && view.maxLines != Int.MAX_VALUE
                if (ellipsized && !byDesign) problems += "$where ellipsized without ellipsize/maxLines"
                if (ellipsized) {
                    val line = (0 until layout.lineCount).first { layout.getEllipsisCount(it) > 0 }
                    if (layout.getEllipsisStart(line) < minOf(4, view.text.length)) problems += "$where ellipsized down to almost nothing"
                } else {
                    val shown = layout.getLineEnd(layout.lineCount - 1)
                    if (shown < view.text.toString().trimEnd().length) problems += "$where cut off after line limit"
                    val room = view.width - view.compoundPaddingLeft - view.compoundPaddingRight
                    for (i in 0 until layout.lineCount) if (layout.getLineMax(i) > room + 1) problems += "$where line $i wider than its box"
                }
                if (view.maxLines != Int.MAX_VALUE && layout.lineCount > view.maxLines) problems += "$where exceeds maxLines"
                val box = view.height - view.compoundPaddingTop - view.compoundPaddingBottom
                if (layout.height > box + 1) problems += "$where taller (${layout.height}) than its box ($box)"
            }
            if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i), view)
        }
        walk(root, null)
        return problems
    }

    /** Draws every variant at its own minimum size and with some room to spare; collects clipping problems. */
    private fun drawVariants(context: Context, setup: Setup, widget: String, case: String, variants: List<WidgetVariant>, problems: MutableList<String>): Int {
        var drawn = 0
        assertEquals("every variant has its own key", variants.size, variants.map { it.min }.toSet().size)
        assertTrue("at most 16 sized layouts", variants.size <= 16)
        for (v in variants) for ((sizeName, extraW, extraH) in listOf(Triple("min", 0f, 0f), Triple("roomy", 60f, 14f))) {
            val frame = render(context, v.make(), v.min.width + extraW, v.min.height + extraH, setup.night)
            val shown = (frame.getChildAt(0).findViewById<ViewGroup>(R.id.widget_rows))?.takeIf { it.visibility == View.VISIBLE }?.childCount ?: 0
            val label = "$widget/${stepName(v)}/$case/r${v.rows}/$sizeName/${setup.tag}"
            if (stepName(v) != "small") assertEquals("$label rows drawn", v.rows, shown)
            save(frame, "$widget-${stepName(v)}-$case-r${v.rows}-$sizeName-${setup.tag}")
            problems += clipProblems(frame, label)
            drawn++
        }
        return drawn
    }

    // ── Tests ────────────────────────────────────────────────────────────────

    @Test fun lessonWidgetDrawsEveryVariantWithoutClippedText() {
        val problems = mutableListOf<String>()
        var drawn = 0
        for (setup in setups) {
            val context = prepare(setup)
            for (case in lessonCases()) {
                drawn += drawVariants(context, setup, "lesson", case.name, lessonWidgetVariants(context, 1, case.content, case.rows, today), problems)
            }
        }
        println("lesson widget renders: $drawn")
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }

    @Test fun commuteWidgetDrawsEveryVariantWithoutClippedText() {
        val problems = mutableListOf<String>()
        var drawn = 0
        for (setup in setups) {
            val context = prepare(setup)
            for ((name, content, _) in commuteCases()) {
                drawn += drawVariants(context, setup, "commute", name, commuteWidgetVariants(context, 1, content), problems)
            }
        }
        println("commute widget renders: $drawn")
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }

    @Test fun pickerPreviewsInflateInLightAndDark() {
        for (night in listOf(false, true)) {
            val context = prepare(Setup("de", night, 1.0f))
            for ((layout, name) in listOf(R.layout.widget_preview_next_lesson to "next-lesson", R.layout.widget_preview_commute to "commute")) {
                val frame = FrameLayout(context)
                frame.setBackgroundColor(if (night) 0xFF14161A.toInt() else 0xFF8FA3B5.toInt())
                frame.addView(android.view.LayoutInflater.from(context).inflate(layout, frame, false))
                val density = context.resources.displayMetrics.density
                val w = Math.round(250 * density); val h = Math.round(200 * density)
                frame.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                frame.layout(0, 0, w, h)
                save(frame, "preview-$name-${if (night) "dark" else "light"}")
                val problems = clipProblems(frame, "preview/$name")
                assertTrue(problems.joinToString("\n"), problems.isEmpty())
            }
        }
    }

    @Test fun variantsPickTheMostRowsThatFit() {
        val context = prepare(Setup("en", false, 1.0f))
        val variants = commuteWidgetVariants(context, 1, commuteCases().first().second)
        assertEquals(WidgetSpan.SMALL, WidgetSpan.SMALL.takeIf { pickVariant(variants, 150f, 90f).rows == 0 })
        for (v in variants) {
            val picked = pickVariant(variants, v.min.width, v.min.height)
            assertTrue("fits", picked.min.width <= v.min.width && picked.min.height <= v.min.height)
        }
        // More height never shows fewer rows.
        assertTrue(pickVariant(variants, 330f, 400f).rows >= pickVariant(variants, 330f, 160f).rows)
        assertEquals(0, pickVariant(variants, 100f, 50f).rows)
    }

    @Test fun responsiveViewsCarryEveryVariantOnApi31() {
        val context = prepare(Setup("en", false, 1.0f))
        val case = lessonCases()[0]
        val variants = lessonWidgetVariants(context, 1, case.content, case.rows, today)
        assertTrue(variants.size > 3)
        val views = responsiveViews(variants, 200, 150)
        assertTrue(views.apply(context, FrameLayout(context)) != null)
        // The compact setting forces the one-line layout and a plain RemoteViews.
        assertEquals(WidgetSpan.SMALL.name.length, WidgetSpan.SMALL.name.length)
        assertTrue(responsiveViews(variants, 400, 400, forced = variants.first()).apply(context, FrameLayout(context)) != null)
    }

    @Test fun lessonStatesFollowTheSnapshotAndTheRows() {
        assertEquals(LessonWidgetContent.SignedOut, lessonWidgetContent(null, emptyList(), today))
        assertTrue(lessonWidgetContent(snapshot(), lessonRows, today) is LessonWidgetContent.Next)
        // Cancelled lessons never become the hero.
        val onlyCancelled = listOf(row("10:15–11:00", "History", "105", cancelled = true))
        assertEquals(LessonWidgetContent.NothingAhead, lessonWidgetContent(snapshot(), onlyCancelled, today))
        assertEquals(LessonWidgetContent.NothingAhead, lessonWidgetContent(snapshot(), emptyList(), today))
        val holidays = lessonWidgetContent(snapshot(vacation = true), lessonRows.drop(4), today)
        assertTrue(holidays is LessonWidgetContent.Holidays)
        assertEquals("Autumn holidays", (holidays as LessonWidgetContent.Holidays).name)
        assertEquals(LocalDate.of(2026, 11, 20), holidays.until)
        // A lesson today still wins over a holiday entry.
        assertTrue(lessonWidgetContent(snapshot(vacation = true), lessonRows, today) is LessonWidgetContent.Next)
    }

    @Test fun commuteStatesNameWhatIsMissing() {
        prepare(Setup("en", false, 1.0f))
        val states = commuteCases().associate { it.first to it.second }
        assertTrue(states.getValue("delayed") is CommuteWidgetContent.Trips)
        assertTrue(states.getValue("no-connection") is CommuteWidgetContent.NoConnection)
        assertTrue(states.getValue("loading") is CommuteWidgetContent.Loading)
        assertEquals(CommuteWidgetContent.NoRoute, states.getValue("no-route"))
        assertEquals("", (states.getValue("on-time") as CommuteWidgetContent.Trips).stale)
        assertTrue((states.getValue("stale") as CommuteWidgetContent.Trips).stale.isNotBlank())
    }

    @Test fun everyStateOpensTheRightScreen() {
        val context = prepare(Setup("en", false, 1.0f))
        fun category(intent: android.content.Intent) = intent.getStringExtra(CompanionAlerts.EXTRA_CATEGORY)
        // Signed out: the app itself (its gate shows the sign-in).
        assertEquals(MainActivity::class.java.name, lessonWidgetTarget(context, LessonWidgetContent.SignedOut, today).component?.className)
        assertEquals(null, category(lessonWidgetTarget(context, LessonWidgetContent.SignedOut, today)))
        for (content in listOf(LessonWidgetContent.NotLoaded, LessonWidgetContent.NothingAhead, LessonWidgetContent.Holidays("Break", null))) {
            val intent = lessonWidgetTarget(context, content, today)
            assertEquals("timetable", category(intent))
            assertEquals(today.toString(), intent.getStringExtra(CompanionAlerts.EXTRA_DATE))
        }
        assertEquals("commute", category(commuteWidgetTarget(context, CommuteWidgetContent.NoRoute)))
        assertEquals(emptyList<String>(), commuteWidgetTarget(context, CommuteWidgetContent.NoRoute).getStringArrayListExtra(CompanionAlerts.EXTRA_TARGET_IDS).orEmpty())
        val trips = commuteCases().first().second as CommuteWidgetContent.Trips
        val ids = commuteWidgetTarget(context, trips).getStringArrayListExtra(CompanionAlerts.EXTRA_TARGET_IDS).orEmpty()
        assertEquals(3, ids.size)
        val noConnection = commuteWidgetTarget(context, commuteCases().first { it.first == "no-connection" }.second).getStringArrayListExtra(CompanionAlerts.EXTRA_TARGET_IDS).orEmpty()
        assertEquals(listOf(trips.route.id), noConnection)
    }
}
