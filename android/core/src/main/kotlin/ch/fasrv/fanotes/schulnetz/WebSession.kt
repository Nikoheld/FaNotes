package ch.fasrv.fanotes.schulnetz

import java.net.URI

enum class SessionProblem { NONE, INACTIVITY, IP_REJECTED, LOGIN_WALL, INTERACTIVE, OAUTH_FAILED }

data class PageClassification(val problem: SessionProblem, val rule: String)

data class WebSession(
    val baseUrl: String,
    val phpSessionId: String,
    val id: String,
    val transid: String,
)

private val HEX_VALUE = Regex("""(?i)[a-f0-9]{4,}""")
private val HEX_ID = Regex("""(?i)(?:^|[?&])id=([a-f0-9]{4,})""")
private val HEX_TRANS = Regex("""(?i)(?:^|[?&])transid=([a-f0-9]{4,})""")
private val PAGE_ID_QUERY = Regex("""(?i)(?:^|&)pageid=(\d+)""")
private val PAGE_ID_HTML = Regex("""(?i)pageid=(\d+)""")
private val IP_REJECTED_TEXT = listOf(
    "ihre ip-adresse wurde vom system zurückgewiesen",
    "ihre ip-adresse wurde vom system zurueckgewiesen",
)
private val INACTIVITY_TEXT = listOf(
    "inaktivitätslimit überschritten",
    "inaktivitaetslimit ueberschritten",
)

/**
 * Signed-out detection uses the final URL, a missing page id, or the exact
 * inactivity / IP sentences. Menu words and the login form that every
 * schulNetz page carries (Anmelden, Abmelden, loginto.php, mode=5) are not a signal.
 */
fun classifySchulnetzPage(finalUrl: String, html: String): PageClassification {
    val host = runCatching { URI(finalUrl).host }.getOrNull()?.lowercase().orEmpty()
    if (isMicrosoftLoginHost(host)) return PageClassification(SessionProblem.INTERACTIVE, "microsoft-host")
    if (html.contains("ConvergedSignIn")) return PageClassification(SessionProblem.INTERACTIVE, "converged-sign-in")
    if (html.contains("AADSTS50058")) return PageClassification(SessionProblem.INTERACTIVE, "aadsts50058")
    if (Regex("""sErrorCode\\?"?\s*:\s*\\?"?50058""").containsMatchIn(html)) return PageClassification(SessionProblem.INTERACTIVE, "serrorcode-50058")
    if (html.contains("stsErrorCode") && html.contains("50058")) return PageClassification(SessionProblem.INTERACTIVE, "stserrorcode-50058")
    val lowerHtml = html.lowercase()
    if (IP_REJECTED_TEXT.any { lowerHtml.contains(it) }) return PageClassification(SessionProblem.IP_REJECTED, "ip-reject-message")
    if (INACTIVITY_TEXT.any { lowerHtml.contains(it) }) return PageClassification(SessionProblem.INACTIVITY, "inactivity-message")
    val uri = runCatching { URI(finalUrl) }.getOrNull()
    val path = uri?.path?.lowercase().orEmpty()
    if (path.contains("loginto.php") && queryValue(uri?.rawQuery, "mode") == "17") {
        return PageClassification(SessionProblem.OAUTH_FAILED, "url-mode-17")
    }
    if (path.contains("loginto.php") && lowerHtml.contains("login nicht erfolgreich")) {
        return PageClassification(SessionProblem.OAUTH_FAILED, "login-nicht-erfolgreich")
    }
    if (path.contains("loginto.php") && queryValue(uri?.rawQuery, "mode") == "5") {
        return PageClassification(SessionProblem.INACTIVITY, "url-mode-5")
    }
    if (path.contains("loginto.php")) return PageClassification(SessionProblem.LOGIN_WALL, "url-loginto")
    if (missingPageId(uri, html)) return PageClassification(SessionProblem.LOGIN_WALL, "missing-page-id")
    return PageClassification(SessionProblem.NONE, "ok")
}

fun microsoftLoginRequired(url: String, html: String): Boolean =
    classifySchulnetzPage(url, html).problem == SessionProblem.INTERACTIVE

fun sessionProblem(url: String, html: String): SessionProblem = classifySchulnetzPage(url, html).problem

/** Logout and the blocked page ids are never loaded. */
fun isForcedLogoutUrl(url: String): Boolean {
    val lower = url.lowercase()
    return lower.contains("pageid=9999") || lower.contains("action=global_logout") || lower.contains("global_logout")
}

fun sessionProblemText(problem: SessionProblem): String = when (problem) {
    SessionProblem.NONE -> ""
    SessionProblem.IP_REJECTED -> "Schulnetz hat die IP-Adresse abgelehnt. Anmeldung wird erneuert."
    SessionProblem.INACTIVITY -> "Schulnetz-Sitzung abgelaufen. Anmeldung wird erneuert."
    SessionProblem.LOGIN_WALL -> "Schulnetz braucht eine Anmeldung."
    SessionProblem.INTERACTIVE -> "Bei Schulnetz neu anmelden"
    SessionProblem.OAUTH_FAILED -> "OAuth-Handshake fehlgeschlagen."
}

/** A new Microsoft flow (page 1 without id) is allowed only after a confirmed sign-out, or when no session id exists. */
fun bareOauthAllowed(hasSessionId: Boolean, signedOut: Boolean): Boolean = !hasSessionId || signedOut

fun startPageUrl(baseUrl: String, id: String, transid: String, signedOut: Boolean): String {
    if (bareOauthAllowed(id.isNotBlank() && transid.isNotBlank(), signedOut)) return webLoginUrl(baseUrl)
    return pageUrl(baseUrl, "1", id, transid)
}

data class PageSessionIds(val id: String, val transid: String, val source: String)

data class NavTarget(val pageId: String, val id: String, val transid: String, val href: String)

/** id and transid from the page that just loaded. The final URL wins; otherwise the id used by the most links. */
fun sessionIdsFromPage(finalUrl: String, html: String): PageSessionIds? {
    val uri = runCatching { URI(finalUrl) }.getOrNull()
    val urlId = queryValue(uri?.rawQuery, "id")?.takeIf { HEX_VALUE.matches(it) }
    val urlTrans = queryValue(uri?.rawQuery, "transid")?.takeIf { HEX_VALUE.matches(it) }
    if (urlId != null && urlTrans != null) return PageSessionIds(urlId, urlTrans, "final-url")
    val links = navigationTargets(html)
    if (links.isEmpty()) return null
    val best = links.groupBy { it.id.lowercase() }.maxWithOrNull(
        compareBy<Map.Entry<String, List<NavTarget>>> { entry -> entry.value.map { it.pageId }.distinct().size }.thenBy { it.value.size },
    ) ?: return null
    val sample = best.value.last()
    return PageSessionIds(sample.id, sample.transid, "page-links:${best.value.size}")
}

fun navigationTargets(html: String): List<NavTarget> {
    val text = html.replace("&amp;", "&").replace("&#38;", "&")
    return Regex("""(?i)href\s*=\s*["']([^"']+)["']""").findAll(text).mapNotNull { match ->
        val href = match.groupValues[1]
        if (isForcedLogoutUrl(href)) return@mapNotNull null
        val pageId = Regex("""(?i)(?:^|[?&])pageid=(\d+)""").find(href)?.groupValues?.get(1) ?: return@mapNotNull null
        val id = Regex("""(?i)(?:^|[?&])id=([a-f0-9]{4,})""").find(href)?.groupValues?.get(1) ?: return@mapNotNull null
        val transid = Regex("""(?i)(?:^|[?&])transid=([a-f0-9]{4,})""").find(href)?.groupValues?.get(1) ?: return@mapNotNull null
        NavTarget(pageId, id, transid, href)
    }.toList()
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

fun schedulerUrl(baseUrl: String, id: String, transid: String, today: String, minDate: String, maxDate: String): String {
    val from = urlEncode("$minDate 00:00")
    val to = urlEncode("$maxDate 23:59")
    return "${baseUrl.trimEnd('/')}/scheduler_processor.php?view=week&from=$from&to=$to&curr_date=$today&min_date=$minDate&max_date=$maxDate&ansicht=schueleransicht&id=$id&transid=$transid&pageid=22202&timeshift=-60"
}

/** The Schülerplan page's own scheduler.load URL, with the range the connector expects. */
fun findSchedulerUrl(html: String, baseUrl: String, id: String, transid: String, from: String, to: String): String? {
    val raw = Regex("""scheduler_processor\.php\?[^"'\\\s<>]+""").find(html)?.value ?: return null
    val absolute = absoluteSchoolUrl(baseUrl, raw)
    if (isForcedLogoutUrl(absolute) || !webReadAllowed(absolute)) return null
    val extra = buildString {
        if (!absolute.contains("from=")) append("&from=").append(urlEncode(from)).append("&to=").append(urlEncode(to))
        if (!absolute.contains("id=") && id.isNotBlank()) append("&id=").append(id)
        if (!absolute.contains("transid=") && transid.isNotBlank()) append("&transid=").append(transid)
        if (!absolute.contains("pageid=")) append("&pageid=22202")
        if (!absolute.contains("ansicht=")) append("&ansicht=schueleransicht")
        if (!absolute.contains("timeshift=")) append("&timeshift=-60")
    }
    val url = absolute + extra
    return url.takeIf { webReadAllowed(it) }
}

private fun urlEncode(value: String): String =
    java.net.URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")

/** Microsoft hosts whose cookies let a later login skip the password. PHPSESSID is never one of them. */
val SSO_COOKIE_URLS = listOf(
    "https://login.microsoftonline.com/",
    "https://login.microsoft.com/",
    "https://login.live.com/",
    "https://login.windows.net/",
)

fun stripPhpSession(cookieHeader: String): String =
    cookieHeader.split(';').map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("PHPSESSID=", ignoreCase = true) }.joinToString("; ")

/** Href for [pageId] taken from a page that is already open. Logout links are ignored. */
fun linkedPageUrl(html: String, pageId: String, baseUrl: String, sessionId: String = ""): String? {
    if (!pageId.matches(Regex("""\d+"""))) return null
    val links = navigationTargets(html).filter { it.pageId == pageId && (sessionId.isBlank() || it.id.equals(sessionId, true)) }
    val href = links.lastOrNull()?.href ?: return null
    val absolute = absoluteSchoolUrl(baseUrl, href)
    return absolute.takeIf { webReadAllowed(it) }
}

/** Cookie values, OAuth codes and bearer tokens are removed. id and transid stay. */
fun redactSchulnetzSecrets(value: String): String {
    var text = value
    text = Regex("""(?i)(Cookie\s*:\s*)([^\r\n]+)""").replace(text) { match ->
        val names = cookieNames(match.groupValues[2])
        "${match.groupValues[1]}names=${names.joinToString(",")}"
    }
    text = Regex("""(?i)([?&#\s]|^)(code|flowToken|access_token|refresh_token|id_token|client_secret)=([^&\s#"'<>]+)""")
        .replace(text) { "${it.groupValues[1]}${it.groupValues[2]}=[redacted]" }
    text = Regex("""(?i)"(flowToken|access_token|refresh_token|id_token|client_secret|code)"\s*:\s*"[^"]*"""")
        .replace(text) { "\"${it.groupValues[1]}\":\"[redacted]\"" }
    text = Regex("""(?i)\b(PHPSESSID|ESTSAUTH[A-Z0-9]*|SignInStateCookie|esctx)=([^;\s,]+)""")
        .replace(text) { "${it.groupValues[1]}=[redacted]" }
    text = Regex("""(?i)(Authorization\s*:\s*)\S+""").replace(text) { "${it.groupValues[1]}[redacted]" }
    text = Regex("""(?i)\bBearer\s+\S+""").replace(text, "Bearer [redacted]")
    return text
}

fun cookieNames(header: String): List<String> =
    header.split(';').mapNotNull { part ->
        val name = part.trim().substringBefore('=').trim()
        if (name.isEmpty() || name.equals("path", true) || name.equals("expires", true) || name.equals("secure", true) || name.equals("httponly", true) || name.equals("samesite", true) || name.equals("domain", true) || name.equals("max-age", true)) {
            null
        } else {
            name
        }
    }

private fun missingPageId(uri: URI?, html: String): Boolean {
    if (uri == null) return false
    val host = uri.host?.lowercase().orEmpty()
    val school = host == "schulnetz-ag.ch" || host.endsWith(".schulnetz-ag.ch") || host.endsWith(".schulnetz.ch") || host.endsWith(".schulnetz.com")
    if (!school) return false
    if (PAGE_ID_QUERY.containsMatchIn(uri.rawQuery.orEmpty())) return false
    val text = html.replace("&amp;", "&")
    if (PAGE_ID_HTML.containsMatchIn(text)) return false
    val lower = html.lowercase()
    return lower.contains("<html") || lower.contains("<body") || lower.contains("<main")
}

private fun absoluteSchoolUrl(baseUrl: String, href: String): String {
    val trimmed = href.trim()
    if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed
    val base = runCatching { URI(baseUrl) }.getOrNull()
    val origin = if (base?.host.isNullOrBlank()) baseUrl.trimEnd('/') else "https://${base.host}"
    val prefix = (base?.path ?: "").trimEnd('/')
    return when {
        trimmed.startsWith("/") -> origin + trimmed
        prefix.isNotEmpty() -> "$origin$prefix/${trimmed.trimStart('/')}"
        else -> "${baseUrl.trimEnd('/')}/${trimmed.trimStart('/')}"
    }
}

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
