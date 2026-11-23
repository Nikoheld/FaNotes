package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.TeacherAbsenceDay
import java.time.LocalDate

/** The one line Heute shows: absent names, then the excursion names after a separator. */
fun teacherAbsenceLine(absences: TeacherAbsenceDay, excursionLabel: (String) -> String): String =
    listOfNotNull(
        absences.absent.takeIf { it.isNotEmpty() }?.joinToString(", "),
        absences.excursion.takeIf { it.isNotEmpty() }?.let { excursionLabel(it.joinToString(", ")) },
    ).joinToString("  ·  ")

/** Today card: one compact row with the teachers the start page lists as absent or on an excursion. Shows nothing when the stored read is not from [today]. */
@Composable
fun TeacherAbsenceCard(absences: TeacherAbsenceDay?, today: LocalDate) {
    if (absences == null || absences.day != today.toString()) return
    val scheme = MaterialTheme.colorScheme
    val none = absences.absent.isEmpty() && absences.excursion.isEmpty()
    Group {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(t(R.string.teacher_absences_row), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
            if (none) Text(t(R.string.teacher_absences_none), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
            else Text(teacherAbsenceLine(absences) { t(R.string.teacher_absences_excursion_inline, it) }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}
