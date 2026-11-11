package ch.fasrv.fanotes.companion

/**
 * Shows a stored Schulnetz or sync message in the current app language.
 * Unknown text, course names and free-form reasons pass through.
 */
fun shownText(raw: String?, fragments: Boolean = true): String {
    if (raw.isNullOrEmpty()) return raw.orEmpty()
    EXACT[raw]?.let { return t(it) }
    val trimmed = raw.trim()
    if (trimmed != raw) EXACT[trimmed]?.let { return t(it) }
    counted(trimmed)?.let { return it }
    templated(trimmed)?.let { return it }
    if (!fragments) return raw
    val translated = applyFragments(raw)
    return if (trimmed != raw && translated == raw) applyFragments(trimmed) else translated
}

private fun counted(raw: String): String? {
    COUNTED_DE.matchEntire(raw)?.let { match ->
        val count = match.groupValues[1].toIntOrNull() ?: return null
        val id = if (raw.contains("Aufdecken")) R.plurals.new_grades_tap else R.plurals.new_grades
        return tp(id, count, count)
    }
    COUNTED_EN.matchEntire(raw)?.let { match ->
        val count = match.groupValues[1].toIntOrNull() ?: return null
        val id = if (raw.contains("reveal")) R.plurals.new_grades_tap else R.plurals.new_grades
        return tp(id, count, count)
    }
    return null
}

private fun templated(raw: String): String? {
    DAMAGED.matchEntire(raw)?.let { return t(R.string.arrived_damaged, it.groupValues[1]) }
    CHECKSUM.matchEntire(raw)?.let { return t(R.string.checksum_mismatch, it.groupValues[1]) }
    REQUEST_DE.matchEntire(raw)?.let { return t(R.string.phrase_request_failed_status, it.groupValues[1]) }
    REQUEST_EN.matchEntire(raw)?.let { return t(R.string.phrase_request_failed_status, it.groupValues[1]) }
    BLOCKED_DE.matchEntire(raw)?.let { return t(R.string.phrase_blocked, it.groupValues[1]) }
    BLOCKED_EN.matchEntire(raw)?.let { return t(R.string.phrase_blocked, it.groupValues[1]) }
    REJECTED_DE.matchEntire(raw)?.let { return t(R.string.phrase_rejected_reason, it.groupValues[1]) }
    REJECTED_EN.matchEntire(raw)?.let { return t(R.string.phrase_rejected_reason, it.groupValues[1]) }
    SYNC_STATUS.matchEntire(raw)?.let { return t(R.string.phrase_sync_status, it.groupValues[1].toInt()) }
    SYNC_STATUS_DE.matchEntire(raw)?.let { return t(R.string.phrase_sync_status, it.groupValues[1].toInt()) }
    return null
}

private fun applyFragments(raw: String): String {
    val out = StringBuilder()
    var index = 0
    for (match in FRAGMENTS.findAll(raw)) {
        if (match.range.first < index) continue
        out.append(raw, index, match.range.first)
        out.append(fragmentText(match.value))
        index = match.range.last + 1
    }
    out.append(raw, index, raw.length)
    return out.toString()
}

private fun fragmentText(token: String): String = when (token) {
    "nicht entschuldigt", "unexcused" -> t(R.string.frag_unexcused)
    "entschuldigt", "excused" -> t(R.string.frag_excused)
    "Neue Noten", "new grades" -> t(R.string.frag_new_grades)
    "Neue Note", "New grade" -> t(R.string.phrase_new_grade)
    "fällt aus" -> t(R.string.frag_cancelled)
    "Vertretung", "Substitution" -> t(R.string.phrase_substitution)
    "Gewicht", "Weight" -> t(R.string.frag_weight)
    "Raum ", "Room " -> t(R.string.frag_room)
    "Tippen zum Aufdecken", "Tap to reveal" -> t(R.string.phrase_tap_reveal)
    "Absenzmeldung offen" -> t(R.string.frag_absence_report_open)
    else -> ESTIMATED_POINTS.matchEntire(token)?.let { t(R.string.frag_estimated_points, it.groupValues[1]) }
        ?: BOOKED_POINTS.matchEntire(token)?.let { t(R.string.frag_booked_points, localizedNumber(it.groupValues[1])) }
        ?: QUOTA_LEFT.matchEntire(token)?.let { t(R.string.absence_points_left, localizedNumber(it.groupValues[1]), localizedNumber(it.groupValues[2])) }
        ?: token
}

private val ESTIMATED_POINTS = Regex("""geschätzt (\d+) Punkte""")
private val BOOKED_POINTS = Regex("""(-?\d+(?:,\d+)?) Punkte gebucht""")
private val QUOTA_LEFT = Regex("""Kontingent noch (-?\d+(?:,\d+)?) von (-?\d+(?:,\d+)?)""")

private val COUNTED_DE = Regex("""^(\d+) neue Noten(?: – tippen zum Aufdecken)?$""")
private val COUNTED_EN = Regex("""^(\d+) new grades?(?: – tap to reveal)?$""")
private val DAMAGED = Regex("""^[“"](.+)[”"] arrived damaged\.$""")
private val CHECKSUM = Regex("""^The checksum of [“"](.+)[”"] does not match\.$""")
private val REQUEST_DE = Regex("""^Anfrage fehlgeschlagen \((.+)\)\.$""")
private val REQUEST_EN = Regex("""^Request failed \((.+)\)\.$""")
private val BLOCKED_DE = Regex("""^Blockiert: (.+)$""")
private val BLOCKED_EN = Regex("""^Blocked: (.+)$""")
private val REJECTED_DE = Regex("""^Schulnetz hat die Anmeldung abgelehnt \((.+)\)\.$""")
private val REJECTED_EN = Regex("""^Schulnetz rejected the sign-in \((.+)\)\.$""")
private val SYNC_STATUS = Regex("""^The sync server responded with (\d+)\.$""")
private val SYNC_STATUS_DE = Regex("""^Der Sync-Server hat mit (\d+) geantwortet\.$""")
private val FRAGMENTS = Regex(
    """Absenzmeldung offen|geschätzt \d+ Punkte|-?\d+(?:,\d+)? Punkte gebucht|Kontingent noch -?\d+(?:,\d+)? von -?\d+(?:,\d+)?|nicht entschuldigt|Tippen zum Aufdecken|Tap to reveal|unexcused|Neue Noten|new grades|Neue Note|New grade|fällt aus|(?<![\p{L}])Vertretung(?![\p{L}])|(?<![\p{L}])Substitution(?![\p{L}])|(?<![\p{L}])Gewicht(?![\p{L}])|(?<![\p{L}])Weight(?![\p{L}])|Raum |Room |(?<!un)entschuldigt|(?<!un)excused"""
)

private val EXACT = mapOf(
    "Verspätung" to R.string.commute_alert_delay,
    "Fällt aus" to R.string.commute_alert_cancelled,
    "Anschluss verpasst" to R.string.commute_alert_missed,
    "Verbindung fehlt" to R.string.commute_alert_pin_missing,
    "Gleisänderung" to R.string.commute_alert_platform,
    "Früher nach Hause" to R.string.commute_alert_home_early,
    "Später zur Schule" to R.string.commute_alert_school_late,
    "a subject" to R.string.phrase_a_subject,
    "Absences: the page loaded, but it could not be read" to R.string.phrase_absences_unreadable,
    "Absenzen: Seite geladen, aber nicht lesbar" to R.string.phrase_absences_unreadable,
    "Already signed in to Schulnetz" to R.string.already_signed_in_schulnetz,
    "Anfrage fehlgeschlagen" to R.string.phrase_request_failed,
    "Ankündigung" to R.string.announcement_item,
    "Announcement" to R.string.announcement_item,
    "Auch eine 6 reicht für diesen Schnitt nicht." to R.string.phrase_even_six,
    "Bei Schulnetz neu anmelden" to R.string.phrase_sign_in_schulnetz,
    "Bereits bei Schulnetz angemeldet" to R.string.already_signed_in_schulnetz,
    "biometric_required" to R.string.phrase_biometric,
    "Bitte erneut anmelden." to R.string.phrase_sign_in_again,
    "cookie-expired" to R.string.phrase_cookie_expired,
    "Could not load" to R.string.phrase_load_failed,
    "Das Gewicht der nächsten Prüfung muss grösser als 0 sein." to R.string.phrase_weight_positive,
    "Das Passwort braucht mindestens 10 Zeichen." to R.string.phrase_password_short,
    "Das Passwort ist zu lang." to R.string.phrase_password_long,
    "Das Push-Token ist ungültig." to R.string.phrase_push_invalid,
    "Das Schulnetz-Token ist ungültig." to R.string.phrase_token_invalid,
    "Der Inhalt konnte nicht entschlüsselt werden." to R.string.phrase_content_decrypt,
    "Der Schnappschuss ist ungültig." to R.string.phrase_snapshot_invalid,
    "Der Schnitt ist schon gesichert. Eine 1 genügt." to R.string.phrase_already_safe,
    "Der Schulnetz-Dienst ist vorübergehend nicht erreichbar." to R.string.phrase_service_down,
    "Der Schulnetz-Schlüssel ist auf dem Server noch nicht eingerichtet." to R.string.phrase_key_missing,
    "Der Server hat keine Schlüsselparameter gesendet." to R.string.phrase_no_kdf,
    "Der Server hat nicht unterstützte Schlüsselparameter gesendet." to R.string.phrase_unsupported_kdf,
    "Der Sync-Server ist nicht erreichbar." to R.string.phrase_unreachable,
    "Der Termin ist nicht mehr im letzten Stand." to R.string.hint_event_gone,
    "Der Tresorschlüssel lässt sich mit diesem Passwort nicht entschlüsseln." to R.string.phrase_vault_password,
    "Der verschlüsselte Inhalt ist beschädigt." to R.string.phrase_content_damaged,
    "Die Absenz ist nicht mehr im letzten Stand." to R.string.hint_absence_gone,
    "Die Anfrage ist zu gross." to R.string.phrase_too_large,
    "Die beiden neuen Passwörter stimmen nicht überein." to R.string.phrase_password_mismatch,
    "Die Cookie-Daten sind zu gross." to R.string.phrase_cookies_large,
    "Die Datei-Metadaten sind unvollständig." to R.string.phrase_meta_incomplete,
    "Die Gerätekennung fehlt." to R.string.phrase_device_missing,
    "Die Lektion ist nicht mehr im letzten Stand." to R.string.hint_lesson_gone,
    "Die Microsoft-Anmeldung ist abgelaufen." to R.string.phrase_microsoft_expired,
    "Die Microsoft-Anmeldung ist abgelaufen. In Kanti+ neu anmelden." to R.string.phrase_microsoft_expired_kanti,
    "Die Microsoft-Cookies fehlen." to R.string.phrase_cookies_missing,
    "Die Note ist nicht mehr im letzten Stand." to R.string.hint_grade_gone,
    "Die Prüfung ist nicht mehr im letzten Stand." to R.string.hint_exam_gone,
    "Die Schlüsselableitung dieses Kontos wird nicht unterstützt." to R.string.phrase_kdf_account,
    "Die Schulnetz-Adresse ist nicht erlaubt." to R.string.phrase_address_not_allowed,
    "Die Schulnetz-Sitzung ist abgelaufen." to R.string.phrase_cookie_expired,
    "Die Wunschnote lässt sich daraus nicht rechnen." to R.string.phrase_cannot_calculate,
    "Die Zielnote liegt ausserhalb von 1 bis 6." to R.string.phrase_target_range,
    "Diese Anfrage braucht ein FaNotes-Konto." to R.string.phrase_needs_fanotes,
    "Diese Anfrage braucht ein Kanti+-Konto." to R.string.phrase_needs_kanti,
    "Diese Anmeldung ist abgelaufen oder wurde von einem anderen Gerät beendet." to R.string.phrase_signin_ended,
    "Diese Schulnetz-Anfrage ist nicht erlaubt." to R.string.phrase_request_not_allowed,
    "Diese Schulnetz-Anmeldung ist nicht erlaubt." to R.string.phrase_signin_not_allowed,
    "Diesen Schulnetz-Endpunkt gibt es nicht." to R.string.phrase_no_endpoint,
    "Dieses Gerät braucht noch eine biometrische Prüfung." to R.string.phrase_biometric,
    "Dieses Kanti+-Konto gibt es nicht." to R.string.phrase_no_kanti_account,
    "Dieses Passwort ist zu leicht zu erraten." to R.string.phrase_password_easy,
    "Eigene Note" to R.string.own_mark,
    "einem Fach" to R.string.phrase_a_subject,
    "Even a 6 is not enough for this average." to R.string.phrase_even_six,
    "Event" to R.string.phrase_termin,
    "Events: the page loaded, but it could not be read" to R.string.phrase_events_unreadable,
    "Exam cancelled" to R.string.phrase_exam_cancelled,
    "Exam changed" to R.string.phrase_exam_changed,
    "Exam moved" to R.string.phrase_exam_moved,
    "Exam removed" to R.string.phrase_exam_removed,
    "Exams: the page loaded, but it could not be read" to R.string.phrase_exams_unreadable,
    "File metadata is incomplete." to R.string.phrase_meta_incomplete,
    "Grade change" to R.string.phrase_grade_change,
    "Grades: the page loaded, but it could not be read" to R.string.phrase_grades_unreadable,
    "Hidden · hold to reveal" to R.string.hidden_hold,
    "Hidden · tap to reveal" to R.string.hidden_tap,
    "Invalid account." to R.string.phrase_invalid_account,
    "Invalid JSON." to R.string.phrase_bad_json,
    "Kanti+ can display notifications." to R.string.test_notification_body,
    "Kanti+ kann Benachrichtigungen anzeigen." to R.string.test_notification_body,
    "Laden fehlgeschlagen" to R.string.phrase_load_failed,
    "Lektion entfernt" to R.string.phrase_lesson_removed,
    "Lektion fällt aus" to R.string.phrase_lesson_cancelled,
    "Lesson cancelled" to R.string.phrase_lesson_cancelled,
    "Lesson removed" to R.string.phrase_lesson_removed,
    "Local mark" to R.string.local_mark,
    "Lokale Note" to R.string.local_mark,
    "Message" to R.string.phrase_message,
    "microsoft" to R.string.phrase_microsoft_expired,
    "Mitteilung" to R.string.phrase_message,
    "Neue Absenz" to R.string.phrase_new_absence,
    "Neue Mitteilung" to R.string.phrase_new_message,
    "Neue Note" to R.string.phrase_new_grade,
    "Neue Prüfung" to R.string.phrase_new_exam,
    "Neue Schulnetz-Meldung" to R.string.lock_notice,
    "Neuer Termin" to R.string.phrase_new_event,
    "New absence" to R.string.phrase_new_absence,
    "New event" to R.string.phrase_new_event,
    "New exam" to R.string.phrase_new_exam,
    "New grade" to R.string.phrase_new_grade,
    "New message" to R.string.phrase_new_message,
    "New Schulnetz notice" to R.string.lock_notice,
    "Nicht angemeldet" to R.string.phrase_not_signed_in_short,
    "Nicht angemeldet." to R.string.phrase_not_signed_in,
    "Not signed in" to R.string.phrase_not_signed_in_short,
    "Not signed in." to R.string.phrase_not_signed_in,
    "Noten: Seite geladen, aber nicht lesbar" to R.string.phrase_grades_unreadable,
    "Notenänderung" to R.string.phrase_grade_change,
    "OAuth-Handshake fehlgeschlagen." to R.string.phrase_oauth_failed,
    "Own mark" to R.string.own_mark,
    "Partial test" to R.string.partial_test_name,
    "Please sign in again." to R.string.phrase_sign_in_again,
    "Prüfung entfällt" to R.string.phrase_exam_removed,
    "Prüfung fällt aus" to R.string.phrase_exam_cancelled,
    "Prüfung geändert" to R.string.phrase_exam_changed,
    "Prüfung verschoben" to R.string.phrase_exam_moved,
    "Prüfungen: Seite geladen, aber nicht lesbar" to R.string.phrase_exams_unreadable,
    "Raum geändert" to R.string.phrase_room_changed,
    "reauth" to R.string.phrase_sign_in_schulnetz,
    "Request failed" to R.string.phrase_request_failed,
    "Room changed" to R.string.phrase_room_changed,
    "Schulnetz braucht eine Anmeldung." to R.string.phrase_needs_signin,
    "Schulnetz did not return a refresh token." to R.string.phrase_no_refresh,
    "Schulnetz hat die Anmeldung abgelehnt" to R.string.phrase_schulnetz_rejected,
    "Schulnetz hat die IP-Adresse abgelehnt. Anmeldung wird erneuert." to R.string.phrase_ip_rejected,
    "Schulnetz hat kein Refresh-Token geliefert." to R.string.phrase_no_refresh,
    "Schulnetz is not connected yet." to R.string.phrase_not_connected,
    "Schulnetz is unreachable." to R.string.phrase_schulnetz_down,
    "Schulnetz ist noch nicht verbunden." to R.string.phrase_not_connected,
    "Schulnetz needs a sign-in." to R.string.phrase_needs_signin,
    "Schulnetz nicht erreichbar" to R.string.phrase_schulnetz_down,
    "Schulnetz rejected the IP address. Sign-in will be renewed." to R.string.phrase_ip_rejected,
    "Schulnetz rejected the sign-in" to R.string.phrase_schulnetz_rejected,
    "Schulnetz-Sitzung abgelaufen. Anmeldung wird erneuert." to R.string.phrase_session_expired,
    "Sign in to Schulnetz again" to R.string.phrase_sign_in_schulnetz,
    "Stundenplan geändert" to R.string.phrase_timetable_changed,
    "Stundenplan: Seite geladen, aber nicht lesbar" to R.string.phrase_timetable_unreadable,
    "Substitution" to R.string.phrase_substitution,
    "Sync failed." to R.string.phrase_sync_failed,
    "Sync is not attached." to R.string.phrase_sync_not_attached,
    "Sync is not available in this environment." to R.string.phrase_sync_unavailable_env,
    "Sync ist fehlgeschlagen." to R.string.phrase_sync_failed,
    "Sync ist in dieser Umgebung nicht verfügbar." to R.string.phrase_sync_unavailable_env,
    "Sync ist nicht verbunden." to R.string.phrase_sync_not_attached,
    "Tap to reveal" to R.string.phrase_tap_reveal,
    "Teilprüfung" to R.string.partial_test_name,
    "Termin" to R.string.phrase_termin,
    "Termine: Seite geladen, aber nicht lesbar" to R.string.phrase_events_unreadable,
    "Test notification" to R.string.test_notification,
    "Testbenachrichtigung" to R.string.test_notification,
    "That Schulnetz endpoint does not exist." to R.string.phrase_no_endpoint,
    "The absence is no longer in the last snapshot." to R.string.hint_absence_gone,
    "The average is already safe. A 1 is enough." to R.string.phrase_already_safe,
    "The content could not be decrypted." to R.string.phrase_content_decrypt,
    "The cookie data is too large." to R.string.phrase_cookies_large,
    "The device id is missing." to R.string.phrase_device_missing,
    "The encrypted content is damaged." to R.string.phrase_content_damaged,
    "The event is no longer in the last snapshot." to R.string.hint_event_gone,
    "The exam is no longer in the last snapshot." to R.string.hint_exam_gone,
    "The grade is no longer in the last snapshot." to R.string.hint_grade_gone,
    "The lesson is no longer in the last snapshot." to R.string.hint_lesson_gone,
    "The Microsoft cookies are missing." to R.string.phrase_cookies_missing,
    "The Microsoft sign-in has expired." to R.string.phrase_microsoft_expired,
    "The Microsoft sign-in has expired. Sign in again in Kanti+." to R.string.phrase_microsoft_expired_kanti,
    "The OAuth handshake failed." to R.string.phrase_oauth_failed,
    "The password is too long." to R.string.phrase_password_long,
    "The password needs at least 10 characters." to R.string.phrase_password_short,
    "The push token is invalid." to R.string.phrase_push_invalid,
    "The request is too large." to R.string.phrase_too_large,
    "The Schulnetz address is not allowed." to R.string.phrase_address_not_allowed,
    "The Schulnetz key is not set up on the server yet." to R.string.phrase_key_missing,
    "The Schulnetz service is temporarily unavailable." to R.string.phrase_service_down,
    "The Schulnetz session expired. Sign-in will be renewed." to R.string.phrase_session_expired,
    "The Schulnetz session has expired." to R.string.phrase_cookie_expired,
    "The Schulnetz token is invalid." to R.string.phrase_token_invalid,
    "The server sent no key parameters." to R.string.phrase_no_kdf,
    "The server sent unsupported key parameters." to R.string.phrase_unsupported_kdf,
    "The snapshot is invalid." to R.string.phrase_snapshot_invalid,
    "The sync server is unreachable." to R.string.phrase_unreachable,
    "The target grade cannot be calculated from this." to R.string.phrase_cannot_calculate,
    "The target grade is outside 1 to 6." to R.string.phrase_target_range,
    "The two new passwords do not match." to R.string.phrase_password_mismatch,
    "The vault key could not be decrypted with this password." to R.string.phrase_vault_password,
    "The weight of the next exam must be greater than 0." to R.string.phrase_weight_positive,
    "This account's key derivation is not supported." to R.string.phrase_kdf_account,
    "This device still needs a biometric check." to R.string.phrase_biometric,
    "This Kanti+ account does not exist." to R.string.phrase_no_kanti_account,
    "This password is too easy to guess." to R.string.phrase_password_easy,
    "This request needs a FaNotes account." to R.string.phrase_needs_fanotes,
    "This request needs a Kanti+ account." to R.string.phrase_needs_kanti,
    "This Schulnetz request is not allowed." to R.string.phrase_request_not_allowed,
    "This Schulnetz sign-in is not allowed." to R.string.phrase_signin_not_allowed,
    "This sign-in expired or was ended from another device." to R.string.phrase_signin_ended,
    "Time changed" to R.string.phrase_time_changed,
    "Timetable changed" to R.string.phrase_timetable_changed,
    "Timetable: the page loaded, but it could not be read" to R.string.phrase_timetable_unreadable,
    "Tippen zum Aufdecken" to R.string.phrase_tap_reveal,
    "token" to R.string.phrase_token_invalid,
    "Too many requests. Please try again later." to R.string.phrase_too_many_later,
    "Too many requests. Please wait a moment." to R.string.phrase_too_many,
    "Ungültiges JSON." to R.string.phrase_bad_json,
    "Ungültiges Konto." to R.string.phrase_invalid_account,
    "Verdeckt · halten zum Aufdecken" to R.string.hidden_hold,
    "Verdeckt · tippen zum Aufdecken" to R.string.hidden_tap,
    "Vertretung" to R.string.phrase_substitution,
    "Zeit geändert" to R.string.phrase_time_changed,
    "Zu viele Anfragen. Bitte kurz warten." to R.string.phrase_too_many,
    "Zu viele Anfragen. Bitte später erneut versuchen." to R.string.phrase_too_many_later,
)
