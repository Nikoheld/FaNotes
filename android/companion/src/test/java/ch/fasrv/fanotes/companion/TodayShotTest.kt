package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.schulnetz.DeskPrefs
import ch.fasrv.fanotes.schulnetz.TeacherAbsenceDay
import ch.fasrv.fanotes.schulnetz.toNormalizedJson
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the Today screen (the real [TodayScreen] over a real model on the synthetic school year) to PNG for a design
 * review: German, phone size, light and dark. Runs only with KANTI_SHOT_DIR set; CI never sets it.
 * KANTI_SHOT_NAME (default "after") is the file name part: today-<name>-light.png.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
abstract class TodayShotBase(private val suffix: String) {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val out = System.getenv("KANTI_SHOT_DIR").orEmpty()
    private val name = System.getenv("KANTI_SHOT_NAME").orEmpty().ifBlank { "after" }

    @Before fun language() {
        assumeTrue(out.isNotBlank())
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("de")
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun buildModel(): CompanionModel {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val today = LocalDate.now()
        val zurich = LocalDate.now(ZoneId.of("Europe/Zurich"))
        // One exam three days out, one absence-teacher read for today, everything else from the shared fixture.
        val base = PerfFixture.buildSnapshot(today)
        val soon = base.exams.filter { it.start.take(10) >= today.toString() }.minByOrNull { it.start }!!
        val snapshot = base.copy(
            exams = listOf(soon),
            teacherAbsences = TeacherAbsenceDay(zurich.toString(), absent = listOf("Lehrperson A", "Lehrperson C", "Lehrperson F"), excursion = listOf("Lehrperson K")),
        )
        slotFile(app, ch.fasrv.fanotes.schulnetz.PRIMARY_SLOT, "schulnetz-snapshot.json").writeText(snapshot.toNormalizedJson())
        app.getSharedPreferences("fanotes-companion", android.content.Context.MODE_PRIVATE).edit().putBoolean("school-linked", true).commit()
        val menus = """[{"name":"Gemüsecurry","description":"Reis, Kokosmilch, Saisongemüse","label":"Vegi","price":13.5,"studentPrice":10.5},
            {"name":"Pouletgeschnetzeltes","description":"Rahmsauce, Nudeln, Salat","label":"Fleisch","price":15.0,"studentPrice":11.5},
            {"name":"Salatteller","description":"Saisonsalat","label":"Salat","price":11.0,"studentPrice":8.5}]"""
        val days = (-3L..10L).map { today.plusDays(it) }.filter { it.dayOfWeek.value < 6 }.joinToString(",") { """{"date":"$it","closed":false,"note":"","menus":$menus}""" }
        File(app.filesDir, "mensa.json").writeText("""{"fetchedAt":"${java.time.Instant.now()}","stale":false,"days":[$days]}""")
        val (commuteState, commuteBoard) = CommuteSamples.fixtureFiles(java.time.ZonedDateTime.now(), 45)
        File(app.filesDir, "commute").also { dir ->
            dir.mkdirs()
            File(dir, CommuteStore.STATE_FILE).writeText(commuteState)
            File(dir, CommuteStore.BOARD_FILE).writeText(commuteBoard)
        }
        val graph = CompanionGraph(app)
        graph.commuteRequestsAllowed = false
        val waitStart = System.currentTimeMillis()
        while (!graph.snapshotReady.value && System.currentTimeMillis() - waitStart < 20_000) { idle(); Thread.sleep(10) }
        graph.saveDeskPrefs(DeskPrefs(theme = "system", showMensa = true, showTeacherAbsences = true, showPluspunkte = true))
        graph.saveHomeworkTask(HomeworkTask(id = "shot-1", title = "Übungsblatt 4 lösen", subject = "Mathematik", dueDate = today.toString(), createdAt = "2026-09-01T08:00:00Z"))
        graph.saveHomeworkTask(HomeworkTask(id = "shot-2", title = "Vokabeln Unit 5 lernen", subject = "Englisch", dueDate = today.plusDays(1).toString(), createdAt = "2026-09-01T08:00:00Z"))
        graph.markOnboardingSeen(); graph.setLocalAccess(true)
        val model = CompanionModel(graph)
        val readyStart = System.currentTimeMillis()
        while ((!model.schoolReady || model.loading || model.tasks.isEmpty()) && System.currentTimeMillis() - readyStart < 20_000) { idle(); Thread.sleep(10) }
        model.mensa = graph.mensaStore.cached()
        val commuteBy = System.currentTimeMillis() + 10_000
        while (!model.commute.loaded && System.currentTimeMillis() < commuteBy) { idle(); Thread.sleep(10) }
        val now = System.currentTimeMillis()
        model.tree = listOf("Mathe Zusammenfassung", "Ideen Projektwoche", "Leseliste").mapIndexed { index, title ->
            VaultNode(title, "$title.md", NoteKind.MARKDOWN, now - index * 3_600_000L)
        }
        model.notesAccount = true
        return model
    }

    private fun shot(dark: Boolean) {
        val model = buildModel()
        model.lastSyncOk = System.currentTimeMillis()
        rule.mainClock.autoAdvance = false
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = dark, accent = model.desk.accent, amoled = model.desk.amoled, reducedMotion = false, online = true) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { CompanionRoot(model) }
            }
        }
        repeat(40) { rule.mainClock.advanceTimeByFrame(); idle(); Thread.sleep(5) }
        // The synthetic library has no server behind it; its failed reload must not put a banner into the shot.
        model.loadError = null
        repeat(5) { rule.mainClock.advanceTimeByFrame(); idle() }
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(out).mkdirs()
        File(out, "today-$name-${if (dark) "dark" else "light"}$suffix.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun light() = shot(dark = false)
    @Test fun dark() = shot(dark = true)
}

/** The first screen of a tall phone (411 x 891 dp). */
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
class TodayShotTest : TodayShotBase("")

/** The whole page on one tall canvas, to review the sections below the first screen. */
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h1900dp-xxhdpi")
class TodayShotFullTest : TodayShotBase("-full")
