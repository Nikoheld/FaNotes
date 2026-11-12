package ch.fasrv.fanotes.companion

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.commute.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Renders the connection detail over synthetic data and checks what the traveller reads. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CommuteDetailUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Before fun language() {
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("en")
    }

    private fun at(clock: String) = CommuteSamples.at(clock)
    private fun time(planned: String, real: String = planned, delay: Int? = 0) = StopTime(at(planned), at(real), delay)
    private fun point(name: String, planned: String, real: String = planned, delay: Int? = 0, platform: String = "", changed: Boolean = false) =
        Point(name, "", at(real), at(planned), delay, platform, changed)

    /** Train with four intermediate stops (delay, no real time, cancelled), a tight change, a walk and a bus. */
    private fun trip(change: Transfer = Transfer("Knoten", 2, 7, tight = true)): Trip {
        val train = Leg(
            kind = "ride", line = "IR37", category = "IR", type = StopType.TRAIN, operator = "Testbahn", direction = "Knoten",
            fgColor = "fff", bgColor = "e2001a", occupancy = Occupancy(1, 2), minutes = 22, journeyId = "j1", stopCount = 3,
            from = point("Teststadt", "23:40", platform = "3"),
            to = point("Knoten", "00:00", "00:02", 2, platform = "5", changed = true),
            stops = listOf(
                LegStop("Mittelhausen", "2", time("23:51", "23:52", 1), time("23:52", "23:53", 1), platform = "4"),
                LegStop("Dorf B", "3", StopTime(at("23:56"), at("23:56"), null), null, realtime = false),
                LegStop("Dorf C", "4", time("23:58"), time("23:58"), cancelled = true),
            ),
        )
        val walk = Leg(kind = "walk", minutes = 4, from = point("Knoten", "00:02"), to = point("Knoten Bus", "00:06"))
        val bus = Leg(
            kind = "ride", line = "31", category = "B", type = StopType.BUS, direction = "Schulstadt", fgColor = "fff", bgColor = "039",
            from = point("Knoten Bus", "00:07", platform = "B"), to = point("Schulstadt", "00:18", "00:20", 2), minutes = 13, stopCount = 0,
        )
        return Trip(
            id = "t1", departure = at("23:40"), arrival = at("00:20"), plannedDeparture = at("23:40"), plannedArrival = at("00:18"),
            depDelay = 0, arrDelay = 2, minutes = 40, transfers = 1, status = TripStatus.DELAYED,
            legs = listOf(train, walk, bus), changes = listOf(change), occupancy = Occupancy(1, 2),
        )
    }

    private fun detail(position: Position? = Position(PositionState.BETWEEN, 0, 1, 0.4, true), trip: Trip? = trip(), gone: Boolean = false, stale: Boolean = false, platforms: String? = "transport.opendata.ch") =
        TripDetail(trip, position, at("23:48"), stale, gone, DetailSources("search.ch", platforms, null))

    private fun show(ui: TripDetailUi, dark: Boolean = false, onRetry: () -> Unit = {}, onRoute: () -> Unit = {}) {
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = dark) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    CommuteTripDetailContent(ui, "Schule", onRefresh = {}, onRetry = onRetry, onOpenRoute = onRoute)
                }
            }
        }
    }

    /** The list composes only what is near the viewport: scroll to the node first. */
    private fun reveal(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        rule.onNode(hasScrollAction()).performScrollToNode(matcher)
        return rule.onNode(matcher)
    }

    private fun text(res: Int, vararg args: Any) = t(res, *args)

    @Test fun headerShowsTimesDurationTransfersStatusAndRouteName() = header(dark = false)
    @Test fun headerInDarkMode() = header(dark = true)

    private fun header(dark: Boolean) {
        show(TripDetailUi(detail = detail()), dark)
        rule.onNodeWithText("Schule").assertIsDisplayed()
        rule.onAllNodes(hasText("23:40")).onFirst().assertIsDisplayed()
        rule.onAllNodes(hasText("00:20")).onFirst().assertIsDisplayed()
        rule.onAllNodes(hasText("00:18")).onFirst().assertIsDisplayed() // planned arrival, struck
        rule.onNodeWithText("40 min · 1 change").assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_on_time)).assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_detail_all_connections)).assertIsDisplayed()
    }

    @Test fun legShowsChipDirectionOperatorAndOccupancy() {
        show(TripDetailUi(detail = detail()))
        rule.onNodeWithText("IR 37").assertIsDisplayed()
        rule.onNodeWithText("→ Knoten").assertIsDisplayed()
        rule.onNodeWithText("Testbahn").assertIsDisplayed()
        rule.onNode(hasContentDescription("${text(R.string.commute_class_second)}: ${text(R.string.commute_occupancy_medium)}")).assertIsDisplayed()
        reveal(hasText("Bus 31")).assertIsDisplayed()
    }

    @Test fun collapsedTimelineShowsBoardingExitAndTheStopsAroundTheVehicle() {
        show(TripDetailUi(detail = detail()))
        rule.onNodeWithText("Teststadt").assertIsDisplayed()
        rule.onNodeWithText("Mittelhausen").assertIsDisplayed()
        rule.onNodeWithText("Dorf B").assertIsDisplayed()
        // Dorf C is folded away behind "1 intermediate stop".
        assertTrue(rule.onAllNodes(hasText("Dorf C")).fetchSemanticsNodes().isEmpty())
        rule.onNodeWithText(tp(R.plurals.commute_detail_stops, 1, 1)).assertIsDisplayed()
        rule.onNodeWithText("Knoten").assertIsDisplayed()
    }

    @Test fun expandingShowsTheCancelledStopStruckWithItsNoteAndFoldsAgain() {
        show(TripDetailUi(detail = detail()))
        rule.onNodeWithText(tp(R.plurals.commute_detail_stops, 1, 1)).performClick()
        rule.onNodeWithText("Dorf C").assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_detail_stop_cancelled)).assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_detail_hide_stops)).performClick()
        assertTrue(rule.onAllNodes(hasText("Dorf C")).fetchSemanticsNodes().isEmpty())
    }

    @Test fun intermediateDelayPlatformAndNoRealtimeMarkers() {
        show(TripDetailUi(detail = detail()))
        rule.onNodeWithText("23:52").assertIsDisplayed() // real arrival
        rule.onNodeWithText("23:51").assertIsDisplayed() // planned arrival, struck
        rule.onNodeWithText(text(R.string.commute_delay_minutes, 1)).assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_platform_train, "4")).assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_detail_no_realtime)).assertIsDisplayed()
        // The stop without a delay value shows its planned time only, never a computed one.
        rule.onNodeWithText("23:56").assertIsDisplayed()
    }

    @Test fun exitStopShowsTheChangedPlatform() {
        show(TripDetailUi(detail = detail()))
        reveal(hasText(text(R.string.commute_platform_changed, text(R.string.commute_platform_train, "5")))).assertIsDisplayed()
    }

    @Test fun stopRowReadsAsOneSentenceForTalkBack() {
        show(TripDetailUi(detail = detail()))
        val vehicle = text(R.string.commute_a11y_vehicle_next)
        rule.onNode(hasContentDescription("Mittelhausen, arrives 23:51, departs 23:52, plus 1 minute, ${text(R.string.commute_platform_train, "4")}, $vehicle")).assertIsDisplayed()
        rule.onNode(hasContentDescription("Dorf B, arrives 23:56, ${text(R.string.commute_detail_no_realtime)}")).assertIsDisplayed()
    }

    @Test fun stopRowReadsInGerman() {
        AppLanguage.choose("de")
        try {
            val onTime = trip().let { it.copy(legs = it.legs.map { leg -> if (leg.walk) leg else leg.copy(stops = leg.stops.take(1)) }) }
            show(TripDetailUi(detail = detail(position = null, trip = onTime)))
            rule.onNodeWithText(tp(R.plurals.commute_detail_stops, 1, 1)).performClick()
            rule.onNode(hasContentDescription("Mittelhausen, an 23:51, ab 23:52, plus 1 Minute, Gleis 4")).assertIsDisplayed()
        } finally { AppLanguage.choose("en") }
    }

    @Test fun positionBannerSaysBetweenTwoStopsAndEstimated() {
        show(TripDetailUi(detail = detail()))
        rule.onNodeWithText("${text(R.string.commute_pos_between, "Mittelhausen", "Dorf B")} (${text(R.string.commute_pos_estimated)})").assertIsDisplayed()
    }

    @Test fun positionStatesHaveTheirOwnTexts() {
        val cases = listOf(
            Position(PositionState.NOT_STARTED) to text(R.string.commute_pos_not_started),
            Position(PositionState.AT_STOP, 0, 2) to text(R.string.commute_pos_at, "Dorf B"),
            Position(PositionState.TRANSFER, 0, 4) to text(R.string.commute_pos_transfer, "Knoten"),
            Position(PositionState.ARRIVED, 2, 1) to text(R.string.commute_pos_arrived),
        )
        for ((position, expected) in cases) {
            show(TripDetailUi(detail = detail(position)))
            rule.onNodeWithText(expected).assertIsDisplayed()
            rule.activityRule.scenario.recreate()
        }
    }

    @Test fun tightChangeWalkAndFooter() {
        show(TripDetailUi(detail = detail()))
        reveal(hasText(text(R.string.commute_detail_walk, 4))).assertIsDisplayed()
        reveal(hasText(text(R.string.commute_detail_transfer_tight))).assertIsDisplayed()
        reveal(hasText("Real time: search.ch · Platforms: transport.opendata.ch")).assertIsDisplayed()
        reveal(hasText(text(R.string.commute_detail_asof, "23:48"))).assertIsDisplayed()
        reveal(hasText(text(R.string.commute_detail_formation_none))).assertIsDisplayed()
    }

    @Test fun missedChangeIsNamed() {
        show(TripDetailUi(detail = detail(trip = trip(Transfer("Knoten", 0, 7, broken = true)))))
        reveal(hasText(text(R.string.commute_detail_transfer_broken))).assertIsDisplayed()
    }

    @Test fun footerWithoutPlatformSourceNamesRealtimeOnly() {
        show(TripDetailUi(detail = detail(platforms = null)))
        reveal(hasText("Real time: search.ch")).assertIsDisplayed()
    }

    @Test fun goneConnectionSaysSoAndLeadsBackToTheRoute() {
        var back = 0
        show(TripDetailUi(detail = detail(trip = null, position = null, gone = true)), onRoute = { back++ })
        rule.onNodeWithText(text(R.string.commute_detail_gone)).assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_detail_back_route)).performClick()
        assertEquals(1, back)
    }

    @Test fun failedFirstLoadOffersRetry() {
        var retries = 0
        show(TripDetailUi(failed = true), onRetry = { retries++ })
        rule.onNodeWithText(text(R.string.commute_detail_error)).assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_detail_retry)).performClick()
        assertEquals(1, retries)
    }

    @Test fun loadingShowsTheBoardTripWithoutStopsSoNothingJumps() {
        show(TripDetailUi(seed = trip()))
        rule.onNodeWithText("IR 37").assertIsDisplayed()
        rule.onNodeWithText("Teststadt").assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_detail_loading_stops)).assertIsDisplayed()
        assertTrue(rule.onAllNodes(hasText("Mittelhausen")).fetchSemanticsNodes().isEmpty())
    }

    @Test fun staleAndFailedRefreshKeepTheOldDataWithANote() {
        show(TripDetailUi(detail = detail(stale = true), failed = true))
        rule.onNodeWithText(text(R.string.commute_detail_refresh_failed)).assertIsDisplayed()
        rule.onNodeWithText(text(R.string.commute_stale_since, "23:48")).assertIsDisplayed()
        rule.onNodeWithText("Mittelhausen").assertIsDisplayed()
    }

    @Test fun allConnectionsLeadsToTheRoute() {
        var opened = 0
        show(TripDetailUi(detail = detail()), onRoute = { opened++ })
        rule.onNodeWithText(text(R.string.commute_detail_all_connections)).performClick()
        assertEquals(1, opened)
    }
}
