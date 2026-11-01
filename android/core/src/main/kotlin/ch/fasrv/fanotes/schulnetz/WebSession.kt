package ch.fasrv.fanotes.schulnetz

import java.net.URI

enum class SessionProblem { NONE, INACTIVITY, IP_REJECTED, LOGIN_WALL }

data class WebSession(
    val baseUrl: String,
    val phpSessionId: String,
    val id: String,
    val transid: String,
)

private val HEX_ID = Regex("""(?i)(?:^|[?&])id=([a-f0-9]{4,})""")
private val HEX_TRANS = Regex("""(?i)(?:^|[?&])transid=([a-f0-9]{4,})""")

fun sessionProblem(url: String, html: String): SessionProblem {
    val blob = "${url}\n$html".lowercase()
    if (blob.contains("ip-adresse wurde vom system zurückgewiesen") || blob.contains("ip-adresse wurde vom system zurueckgewiesen")) {
        return SessionProblem.IP_REJECTED
    }
    if (blob.contains("inaktivitätslimit") || blob.contains("inaktivitaetslimit") || blob.contains("mode=5")) {
        return SessionProblem.INACTIVITY
    }
    if (url.lowercase().contains("loginto.php")) return SessionProblem.LOGIN_WALL
    if (html.contains("name=\"passwort\"", ignoreCase = true) || html.contains("name=\"login\"", ignoreCase = true) && html.contains("loginto", ignoreCase = true)) {
        return SessionProblem.LOGIN_WALL
    }
    return SessionProblem.NONE
}

fun sessionProblemText(problem: SessionProblem): String = when (problem) {
    SessionProblem.NONE -> ""
    SessionProblem.IP_REJECTED -> "Schulnetz hat die IP-Adresse abgelehnt. Anmeldung wird erneuert."
    SessionProblem.INACTIVITY -> "Schulnetz-Sitzung abgelaufen. Anmeldung wird erneuert."
    SessionProblem.LOGIN_WALL -> "Schulnetz braucht eine Anmeldung."
}

/** Logged-in Start: school landing or page 1, with a session id, and not a login wall. */
fun isLoggedInLanding(url: String, html: String): Boolean {
    if (sessionProblem(url, html) != SessionProblem.NONE) return false
    val parsed = runCatching { URI(url) }.getOrNull() ?: return false
    val host = parsed.host?.lowercase().orEmpty()
    if (host != "schulnetz-ag.ch" && !host.endsWith(".schulnetz-ag.ch")) return false
    val path = (parsed.path ?: "").trimEnd('/').lowercase()
    val page = queryValue(parsed.rawQuery, "pageid")
    val start = path.endsWith("/aksa") || page == null || page == "1"
    if (!start) return false
    if (extractWebSession(url, html, "https://$host/aksa") != null) return true
    return html.contains("pageid=21311", ignoreCase = true) || html.contains("pageid=21111", ignoreCase = true)
}

fun extractWebSession(url: String, html: String, baseUrl: String): WebSession? {
    val id = firstHex(url, html, HEX_ID) ?: return null
    val transid = firstHex(url, html, HEX_TRANS) ?: return null
    val php = Regex("""PHPSESSID=([A-Za-z0-9]+)""").find(html)?.groupValues?.get(1).orEmpty()
    return WebSession(baseUrl.trimEnd('/'), php, id, transid)
}

fun freshTransid(html: String, fallback: String): String =
    HEX_TRANS.find(html)?.groupValues?.get(1) ?: fallback

fun pageUrl(baseUrl: String, pageId: String, id: String, transid: String, extra: String = ""): String {
    val tail = if (extra.isBlank()) "" else "&$extra"
    return "${baseUrl.trimEnd('/')}/index.php?pageid=$pageId&id=$id&transid=$transid$tail"
}

fun schedulerUrl(baseUrl: String, id: String, transid: String, today: String, minDate: String, maxDate: String): String =
    "${baseUrl.trimEnd('/')}/scheduler_processor.php?view=week&curr_date=$today&min_date=$minDate&max_date=$maxDate&ansicht=schueleransicht&id=$id&transid=$transid&pageid=22202&timeshift=-120"

/** Microsoft hosts whose cookies let a later login skip the password. PHPSESSID is never one of them. */
val SSO_COOKIE_URLS = listOf(
    "https://login.microsoftonline.com/",
    "https://login.microsoft.com/",
    "https://login.live.com/",
    "https://login.windows.net/",
)

fun stripPhpSession(cookieHeader: String): String =
    cookieHeader.split(';').map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("PHPSESSID=", ignoreCase = true) }.joinToString("; ")

private fun firstHex(url: String, html: String, pattern: Regex): String? {
    val htmlText = html.replace("&amp;", "&")
    return pattern.find(url)?.groupValues?.get(1) ?: pattern.find(htmlText)?.groupValues?.get(1)
}

private fun queryValue(query: String?, name: String): String? {
    if (query.isNullOrBlank()) return null
    return query.split('&').firstNotNullOfOrNull { part ->
        val cut = part.indexOf('=')
        if (cut <= 0) null else if (part.substring(0, cut).equals(name, true)) part.substring(cut + 1) else null
    }
}
