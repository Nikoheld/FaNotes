package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.TeacherAbsenceDay
import java.time.LocalDate

/** Today card: teachers the start page lists as absent or on an excursion. Shows nothing when the stored read is not from [today]. */
@Composable
fun TeacherAbsenceCard(absences: TeacherAbsenceDay?, today: LocalDate) {
    if (absences == null || absences.day != today.toString()) return
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        SectionLabel(t(R.string.teacher_absences_title))
        Group {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (absences.absent.isEmpty() && absences.excursion.isEmpty()) {
                    Text(t(R.string.teacher_absences_none), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                }
                if (absences.absent.isNotEmpty()) TeacherNames(t(R.string.teacher_absences_absent), absences.absent)
                if (absences.excursion.isNotEmpty()) TeacherNames(t(R.string.teacher_absences_excursion), absences.excursion)
            }
        }
    }
}

@Composable
private fun TeacherNames(label: String, names: List<String>) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        names.forEach { Text(it, style = MaterialTheme.typography.bodyLarge) }
    }
}
