package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.SchulnetzChange

/** Icon for a change feed category (same categories as the notification channels). */
fun changeIcon(category: String): ImageVector = when (category) {
    "grade" -> Icons.Outlined.Grade
    "timetable" -> Icons.Outlined.CalendarMonth
    "exam" -> Icons.AutoMirrored.Outlined.Assignment
    "absence" -> Icons.Outlined.EventAvailable
    "deadline" -> Icons.Outlined.Schedule
    "event" -> Icons.Outlined.Event
    else -> Icons.Outlined.Notifications
}

/** One row of the "Änderungen" list: kind icon, title, text and time. */
@Composable
fun ChangeRow(change: SchulnetzChange) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.Top) {
        Icon(changeIcon(change.category), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f)) {
            Text(shownText(change.title), style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (change.body.isNotBlank()) Text(shownText(change.body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            if (change.at.isNotBlank()) Text(updatedLabel(change.at), style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        }
    }
}
