package ch.fasrv.fanotes.companion

import android.app.Application
import android.content.Context
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.commute.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Renders the Pendelstrecken screens in light and dark over synthetic data and checks what the traveller reads. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CommuteUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Before fun language() {
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("en")
    }

    private fun show(dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit, scroll: Boolean = true) {
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = dark) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    if (scroll) Column(Modifier.verticalScroll(rememberScrollState())) { content() } else content()
                }
            }
        }
    }

    private fun card(ui: CommuteUi, invite: Boolean = true, opened: MutableList<String> = mutableListOf(), added: MutableList<Boolean> = mutableListOf()) =
        @androidx.compose.runtime.Composable { CommuteCard(ui, CommuteSamples.NOW, invite, { opened += it }, { added += true }) }

    private fun text(res: Int, vararg args: Any) = hasText(t(res, *args))

    @Test fun onTimeTripShowsDepartureLineChipsPlatformAndOccupancy() = onTimeTrip(dark = false)
    @Test fun onTimeTripInDarkMode() = onTimeTrip(dark = true)

    private fun onTimeTrip(dark: Boolean) {
        run {
            val opened = mutableListOf<String>()
            show(dark, card(CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(quietest = true))), opened = opened))
            rule.onNodeWithText("Schule").assertIsDisplayed()
            rule.onNodeWithText("07:05").assertIsDisplayed()
            rule.onNodeWithText("in 15 min").assertIsDisplayed()
            rule.onNodeWithText("371").assertIsDisplayed()
            rule.onNodeWithText("S29").assertIsDisplayed()
            rule.onNodeWithText(t(R.string.commute_quieter)).assertIsDisplayed()
            rule.onAllNodes(hasContentDescription("${t(R.string.commute_class_second)}: ${t(R.string.commute_occupancy_medium)}")).onFirst().assertIsDisplayed()
            rule.onAllNodes(hasText("Arrives 07:47", substring = true)).onFirst().assertIsDisplayed()
            rule.onNodeWithText(t(R.string.commute_transfer, "Knoten", 5) + " · " + t(R.string.commute_platform_train, "5")).assertIsDisplayed()
            rule.onNodeWithText("Schule").performClick()
            assertEquals(listOf("a1b2c3d4e5f6"), opened)
        }
    }

    @Test fun delayedTripStrikesThePlannedTimeAndShowsTheBadge() {
        show(false, card(CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(delay = 4, changed = true, tight = true)))))
        rule.onNodeWithText("07:05").assertIsDisplayed() // planned, struck through
        rule.onNodeWithText("07:09").assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_delay_minutes, 4)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_transfer_tight, "Knoten", 2) + " · " + t(R.string.commute_platform_changed, t(R.string.commute_platform_train, "5"))).assertIsDisplayed()
    }

    @Test fun cancelledTripShowsTheAlternativeAndWhenTheViaStopWasDropped() = cancelledTrip(dark = false)
    @Test fun cancelledTripInDarkMode() = cancelledTrip(dark = true)

    private fun cancelledTrip(dark: Boolean) {
        val route = CommuteSamples.route(via = CommuteSamples.hub)
        val board = CommuteSamples.board(CommuteSamples.trip(status = TripStatus.CANCELLED), alternatives = listOf(CommuteSamples.trip("07:35", delay = 7, id = "alt")), viaDropped = true)
        show(dark, card(CommuteSamples.ui(board, listOf(route))))
        rule.onNodeWithText(t(R.string.commute_trip_cancelled)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_alternative)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_alternative_no_via_named, "Knoten")).assertIsDisplayed()
        rule.onNodeWithText("07:42").assertIsDisplayed()
    }

    @Test fun brokenConnectionIsNamedAndHasNoAlternativeYet() {
        show(false, card(CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(status = TripStatus.BROKEN, broken = true)))))
        rule.onNodeWithText(t(R.string.commute_connection_missed)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_transfer_broken, "Knoten")).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_no_alternative)).assertIsDisplayed()
    }

    @Test fun cancelledLastLessonTellsWhichConnectionToTake() {
        val target = CommuteSamples.target("lastLesson", LessonChange.LAST_CANCELLED, plannedAt = CommuteSamples.at("16:15"))
        val trip = CommuteSamples.trip("15:05")
        show(false, card(CommuteSamples.ui(CommuteSamples.board(trip, target = target), listOf(CommuteSamples.route(mode = ScheduleMode.LAST_LESSON)))))
        rule.onNodeWithText(t(R.string.commute_last_cancelled_title)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_take_bus, "15:05") + "\n" + t(R.string.commute_was_planned, "16:15")).assertIsDisplayed()
    }

    @Test fun cancelledFirstLessonSaysLaterToSchool() {
        val target = CommuteSamples.target("firstLesson", LessonChange.FIRST_CANCELLED)
        show(false, card(CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip("08:05"), target = target))))
        rule.onNodeWithText(t(R.string.commute_first_cancelled_title)).assertIsDisplayed()
    }

    @Test fun staleBoardSaysSince() {
        show(false, card(CommuteSamples.ui(CommuteSamples.board(CommuteSamples.trip(), stale = true))))
        rule.onNodeWithText(t(R.string.commute_stale_since, "06:48")).assertIsDisplayed()
    }

    @Test fun withoutRoutesTheCardInvitesAndOnlyOnceKnown() {
        val added = mutableListOf<Boolean>()
        show(false, card(CommuteUi(loaded = true), added = added))
        rule.onNodeWithText(t(R.string.commute_invite_title)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_add_route)).performClick()
        assertEquals(listOf(true), added)
    }

    @Test fun nothingIsShownWhileTheRoutesAreStillUnknown() {
        show(false, card(CommuteUi(loaded = false), invite = false))
        rule.onAllNodes(hasText(t(R.string.commute_invite_title))).fetchSemanticsNodes().let { assertTrue(it.isEmpty()) }
    }

    // ── Editor ───────────────────────────────────────────────────────────────

    private class Harness(start: Route) {
        var route by mutableStateOf(start)
        val searches = mutableListOf<String>()
        var saved = 0
        var deleted = 0
    }

    private fun showEditor(harness: Harness, isNew: Boolean = true, dark: Boolean = false) {
        show(dark, scroll = false, content = {
            CommuteEditor(
                route = harness.route, isNew = isNew, defaultThreshold = 3, saving = false,
                searchStops = { q -> harness.searches += q; listOf(Stop("1", "Testdorf, Dorfplatz", StopType.BUS), Stop("2", "Testdorf Bahnhof", StopType.TRAIN)) },
                onChange = { harness.route = it }, onSave = { harness.saved++ }, onDelete = if (isNew) null else ({ harness.deleted++ }),
            )
        })
    }

    @Test fun stopSearchWaitsForTwoCharactersAndTheDebounceThenListsStopsWithTheirKind() {
        val h = Harness(Route("x"))
        rule.mainClock.autoAdvance = false
        showEditor(h)
        val field = rule.onAllNodes(hasText(t(R.string.commute_stop_hint)).or(hasText(t(R.string.commute_from)))).onFirst()
        field.performTextInput("T")
        rule.mainClock.advanceTimeBy(600)
        assertTrue("one character must not search", h.searches.isEmpty())
        field.performTextInput("e")
        rule.mainClock.advanceTimeBy(100)
        assertTrue("before the debounce", h.searches.isEmpty())
        rule.mainClock.advanceTimeBy(400)
        rule.waitForIdle()
        assertEquals(listOf("Te"), h.searches)
        rule.onAllNodes(hasText("Testdorf Bahnhof")).onFirst().assertIsDisplayed()
        rule.onAllNodes(hasText(t(R.string.commute_type_train))).onFirst().assertIsDisplayed()
        // Typing fast sends only the last text.
        field.performTextInput("s"); rule.mainClock.advanceTimeBy(100)
        field.performTextInput("t"); rule.mainClock.advanceTimeBy(600)
        rule.waitForIdle()
        assertEquals(listOf("Te", "Test"), h.searches)
        rule.onAllNodes(hasText("Testdorf, Dorfplatz")).onFirst().performClick()
        assertEquals("Testdorf, Dorfplatz", h.route.from.name)
        assertEquals(StopType.BUS, h.route.from.type)
    }

    @Test fun editorShowsScheduleControlsPerModeAndSavesOnlyWhenComplete() {
        val h = Harness(Route("x", from = CommuteSamples.home, to = CommuteSamples.school))
        showEditor(h, dark = true)
        rule.onNodeWithText(t(R.string.commute_mode_none_body)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_mode_times)).performScrollTo().performClick()
        assertEquals(ScheduleMode.TIMES, h.route.schedule.mode)
        rule.onNodeWithText(t(R.string.commute_add_time)).assertIsDisplayed()
        // Fixed times need a time: save is disabled until one exists.
        rule.onNodeWithText(t(R.string.save)).assertIsNotEnabledCompat()
        h.route = h.route.copy(schedule = h.route.schedule.copy(times = listOf("07:05", "12:40")))
        rule.waitForIdle()
        rule.onNodeWithText("07:05").assertIsDisplayed()
        rule.onNodeWithText(t(R.string.save)).performScrollTo().performClick()
        assertEquals(1, h.saved)
        rule.onNodeWithText(t(R.string.commute_mode_first)).performScrollTo().performClick()
        rule.onNodeWithText(t(R.string.commute_buffer_first, 10)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_mode_last)).performScrollTo().performClick()
        rule.onNodeWithText(t(R.string.commute_buffer_last, 10)).assertIsDisplayed()
    }

    @Test fun existingRouteCanBeDeletedAfterConfirmation() {
        val h = Harness(CommuteSamples.route())
        showEditor(h, isNew = false)
        rule.onNodeWithText(t(R.string.commute_delete_route)).performScrollTo().performClick()
        rule.onNodeWithText(t(R.string.delete)).performClick()
        assertEquals(1, h.deleted)
    }

    @Test fun routeListShowsRoutesWithReorderControls() {
        val moves = mutableListOf<Pair<String, Int>>()
        val routes = listOf(CommuteSamples.route("aaaaaaaaaaaa", "Schule"), CommuteSamples.route("bbbbbbbbbbbb", "Heimweg", ScheduleMode.LAST_LESSON))
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = false) {
                CommuteListContent(CommuteUi(loaded = true, routes = routes), {}, { r, d -> moves += r.id to d }, {}, {}, {})
            }
        }
        rule.onNodeWithText("Heimweg").assertIsDisplayed()
        rule.onNodeWithContentDescription(t(R.string.commute_move_up, "Heimweg")).performClick()
        assertEquals(listOf("bbbbbbbbbbbb" to -1), moves)
        rule.onNodeWithContentDescription(t(R.string.commute_move_up, "Schule")).assertIsNotEnabledCompat()
    }

    @Test fun alertTitlesFromTheServerAreShownInTheChosenLanguage() {
        val titles = listOf("Verspätung", "Fällt aus", "Anschluss verpasst", "Gleisänderung", "Früher nach Hause", "Später zur Schule", "Verbindung fehlt")
        AppLanguage.choose("en")
        assertEquals(listOf("Delay", "Cancelled", "Connection missed", "Platform change", "Home earlier", "Later to school", "Connection missing"), titles.map { shownText(it) })
        AppLanguage.choose("de")
        assertEquals(titles, titles.map { shownText(it) })
        AppLanguage.choose("en")
    }

    // ── Fixed connection ─────────────────────────────────────────────────────

    private val pin = Pin(listOf(1, 2, 3, 4, 5), "IR 16", "1234", "Testdorf", "9000001", "07:05", "07:47", 1)

    private fun pinnedBoard(state: PinnedState?, vararg trips: Trip, alternatives: List<Trip> = emptyList(), change: Trip? = null, target: TripTarget = CommuteSamples.target()) =
        CommuteSamples.board(*trips, alternatives = alternatives, target = target).copy(pinned = state, change = change)

    @Test fun pinnedRouteShowsThePinnedTripAndHidesOthersBehindAnExpander() {
        val p = CommuteSamples.trip("07:05", delay = 4, id = "pin")
        val other = CommuteSamples.trip("07:35", id = "other")
        val board = pinnedBoard(PinnedState(PinStatus.OK, CommuteSamples.DAY, pin, p), p, other)
        show(false, card(CommuteSamples.ui(board)))
        rule.onNodeWithText("07:09").assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_delay_minutes, 4)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_other_show)).assertIsDisplayed()
        assertTrue(rule.onAllNodes(hasText("07:35")).fetchSemanticsNodes().isEmpty())
        rule.onNodeWithText(t(R.string.commute_other_show)).performClick()
        rule.onNodeWithText("07:35").assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_other_hide)).assertIsDisplayed()
    }

    @Test fun movedPinSaysTheNewTime() {
        val p = CommuteSamples.trip("07:12", id = "pin")
        show(false, card(CommuteSamples.ui(pinnedBoard(PinnedState(PinStatus.MOVED, CommuteSamples.DAY, pin, p), p))))
        rule.onNodeWithText(t(R.string.commute_pin_moved, "07:12")).assertIsDisplayed()
    }

    @Test fun missingPinSaysSoOffersTheNearestTripAndARepickButton() {
        val near = CommuteSamples.trip("07:20", id = "near")
        val repicks = mutableListOf<String>()
        val board = pinnedBoard(PinnedState(PinStatus.MISSING, CommuteSamples.DAY, pin, null, near), near)
        show(false, { CommuteCard(CommuteSamples.ui(board), CommuteSamples.NOW, true, {}, {}, onRepick = { repicks += it }) })
        rule.onNodeWithText(t(R.string.commute_pin_missing_title)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_pin_nearest)).assertIsDisplayed()
        rule.onNodeWithText("07:20").assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_pin_repick)).performClick()
        assertEquals(listOf("a1b2c3d4e5f6"), repicks)
    }

    @Test fun cancelledPinShowsTheAlternativesProminentlyAndALessonChangeLine() {
        val p = CommuteSamples.trip("07:05", status = TripStatus.CANCELLED, id = "pin")
        val alt = CommuteSamples.trip("07:35", id = "alt")
        val early = CommuteSamples.trip("12:40", id = "early")
        val target = CommuteSamples.target("lastLesson", LessonChange.LAST_CANCELLED)
        val board = pinnedBoard(PinnedState(PinStatus.OK, CommuteSamples.DAY, pin, p), p, alternatives = listOf(alt), change = early, target = target)
        show(false, card(CommuteSamples.ui(board)))
        rule.onNodeWithText(t(R.string.commute_alternative)).assertIsDisplayed()
        rule.onNodeWithText(t(R.string.commute_change_last, "12:40 371")).assertIsDisplayed()
    }

    @Test fun editorOffersASecondViaOnlyAfterTheFirstAndKeepsTheOrder() {
        val h = Harness(Route("x", from = CommuteSamples.home, to = CommuteSamples.school))
        showEditor(h)
        assertTrue(rule.onAllNodes(hasText(t(R.string.commute_optional, t(R.string.commute_via_second)))).fetchSemanticsNodes().isEmpty())
        h.route = withViaAt(h.route, 0, CommuteSamples.hub)
        rule.waitForIdle()
        rule.onNodeWithText(t(R.string.commute_optional, t(R.string.commute_via_second))).performScrollTo().assertIsDisplayed()
        h.route = withViaAt(h.route, 1, Stop("5", "Zwischen", StopType.BUS))
        rule.waitForIdle()
        assertEquals(listOf("Knoten", "Zwischen"), h.route.vias.map { it.name })
    }

    @Test fun changingTheStopsClearsThePinsAndThePinSectionNeedsStops() {
        val pinned = CommuteSamples.route().copy(pins = listOf(pin))
        val h = Harness(pinned)
        showEditor(h)
        rule.onNodeWithText(t(R.string.commute_pin_title)).performScrollTo().assertIsDisplayed()
        rule.onNodeWithText(commutePinSummary(pin)).performScrollTo().assertIsDisplayed()
        rule.onNodeWithContentDescription(t(R.string.commute_clear_stop, t(R.string.commute_to))).performScrollTo().performClick()
        assertTrue(h.route.pins.isEmpty())
        rule.waitForIdle()
        rule.onNodeWithText(t(R.string.commute_pin_cleared)).performScrollTo().assertIsDisplayed()
    }

    // ── Widget rows ──────────────────────────────────────────────────────────

    private fun inflate(row: CommuteRow, wide: Boolean): View {
        val context = ApplicationProvider.getApplicationContext<Context>()
        return commuteRowViews(context, row, wide, "a1b2c3d4e5f6").apply(context, FrameLayout(context))
    }

    private fun View.text(id: Int) = (findViewById<TextView>(id)).text.toString()

    @Test fun widgetRowsShowDepartureDelayLinePlatformAndStatus() {
        val board = CommuteSamples.board(CommuteSamples.trip(delay = 4), alternatives = emptyList())
        val rows = commuteRows(board)
        val view = inflate(rows.first(), wide = true)
        assertEquals("07:09", view.text(R.id.row_dep))
        assertEquals("+4", view.text(R.id.row_delay))
        assertEquals("371", view.text(R.id.row_line))
        assertEquals(t(R.string.commute_arrive_short, "07:47"), view.text(R.id.row_arrive))
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.row_occ).visibility)
        val compact = inflate(rows.first(), wide = false)
        assertEquals("07:09", compact.text(R.id.row_dep))
        assertTrue(compact.findViewById<View>(R.id.row_arrive) == null)
    }

    @Test fun widgetRowOfACancelledTripAndItsAlternative() {
        val board = CommuteSamples.board(CommuteSamples.trip(status = TripStatus.CANCELLED), alternatives = listOf(CommuteSamples.trip("07:35", id = "alt")))
        val rows = commuteRows(board)
        assertEquals(listOf(false, true), rows.map { it.alternative })
        assertEquals(t(R.string.commute_cancelled), inflate(rows[0], true).text(R.id.row_status))
        assertEquals(t(R.string.commute_alternative_short), inflate(rows[1], true).text(R.id.row_status))
        assertEquals(View.GONE, inflate(rows[0], true).findViewById<View>(R.id.row_occ).visibility)
    }
}

private fun androidx.compose.ui.test.SemanticsNodeInteraction.assertIsNotEnabledCompat() = assertIsNotEnabled()
