package ch.fasrv.fanotes

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.recognition.InkModelState
import ch.fasrv.fanotes.recognition.MATH_SOLVER_ACTIONS
import ch.fasrv.fanotes.recognition.RecognitionPreference
import ch.fasrv.fanotes.recognition.megabytes
import ch.fasrv.fanotes.recognition.recognitionLanguage
import ch.fasrv.fanotes.recognition.recognitionPreference
import ch.fasrv.fanotes.recognition.recognitionUi

private fun t(source: String) = recognitionUi(source)

private val PREFERENCES = listOf(
    RecognitionPreference.AUTO to "Automatisch",
    RecognitionPreference.TEXT to "Text",
    RecognitionPreference.MATH to "Mathematik",
)

/** Floating cards for conversion, solver and checker, over the page so the ink stays visible. */
@Composable
fun RecognitionOverlays(model: FaNotesViewModel, modifier: Modifier = Modifier) {
    val controller = model.recognition
    val conversion by controller.conversion.collectAsStateWithLifecycle()
    val solver by controller.solver.collectAsStateWithLifecycle()
    val checker by controller.checker.collectAsStateWithLifecycle()
    if (conversion == null && solver == null && checker == null) return
    RecognitionCard(modifier) {
        conversion?.let { ConversionContent(controller, it) }
            ?: solver?.let { SolverContent(controller, it) }
            ?: checker?.let { CheckContent(controller, it) }
    }
}

@Composable
private fun RecognitionCard(modifier: Modifier, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Surface(
        modifier
            .padding(12.dp)
            .imePadding()
            .widthIn(max = 460.dp)
            .fillMaxWidth()
            .heightIn(max = 560.dp)
            .border(1.dp, rule, shape),
        shape = shape,
        color = LocalStatusInk.current.panelStrong,
        shadowElevation = 10.dp,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) { content() }
    }
}

@Composable
private fun Title(text: String) {
    Text(t(text), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun Muted(text: String) {
    Text(text, fontSize = 12.sp, color = LocalStatusInk.current.muted, lineHeight = 17.sp)
}

@Composable
private fun Busy(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(t(text), fontSize = 13.sp)
    }
}

@Composable
private fun RecognitionError(text: String) {
    Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.error, lineHeight = 18.sp)
}

/** `.segmented.compact` with touch-sized segments. */
@Composable
private fun <T> Segmented(options: List<Pair<T, String>>, selected: T, enabled: Boolean = true, onSelect: (T) -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Row(
        Modifier.clip(shape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { (value, label) ->
            val on = value == selected
            Box(
                Modifier
                    .heightIn(min = 40.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (on) MaterialTheme.colorScheme.surface else Color.Transparent)
                    .clickable(enabled = enabled && !on) { onSelect(value) }
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(t(label), fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
            }
        }
    }
}

@Composable
private fun Actions(content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
        content()
    }
}

@Composable
private fun ConversionContent(controller: RecognitionController, ui: ConversionUi) {
    Title("Intelligente Konvertierung")
    Muted(t(if (ui.scope == "page") "Ganze Seite · vollständig lokal" else "${ui.strokeIndexes.size} Striche im ausgewählten Bereich · vollständig lokal"))
    Segmented(PREFERENCES, ui.preference, enabled = !ui.running) { controller.rerunConversion(it) }
    when {
        ui.running -> Busy("Handschrift wird erkannt …")
        ui.error != null -> RecognitionError(ui.error)
        else -> {
            val result = ui.result
            if (result != null) {
                val engine = if (result.engine == "fanotes-ink") result.reason.ifBlank { "lokale Stifterkennung" } else "GlyphenWerk · ${result.reason.ifBlank { "Zeichenerkennung" }}"
                Muted(t("$engine · ${result.confidence} % Sicherheit"))
                if (result.engine != "fanotes-ink" && result.mode == "text" && !controller.neuralReady) {
                    Muted(t("Für Fliesstext liest das Zeilenmodell der Desktop-App deutlich besser. Du kannst es in den Einstellungen unter Handschrifterkennung laden."))
                }
            }
            Segmented(listOf("text" to "Als Text", "math" to "Als Formel"), ui.mode) { controller.setConversionMode(it) }
            OutlinedTextField(
                value = ui.value,
                onValueChange = controller::editConversion,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(t(if (ui.mode == "math") "LaTeX" else "Erkannter Text")) },
                minLines = 2,
            )
        }
    }
    Actions {
        TextButton(onClick = controller::closeConversion) { Text(t("Schliessen")) }
        if (ui.scope == "selection" && !ui.running && ui.error == null) {
            TextButton(onClick = { controller.insertConversion(removeInk = true) }, enabled = ui.value.isNotBlank()) { Text(t("Ersetzen")) }
        }
        Button(onClick = { controller.insertConversion(removeInk = false) }, enabled = !ui.running && ui.error == null && ui.value.isNotBlank()) { Text(t("Einfügen")) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SolverContent(controller: RecognitionController, ui: SolverUi) {
    Title("Mathe-Löser")
    when {
        ui.running && ui.input.isEmpty() && ui.error == null -> Busy("Ausdruck wird gelesen …")
        else -> {
            if (ui.confidence > 0) Muted(t("Erkannt mit ${ui.confidence} % Sicherheit. Korrigiere den Ausdruck, falls nötig."))
            OutlinedTextField(
                value = ui.input,
                onValueChange = controller::editSolverInput,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text(t("Ausdruck")) },
                isError = ui.inputError != null,
            )
            ui.inputError?.let { RecognitionError(it) }
            if (ui.variables.size > 1) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(t("Variable"), fontSize = 13.sp)
                    Segmented(ui.variables.map { it to it }, ui.variable) { controller.setSolverVariable(it) }
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                MATH_SOLVER_ACTIONS.forEach { (action, label) ->
                    TextButton(
                        onClick = { controller.runSolver(action) },
                        enabled = !ui.running && ui.inputError == null && ui.input.isNotBlank(),
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(t(label)) }
                }
            }
            if (ui.running) Busy("Wird berechnet …")
            ui.error?.let { RecognitionError(it) }
            ui.result?.let { result ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    result.steps.forEach { step ->
                        Text(
                            step.display,
                            fontSize = 15.sp,
                            fontWeight = if (step.kind == "result") FontWeight.SemiBold else FontWeight.Normal,
                            color = if (step.kind == "result") LocalStatusInk.current.success else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
    }
    Actions {
        TextButton(onClick = controller::closeSolver) { Text(t("Schliessen")) }
        if (ui.result != null) {
            TextButton(onClick = controller::insertSolutionMarkdown) { Text(t("Als Formel einfügen")) }
            Button(onClick = controller::insertSolutionInk) { Text(t("Handschriftlich einfügen")) }
        }
    }
}

@Composable
private fun CheckContent(controller: RecognitionController, ui: CheckUi) {
    Title("Mathe-Korrigierer")
    if (ui.running && ui.lines.isEmpty()) Busy("Rechenweg wird gelesen …")
    ui.error?.let { RecognitionError(it) }
    val ink = LocalStatusInk.current
    ui.lines.forEachIndexed { index, line ->
        val verdict = ui.result?.lines?.getOrNull(index)
        val color = when (verdict?.status) {
            "correct", "start" -> ink.success
            "incorrect" -> MaterialTheme.colorScheme.error
            "uncertain", "unreadable" -> ink.warning
            else -> ink.muted
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(color))
                OutlinedTextField(
                    value = line.input,
                    onValueChange = { controller.editCheckLine(index, it) },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    label = { Text(t("Schritt ${index + 1}")) },
                )
            }
            verdict?.message?.takeIf { it.isNotBlank() }?.let { Text(t(it), fontSize = 12.sp, color = color, modifier = Modifier.padding(start = 18.dp)) }
        }
    }
    ui.result?.let { result ->
        Text(t(result.message), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        result.suggestion?.takeIf { it.isNotBlank() }?.let { Muted(t(it)) }
    }
    if (ui.running && ui.lines.isNotEmpty()) Busy("Wird geprüft …")
    Actions {
        TextButton(onClick = controller::closeCheck) { Text(t("Schliessen")) }
        if (ui.lines.isNotEmpty()) Button(onClick = controller::recheck, enabled = !ui.running) { Text(t("Erneut prüfen")) }
    }
}

/** "Handschrifterkennung" in the drawing section: the desktop card plus the on-demand model. */
@Composable
internal fun RecognitionSettingsCard(model: FaNotesViewModel, settings: Map<String, String>, modifier: Modifier = Modifier) {
    val controller = model.recognition
    val state by controller.modelState.collectAsStateWithLifecycle()
    val enabled = settings[SETTING_HANDWRITING_TO_TEXT] == "on"
    SettingCard("Handschrifterkennung", Icons.Filled.AutoAwesome, modifier) {
        SettingRow(
            "Handschrift zu Text",
            t("Schaltet Konvertieren, Bereichserkennung, den unsichtbaren Suchindex sowie Mathe-Löser und Mathe-Korrigierer ein. Die Erkennung bleibt lokal auf diesem Gerät."),
        ) {
            Switch(checked = enabled, onCheckedChange = { model.updateDesk(SETTING_HANDWRITING_TO_TEXT, if (it) "on" else "off") })
        }
        SettingRow("Erkennungsmodus", t("Automatisch vergleicht Text- und Mathematikerkennung und merkt sich unklare Fälle.")) {
            Segmented(PREFERENCES, recognitionPreference(settings[SETTING_RECOGNITION_MODE])) { model.updateDesk(SETTING_RECOGNITION_MODE, it.id) }
        }
        SettingRow("Textsprache", t("Steuert Wörter und Buchstabenfolgen. Die Stifterkennung liest Deutsch und Englisch.")) {
            Segmented(listOf("de" to "Deutsch", "en" to "Englisch"), recognitionLanguage(settings[SETTING_RECOGNITION_LANGUAGE])) {
                model.updateDesk(SETTING_RECOGNITION_LANGUAGE, it)
            }
        }
        val total = remember(model) { controller.modelBytes }
        SettingRow(
            "Stifterkennung (Zeilenmodell)",
            t("Dasselbe Deutsch-Englisch-Zeilenmodell wie in der Desktop-App, mit Sprachmodellen (${megabytes(total)}). Es wird nur nach deiner Bestätigung geladen und läuft lokal; keine Handschrift verlässt das Gerät. Ohne Modell liest GlyphenWerk Zeichen einzeln."),
        ) {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                when (val current = state) {
                    InkModelState.Missing -> TextButton(onClick = controller::downloadModel) { Text(t("Laden")) }
                    is InkModelState.Downloading -> {
                        LinearProgressIndicator(progress = { current.percent / 100f }, modifier = Modifier.widthIn(min = 140.dp, max = 180.dp))
                        Text("${current.percent} % · ${megabytes(current.bytes)} / ${megabytes(current.total)}", fontSize = 12.sp, color = LocalStatusInk.current.muted)
                        TextButton(onClick = controller::cancelDownload) { Text(t("Abbrechen")) }
                    }
                    InkModelState.Verifying -> Busy("Wird geprüft …")
                    is InkModelState.Installed -> {
                        Text(t("Installiert · ${current.version}"), fontSize = 12.sp, color = LocalStatusInk.current.success)
                        TextButton(onClick = controller::removeModel) { Text(t("Entfernen")) }
                    }
                    is InkModelState.Failed -> {
                        Text(t(current.message), fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = controller::downloadModel) { Text(t("Erneut versuchen")) }
                    }
                }
            }
        }
        SettingRow(
            "Unsichtbarer Suchindex",
            t("Nur aktiv, wenn „Handschrift zu Text“ eingeschaltet ist. Die Seite bleibt Handschrift; die Vault-Suche nutzt dann im Hintergrund eine lokale Transkription."),
        ) {
            Text(t(if (enabled) "Lokal aktiv" else "Experimentell aus"), fontSize = 12.sp, color = LocalStatusInk.current.muted)
        }
        SettingRow("GlyphenWerk", t("Eigene Zeichen mit dem Stift schreiben. Sie fliessen in Text zu Handschrift und in handschriftliche Mathe-Lösungen ein."), divider = false) {
            TextButton(onClick = { model.performDesktopCommand("glyphenwerk") }) { Text(t("Öffnen")) }
        }
    }
    LaunchedEffect(Unit) { controller.refreshModelState() }
}
