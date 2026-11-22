package ch.fasrv.fanotes

import androidx.compose.material3.Text
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.desk.StatusTone
import ch.fasrv.fanotes.desk.WORK_REQUEST_DESCRIPTION_MAX
import ch.fasrv.fanotes.desk.WORK_REQUEST_MESSAGE_MAX
import ch.fasrv.fanotes.desk.WORK_REQUEST_SCREENSHOT_MAX_BYTES
import ch.fasrv.fanotes.desk.WORK_REQUEST_TITLE_MAX
import ch.fasrv.fanotes.desk.WorkRequest
import ch.fasrv.fanotes.desk.WorkRequestDetail
import ch.fasrv.fanotes.desk.WorkRequestDraft
import ch.fasrv.fanotes.desk.WorkRequestError
import ch.fasrv.fanotes.desk.WorkRequestKind
import ch.fasrv.fanotes.desk.WorkRequestPriority
import ch.fasrv.fanotes.desk.canApproveWorkRequest
import ch.fasrv.fanotes.desk.canCancelWorkRequest
import ch.fasrv.fanotes.desk.canMessageWorkRequest
import ch.fasrv.fanotes.desk.describeWorkRequestEvent
import ch.fasrv.fanotes.desk.validateWorkRequestDraft
import ch.fasrv.fanotes.desk.workRequestCiLabel
import ch.fasrv.fanotes.desk.workRequestDraftProblemText
import ch.fasrv.fanotes.desk.workRequestProgressPercent
import ch.fasrv.fanotes.desk.workRequestStatusInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.DateFormat
import java.util.Date
import kotlin.coroutines.resume

private fun t(source: String) = ChromeText.ui(source)

private fun errorText(error: Throwable): String =
    if (!error.message.isNullOrBlank()) t(error.message.orEmpty()) else t("Das hat nicht geklappt.")

/** Pixels of the activity window as a JPEG under the 2 MB limit; null when the capture is not possible. */
private suspend fun captureScreen(activity: Activity): ByteArray? {
    val window = activity.window
    val view = window.decorView
    if (view.width <= 0 || view.height <= 0) return null
    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    val copied = suspendCancellableCoroutine { continuation ->
        try {
            PixelCopy.request(window, bitmap, { code -> if (continuation.isActive) continuation.resume(code == PixelCopy.SUCCESS) }, Handler(Looper.getMainLooper()))
        } catch (error: IllegalArgumentException) {
            if (continuation.isActive) continuation.resume(false)
        }
    }
    if (!copied) view.draw(Canvas(bitmap))
    return withContext(Dispatchers.Default) {
        val longEdge = maxOf(bitmap.width, bitmap.height)
        val scale = if (longEdge > 1600) 1600f / longEdge else 1f
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
        var quality = 85
        var bytes: ByteArray
        do {
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
            bytes = out.toByteArray()
            quality -= 15
        } while (bytes.size > WORK_REQUEST_SCREENSHOT_MAX_BYTES && quality > 10)
        bytes.takeIf { it.size <= WORK_REQUEST_SCREENSHOT_MAX_BYTES }
    }
}

@Composable
private fun StatusChip(request: WorkRequest) {
    val info = workRequestStatusInfo(request.status, request.cancelled)
    val color = when (info.tone) {
        StatusTone.Neutral -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
        StatusTone.Active -> MaterialTheme.colorScheme.primary
        StatusTone.Attention -> Color(0xFFB26A00)
        StatusTone.Success -> Color(0xFF2E7D32)
        StatusTone.Danger -> MaterialTheme.colorScheme.error
    }
    Text(
        t(info.label), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = color,
        modifier = Modifier.border(BorderStroke(1.dp, color.copy(alpha = 0.5f)), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

@Composable
private fun Chip(label: String, selected: Boolean, onClick: () -> Unit) {
    val ink = MaterialTheme.colorScheme.onSurface
    Text(
        ui(label), fontSize = 13.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal, color = ink,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) ink.copy(alpha = 0.1f) else Color.Transparent)
            .border(1.dp, ink.copy(alpha = if (selected) 0.4f else 0.15f), RoundedCornerShape(8.dp))
            .clickable(role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

@Composable
fun WorkRequestsDialog(model: FaNotesViewModel) {
    val activity = LocalContext.current as? Activity
    val scope = rememberCoroutineScope()
    val client = model.workRequests
    var tab by remember { mutableStateOf("new") }
    var kind by remember { mutableStateOf(WorkRequestKind.Bug) }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf(WorkRequestPriority.Normal) }
    var screenshot by remember { mutableStateOf<ByteArray?>(null) }
    var withLogs by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var requests by remember { mutableStateOf<List<WorkRequest>?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    val dismiss = { model.closeWorkRequests() }
    val ink = MaterialTheme.colorScheme.onSurface
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.BUG_REPORT_RADIUS_DP.dp)

    // The list refreshes every 5 s while it is visible.
    LaunchedEffect(tab, selected) {
        if (tab != "mine" || selected != null) return@LaunchedEffect
        while (true) {
            try { requests = withContext(Dispatchers.IO) { client.list() } } catch (e: CancellationException) { throw e } catch (e: Exception) { error = errorText(e) }
            delay(ch.fasrv.fanotes.desk.WORK_REQUEST_POLL_MS)
        }
    }

    fun send() {
        val draft = WorkRequestDraft(
            kind, title, description, priority, screenshot, if (withLogs) model.workRequestLogs() else null,
            model.installedVersion, "android",
        )
        validateWorkRequestDraft(draft)?.let { error = t(workRequestDraftProblemText(it)); return }
        busy = true; error = null
        scope.launch {
            try {
                val created = withContext(Dispatchers.IO) { client.create(draft) }
                title = ""; description = ""; screenshot = null; withLogs = false
                model.message.value = t("Anfrage wurde gesendet.")
                selected = created.id.ifEmpty { null }
                tab = "mine"
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error = errorText(e) } finally { busy = false }
        }
    }

    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val screen = androidx.compose.ui.platform.LocalConfiguration.current
        Box(
            Modifier.fillMaxSize().background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM)).clickable(interactionSource = scrim, indication = null, onClick = dismiss).imePadding(),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .fillMaxWidth(ch.fasrv.fanotes.desk.BUG_REPORT_WIDTH_FRACTION)
                    .widthIn(max = ch.fasrv.fanotes.desk.BUG_REPORT_MAX_DP.dp)
                    .heightIn(max = ch.fasrv.fanotes.desk.bugReportMaxHeightDp(screen.screenHeightDp).dp)
                    .clickable(interactionSource = card, indication = null, onClick = {})
                    .directionalBugReportShade()
                    .clip(shape)
                    .border(1.dp, ink.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), shape)
                    .background(MaterialTheme.colorScheme.background),
            ) {
                Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 8.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(t("Fehler & Wünsche"), fontSize = 16.sp, fontWeight = FontWeight(650))
                        Text(t("Beschreibe einen Fehler oder eine Funktion. Claude arbeitet daran und zeigt dir hier den Fortschritt."), fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    }
                    TextButton(onClick = dismiss) { Text(t("Schliessen")) }
                }
                Row(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip(t("Neu"), tab == "new") { tab = "new"; error = null }
                    Chip(t("Meine Anfragen"), tab == "mine") { tab = "mine"; selected = null; error = null }
                }
                Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 18.dp).padding(bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (tab == "new") {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Chip(t("Fehler"), kind == WorkRequestKind.Bug) { kind = WorkRequestKind.Bug }
                            Chip(t("Funktion"), kind == WorkRequestKind.Feature) { kind = WorkRequestKind.Feature }
                        }
                        OutlinedTextField(
                            title, { title = it.take(WORK_REQUEST_TITLE_MAX) }, Modifier.fillMaxWidth(), singleLine = true,
                            label = { Text(t("Titel")) }, placeholder = { Text(t("Kurz in einem Satz")) },
                        )
                        OutlinedTextField(
                            description, { description = it.take(WORK_REQUEST_DESCRIPTION_MAX) }, Modifier.fillMaxWidth().heightIn(min = 140.dp),
                            label = { Text(t(if (kind == WorkRequestKind.Bug) "Was ist passiert?" else "Was soll FaNotes können?")) },
                            placeholder = { Text(t("So genau wie möglich: wo, wann, was du erwartet hast.")) },
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(t("Priorität"), fontSize = 12.sp, color = LocalStatusInk.current.muted)
                            Chip(t("Niedrig"), priority == WorkRequestPriority.Low) { priority = WorkRequestPriority.Low }
                            Chip(t("Normal"), priority == WorkRequestPriority.Normal) { priority = WorkRequestPriority.Normal }
                            Chip(t("Hoch"), priority == WorkRequestPriority.High) { priority = WorkRequestPriority.High }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (screenshot != null) {
                                Text(t("Screenshot angehängt"), fontSize = 13.sp, modifier = Modifier.weight(1f))
                                TextButton(onClick = { screenshot = null }) { Text(t("Screenshot entfernen")) }
                            } else {
                                TextButton(enabled = activity != null && !busy, onClick = {
                                    scope.launch {
                                        error = null
                                        val bytes = try { captureScreen(activity!!) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                                        if (bytes == null) error = t("Der Screenshot konnte nicht aufgenommen werden.") else screenshot = bytes
                                    }
                                }) { Text(t("Screenshot anhängen")) }
                            }
                        }
                        Row(Modifier.clickable { withLogs = !withLogs }, verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(withLogs, { withLogs = it })
                            Text(t("Protokoll der letzten fünf Minuten anhängen"), fontSize = 13.sp)
                        }
                        error?.let { Text(ui(it), color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            TextButton(enabled = !busy && title.isNotBlank() && description.isNotBlank(), onClick = { send() }) {
                                Text(t(if (busy) "Wird gesendet …" else "Anfrage senden"))
                            }
                        }
                    } else if (selected != null) {
                        WorkRequestDetailView(model, selected!!) { selected = null }
                    } else {
                        error?.let { Text(ui(it), color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                        val list = requests
                        when {
                            list == null -> Text(t("Wird geladen …"), color = LocalStatusInk.current.muted)
                            list.isEmpty() -> Text(t("Noch keine Anfragen."), color = LocalStatusInk.current.muted)
                            else -> list.forEach { item ->
                                Row(
                                    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { selected = item.id }.padding(vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Text(item.title, Modifier.weight(1f), fontSize = 14.sp, maxLines = 2)
                                    StatusChip(item)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkRequestDetailView(model: FaNotesViewModel, id: String, onBack: () -> Unit) {
    val client = model.workRequests
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var detail by remember(id) { mutableStateOf<WorkRequestDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var messageOpen by remember { mutableStateOf(false) }

    // SSE through OkHttp with Last-Event-ID; polling every 5 s when the stream is unavailable. Cancelled on leave.
    LaunchedEffect(id) {
        client.observe(id, onUpdate = { detail = it; error = null }, onError = { error = errorText(it) })
    }

    fun act(run: suspend () -> Unit) {
        busy = true; error = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) { run() }
                val fresh = withContext(Dispatchers.IO) { client.detail(id) }
                detail = detail?.copy(request = fresh)
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error = errorText(e) } finally { busy = false }
        }
    }

    val current = detail
    if (current == null) {
        Text(error ?: t("Wird geladen …"), color = LocalStatusInk.current.muted)
        TextButton(onClick = onBack) { Text(t("Zurück")) }
        return
    }
    val request = current.request
    val percent = workRequestProgressPercent(request, current.events)
    TextButton(onClick = onBack) { Text(t("Zurück")) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(request.title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
        StatusChip(request)
    }
    Text(request.description, fontSize = 13.sp)
    if (percent != null) LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
    if (request.approved && request.status == ch.fasrv.fanotes.desk.WorkRequestStatus.WaitingForYou) {
        Text(t("Freigegeben. Claude übernimmt die Änderung, sobald die Prüfung bestanden ist."), fontSize = 13.sp)
    }
    request.reason?.let { Text(ui(it), color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
    request.pr?.let { pr ->
        val ci = workRequestCiLabel(pr.ci)?.let { " · ${t("Prüfung")}: ${t(it)}" }.orEmpty()
        Text(
            ui("${t("Änderung")} #${pr.number}$ci"), color = MaterialTheme.colorScheme.primary, fontSize = 13.sp,
            modifier = Modifier.clickable { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(pr.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } },
        )
    }
    val format = remember { DateFormat.getTimeInstance(DateFormat.SHORT) }
    current.events.forEach { event ->
        if (describeWorkRequestEvent(event) == null) return@forEach
        val shown = when {
            event.type == "message" -> "${t("Nachricht an Claude")}: ${event.message}"
            event.type == "status" -> "${t("Status")}: ${t(workRequestStatusInfo(event.status!!).label)}"
            event.type == "approved" -> t("Übernahme freigegeben")
            else -> event.message
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (event.at > 0) format.format(Date(event.at)) else "", fontSize = 11.sp, color = LocalStatusInk.current.muted)
            Text(shown, Modifier.weight(1f), fontSize = 13.sp)
            event.percent?.let { Text("$it %", fontSize = 11.sp, color = LocalStatusInk.current.muted) }
        }
    }
    error?.let { Text(ui(it), color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
    if (messageOpen && canMessageWorkRequest(request.status)) {
        OutlinedTextField(
            note, { note = it.take(WORK_REQUEST_MESSAGE_MAX) }, Modifier.fillMaxWidth(), minLines = 2,
            label = { Text(t("Nachricht an Claude")) }, placeholder = { Text(t("Zusätzlicher Hinweis für Claude")) },
        )
        TextButton(enabled = !busy && note.isNotBlank(), onClick = { act { client.message(id, note); note = ""; messageOpen = false } }) { Text(t("Senden")) }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        if (canCancelWorkRequest(request.status)) TextButton(enabled = !busy, onClick = { act { client.cancel(id) } }) { Text(t("Abbrechen")) }
        if (canMessageWorkRequest(request.status)) TextButton(enabled = !busy, onClick = { messageOpen = !messageOpen }) { Text(t("Nachricht")) }
        if (canApproveWorkRequest(request.status, request.approved)) TextButton(enabled = !busy, onClick = { act { client.approve(id) } }) { Text(t("Übernehmen")) }
    }
}
