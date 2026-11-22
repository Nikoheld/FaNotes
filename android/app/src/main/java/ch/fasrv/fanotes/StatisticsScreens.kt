package ch.fasrv.fanotes

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.Style
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.desk.StatKind
import ch.fasrv.fanotes.desk.StatsProgress
import ch.fasrv.fanotes.desk.VaultStats
import kotlinx.coroutines.launch

private fun t(source: String) = ChromeText.ui(source)

private val KIND_LABEL = mapOf(
    StatKind.MARKDOWN to "Markdown",
    StatKind.HANDWRITING to "Handschrift",
    StatKind.PDF to "PDF",
    StatKind.STORY to "Geschichten",
    StatKind.IMAGE to "Bilder",
    StatKind.MEDIA to "Andere Dateien",
)

private fun folderColor(hex: String?, fallback: Color): Color =
    runCatching { Color(android.graphics.Color.parseColor(hex ?: return fallback)) }.getOrDefault(fallback)

/** Settings → Statistik: vault, activity, writing, study time, school, cards, sync, and the opt-in diagnostics card. */
@Composable
internal fun StatisticsSection(model: FaNotesViewModel, viewportWidth: Int, anchorY: MutableMap<String, Int>) {
    val stats by model.vaultStats.collectAsStateWithLifecycle()
    val progress by model.vaultStatsProgress.collectAsStateWithLifecycle()
    val failed by model.vaultStatsFailed.collectAsStateWithLifecycle()
    // Compute when the page opens, stop when it closes.
    DisposableEffect(Unit) {
        model.diagnostics.recordFeature("view.statistics")
        model.loadVaultStats()
        onDispose { model.cancelVaultStats() }
    }
    val ink = LocalStatusInk.current
    val busy = progress != null
    Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTING_CARD_MARGIN_DP.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            val status = when (progress?.phase) {
                "notes" -> "Notizen werden gelesen"
                "history" -> "Verlauf wird gelesen"
                "tree" -> "Notizen werden gelesen"
                else -> null
            }
            Text(
                when {
                    failed -> t("Statistik konnte nicht gelesen werden. Tippe auf „Neu berechnen“.")
                    busy && status != null -> t(status) + " …" + progressCount(progress)
                    else -> t("Nur auf diesem Gerät berechnet")
                },
                fontSize = 12.sp,
                color = if (failed) MaterialTheme.colorScheme.error else ink.muted,
                modifier = Modifier.weight(1f),
            )
            Text(
                t("Neu berechnen"),
                fontSize = 12.sp,
                fontWeight = FontWeight(600),
                color = ink.soft,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(enabled = !busy) { model.loadVaultStats(force = true) }
                    .heightIn(min = 32.dp)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().height(3.dp), color = MaterialTheme.colorScheme.primary, trackColor = ink.muted.copy(alpha = 0.2f))
        val data = stats
        if (data == null) {
            StatSkeleton()
        } else {
            VaultCards(data, anchorY)
            ActivityCard(data, anchorY)
            WritingCard(data)
            TimeCard(data)
            SchoolCard(data)
            CardsCard(data)
        }
        SyncStatsCard(model)
        DiagnosticsCard(model, anchorY)
    }
}

@Composable
private fun StatSkeleton() {
    val ink = LocalStatusInk.current
    repeat(3) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(88.dp)
                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SETTING_CARD_RADIUS_DP.dp))
                .background(ink.muted.copy(alpha = 0.10f))
                .semantics { contentDescription = t("Notizen werden gelesen") },
        )
    }
}

@Composable
private fun StatLine(label: String, value: String, detail: String? = null, divider: Boolean = true) {
    SettingRow(label, detail, divider = divider) {
        VerbatimText(value, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun Bar(fraction: Float, color: Color, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(5.dp).clip(RoundedCornerShape(3.dp)).background(LocalStatusInk.current.muted.copy(alpha = 0.18f))) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0.02f, 1f)).height(5.dp).background(color))
    }
}

@Composable
private fun Empty(text: String) {
    Text(t(text), fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(15.dp))
}

private fun count(value: Int) = ch.fasrv.fanotes.desk.statCount(value, ChromeText.language)

/** " 1’234 / 20’000" while the loader reports how far it is, else nothing. */
private fun progressCount(progress: StatsProgress?): String = when {
    progress == null || progress.done <= 0 -> ""
    progress.total > 0 -> " ${count(progress.done)} / ${count(progress.total)}"
    else -> " ${count(progress.done)}"
}

@Composable
private fun VaultCards(data: VaultStats, anchorY: MutableMap<String, Int>) {
    val accent = MaterialTheme.colorScheme.primary
    SettingCard("Vault", Icons.Filled.Folder, Modifier.settingsAnchor("statistics", "settings-stat-vault", anchorY)) {
        StatLine("Notizen", count(data.totals.notes))
        StatLine("Grösse des Vaults", ch.fasrv.fanotes.sync.syncByteLabel(data.totals.bytes), "${count(data.totals.files)} " + t("Dateien") + " · ${count(data.totals.folders)} " + t("Ordner"))
        val top = data.kinds.values.maxOfOrNull { it.count }?.coerceAtLeast(1) ?: 1
        val kinds = StatKind.values().filter { (data.kinds[it]?.count ?: 0) > 0 }
        kinds.forEachIndexed { index, kind ->
            val row = data.kinds.getValue(kind)
            SettingRow(KIND_LABEL.getValue(kind), ch.fasrv.fanotes.sync.syncByteLabel(row.bytes), divider = index != kinds.lastIndex) {
                Column(Modifier.fillMaxWidth()) {
                    Text(count(row.count), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Bar(row.count.toFloat() / top, accent, Modifier.padding(top = 4.dp).heightIn(max = 5.dp))
                }
            }
        }
    }
    SettingCard("Fächer und Ordner", Icons.Filled.Folder) {
        if (data.subjects.isEmpty()) Empty("Noch keine Ordner.")
        val peak = data.subjects.maxOfOrNull { it.count }?.coerceAtLeast(1) ?: 1
        data.subjects.take(12).forEachIndexed { index, subject ->
            val color = folderColor(subject.color, accent)
            Column(Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 9.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(9.dp).clip(CircleShape).background(color))
                    VerbatimText(subject.name, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(
                        "${count(subject.count)} · ${ch.fasrv.fanotes.sync.syncByteLabel(subject.bytes)}" + if (subject.words > 0) " · ${count(subject.words)} " + t("Wörter") else "",
                        fontSize = 11.sp, color = LocalStatusInk.current.muted,
                    )
                }
                Bar(subject.count.toFloat() / peak, color, Modifier.padding(top = 5.dp))
            }
            if (index != minOf(data.subjects.size, 12) - 1) Box(Modifier.fillMaxWidth().height(1.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)))
        }
    }
    FileListCard("Grösste Notizen", data.largest) { ch.fasrv.fanotes.sync.syncByteLabel(it.size) }
    FileListCard("Zuletzt bearbeitet", data.recent) { ch.fasrv.fanotes.desk.overviewModifiedLabel(it.mtime) }
    FileListCard("Neueste Notizen", data.newest) { ch.fasrv.fanotes.desk.overviewModifiedLabel(if (it.ctime > 0) it.ctime else it.mtime) }
}

@Composable
private fun FileListCard(title: String, rows: List<ch.fasrv.fanotes.desk.StatFileRow>, value: (ch.fasrv.fanotes.desk.StatFileRow) -> String) {
    SettingCard(title, Icons.Filled.Description) {
        if (rows.isEmpty()) Empty("Noch nichts vorhanden.")
        rows.forEachIndexed { index, row ->
            SettingRow(
                ch.fasrv.fanotes.vault.titleOf(row.path).ifBlank { row.name },
                ch.fasrv.fanotes.desk.overviewPathParent(row.path),
                divider = index != rows.lastIndex,
            ) { VerbatimText(value(row), fontSize = 12.sp, color = LocalStatusInk.current.soft) }
        }
    }
}

@Composable
private fun ActivityCard(data: VaultStats, anchorY: MutableMap<String, Int>) {
    val accent = MaterialTheme.colorScheme.primary
    val ink = LocalStatusInk.current
    SettingCard("Aktivität", Icons.Filled.BarChart, Modifier.settingsAnchor("statistics", "settings-stat-activity", anchorY)) {
        StatLine("Tage in Folge", count(data.activity.streak.current))
        StatLine("Längste Serie", count(data.activity.streak.longest))
        StatLine("Aktive Tage", count(data.activity.streak.activeDays))
        BoxWithConstraints(Modifier.fillMaxWidth().padding(15.dp)) {
            // As many weeks as fit: up to a year on a wide tablet, about half a year when narrow.
            val cell = 11.dp
            val gap = 3.dp
            val weeks = ((maxWidth + gap) / (cell + gap)).toInt().coerceIn(8, ch.fasrv.fanotes.desk.STATS_HEATMAP_WEEKS)
            val cells = data.activity.cells.takeLast(weeks * 7)
            val description = t("Aktivitätskalender")
            Canvas(
                Modifier
                    .fillMaxWidth()
                    .height(cell * 7 + gap * 6)
                    .semantics { contentDescription = ui(description) },
            ) {
                val size = cell.toPx()
                val step = (cell + gap).toPx()
                cells.forEachIndexed { index, day ->
                    val column = index / 7
                    val row = index % 7
                    val color = if (day.level == 0) ink.muted.copy(alpha = 0.14f) else accent.copy(alpha = 0.22f + 0.78f * day.level / 4f)
                    drawRoundRect(color, Offset(column * step, row * step), Size(size, size), CornerRadius(2.dp.toPx()))
                }
            }
        }
        val weeks = data.activity.weeks
        val peak = weeks.maxOfOrNull { it.edited }?.coerceAtLeast(1) ?: 1
        Column(Modifier.fillMaxWidth().padding(start = 15.dp, end = 15.dp, bottom = 14.dp)) {
            Text(t("Bearbeitet pro Woche"), fontSize = 11.sp, color = ink.muted)
            Row(Modifier.fillMaxWidth().height(46.dp).padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
                weeks.forEach { week ->
                    Box(Modifier.weight(1f).height((3 + 40f * week.edited / peak).dp).clip(RoundedCornerShape(2.dp)).background(accent.copy(alpha = if (week.edited > 0) 0.85f else 0.25f)))
                }
            }
        }
    }
}

@Composable
private fun WritingCard(data: VaultStats) {
    val w = data.writing
    SettingCard("Schreiben", Icons.Filled.Edit) {
        StatLine(
            "Wörter in Notizen", count(w.wordsInNotes),
            if (data.partialNotes > 0) "${count(data.partialNotes)} " + t("Notizen nur teilweise gezählt (sehr gross)") else null,
        )
        StatLine("Wörter getippt", count(w.wordsTyped))
        StatLine("Wörter in Geschichten", count(w.storyWords))
        StatLine("Handschrift-Striche", count(w.strokes))
        StatLine("Schreibzeit mit Stift", ch.fasrv.fanotes.desk.formatStudyDuration(w.penMs), divider = false)
    }
}

@Composable
private fun TimeCard(data: VaultStats) {
    val accent = MaterialTheme.colorScheme.primary
    val time = data.time
    SettingCard("Lernzeit", Icons.Filled.Timer) {
        StatLine("Zeit in Notizen", ch.fasrv.fanotes.desk.formatStudyDuration(time.dwellMs), "${count(time.notesMeasured)} " + t("Notizen"))
        if (time.dwellMs <= 0) {
            Empty("Die Zeit wird pro Notiz auf diesem Gerät mitgezählt, sobald du Notizen öffnest.")
            return@SettingCard
        }
        Column(Modifier.fillMaxWidth().padding(15.dp)) {
            Text(t("Zeit pro Wochentag"), fontSize = 11.sp, color = LocalStatusInk.current.muted)
            // Index 0 is Sunday; the week reads Monday first.
            val order = listOf(1 to "Mo", 2 to "Di", 3 to "Mi", 4 to "Do", 5 to "Fr", 6 to "Sa", 0 to "So")
            val peak = time.byWeekday.maxOrNull()?.coerceAtLeast(1) ?: 1
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                order.forEach { (index, label) ->
                    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.height(50.dp).fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
                            Box(Modifier.fillMaxWidth().height((3 + 46f * time.byWeekday.getOrElse(index) { 0 } / peak).dp).clip(RoundedCornerShape(3.dp)).background(accent.copy(alpha = 0.8f)))
                        }
                        Text(label, fontSize = 10.sp, color = LocalStatusInk.current.muted)
                    }
                }
            }
        }
        if (time.bySubject.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().padding(start = 15.dp, end = 15.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(t("Zeit pro Fach"), fontSize = 11.sp, color = LocalStatusInk.current.muted)
                val top = time.bySubject.first().dwellMs.coerceAtLeast(1)
                time.bySubject.forEach { row ->
                    Column {
                        Row {
                            VerbatimText(row.name, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(ch.fasrv.fanotes.desk.formatStudyDuration(row.dwellMs), fontSize = 11.sp, color = LocalStatusInk.current.muted)
                        }
                        Bar(row.dwellMs.toFloat() / top, folderColor(row.color, accent), Modifier.padding(top = 3.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun SchoolCard(data: VaultStats) {
    val school = data.school
    SettingCard("Schule", Icons.Filled.School) {
        if (school == null) {
            Empty("Noch keine Hausaufgaben angelegt.")
            return@SettingCard
        }
        StatLine("Hausaufgaben erledigt", count(school.done))
        StatLine("Hausaufgaben offen", count(school.open), if (school.overdue > 0) "${count(school.overdue)} " + t("überfällig") else null)
        school.bySubject.take(8).forEach { row ->
            StatLine(row.name, "${count(row.done)} / ${count(row.done + row.open)}", if (row.overdue > 0) "${count(row.overdue)} " + t("überfällig") else null)
        }
        Text(t("Anstehende Termine und Prüfungen"), fontSize = 11.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(start = 15.dp, top = 12.dp, end = 15.dp))
        if (school.upcoming.isEmpty()) Empty("Keine anstehenden Termine.")
        school.upcoming.forEachIndexed { index, item ->
            val date = ch.fasrv.fanotes.desk.statDateLabel(item.date, ChromeText.language)
            SettingRow(
                item.title,
                listOf(item.subject, if (item.exam) t("Prüfung") else "").filter { it.isNotBlank() }.joinToString(" · ").ifBlank { null },
                divider = index != school.upcoming.lastIndex,
            ) { Text(date + (item.time?.let { " $it" } ?: ""), fontSize = 12.sp, color = LocalStatusInk.current.soft) }
        }
    }
}

@Composable
private fun CardsCard(data: VaultStats) {
    val cards = data.cards
    SettingCard("Karten", Icons.Filled.Style) {
        if (cards.total == 0) {
            Empty("Noch keine Karteikarten. Sie entstehen aus den Lernfragen einer Notiz.")
            return@SettingCard
        }
        StatLine("Karten", count(cards.total), "${count(cards.notes)} " + t("Notizen"))
        StatLine("Heute fällig", count(cards.due))
        StatLine("Schon geübt", count(cards.reviewed))
        StatLine("Behaltensquote", cards.retention?.let { "${Math.round(it * 100)} %" } ?: "–", divider = false)
    }
}

@Composable
private fun SyncStatsCard(model: FaNotesViewModel) {
    val sync by model.sync.collectAsStateWithLifecycle()
    SettingCard("Sync", Icons.Filled.Cloud) {
        if (sync.account == null) {
            Empty("Sync ist nicht eingerichtet. Melde dich unter Sync an, um hier den Stand zu sehen.")
            return@SettingCard
        }
        StatLine("Sync", ch.fasrv.fanotes.sync.syncStatusLabel(sync))
        StatLine("Letzte Synchronisierung", ch.fasrv.fanotes.sync.syncDeviceSeenLabel(sync.lastSyncAt))
        StatLine("Verfolgte Dateien", count(sync.trackedFiles))
        StatLine("Wartet auf Upload", count(sync.pendingLocal))
        StatLine("Offene Konflikte", count(sync.conflicts.size), divider = sync.info != null)
        sync.info?.let { info ->
            StatLine("Belegt auf dem Server", ch.fasrv.fanotes.sync.syncUsageLabel(info.files, info.bytes, info.quotaBytes), divider = false)
        }
    }
}

/** Opt-in sharing of anonymous usage numbers and scrubbed logs. Off by default. Same texts as the desktop card. */
@Composable
private fun DiagnosticsCard(model: FaNotesViewModel, anchorY: MutableMap<String, Int>) {
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val client = model.diagnostics
    val scope = rememberCoroutineScope()
    var preview by remember { mutableStateOf<String?>(null) }
    var comment by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf("") }
    var idShown by remember { mutableStateOf(client.installId()) }
    SettingCard("Diagnose & Verbesserung", Icons.Filled.Shield, Modifier.settingsAnchor("statistics", "settings-diagnostics", anchorY)) {
        Text(
            t("Hilf mit, FaNotes zu verbessern. Beides ist standardmässig aus. Es werden nie Notiztexte, Titel, Dateinamen, Pfade, E-Mail-Adressen, Sync-Schlüssel oder Vault-Inhalte gesendet. Gesendet wird höchstens einmal am Tag an fanotes.fasrv.ch, mit einer zufälligen Installations-ID, die nicht mit deinem Sync-Konto verbunden ist."),
            fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(15.dp),
        )
        SettingRow("Anonyme Nutzungsstatistik senden", "Version, Betriebssystem, wie oft Werkzeuge und Ansichten genutzt werden, Fehlerzahlen, Startzeit und ungefähre Vault-Grösse in Stufen.") {
            Switch(checked = settings["diagnostics-usage"] == "on", onCheckedChange = { model.updateDesk("diagnostics-usage", if (it) "on" else "off"); preview = null })
        }
        SettingRow("Logs mitsenden", "Fehlerart, Fehlercode und die Code-Zeilen der App, bei der ein Fehler auftrat, plus ein Kürzel zum Gruppieren. Der Text der Fehlermeldung wird nie gesendet.") {
            Switch(checked = settings["diagnostics-logs"] == "on", onCheckedChange = { model.updateDesk("diagnostics-logs", if (it) "on" else "off"); preview = null })
        }
        SettingRow(
            "Jetzt Logs senden",
            "Schickt einmalig die letzten Fehler (nur Art, Code und Code-Zeilen), auch wenn die Schalter aus sind. Dein Kommentar wird gesendet, wie du ihn in der Vorschau siehst, nach dem Entfernen von Pfaden, Namen und Zugangsdaten. Er ist optional.",
        ) {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(
                    comment,
                    { comment = it.take(ch.fasrv.fanotes.desk.DIAGNOSTICS_MAX_COMMENT) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp),
                    placeholder = { Text(t("Was ist passiert? (optional)"), fontSize = 12.sp) },
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp),
                )
                DiagnosticsButton("Jetzt Logs senden", !busy) {
                    busy = true
                    scope.launch {
                        val ok = client.sendLogsNow(comment)
                        busy = false
                        if (ok) { comment = ""; notice = "Gesendet. Danke!" } else notice = "Senden fehlgeschlagen. Prüfe deine Internetverbindung und versuche es später noch einmal."
                    }
                }
            }
        }
        SettingRow("Vorschau", "Zeigt genau das JSON, das gesendet würde, wenn beide Schalter an sind.") {
            DiagnosticsButton(if (preview != null) "Vorschau schliessen" else "Vorschau", true) {
                preview = if (preview != null) null else client.previewText(comment)
            }
        }
        preview?.let { text ->
            SelectionContainer {
                Text(
                    text,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 15.dp, vertical = 8.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(LocalStatusInk.current.muted.copy(alpha = 0.10f))
                        .padding(10.dp)
                        .semantics { contentDescription = t("Vorschau der Daten") },
                )
            }
        }
        SettingRow("Meine Daten löschen", "Löscht alles, was zu deiner Installations-ID auf dem Server liegt, und erzeugt eine neue ID.", divider = notice.isNotEmpty()) {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(idShown.take(8) + "…", fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = LocalStatusInk.current.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DiagnosticsButton("Meine Daten löschen", !busy) {
                        busy = true
                        scope.launch {
                            val ok = client.deleteMyData()
                            busy = false
                            preview = null
                            idShown = client.installId()
                            notice = if (ok) "Deine Daten auf dem Server sind gelöscht. Es gibt eine neue Installations-ID."
                            else "Der Server war nicht erreichbar. Auf diesem Gerät sind die gesammelten Nutzungszahlen und Fehlerlogs gelöscht, die schon gesendeten Daten liegen aber noch auf dem Server. Wähle später noch einmal „Meine Daten löschen“."
                        }
                    }
                    DiagnosticsButton("ID erneuern", !busy) {
                        idShown = client.rotateInstallId()
                        preview = null
                        notice = "Neue Installations-ID erzeugt."
                    }
                }
            }
        }
        if (notice.isNotEmpty()) {
            Text(t(notice), fontSize = 12.sp, color = LocalStatusInk.current.soft, modifier = Modifier.padding(15.dp))
        }
    }
}

@Composable
private fun DiagnosticsButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .heightIn(min = 31.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 0.08f else 0.04f))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(t(label), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.45f))
    }
}
