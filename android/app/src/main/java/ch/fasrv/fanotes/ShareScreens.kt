package ch.fasrv.fanotes

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.share.ShareLinkRecord
import ch.fasrv.fanotes.share.ShareMode
import ch.fasrv.fanotes.share.normalizeUsername

private val Target = 48.dp

private fun shareChooser(context: android.content.Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    context.startActivity(Intent.createChooser(send, "Link teilen").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/** "Link teilen" for the open note or a folder: pick copy or live, create the link, copy or send it. */
@Composable
fun ShareDialogHost(model: FaNotesViewModel) {
    val service = model.shares
    val state by service.dialog.collectAsStateWithLifecycle()
    val current = state ?: return
    var mode by remember(current.rootPath) { mutableStateOf(ShareMode.COPY) }
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = { service.closeDialog() },
        title = { Text(ui(if (current.isFolder) "Ordner teilen" else "Notiz teilen")) },
        text = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(current.rootPath.substringAfterLast('/').ifEmpty { current.rootPath }, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                val created = current.created
                if (created == null) {
                    ModeRow("Kopie", "Der Stand von jetzt. Spätere Änderungen erscheinen nicht im Link.", mode == ShareMode.COPY) { mode = ShareMode.COPY }
                    ModeRow("Live", "Der Link wird nach dem Speichern aktualisiert.", mode == ShareMode.LIVE) { mode = ShareMode.LIVE }
                    Text(
                        ui("Wer den Link kennt, kann die Notiz lesen. Text und sichtbare Handschrift werden hochgeladen, der Verlauf nicht."),
                        fontSize = 12.sp,
                        color = LocalStatusInk.current.muted,
                    )
                } else {
                    Text(if (created.mode == ShareMode.LIVE) "Live-Link erstellt" else "Link erstellt", fontSize = 13.sp, color = LocalStatusInk.current.success)
                    SelectionContainer { Text(created.link, fontSize = 14.sp, color = MaterialTheme.colorScheme.primary) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { clipboard.setText(AnnotatedString(created.link)); model.message.value = "Link kopiert." }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Kopieren")) }
                        OutlinedButton(onClick = { shareChooser(context, created.link) }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Senden …")) }
                    }
                    TextButton(onClick = { service.stop(created.id) { model.message.value = it } }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Freigabe beenden"), color = MaterialTheme.colorScheme.error) }
                }
                current.error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                if (current.busy) Text(ui("Wird hochgeladen …"), fontSize = 13.sp, color = LocalStatusInk.current.muted)
            }
        },
        confirmButton = {
            if (current.created == null) {
                Button(onClick = { service.publish(mode) }, enabled = !current.busy, modifier = Modifier.heightIn(min = Target)) { Text(ui("Link erstellen")) }
            } else {
                TextButton(onClick = { service.closeDialog() }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Fertig")) }
            }
        },
        dismissButton = {
            if (current.created == null) TextButton(onClick = { service.closeDialog() }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Abbrechen")) }
        },
    )
}

@Composable
private fun ModeRow(title: String, text: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Column(Modifier.padding(start = 4.dp)) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(text, fontSize = 12.sp, color = LocalStatusInk.current.muted)
        }
    }
}

/** Remembered links of this device, in the sync section of the settings. */
@Composable
fun ShareSettingsCard(model: FaNotesViewModel, modifier: Modifier = Modifier) {
    val service = model.shares
    val shares by service.shares.collectAsStateWithLifecycle()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    LaunchedEffect(Unit) { service.checkLinks() }
    SettingCard("Freigaben & Links", Icons.Filled.Share, modifier) {
        if (shares.isEmpty()) {
            SettingRow("Noch keine Links", "Öffne eine Notiz und wähle „Mehr“ → „Link teilen“.", divider = false) {}
        }
        shares.forEachIndexed { index, share ->
            ShareRow(share, divider = index != shares.lastIndex, onCopy = {
                clipboard.setText(AnnotatedString(share.link))
                model.message.value = "Link kopiert."
            }, onSend = { shareChooser(context, share.link) }, onStop = { service.stop(share.id) { model.message.value = it } }, onForget = { service.forget(share.id) })
        }
    }
}

@Composable
private fun ShareRow(share: ShareLinkRecord, divider: Boolean, onCopy: () -> Unit, onSend: () -> Unit, onStop: () -> Unit, onForget: () -> Unit) {
    val kind = when {
        share.stopped -> "beendet"
        share.mode == ShareMode.LIVE -> "live"
        else -> "Kopie"
    }
    SettingRow(share.title.ifBlank { share.rootPath }, "${if (share.kind == "folder") "Ordner" else "Notiz"} · $kind · ${share.createdAt.take(10)}", divider = divider) {
        Row {
            if (!share.stopped) {
                TextButton(onClick = onCopy, modifier = Modifier.heightIn(min = Target)) { Text(ui("Kopieren")) }
                TextButton(onClick = onSend, modifier = Modifier.heightIn(min = Target)) { Text(ui("Senden")) }
                TextButton(onClick = onStop, modifier = Modifier.heightIn(min = Target)) { Text(ui("Beenden")) }
            } else {
                TextButton(onClick = onForget, modifier = Modifier.heightIn(min = Target)) { Text(ui("Entfernen")) }
            }
        }
    }
}

/** The public username and the activity overview (`/user/<name>`). Only numbers are published, never note text. */
@Composable
fun ProfileSettingsCard(model: FaNotesViewModel, modifier: Modifier = Modifier) {
    val service = model.shares
    val profile by service.profile.collectAsStateWithLifecycle()
    val clipboard = LocalClipboardManager.current
    LaunchedEffect(profile.claimed) { if (profile.claimed) service.loadOverview() }
    SettingCard("Öffentliches Profil", Icons.Filled.Person, modifier) {
        SettingRow("Benutzername", "3 bis 24 Zeichen: Kleinbuchstaben, Ziffern, - und _. Er gehört deinem Gerät, sobald er festgelegt ist.") {
            OutlinedTextField(
                profile.username,
                { service.setUsernameDraft(it) },
                singleLine = true,
                isError = profile.username.isNotBlank() && normalizeUsername(profile.username) == null,
                modifier = Modifier.heightIn(min = Target),
            )
        }
        SettingRow("Name festlegen", profile.message, divider = profile.claimed) {
            Button(
                onClick = { service.claim() },
                enabled = !profile.busy && profile.username.isNotBlank(),
                modifier = Modifier.heightIn(min = Target),
            ) { Text(ui(if (profile.claimed) "Ändern" else "Festlegen")) }
        }
        if (profile.claimed) {
            SettingRow("Übersicht öffentlich", "Zeigt Zahl der Notizen, Zeit in FaNotes und die aktiven Tage. Keine Titel, keine Texte.", divider = profile.public) {
                Switch(checked = profile.public, onCheckedChange = { service.setPublic(it) }, enabled = !profile.busy)
            }
            val link = service.profileLink()
            if (profile.public && link != null) {
                SettingRow("Link", link, divider = profile.overview != null) {
                    TextButton(onClick = { clipboard.setText(AnnotatedString(link)); model.message.value = "Link kopiert." }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Kopieren")) }
                }
            }
            profile.overview?.let { overview ->
                SettingRow("Veröffentlicht", "${overview.noteCount} Notizen · ${overview.durationLabel} · ${overview.activeDays.size} aktive Tage", divider = false) {}
            }
        }
    }
}

/** The conflict list moved to its own screen; the sync section keeps one big entry to it. */
@Composable
fun ConflictShortcutCard(model: FaNotesViewModel, modifier: Modifier = Modifier) {
    val sync by model.sync.collectAsStateWithLifecycle()
    if (sync.conflicts.isEmpty()) return
    SettingCard("Konflikte", Icons.Filled.Warning, modifier) {
        SettingRow(
            if (sync.conflicts.size == 1) "1 Datei mit Konflikt" else "${sync.conflicts.size} Dateien mit Konflikt",
            "Vergleiche beide Fassungen und entscheide, welche gilt.",
            divider = false,
        ) {
            Button(onClick = { model.showDestination("conflicts") }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Konflikte öffnen")) }
        }
    }
}
