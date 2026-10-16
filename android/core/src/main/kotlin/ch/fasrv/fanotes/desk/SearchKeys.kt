package ch.fasrv.fanotes.desk

/**
 * Arrow keys in the desktop vault search.
 * Down from the field selects the first hit. Down on the last hit wraps.
 * Up from the first hit returns to the field, which is index -1.
 */
fun searchResultMove(selected: Int, count: Int, forward: Boolean): Int {
    if (count <= 0) return -1
    if (selected < 0) return if (forward) 0 else -1
    if (!forward && selected == 0) return -1
    val index = selected.coerceIn(0, count - 1)
    return if (forward) (index + 1) % count else index - 1
}

/** Vault search panel from `.search-panel` and `.empty-mini`. */
const val SEARCH_TITLE_SP = 14
const val SEARCH_EYEBROW = "IM GESAMTEN VAULT"
const val SEARCH_EMPTY_TITLE = "Finde alles wieder"
const val SEARCH_EMPTY_HINT = "Tippe mindestens zwei Zeichen. Auch noch nicht konvertierte Handschrift wird durchsucht."
const val SEARCH_RESULT_MIN_DP = 70
const val SEARCH_RESULT_RADIUS_DP = 7
const val SEARCH_RESULT_PAD_DP = 9
const val SEARCH_RESULT_GAP_DP = 6
const val SEARCH_BADGE_RADIUS_DP = 8
const val SEARCH_BADGE_PAD_X_DP = 5
const val SEARCH_BADGE_PAD_Y_DP = 2
const val SEARCH_PATH_INSET_DP = 20
const val SEARCH_EMPTY_PAD_TOP_DP = 50
const val SEARCH_FOOTER_DP = 34
const val SEARCH_RULE_ALPHA = 0.09f
const val SEARCH_CLOSE = "Suche schließen"
const val SEARCH_PLACEHOLDER = "Text, Dateinamen, Handschrift …"
const val SEARCH_CHOOSE = "Ergebnis wählen"
const val SEARCH_FOOTER_CLOSE = "Schließen"
const val SEARCH_KBD_RADIUS_DP = 5
const val SEARCH_SHADOW_X_DP = 16
const val SEARCH_SHADOW_BLUR_DP = 32
const val SEARCH_SHADOW_ALPHA = 0.14f

/** The vault search panel is as wide as the file tree and floats over the left of the workspace. */
fun searchPanelWidthDp(raw: String?) = sidebarWidthDp(raw)
