package ch.fasrv.fanotes.schulnetz

import java.net.URI

/**
 * Companion never enrols, never confirms a grade, and never files an absence.
 * Allowed calls are GET reads plus the OAuth token exchange and refresh.
 */
private val REST_GET = setOf(
    "/rest/v1/me",
    "/rest/v1/me/grades",
    "/rest/v1/me/events",
    "/rest/v1/me/exams",
    "/rest/v1/me/absences",
    "/rest/v1/me/absencenotices",
    "/rest/v1/me/vacations",
    "/rest/v1/me/notes/homework",
    "/rest/v1/me/notes/objectives",
    "/rest/v1/me/notifications/push",
    "/rest/v1/me/notifications/topics",
    "/rest/v1/me/courses",
    "/rest/v1/me/certificates/grades",
    "/rest/v1/me/lateness",
    "/rest/v1/config/settings",
    "/rest/v1/config/lists/absencenoticestatus",
)

private val READ_PAGE_IDS = setOf(
    "1", "21311", "21111", "21411", "22202", "22108", "21312", "21200", "22206",
    "1000", "1001", "1012",
)

private val BLOCKED_PAGE_IDS = setOf("23118", "23100", "23104", "23102", "23182", "23150", "23156", "9999")

fun schulnetzCallAllowed(method: String, url: String, body: String? = null): Boolean {
    val verb = method.trim().uppercase()
    if (verb !in setOf("GET", "HEAD", "POST")) return false
    val parsed = runCatching { URI(url) }.getOrNull() ?: return false
    if (!parsed.scheme.equals("https", true)) return false
    val path = (parsed.rawPath ?: "").lowercase()
    val query = (parsed.rawQuery ?: "").lowercase()
    val blob = "$path?$query"
    if (containsBlocked(blob) || containsBlocked(body?.lowercase().orEmpty())) return false
    if (path.endsWith("/authorize.php")) return false
    if (verb == "POST") return tokenPostAllowed(path, body) || hiddenAuthPostAllowed(parsed.host, path, body)
    if (path.endsWith("/loginto.php") || path.endsWith("/token.php")) return !query.contains("action=")
    restPath(path)?.let { rest ->
        return rest in REST_GET
    }
    if (path.endsWith("/index.php")) return readPage(query)
    if (path.endsWith("/scheduler_processor.php")) {
        return !query.contains("action=") && (query.contains("pageid=22202") || query.contains("ansicht=schueleransicht"))
    }
    return false
}

fun loginWebViewAllowed(url: String, schulnetzHost: String): Boolean {
    val parsed = runCatching { URI(url) }.getOrNull() ?: return false
    val scheme = parsed.scheme?.lowercase().orEmpty()
    if (scheme != "https") return false
    val path = (parsed.rawPath ?: "").lowercase()
    if (path.endsWith("/authorize.php")) return false
    val host = parsed.host?.lowercase().orEmpty()
    if (isMicrosoftLoginHost(host)) return true
    if (host == "schulnetz.web.app") return true
    val school = (if (schulnetzHost.startsWith("http")) runCatching { URI(schulnetzHost).host }.getOrNull() else schulnetzHost)
        ?.lowercase().orEmpty()
    if (host == school || host.endsWith(".schulnetz-ag.ch")) {
        val blob = "${path}?${parsed.rawQuery.orEmpty()}".lowercase()
        if (containsBlocked(blob)) return false
        val trimmed = path.trimEnd('/')
        val basePath = if (schulnetzHost.startsWith("http")) {
            runCatching { URI(schulnetzHost).rawPath }.getOrNull().orEmpty().trimEnd('/').lowercase()
        } else {
            ""
        }
        if (trimmed == "/aksa" || (basePath.isNotEmpty() && trimmed == basePath)) return true
        return schulnetzCallAllowed("GET", url)
    }
    return false
}

/** GET of a logged-in page or the bare school landing. Never authorize.php. */
fun webReadAllowed(url: String): Boolean {
    val parsed = runCatching { URI(url) }.getOrNull() ?: return false
    if (!parsed.scheme.equals("https", true)) return false
    val path = (parsed.rawPath ?: "").lowercase()
    val blob = "$path?${parsed.rawQuery.orEmpty()}".lowercase()
    if (containsBlocked(blob) || path.endsWith("/authorize.php")) return false
    val trimmed = path.trimEnd('/')
    if (trimmed.endsWith("/aksa") || trimmed == "") return true
    return schulnetzCallAllowed("GET", url)
}

/** AKSA's Entra app rejects the mobile client redirect, so the website session is the login. */
fun usesWebsiteSession(baseUrl: String): Boolean {
    val host = runCatching { URI(baseUrl.trim()).host }.getOrNull()?.lowercase().orEmpty()
    return host == "schulnetz-ag.ch" || host.endsWith(".schulnetz-ag.ch")
}

fun webLoginUrl(baseUrl: String): String = baseUrl.trimEnd('/') + "/index.php?pageid=1"

private fun hiddenAuthPostAllowed(host: String?, path: String, body: String?): Boolean {
    val form = body?.lowercase().orEmpty()
    if (form.contains("passwort") || form.contains("password=") || form.contains("passwd")) return false
    if (!form.contains("code=") && !form.contains("id_token=") && !form.contains("session_state=")) return false
    val value = host?.lowercase().orEmpty()
    if (isMicrosoftLoginHost(value)) return true
    return path.endsWith("/index.php") || path.endsWith("/aksa") || path.endsWith("/")
}

fun isMicrosoftLoginHost(host: String): Boolean {
    val value = host.lowercase()
    return value == "login.microsoftonline.com" ||
        value == "login.microsoft.com" ||
        value == "login.live.com" ||
        value.endsWith(".login.microsoftonline.com") ||
        value.endsWith(".msidentity.com") ||
        value.endsWith(".msauth.net") ||
        value.endsWith(".msftauth.net")
}

/** HTTPS Schulnetz host. Rejects arbitrary bases so a linked account cannot retarget the poller. */
fun normalizeSchoolBase(baseUrl: String): String? {
    val parsed = runCatching { URI(baseUrl.trim()) }.getOrNull() ?: return null
    if (!parsed.scheme.equals("https", true)) return null
    if (!parsed.userInfo.isNullOrBlank()) return null
    val host = parsed.host?.lowercase() ?: return null
    if (!host.matches(Regex("^[a-z0-9.-]+$"))) return null
    val allowed = host == "schulnetz.web.app" ||
        host.endsWith(".schulnetz-ag.ch") ||
        host.endsWith(".schulnetz.ch") ||
        host.endsWith(".schulnetz.com") ||
        host.startsWith("schulnetz.")
    if (!allowed) return null
    val path = (parsed.rawPath ?: "").trimEnd('/')
    return "https://$host$path"
}

private fun tokenPostAllowed(path: String, body: String?): Boolean {
    if (!path.endsWith("/token.php")) return false
    val form = body?.lowercase().orEmpty()
    if (form.contains("passwort") || form.contains("loginhash") || form.contains("eschool")) return false
    val grant = form.split('&').firstNotNullOfOrNull { part ->
        val cut = part.indexOf('=')
        if (cut <= 0) null else if (part.substring(0, cut) == "grant_type") part.substring(cut + 1) else null
    } ?: return false
    return grant == "authorization_code" || grant == "refresh_token"
}

private fun readPage(query: String): Boolean {
    if (query.contains("action=")) return false
    val pageId = query.split('&').firstNotNullOfOrNull { part ->
        if (part.startsWith("pageid=")) part.substringAfter('=') else null
    } ?: return false
    return pageId in READ_PAGE_IDS
}

private fun restPath(path: String): String? {
    val index = path.indexOf("/rest/v1/")
    if (index < 0) return null
    return path.substring(index).trimEnd('/')
}

private fun containsBlocked(value: String): Boolean {
    if (value.isEmpty()) return false
    if (value.contains("eschool") || value.contains("e-school") || value.contains("e_school")) return true
    if (value.contains("notifications/token")) return true
    if (value.contains("isalreadyconfirmed")) return true
    if (value.contains("bestaetigen") || value.contains("best%c3%a4tigen") || value.contains("bestätigen")) return true
    if (value.contains("action=confirm") || value.contains("action=global_logout")) return true
    if (value.contains("gradeconfirm") || value.contains("/enroll")) return true
    for (pageId in BLOCKED_PAGE_IDS) {
        if (value.contains("pageid=$pageId")) return true
    }
    return false
}
