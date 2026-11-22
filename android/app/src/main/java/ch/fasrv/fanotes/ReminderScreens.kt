package ch.fasrv.fanotes

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.NotificationAccess
import java.text.DateFormat
import java.util.Date
import java.util.Locale

private val Target = 48.dp

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/**
 * Reminders for calendar events and homework, with the Android 13 notification permission flow and the
 * exact-alarm switch. The text under the switch always says what will happen on this device.
 */
@Composable
fun ReminderSettingsCard(model: FaNotesViewModel, modifier: Modifier = Modifier) {
    val scheduler = model.reminders
    val settings by scheduler.settings.collectAsStateWithLifecycle()
    val upcoming by scheduler.upcoming.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val activity = context.activity()
    // Bumped when the screen comes back from the system settings, so the state below is read again.
    var refresh by remember { mutableIntStateOf(0) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) refresh += 1 }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val rationale = Build.VERSION.SDK_INT >= 33 && activity?.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) == true
    val readiness = remember(refresh, rationale, settings.enabled) { scheduler.readiness(rationale) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        refresh += 1
        if (granted) {
            scheduler.update { it.copy(enabled = true) }
        } else {
            model.message.value = "Ohne Erlaubnis kann FaNotes keine Erinnerungen zeigen."
        }
    }
    SettingCard("Erinnerungen", Icons.Filled.Notifications, modifier) {
        SettingRow(
            "Erinnerungen",
            "Benachrichtigung vor Terminen und am Abend vor fälligen Hausaufgaben, auch wenn FaNotes geschlossen ist.",
            divider = true,
        ) {
            Switch(
                checked = settings.enabled,
                onCheckedChange = { on ->
                    if (!on) {
                        scheduler.update { it.copy(enabled = false) }
                    } else if (readiness.access == NotificationAccess.CAN_ASK && Build.VERSION.SDK_INT >= 33) {
                        scheduler.markPermissionAsked()
                        permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        scheduler.update { it.copy(enabled = true) }
                    }
                },
            )
        }
        if (settings.enabled || readiness.access != NotificationAccess.GRANTED) {
            SettingRow("Zustand", readiness.summary, divider = settings.enabled) {
                Column(horizontalAlignment = androidx.compose.ui.Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (readiness.access == NotificationAccess.NEEDS_SETTINGS || readiness.summary.startsWith("Der Kanal")) {
                        OutlinedButton(onClick = { openNotificationSettings(context) }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Benachrichtigungen öffnen")) }
                    }
                    if (readiness.offerExactAlarmSwitch) {
                        OutlinedButton(onClick = { openExactAlarmSettings(context) }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Genaue Alarme erlauben")) }
                    }
                }
            }
        }
        if (settings.enabled) {
            SettingRow("Vor Terminen", "So viele Minuten vorher.") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(5, 15, 30, 60).forEach { minutes ->
                        FilterChip(
                            selected = settings.calendarLeadMinutes == minutes,
                            onClick = { scheduler.update { it.copy(calendarLeadMinutes = minutes) } },
                            label = { Text(if (minutes == 60) "1 h" else "$minutes min", fontSize = 14.sp) },
                            modifier = Modifier.heightIn(min = Target),
                        )
                    }
                }
            }
            SettingRow("Hausaufgaben", "Erinnert am Abend vorher, oder eine Stunde vor der Fälligkeitszeit.") {
                Switch(checked = settings.homework, onCheckedChange = { on -> scheduler.update { it.copy(homework = on) } })
            }
            if (settings.homework) {
                SettingRow("Abendliche Erinnerung", "Uhrzeit für Aufgaben ohne Fälligkeitszeit.") {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(16, 18, 20).forEach { hour ->
                            FilterChip(
                                selected = settings.homeworkEveningHour == hour,
                                onClick = { scheduler.update { it.copy(homeworkEveningHour = hour) } },
                                label = { Text("$hour:00", fontSize = 14.sp) },
                                modifier = Modifier.heightIn(min = Target),
                            )
                        }
                    }
                }
            }
            SettingRow("Als Nächstes", if (upcoming.isEmpty()) "Nichts in den nächsten 7 Tagen." else null, divider = true) {
                OutlinedButton(onClick = { scheduler.sendTest() }, modifier = Modifier.heightIn(min = Target)) { Text(ui("Test senden")) }
            }
            val formatter = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, Locale.GERMAN)
            upcoming.take(4).forEachIndexed { index, reminder ->
                SettingRow(reminder.title, "${formatter.format(Date(reminder.triggerAtMs))} · ${reminder.text}", divider = index != upcoming.take(4).lastIndex) {}
            }
        }
    }
}

private fun openNotificationSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

private fun openExactAlarmSettings(context: Context) {
    if (Build.VERSION.SDK_INT < 31) return
    val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }.onFailure {
        runCatching { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}
