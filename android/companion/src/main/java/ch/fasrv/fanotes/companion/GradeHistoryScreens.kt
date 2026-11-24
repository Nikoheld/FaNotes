package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.RestoreFromTrash
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.*

/** The moment the app first saw a version, in the phone's time zone. */
internal fun gradeSeenLabel(raw: String): String = updatedLabel(raw)

/** The history icon on a grade that changed. */
@Composable
fun GradeHistoryButton(title: String, onClick: () -> Unit) {
    ActionIcon(Icons.Outlined.History, t(R.string.grade_history_of, title.ifBlank { t(R.string.school_mark) }), onClick = onClick)
}

/**
 * Every version the app saw of one grade, newest first. A grade that is still hidden (guess the grade)
 * shows no mark in any version until it is revealed.
 */
@Composable
fun GradeVersionSheet(track: GradeTrack, decimals: Int, hidden: Boolean, onDismiss: () -> Unit) {
    KantiSheet(onDismiss) {
        Text(
            t(R.string.grade_history_of, track.latest.title.ifBlank { t(R.string.school_mark) }),
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(bottom = 12.dp).semantics { heading() },
        )
        GradeVersionList(track, decimals, hidden)
    }
}

/** The version rows of the sheet, also shown on their own by the screenshot test. */
@Composable
fun GradeVersionList(track: GradeTrack, decimals: Int, hidden: Boolean) {
    run {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            track.versions.asReversed().forEachIndexed { index, version ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(version.title.ifBlank { t(R.string.school_mark) }, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(
                            t(R.string.grade_version_detail, uiMark(version.weight), parseDisplayDate(version.date)?.let { formatSchoolDate(it, "d.M.yyyy") } ?: version.date),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        val current = if (index == 0 && track.removedAt == null) " · ${t(R.string.grade_current)}" else ""
                        Text(t(R.string.grade_seen_on, gradeSeenLabel(version.seenAt)) + current, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (hidden) Text(t(R.string.grade_version_hidden), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    val value = version.mark
                    if (hidden || value == null) {
                        Text("?", style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        Text(uiMark(value, decimals), style = TimeStyle.copy(fontSize = MaterialTheme.typography.headlineSmall.fontSize), color = if (value < 4.0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                    }
                }
                if (index < track.versions.size - 1) HorizontalDivider()
            }
            track.removedAt?.let { Text(t(R.string.grade_removed_on, gradeSeenLabel(it)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** The collapsible "Entfernte Noten" block of a course page. Removed grades are in no average. */
@Composable
fun RemovedGradesBlock(
    tracks: List<GradeTrack>,
    decimals: Int,
    hiddenIds: Set<String>,
    onOpen: (GradeTrack) -> Unit,
    startOpen: Boolean = false,
) {
    var open by rememberSaveable { mutableStateOf(startOpen) }
    Group {
        SettingRow(Icons.Outlined.RestoreFromTrash, t(R.string.removed_grades), "${tracks.size}", chevron = false) { open = !open }
        if (open) {
            Text(t(R.string.removed_grades_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            tracks.forEach { track ->
                val hidden = track.targetIds().any { it in hiddenIds }
                val last = track.latest
                Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(last.title.ifBlank { t(R.string.school_mark) }, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(t(R.string.grade_removed_on, gradeSeenLabel(track.removedAt.orEmpty())), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (track.changed) GradeHistoryButton(last.title) { onOpen(track) }
                    val lastMark = last.mark
                    Text(
                        if (hidden || lastMark == null) "?" else uiMark(lastMark, decimals),
                        style = TimeStyle.copy(fontSize = MaterialTheme.typography.headlineSmall.fontSize),
                        modifier = Modifier.padding(end = 12.dp),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}
