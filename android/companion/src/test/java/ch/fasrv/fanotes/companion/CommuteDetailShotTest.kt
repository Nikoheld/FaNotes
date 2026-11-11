package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.commute.*
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the connection detail to PNG for a design review (German, light and dark, phone size).
 * Runs only with KANTI_SHOT_DIR set; CI never sets it.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CommuteDetailShotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val out = System.getenv("KANTI_SHOT_DIR").orEmpty()

    @Before fun language() {
        assumeTrue(out.isNotBlank())
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("de")
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


    private fun shot(name: String, dark: Boolean) {
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = dark) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    CommuteTripDetailContent(TripDetailUi(detail = detail()), "Schulweg", onRefresh = {}, onRetry = {}, onOpenRoute = {})
                }
            }
        }
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(out).mkdirs()
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun light() = shot("android-detail-light", dark = false)
    @Test fun dark() = shot("android-detail-dark", dark = true)
}
