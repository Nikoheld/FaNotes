@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.*
import java.time.LocalDate
import java.time.ZoneId

@Composable
fun GradeRevealSheet(model: CompanionModel) {
    val targetId = model.revealQueue.firstOrNull() ?: return
    val grade = model.snapshot.grades.firstOrNull { gradeTargetId(it) == targetId }
    var step by rememberSaveable(targetId) { mutableStateOf("menu") }
    var guess by rememberSaveable(targetId) { mutableStateOf("") }
    var tries by rememberSaveable(targetId) { mutableStateOf(0) }
    var last by rememberSaveable(targetId) { mutableStateOf("") }
    var guessed by rememberSaveable(targetId) { mutableStateOf(false) }
    val today = remember { LocalDate.now(ZoneId.of("Europe/Zurich")) }
    ModalBottomSheet(onDismissRequest = model::dismissReveal, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).sheetKeyboardPadding().padding(horizontal = Space.page)) {
            SheetTitle(
                if (grade == null) "New mark" else "New mark in ${courseAlias(grade.courseLabel, model.desk.courseAliases)}",
                model::dismissReveal,
            )
            val mark = grade?.mark
            if (grade == null || mark == null || !mark.isFinite()) {
                Text("The mark is not in the last school snapshot yet.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                return@Column
            }
            Text(grade.title.ifBlank { "School mark" }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when (step) {
                    "menu" -> {
                        SettingRow(Icons.Outlined.Visibility, "Show now", "Reveal the mark immediately") {
                            model.revealGrade(targetId)
                            step = "shown"
                        }
                        SettingRow(Icons.Outlined.Tune, "Guess", "Enter marks until you find it. Higher is better.") { step = "guess" }
                        SettingRow(Icons.Outlined.Cake, "Celebrity age", "See someone who is that old, then reveal") { step = "age" }
                    }
                    "guess" -> {
                        Text("Swiss marks are 1 to 6. Higher is better.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedTextField(
                            guess,
                            { guess = it.take(8) },
                            Modifier.fillMaxWidth(),
                            label = { Text("Your guess") },
                            placeholder = { Text("4.5") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        )
                        val parsed = parseGuessMark(guess)
                        Button(
                            onClick = {
                                val value = parsed ?: return@Button
                                tries += 1
                                when (compareGuess(value, mark)) {
                                    GuessComparison.CORRECT -> {
                                        guessed = true
                                        last = "That's it — ${formatMark(mark, markDecimals(mark))}."
                                        model.revealGrade(targetId)
                                        step = "shown"
                                    }
                                    GuessComparison.ACTUAL_HIGHER -> last = "Higher — the real mark is better than ${formatMark(value, markDecimals(mark))}."
                                    GuessComparison.ACTUAL_LOWER -> last = "Lower — the real mark is worse than ${formatMark(value, markDecimals(mark))}."
                                }
                                guess = ""
                            },
                            enabled = parsed != null,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
                        ) { Text("Check guess") }
                        if (last.isNotBlank()) Text(last, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
                        if (tries > 0) Text("$tries ${if (tries == 1) "try" else "tries"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = { model.revealGrade(targetId); step = "shown" }, modifier = Modifier.fillMaxWidth()) { Text("Reveal") }
                    }
                    "age" -> {
                        val age = celebrityAge(mark)
                        val person = remember(targetId, age) { pickCelebrity(age, targetId, today) }
                        Text("This mark as an age is $age.", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
                        Text("Mark × 10, rounded to a whole year (4.25 → 43).", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (person == null) {
                            Text("No bundled celebrity for this age.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 16.dp))
                        } else {
                            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(person.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                                    Text("${ageOn(person.born, today)} years old · born ${person.born}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Text(person.line, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                        Button(onClick = { model.revealGrade(targetId); step = "shown" }, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text("Reveal the mark") }
                    }
                    else -> {
                        if (guessed) {
                            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("You got it", style = MaterialTheme.typography.titleLarge)
                                    Text("in $tries ${if (tries == 1) "try" else "tries"}.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        Text(formatMark(mark, model.desk.gradeDecimals), style = MaterialTheme.typography.displayMedium, modifier = Modifier.padding(vertical = 12.dp))
                        Text(grade.title.ifBlank { "School mark" }, style = MaterialTheme.typography.bodyLarge)
                        if (model.revealQueue.size > 1) {
                            Button(onClick = { model.finishReveal(); step = "menu"; guess = ""; tries = 0; last = ""; guessed = false }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp).heightIn(min = 50.dp)) { Text("Next hidden mark") }
                        } else {
                            Button(onClick = { model.finishReveal(); model.dismissReveal() }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp).heightIn(min = 50.dp)) { Text("Done") }
                        }
                    }
                }
            }
        }
    }
}
