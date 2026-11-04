package ch.fasrv.fanotes.companion

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.THEME_CHOICES
import ch.fasrv.fanotes.schulnetz.*
import ch.fasrv.fanotes.sync.SyncStatus
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun SettingsScreen(model: CompanionModel, page: Page) {
    val context = LocalContext.current
    val sync by model.graph.engine.state.collectAsStateWithLifecycle()
    var confirm by remember { mutableStateOf("") }
    when (page) {
        Page.Settings -> ScreenList {
            item {
                Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Box(Modifier.size(48.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape), contentAlignment = Alignment.Center) { Icon(if (model.notesAccount) Icons.Outlined.PersonOutline else Icons.Outlined.School, null, tint = MaterialTheme.colorScheme.primary) }
                    Column(Modifier.weight(1f)) {
                        Text(sync.account?.email ?: if (model.notesAccount) "Your FaNotes" else "Kanti+", style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(if (model.notesAccount) syncDescription(sync.status) else "Grades, timetable and school updates", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                FineDivider()
            }
            item { SectionLabel(if (model.notesAccount) "Make it yours" else "School") }
            if (model.notesAccount) item { SettingRow(Icons.Outlined.ManageAccounts, "Account & sync", "FaNotes, Schulnetz and offline status") { model.navigate(Page.Connections) } }
            else item { SettingRow(Icons.Outlined.School, "Schulnetz", "Connection, notifications and this device") { model.navigate(Page.Connections) } }
            if (!model.notesAccount) item { SectionLabel("Make it yours") }
            item { SettingRow(Icons.Outlined.Palette, "Appearance", "Theme, accent and app icon") { model.navigate(Page.Appearance) } }
            item { SettingRow(Icons.Outlined.ViewWeek, "Navigation bar", "Choose tabs and their order") { model.navigate(Page.Navigation) } }
            item { SettingRow(Icons.Outlined.Tune, "Planning & grades", "Today, timetable and grade display") { model.navigate(Page.Planning) } }
            item { SettingRow(Icons.Outlined.NotificationsNone, "Notifications", "What reaches you, and when") { model.navigate(Page.Notifications) } }
            item { SectionLabel(if (model.notesAccount) "About Kanti+" else "Optional") }
            if (model.notesAccount) item { SettingRow(Icons.Outlined.AutoGraph, "Your activity", "Notes, habits and milestones") { model.navigate(Page.Profile) } }
            else item { SettingRow(Icons.Outlined.EditNote, "Sync notes with FaNotes", "Optional. School stays available either way.") { model.navigate(Page.Auth) } }
            if (!model.notesAccount) item { SectionLabel("About Kanti+") }
            item { SettingRow(Icons.Outlined.BugReport, "Diagnostics", "Connection checks and support exports") { model.navigate(Page.Diagnostics) } }
            item { Text("Kanti+ · ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 28.dp)) }
        }
        Page.Connections -> ScreenList {
            if (model.notesAccount) item { SectionLabel("FaNotes account") }
            if (model.notesAccount) item {
                Text(sync.account?.email ?: "Work on this device", style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(syncDescription(sync.status), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                Text("Your notes stay available offline. A connected account syncs them using end-to-end encryption.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                if (sync.account == null) Button(onClick = { model.navigate(Page.Auth) }, modifier = Modifier.fillMaxWidth()) { Text("Connect an account") }
                else {
                    Text("Last sync ${sync.lastSyncAt?.let(::updatedLabel) ?: "Not yet"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = model::sync, enabled = !model.busy && sync.status != SyncStatus.SYNCING, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Icon(Icons.Outlined.Sync, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Sync now") }
                    TextButton(onClick = { confirm = "logout" }) { Text("Sign out") }
                    if (model.graph.plannerHold()) TextButton(onClick = model::acceptUpload) { Text("Upload tasks and calendar") }
                }
                sync.error?.let { error -> InfoBanner("Sync needs attention", error, "Try again", true, model::sync) }
                if (sync.conflicts.isNotEmpty()) InfoBanner("Conflict copies kept", "${sync.conflicts.size} conflicting edits were preserved as separate notes. Find them in your library.")
            }
            item { SectionLabel("School connection") }
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Outlined.School, null, tint = MaterialTheme.colorScheme.primary)
                    Text("Schulnetz", style = MaterialTheme.typography.titleLarge)
                }
                Text(when { model.link.needsReauth -> "Sign in again to refresh"; model.link.linked -> "Connected"; else -> "Not connected" }, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp))
                Text("Read your school information here. Manage official records through your school.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                OutlinedTextField(model.baseUrl, { model.baseUrl = it }, Modifier.fillMaxWidth(), label = { Text("School address") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                Button(onClick = { model.requestVisibleLogin("connections") }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Text(if (model.link.needsReauth) "Sign in to Schulnetz again" else if (model.link.linked) "Open school session" else "Connect with Microsoft") }
                if (model.link.linked) TextButton(onClick = { confirm = "unlink" }) { Text("Disconnect school") }
                if (!model.notesAccount) {
                    TextButton(onClick = { model.navigate(Page.Auth) }, modifier = Modifier.fillMaxWidth()) { Text("Sync notes with FaNotes") }
                    TextButton(onClick = { confirm = "delete-kanti" }) { Text("Delete my Kanti+ data") }
                }
                Text("School data updated ${updatedLabel(model.snapshot.fetchedAt)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
                if (model.link.lastError.isNotBlank()) InfoBanner("School connection needs attention", model.link.lastError, "Diagnostics", true) { model.navigate(Page.Diagnostics) }
            }
        }
        Page.Appearance -> ScreenList {
            item { SectionLabel("Color & light") }
            item {
                Text("Theme", style = MaterialTheme.typography.titleMedium)
                ChoiceRow(THEME_CHOICES.map { it.id to when (it.id) { "light" -> "Paper"; "dark" -> "Graphite"; "midnight" -> "Midnight"; "forest" -> "Forest"; "aurora" -> "Aurora"; "sepia" -> "Warm paper"; else -> "System" } }, model.desk.theme, model::chooseTheme)
                ToggleRow("Pure black", "Use a black background in dark themes", model.desk.amoled) { model.updateDesk(model.desk.copy(amoled = it)) }
                SectionLabel(if (model.notesAccount) "Ink accent" else "Accent")
                ColorChoices(listOf("#2a6f97", "#7f6df2", "#3d8bfd", "#2f9e6b", "#e15b64"), model.desk.accent) { model.updateDesk(model.desk.copy(accent = it)) }
                Text("Accent contrast adjusts to your theme.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { SectionLabel("Home screen icon") }
            item { ChoiceRow(listOf("standard" to "Kanti+", "schule" to "School", "notiz" to "Notebook"), model.iconChoice, { model.chooseIcon(context, it) }) }
            item { SectionLabel("Navigation") }
            item { SettingRow(Icons.Outlined.ViewWeek, "Navigation bar", "Choose tabs and their order") { model.navigate(Page.Navigation) } }
        }
        Page.Navigation -> NavigationBarSettings(model)
        Page.Planning -> ScreenList {
            item { SectionLabel("When you open Kanti+") }
            item { ChoiceRow((if (model.notesAccount) NAV_BAR_IDS else NAV_BAR_IDS.filter { it != "notes" }).map { it to navBarLabel(it) }, startTabId(model.desk.startTab).let { if (!model.notesAccount && it == "notes") "today" else it }, { model.updateDesk(model.desk.copy(startTab = it)) }) }
            item { SectionLabel("On Today") }
            items(TODAY_CARD_IDS, key = { it }) { id ->
                ToggleRow(when (id) { "lessons" -> "Next commitment"; "exam" -> "Upcoming exam"; "grades" -> "Grade overview"; "pluspunkte" -> "Promotion points"; "events" -> "School updates"; else -> "Tasks" }, checked = id !in model.desk.hiddenCards) { show ->
                    model.updateDesk(model.desk.copy(hiddenCards = if (show) model.desk.hiddenCards - id else (model.desk.hiddenCards + id).distinct()))
                }
            }
            item { SectionLabel("Timetable") }
            item { ToggleRow("Compact rows", "Show more lessons at a glance", model.desk.planCompact) { model.updateDesk(model.desk.copy(planCompact = it)) } }
            item { ToggleRow("Include weekends", "Show empty weekend days in week view", model.desk.showWeekend) { model.updateDesk(model.desk.copy(showWeekend = it)) } }
            item {
                Text("Visible school hours", style = MaterialTheme.typography.titleMedium)
                ChoiceRow((0..23).map { it.toString() to "%02d:00".format(it) }, model.desk.dayStartHour.toString(), { model.updateDesk(model.desk.copy(dayStartHour = it.toInt(), dayEndHour = maxOf(model.desk.dayEndHour, it.toInt() + 1))) })
                Text("Until", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                ChoiceRow(((model.desk.dayStartHour + 1)..24).map { it.toString() to "%02d:00".format(it) }, model.desk.dayEndHour.toString(), { model.updateDesk(model.desk.copy(dayEndHour = it.toInt())) })
            }
            if (model.hidden.isNotEmpty()) {
                item { SectionLabel("Hidden lessons") }
                items(model.hidden, key = { it.id }) { rule ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text(rule.subject, style = MaterialTheme.typography.bodyLarge); Text(if (rule.mode == "once") rule.date else "${runCatching { java.time.DayOfWeek.of(rule.weekday).getDisplayName(java.time.format.TextStyle.SHORT, Locale.ENGLISH) }.getOrDefault("Weekly")} · ${rule.start}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        TextButton(onClick = { model.restoreLesson(rule.id) }) { Text("Restore") }
                    }
                }
            }
            item { SectionLabel("Grades & widget") }
            item { ToggleRow("Promotion points", "Show the calculated points balance", model.desk.showPluspunkte) { model.updateDesk(model.desk.copy(showPluspunkte = it)) } }
            item { Text("Grade precision", style = MaterialTheme.typography.titleMedium); ChoiceRow((0..3).map { it.toString() to "$it decimals" }, model.desk.gradeDecimals.toString(), { model.updateDesk(model.desk.copy(gradeDecimals = it.toInt())) }) }
            item { Text("Subject order", style = MaterialTheme.typography.titleMedium); ChoiceRow(listOf("name" to "Name", "average" to "Average", "pluspunkte" to "Points"), model.desk.gradeSort, { model.updateDesk(model.desk.copy(gradeSort = it)) }) }
            item { ToggleRow("Compact home widget", "Use a smaller next-lesson summary", model.desk.widgetCompact) { model.updateDesk(model.desk.copy(widgetCompact = it)) } }
        }
        Page.Notifications -> NotificationSettings(model)
        Page.Diagnostics -> ScreenList {
            item { Text("Connection checks", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 16.dp)) }
            item {
                fun at(ms: Long) = if (ms <= 0L) "Not yet" else Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM yyyy · HH:mm", Locale.ENGLISH))
                val delivery = deliveryModeLabel(firebaseConfigured(context), model.graph.lastPushAt(), System.currentTimeMillis())
                DiagnosticLine("Delivery", delivery)
                DiagnosticLine("Last push", at(model.graph.lastPushAt()))
                DiagnosticLine("Last school check", at(model.graph.lastCheckAt()))
                DiagnosticLine("Next scheduled check", if (delivery == "Instant via push") "Not scheduled while push is healthy" else at(model.graph.nextCheckAt()))
                DiagnosticLine("Cached school data", updatedLabel(model.snapshot.fetchedAt))
                val error = model.graph.lastCheckError().ifBlank { model.link.lastError }
                if (error.isNotBlank()) InfoBanner("Last check", error, error = true)
            }
            if (model.snapshot.readErrors.isNotEmpty()) {
                item { SectionLabel("Source reports") }
                itemsIndexed(model.snapshot.readErrors, key = { index, error -> "err:$index:$error" }) { _, error -> Text(error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp)) }
            }
            item { SectionLabel("Support exports") }
            item {
                Text("Share an export when troubleshooting a school connection. Exports can contain school content; review who you share them with.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton(onClick = { model.shareDebug(context) }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Text("Share school page") }
                OutlinedButton(onClick = { model.shareLogs(context) }, modifier = Modifier.fillMaxWidth()) { Text("Share diagnostic archive") }
                if (model.notesAccount) OutlinedButton(onClick = model::sync, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Refresh connections") }
                else OutlinedButton(onClick = model::refreshSchool, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Refresh school data") }
            }
        }
        Page.Profile -> ScreenList {
            item {
                Text("A little progress, every day.", style = MaterialTheme.typography.headlineMedium)
                Row(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                    if (model.notesAccount) Column { Text(model.writtenNotes.toString(), style = MaterialTheme.typography.headlineLarge); Text("notes", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Column { Text(model.graph.streakDays().toString(), style = MaterialTheme.typography.headlineLarge); Text("days in a row", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                SectionLabel("Milestones")
            }
            items(companionBadges(model.writtenNotes, model.graph.streakDays(), highestVisibleMark(model.snapshot.grades, model.hiddenGradeIds(), model.settings.guessGrades)).filter { model.notesAccount || !it.id.startsWith("notes") }, key = { it.id }) { badge ->
                val title = when (badge.id) { "notes-1" -> "First thought"; "notes-10" -> "A growing notebook"; "streak-3" -> "Finding your rhythm"; else -> "Top marks" }
                val body = when (badge.id) { "notes-1" -> "Write your first note"; "notes-10" -> "Keep ten notes in your library"; "streak-3" -> "Open Kanti+ three days in a row"; else -> "Receive a grade of 6" }
                Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Icon(if (badge.earned) Icons.Outlined.Verified else Icons.Outlined.RadioButtonUnchecked, if (badge.earned) "Achieved" else "Not yet achieved", tint = if (badge.earned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    Column { Text(title, style = MaterialTheme.typography.titleMedium); Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                FineDivider()
            }
        }
        else -> Unit
    }
    if (confirm.isNotBlank()) {
        val deleteKanti = confirm == "delete-kanti"
        ConfirmDialog(
            when (confirm) {
                "logout" -> "Sign out of FaNotes?"
                "delete-kanti" -> "Delete my Kanti+ data?"
                else -> "Disconnect Schulnetz?"
            },
            when (confirm) {
                "logout" -> "Your local notes stay on this device. School updates keep working. Sync will stop until you sign in again."
                "delete-kanti" -> "School data stored for this device is removed from the server, including the Schulnetz link, snapshot and push setup. Tasks and calendar on this device stay."
                else -> "Your last school snapshot stays available. You can reconnect later."
            },
            when (confirm) {
                "logout" -> "Sign out"
                "delete-kanti" -> "Delete"
                else -> "Disconnect"
            },
            { confirm = "" },
        ) {
            when {
                confirm == "logout" -> model.logout()
                deleteKanti -> model.deleteKantiData()
                else -> model.unlink()
            }
            confirm = ""
        }
    }
}

@Composable
private fun NavigationBarSettings(model: CompanionModel) {
    val bar = presentedNavBar(model.desk.navBar, model.notesAccount)
    val fallback = if (model.notesAccount) DEFAULT_NAV_BAR else SCHOOL_NAV_BAR
    val available = remainingNavBar(bar).filter { model.notesAccount || it != "notes" }
    ScreenList {
        item {
            Text("Shown in the bar", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Space.xl, bottom = Space.sm))
            Text("Choose 2 to 5 destinations. Settings stays available from the top bar.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        itemsIndexed(bar, key = { _, id -> "bar:$id" }) { index, id ->
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(navBarIcon(id), null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
                Column(Modifier.weight(1f)) {
                    Text(navBarLabel(id), style = MaterialTheme.typography.titleMedium)
                    Text("${index + 1} of ${bar.size}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                ActionIcon(Icons.Outlined.KeyboardArrowUp, "Move ${navBarLabel(id)} up", enabled = index > 0) {
                    model.updateDesk(model.desk.copy(navBar = moveNavBarItem(bar, index, -1)))
                }
                ActionIcon(Icons.Outlined.KeyboardArrowDown, "Move ${navBarLabel(id)} down", enabled = index < bar.lastIndex) {
                    model.updateDesk(model.desk.copy(navBar = moveNavBarItem(bar, index, 1)))
                }
                ActionIcon(Icons.Outlined.Close, "Remove ${navBarLabel(id)}", enabled = bar.size > NAV_BAR_MIN) {
                    model.updateDesk(model.desk.copy(navBar = removeNavBarItem(bar, id)))
                }
            }
            FineDivider()
        }
        if (available.isNotEmpty()) {
            item { SectionLabel(if (bar.size >= NAV_BAR_MAX) "Remove a tab to add another" else "Add a destination") }
            items(available, key = { "add:$it" }) { id ->
                val enabled = bar.size < NAV_BAR_MAX
                SettingRow(
                    navBarIcon(id),
                    navBarLabel(id),
                    if (enabled) "Add to the navigation bar" else "Maximum of 5 tabs",
                ) { if (enabled) model.updateDesk(model.desk.copy(navBar = addNavBarItem(bar, id))) }
            }
        }
        item {
            TextButton(
                onClick = { model.updateDesk(model.desk.copy(navBar = fallback)) },
                enabled = bar != fallback,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            ) { Text("Reset to default") }
        }
    }
}

@Composable
private fun NotificationSettings(model: CompanionModel) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var allowed by remember { mutableStateOf(CompanionAlerts.notificationsAllowed(context)) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = CompanionAlerts.notificationsAllowed(context) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) {
            allowed = CompanionAlerts.notificationsAllowed(context)
        } }
        owner.lifecycle.addObserver(observer); onDispose { owner.lifecycle.removeObserver(observer) }
    }
    fun open(intent: Intent) { runCatching { context.startActivity(intent) }.onFailure { model.message = "Android could not open this setting." } }
    ScreenList {
        item {
            SectionLabel("Android permission")
            Text(if (allowed) "Notifications are allowed" else "Choose what reaches you", style = MaterialTheme.typography.titleMedium)
            Text("Get relevant school changes and excuse deadlines.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = { if (!allowed && Build.VERSION.SDK_INT >= 33) request.launch(Manifest.permission.POST_NOTIFICATIONS) else open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text(if (allowed) "Android notification settings" else "Allow notifications") }
            if (!allowed && Build.VERSION.SDK_INT >= 33) TextButton(onClick = { open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text("Open Android settings") }
        }
        item { SectionLabel("School updates") }
        item { ToggleRow("Grades", "New or changed marks", model.settings.grades) { model.toggleSetting("grades") } }
        item { ToggleRow("Guess the grade", "Hide new marks until you reveal them. Notifications show the subject only.", model.settings.guessGrades) { model.toggleSetting("guessGrades") } }
        item { ToggleRow("Hold to reveal", "With Guess the grade, a long press opens a hidden mark. A tap leaves it covered.", model.desk.revealLongPress) { model.updateDesk(model.desk.copy(revealLongPress = it)) } }
        item { ToggleRow("Timetable changes", "Room changes, substitutions and cancellations", model.settings.timetable) { model.toggleSetting("timetable") } }
        item { ToggleRow("Exams", checked = model.settings.exams) { model.toggleSetting("exams") } }
        item { ToggleRow("Absences", checked = model.settings.absences) { model.toggleSetting("absences") } }
        item { ToggleRow("Excuse deadlines", checked = model.settings.deadlines) { model.toggleSetting("deadlines") } }
        item { ToggleRow("Events & messages", checked = model.settings.events) { model.toggleSetting("events") } }
        item { SectionLabel("Delivery") }
        item {
            Text(
                when (deliveryModeLabel(firebaseConfigured(context), model.graph.lastPushAt(), System.currentTimeMillis())) {
                    "Instant via push" -> "New grades arrive instantly. No background check while push is healthy."
                    else -> if (firebaseConfigured(context)) "Push has been quiet. Kanti+ checks about every 6 hours until a push arrives."
                    else "School updates are checked about every 6 hours."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 12.dp),
            )
        }
        item { OutlinedButton(onClick = { model.testPush(context) }, modifier = Modifier.fillMaxWidth()) { Text("Send a test notification") } }
    }
}

@Composable
private fun DiagnosticLine(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
    FineDivider()
}
