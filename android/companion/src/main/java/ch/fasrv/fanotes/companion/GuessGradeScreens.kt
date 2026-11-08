@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.math.BigDecimal
import java.math.RoundingMode
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
    var countUp by rememberSaveable(targetId) { mutableStateOf(false) }
    var settled by rememberSaveable(targetId) { mutableStateOf(false) }
    var fromAge by rememberSaveable(targetId) { mutableStateOf(false) }
    var ageGuess by rememberSaveable(targetId) { mutableIntStateOf(0) }
    var ageImage by rememberSaveable(targetId) { mutableStateOf("") }
    var ageAttempt by rememberSaveable(targetId) { mutableIntStateOf(0) }
    var ageReload by rememberSaveable(targetId) { mutableIntStateOf(0) }
    val today = remember { LocalDate.now(ZoneId.of("Europe/Zurich")) }
    val haptic = LocalHapticFeedback.current
    val motion = animatorDurationScale()
    fun commitReveal() {
        if (settled) return
        settled = true
        model.revealGrade(targetId)
    }
    // "Show now" skips the game and the count. A game's reveal button counts up first,
    // and the course average stays on the old marks until that count finishes.
    fun showNow() {
        commitReveal()
        countUp = false
        step = "shown"
    }
    fun unveil() {
        countUp = motion > 0f
        step = "shown"
    }
    ModalBottomSheet(
        onDismissRequest = {
            if (countUp && !settled) commitReveal()
            model.dismissReveal()
        },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = LocalCompanionSemantics.current.raised,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).sheetKeyboardPadding().padding(horizontal = Space.page)) {
            SheetTitle(
                if (grade == null) t(R.string.new_mark) else t(R.string.new_mark_in, courseAlias(grade.courseLabel, model.desk.courseAliases)),
                model::dismissReveal,
            )
            val mark = grade?.mark
            if (grade == null || mark == null || !mark.isFinite()) {
                Text(t(R.string.the_mark_is_not_in_the_last_school_snapshot_yet), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                return@Column
            }
            Text(grade.title.ifBlank { t(R.string.school_mark) }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when (step) {
                    "menu" -> {
                        Group(color = LocalCompanionSemantics.current.sunken.copy(alpha = 0.55f)) {
                            SettingRow(Icons.Outlined.Visibility, t(R.string.show_now), t(R.string.reveal_the_mark_immediately), tone = StateTone.Accent) { showNow() }
                            FineDivider()
                            SettingRow(Icons.Outlined.Tune, t(R.string.guess), t(R.string.enter_marks_until_you_find_it_higher_is_better), tone = StateTone.Accent) { step = "guess" }
                            FineDivider()
                            SettingRow(Icons.Outlined.Cake, t(R.string.celebrity_age), t(R.string.see_someone_who_is_that_old_then_reveal), tone = StateTone.Accent) { step = "age" }
                        }
                    }
                    "guess" -> {
                        Text(t(R.string.swiss_marks_are_1_to_6_higher_is_better), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedTextField(
                            guess,
                            { guess = it.take(8) },
                            Modifier.fillMaxWidth(),
                            label = { Text(t(R.string.your_guess)) },
                            placeholder = { Text(t(R.string.guess_sample)) },
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
                                        last = t(R.string.that_s_it, uiMark(mark, markDecimals(mark)))
                                        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                                        unveil()
                                    }
                                    GuessComparison.ACTUAL_HIGHER -> {
                                        haptic.performHapticFeedback(HapticFeedbackType.Reject)
                                        last = t(R.string.higher_the_real_mark_is_better_than, uiMark(value, markDecimals(mark)))
                                    }
                                    GuessComparison.ACTUAL_LOWER -> {
                                        haptic.performHapticFeedback(HapticFeedbackType.Reject)
                                        last = t(R.string.lower_the_real_mark_is_worse_than, uiMark(value, markDecimals(mark)))
                                    }
                                }
                                guess = ""
                            },
                            enabled = parsed != null,
                            modifier = Modifier.fillMaxWidth().heightIn(min = Space.button),
                        ) { Text(t(R.string.check_guess)) }
                        if (last.isNotBlank()) Text(last, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
                        if (tries > 0) Text(tp(R.plurals.tries_count, tries, tries), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = { unveil() }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.reveal)) }
                    }
                    "age" -> {
                        val seed = if (ageAttempt == 0) targetId else "$targetId#$ageAttempt"
                        val prompt = remember(targetId, mark, ageAttempt) { celebrityAgePrompt(mark, seed, today) }
                        val imageUrl = prompt.imageUrl
                        if (imageUrl == null) {
                            Text(t(R.string.photo_unavailable), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 16.dp))
                            TextButton(onClick = { ageAttempt += 1 }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.try_again)) }
                        } else {
                            CelebrityPortraitImage(imageUrl, ageReload) {
                                ageReload += 1
                                ageAttempt += 1
                            }
                            OutlinedTextField(
                                guess,
                                { guess = it.filter { char -> char.isDigit() }.take(3) },
                                Modifier.fillMaxWidth().padding(top = 12.dp),
                                label = { Text(t(R.string.your_guess)) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            )
                            val parsedAge = parseAgeGuess(guess)
                            Button(
                                onClick = {
                                    val value = parsedAge ?: return@Button
                                    ageGuess = value
                                    ageImage = imageUrl
                                    fromAge = true
                                    if (value == celebrityAge(mark)) {
                                        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                                    } else {
                                        haptic.performHapticFeedback(HapticFeedbackType.Reject)
                                    }
                                    unveil()
                                },
                                enabled = parsedAge != null,
                                modifier = Modifier.fillMaxWidth().heightIn(min = Space.button),
                            ) { Text(t(R.string.check_guess)) }
                        }
                        TextButton(onClick = { fromAge = true; ageImage = imageUrl.orEmpty(); unveil() }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.reveal)) }
                    }
                    else -> {
                        if (fromAge && ageImage.isNotBlank()) CelebrityPortraitImage(ageImage, 0) {}
                        if (guessed) {
                            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text(t(R.string.you_got_it), style = MaterialTheme.typography.titleLarge)
                                    Text(tp(R.plurals.in_tries, tries, tries), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        CountingMark(mark, play = countUp, onFinished = { commitReveal() })
                        val connection = ageConnection(mark, settled, fromAge, ageGuess)
                        if (connection != null) {
                            Text(t(R.string.this_mark_as_an_age_is, connection.age.toString()), style = MaterialTheme.typography.titleMedium)
                            Text(t(R.string.mark_10_rounded_to_a_whole_year_4_25_43), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            val guessedAge = connection.guess
                            if (guessedAge != null) Text(t(R.string.your_age_guess, guessedAge), style = MaterialTheme.typography.bodyMedium)
                        }
                        Text(grade.title.ifBlank { t(R.string.school_mark) }, style = MaterialTheme.typography.bodyLarge)
                        if (model.revealQueue.size > 1) {
                            Button(
                                onClick = { commitReveal(); model.finishReveal(); step = "menu"; guess = ""; tries = 0; last = ""; guessed = false; countUp = false; settled = false; fromAge = false; ageGuess = 0; ageImage = ""; ageAttempt = 0 },
                                enabled = settled,
                                modifier = Modifier.fillMaxWidth().padding(top = 16.dp).heightIn(min = Space.button),
                            ) { Text(t(R.string.next_hidden_mark)) }
                        } else {
                            Button(
                                onClick = { commitReveal(); model.finishReveal(); model.dismissReveal() },
                                enabled = settled,
                                modifier = Modifier.fillMaxWidth().padding(top = 16.dp).heightIn(min = Space.button),
                            ) { Text(t(R.string.done)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun animatorDurationScale(): Float {
    val resolver = LocalContext.current.contentResolver
    val scale = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    return if (scale.isFinite() && scale >= 0f) scale else 1f
}

@Composable
private fun CelebrityPortraitImage(url: String, reload: Int, onFailed: () -> Unit) {
    var localReload by remember(url, reload) { mutableIntStateOf(0) }
    var bitmap by remember(url, reload, localReload) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    var failed by remember(url, reload, localReload) { mutableStateOf(false) }
    LaunchedEffect(url, reload, localReload) {
        val loaded = withContext(Dispatchers.IO) { fetchCelebrityPortrait(url) }
        if (loaded == null) failed = true else bitmap = loaded.asImageBitmap()
    }
    when {
        bitmap != null -> Image(
            bitmap = bitmap!!,
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp, max = 360.dp),
        )
        failed -> {
            Text(t(R.string.photo_unavailable), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 16.dp))
            TextButton(onClick = { localReload += 1; onFailed() }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.try_again)) }
        }
        else -> CircularProgressIndicator(Modifier.padding(vertical = 24.dp))
    }
}

/** Counts 1.0, 1.1, 1.2, … and lands on the real mark. Reduced motion shows it at once. */
@Composable
private fun CountingMark(mark: Double, play: Boolean, onFinished: () -> Unit) {
    val steps = remember(mark) { gradeRevealSteps(mark) }
    var index by remember(mark, play) { mutableIntStateOf(if (play) 0 else steps.lastIndex) }
    val pulse = remember(mark) { Animatable(1f) }
    val haptic = LocalHapticFeedback.current
    val view = LocalView.current
    val motion = animatorDurationScale()
    LaunchedEffect(mark, play) {
        if (!play || motion == 0f || steps.size < 2) {
            index = steps.lastIndex
            onFinished()
            return@LaunchedEffect
        }
        for (step in 1 until steps.size) {
            delay((steps[step].delayBeforeMs * motion).toLong().coerceAtLeast(1L))
            index = step
            if (view.isHapticFeedbackEnabled) {
                val kind = if (step == steps.lastIndex) HapticFeedbackType.Confirm else HapticFeedbackType.SegmentTick
                haptic.performHapticFeedback(kind)
            }
        }
        onFinished()
        pulse.snapTo(1f)
        pulse.animateTo(1.08f, tween(120))
        pulse.animateTo(1f, tween(180))
    }
    val shown = steps[index.coerceIn(0, steps.lastIndex)]
    Text(
        formatCountingMark(shown.value, index >= steps.lastIndex, mark),
        style = MaterialTheme.typography.displayMedium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(vertical = 12.dp).graphicsLayer {
            scaleX = pulse.value
            scaleY = pulse.value
        },
    )
}

private fun formatCountingMark(value: Double, final: Boolean, mark: Double): String {
    val places = if (final) markDecimals(mark).coerceAtLeast(1) else 1
    val shown = if (final) mark else value
    val separator = java.text.DecimalFormatSymbols.getInstance(AppLanguage.formatLocale()).decimalSeparator
    return BigDecimal.valueOf(shown).setScale(places, RoundingMode.HALF_UP).toPlainString().replace('.', separator)
}
