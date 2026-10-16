package ch.fasrv.fanotes

import androidx.compose.ui.Modifier

/**
 * `.history-dialog` keeps `box-shadow: var(--shadow)`.
 * The later "One dialog, button and type system" rule only sets `border-radius: 12px`.
 * Compose elevation is even on every side. The shifted rectangle is blurred on a
 * software bitmap, the same frame the confirm dialog uses for the active theme.
 */
fun Modifier.directionalHistoryShade(themeId: String): Modifier = directionalConfirmShade(themeId)
