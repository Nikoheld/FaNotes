package ch.fasrv.fanotes.companion

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

const val ONBOARDING_VERSION = 1
const val ONBOARDING_PREF = "onboarding-version"
const val SNOWFALL_PREF = "snowfall"
const val NOTIFY_TIP_PREF = "notify-tip-dismissed"

/**
 * Only a true first run sees the onboarding. Anyone who used an earlier version already has
 * local access or an account, so an update never interrupts them or asks for a new login.
 */
fun needsOnboarding(storedVersion: Int, localAccess: Boolean, hasAccount: Boolean): Boolean =
    storedVersion < ONBOARDING_VERSION && !localAccess && !hasAccount

private const val PAGES = 4

@Composable
fun OnboardingScreen(model: CompanionModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val motion = LocalKantiMotion.current
    val pager = rememberPagerState { PAGES }
    val scope = rememberCoroutineScope()
    val replay = model.onboardingReplay
    var allowed by remember { mutableStateOf(CompanionAlerts.notificationsAllowed(context)) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = CompanionAlerts.notificationsAllowed(context)
        if (granted) model.onNotificationsAllowed()
    }
    fun go(page: Int) {
        scope.launch { if (motion.reduced) pager.scrollToPage(page) else pager.animateScrollToPage(page) }
    }
    BackHandler(pager.currentPage > 0 || replay) {
        if (pager.currentPage > 0) go(pager.currentPage - 1) else model.finishOnboarding()
    }
    BoxWithConstraints(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        val showArt = maxHeight >= 560.dp
        Column(Modifier.fillMaxSize().widthIn(max = 560.dp).align(Alignment.TopCenter)) {
            Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top)).padding(start = Space.page, end = 8.dp, top = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                PageDots(pager.currentPage, PAGES, Modifier.weight(1f))
                TextButton(onClick = { model.finishOnboarding() }) { Text(if (replay) t(R.string.close) else t(R.string.onboarding_skip), style = MaterialTheme.typography.labelLarge) }
            }
            HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth(), beyondViewportPageCount = 0) { page ->
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.xl, vertical = Space.lg), verticalArrangement = Arrangement.Center) {
                    if (showArt) {
                        Box(Modifier.fillMaxWidth().height(220.dp).padding(bottom = Space.xl), contentAlignment = Alignment.Center) {
                            when (page) {
                                0 -> DayArt()
                                1 -> LinkArt()
                                2 -> PrivacyArt()
                                else -> AlertArt()
                            }
                        }
                    }
                    val (title, body) = when (page) {
                        0 -> t(R.string.onboarding_day_title) to t(R.string.onboarding_day_body)
                        1 -> t(R.string.onboarding_school_title) to t(R.string.onboarding_school_body)
                        2 -> t(R.string.onboarding_privacy_title) to t(R.string.onboarding_privacy_body)
                        else -> t(R.string.onboarding_alerts_title) to t(R.string.onboarding_alerts_body)
                    }
                    Text(title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
                    Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Space.md))
                    when (page) {
                        0 -> {
                            Spacer(Modifier.height(Space.lg))
                            Group { ToggleRow(t(R.string.mensa_setting), t(R.string.mensa_setting_body), model.desk.showMensa) { model.updateDesk(model.desk.copy(showMensa = it)) } }
                        }
                        1 -> {
                            Spacer(Modifier.height(Space.lg))
                            StatusLine(
                                when {
                                    model.link.needsReauth -> t(R.string.sign_in_again_to_refresh)
                                    model.link.linked -> t(R.string.connected)
                                    else -> t(R.string.not_connected)
                                },
                                if (model.link.linked && !model.link.needsReauth) StateTone.Accent else StateTone.Neutral,
                            )
                        }
                        2 -> {
                            Spacer(Modifier.height(Space.lg))
                            Group { ToggleRow(t(R.string.onboarding_hide_marks), t(R.string.hide_new_marks_until_you_reveal_them_notificatio), model.settings.guessGrades) { model.toggleSetting("guessGrades") } }
                        }
                        3 -> {
                            Spacer(Modifier.height(Space.lg))
                            StatusLine(if (allowed) t(R.string.notifications_are_allowed) else t(R.string.onboarding_alerts_off), if (allowed) StateTone.Accent else StateTone.Neutral)
                        }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)).padding(horizontal = Space.xl, vertical = Space.lg)) {
                val page = pager.currentPage
                val linked = model.link.linked && !model.link.needsReauth
                when (page) {
                    1 -> if (!linked) {
                        PrimaryButton(t(R.string.connect_schulnetz), { model.continueLocally(); model.requestVisibleLogin("onboarding") }, Modifier.fillMaxWidth(), enabled = !model.busy, icon = Icons.Outlined.School)
                        TextButton(onClick = { go(2) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(t(R.string.onboarding_later)) }
                        // For app review and trying Kanti+ without Schulnetz: invented data only.
                        if (model.canStartDemo()) TextButton(onClick = { model.startDemo() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(t(R.string.demo_view)) }
                    } else PrimaryButton(t(R.string.onboarding_next), { go(2) }, Modifier.fillMaxWidth())
                    3 -> {
                        if (!allowed && Build.VERSION.SDK_INT >= 33) {
                            PrimaryButton(t(R.string.allow_notifications), { permission.launch(Manifest.permission.POST_NOTIFICATIONS) }, Modifier.fillMaxWidth(), icon = Icons.Outlined.NotificationsActive)
                            TextButton(onClick = { model.finishOnboarding() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(t(R.string.not_now)) }
                        } else PrimaryButton(if (replay) t(R.string.done) else t(R.string.onboarding_start), { model.finishOnboarding() }, Modifier.fillMaxWidth())
                        if (!replay && !model.notesAccount) TextButton(onClick = { model.finishOnboarding(openNotes = true) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                            Text(t(R.string.onboarding_notes_optional), textAlign = TextAlign.Center)
                        }
                    }
                    else -> PrimaryButton(t(R.string.onboarding_next), { go(page + 1) }, Modifier.fillMaxWidth())
                }
            }
        }
    }
}

@Composable
private fun PageDots(current: Int, count: Int, modifier: Modifier) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier.semantics { contentDescription = t(R.string.onboarding_step, current + 1, count) }, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(count) { index ->
            Box(Modifier.height(6.dp).width(if (index == current) 22.dp else 6.dp).background(if (index <= current) scheme.primary else scheme.outlineVariant, CircleShape))
        }
    }
}

/** Abstract preview of Heute: the day band and the next-lesson block. No real data, no marks. */
@Composable
private fun DayArt() {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    Canvas(Modifier.fillMaxHeight().aspectRatio(1.25f)) {
        val w = size.width; val h = size.height
        drawRoundRect(scheme.surface, Offset(0f, 0f), Size(w, h), CornerRadius(36f))
        drawRoundRect(scheme.primaryContainer, Offset(w * 0.07f, h * 0.09f), Size(w * 0.86f, h * 0.5f), CornerRadius(30f))
        drawRoundRect(scheme.primary, Offset(w * 0.13f, h * 0.17f), Size(w * 0.3f, h * 0.06f), CornerRadius(12f))
        drawRoundRect(scheme.onSurface, Offset(w * 0.13f, h * 0.28f), Size(w * 0.42f, h * 0.12f), CornerRadius(14f))
        drawRoundRect(scheme.onSurfaceVariant.copy(alpha = 0.5f), Offset(w * 0.13f, h * 0.45f), Size(w * 0.5f, h * 0.05f), CornerRadius(10f))
        drawRoundRect(scheme.outline, Offset(w * 0.66f, h * 0.29f), Size(w * 0.2f, h * 0.1f), CornerRadius(18f), style = Stroke(3f))
        val segments = 7
        val gap = w * 0.012f
        val segW = (w * 0.86f - gap * (segments - 1)) / segments
        repeat(segments) { i ->
            val color = when {
                i < 2 -> scheme.onSurfaceVariant.copy(alpha = 0.3f)
                i == 2 -> scheme.primary
                i == 5 -> s.warning
                else -> s.sunken
            }
            drawRoundRect(color, Offset(w * 0.07f + i * (segW + gap), h * 0.68f), Size(segW, h * 0.06f), CornerRadius(10f))
        }
        repeat(3) { i ->
            drawRoundRect(s.sunken, Offset(w * 0.07f + i * w * 0.3f, h * 0.82f), Size(w * 0.26f, h * 0.07f), CornerRadius(14f))
        }
    }
}

@Composable
private fun LinkArt() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        IconTile(Icons.Outlined.School, StateTone.Neutral, 76.dp)
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Outlined.Lock, null, tint = LocalCompanionSemantics.current.success, modifier = Modifier.size(22.dp))
            Box(Modifier.padding(top = 6.dp).width(64.dp).height(3.dp).background(MaterialTheme.colorScheme.outlineVariant, CircleShape))
        }
        IconTile(Icons.Outlined.PhoneAndroid, StateTone.Accent, 76.dp)
    }
}

@Composable
private fun PrivacyArt() {
    val scheme = MaterialTheme.colorScheme
    Box(contentAlignment = Alignment.Center) {
        Box(Modifier.size(132.dp).background(LocalCompanionSemantics.current.sunken, MaterialTheme.shapes.extraLarge), contentAlignment = Alignment.Center) {
            Text("?", style = MaterialTheme.typography.displayLarge, color = scheme.onSurface)
        }
        Box(Modifier.align(Alignment.BottomEnd).offset(x = 14.dp, y = 10.dp)) { IconTile(Icons.Outlined.VisibilityOff, StateTone.Accent, 52.dp) }
    }
}

@Composable
private fun AlertArt() {
    Column(Modifier.widthIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        listOf(Icons.Outlined.Insights to StateTone.Accent, Icons.Outlined.EventRepeat to StateTone.Warning, Icons.Outlined.EventBusy to StateTone.Error).forEachIndexed { index, (icon, tone) ->
            Row(Modifier.fillMaxWidth(1f - index * 0.08f).background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.medium).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                IconTile(icon, tone, 36.dp)
                Column(Modifier.padding(start = 12.dp).weight(1f)) {
                    Box(Modifier.fillMaxWidth(0.7f).height(10.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f), CircleShape))
                    Spacer(Modifier.height(6.dp))
                    Box(Modifier.fillMaxWidth(0.45f).height(8.dp).background(LocalCompanionSemantics.current.sunken, CircleShape))
                }
            }
        }
    }
}
