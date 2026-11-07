package ch.fasrv.fanotes.companion

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.content.res.Resources
import android.os.LocaleList
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.os.LocaleListCompat
import ch.fasrv.fanotes.schulnetz.formatMark
import ch.fasrv.fanotes.schulnetz.formatPluspunkte
import java.util.Locale

/**
 * Per-app language. The choice is stored beside the other app preferences.
 * ComponentActivity does not apply an AppCompat locale list on its own, so
 * [wrap] reads the stored tag and the settings screen recreates the activity.
 */
object AppLanguage {
    private const val PREF = "kanti_language"
    private const val KEY = "tag"
    private lateinit var app: Context
    var currentTag by mutableStateOf("system")
        private set

    fun install(context: Context) {
        app = context.applicationContext
        val tag = storedTag(app)
        currentTag = tag
        AppCompatDelegate.setApplicationLocales(localesFor(tag))
        applyDefaultLocale()
    }

    fun locale(): Locale {
        val tag = if (::app.isInitialized) storedTag(app) else currentTag
        if (tag == "de" || tag == "en") return Locale.forLanguageTag(tag)
        val system = Resources.getSystem().configuration.locales
        return if (system.isEmpty) Locale.getDefault() else system[0]
    }

    /** German school marks use a comma. English uses a decimal point. */
    fun formatLocale(): Locale =
        if (locale().language.equals("de", ignoreCase = true)) Locale.GERMAN else Locale.ENGLISH

    fun acceptLanguage(): String =
        if (locale().language.equals("de", ignoreCase = true)) "de" else "en"

    fun selectedTag(): String = currentTag

    fun choose(tag: String) {
        val next = if (tag == "de" || tag == "en") tag else "system"
        if (::app.isInitialized) app.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString(KEY, next).commit()
        currentTag = next
        AppCompatDelegate.setApplicationLocales(localesFor(next))
        applyDefaultLocale()
    }

    fun applyDefaultLocale() {
        val tag = if (::app.isInitialized) storedTag(app) else currentTag
        if (tag == "de" || tag == "en") Locale.setDefault(Locale.forLanguageTag(tag))
        else {
            val system = Resources.getSystem().configuration.locales
            if (!system.isEmpty) Locale.setDefault(system[0])
        }
    }

    fun wrap(base: Context): Context {
        val tag = storedTag(base)
        if (tag != "de" && tag != "en") return base
        val config = Configuration(base.resources.configuration)
        config.setLocales(LocaleList.forLanguageTags(tag))
        return base.createConfigurationContext(config)
    }

    private fun storedTag(context: Context): String = when (context.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, "system")) {
        "de" -> "de"
        "en" -> "en"
        else -> "system"
    }

    private fun localesFor(tag: String): LocaleListCompat = when (tag) {
        "de", "en" -> LocaleListCompat.forLanguageTags(tag)
        else -> LocaleListCompat.getEmptyLocaleList()
    }

    private fun resources(): Resources = wrap(app).resources

    fun get(@StringRes id: Int, vararg args: Any): String {
        val resources = resources()
        return if (args.isEmpty()) resources.getString(id) else resources.getString(id, *args)
    }

    fun quantity(@PluralsRes id: Int, quantity: Int, vararg args: Any): String {
        val resources = resources()
        return if (args.isEmpty()) resources.getQuantityString(id, quantity) else resources.getQuantityString(id, quantity, *args)
    }
}

fun t(@StringRes id: Int, vararg args: Any): String = AppLanguage.get(id, *args)

fun tp(@PluralsRes id: Int, quantity: Int, vararg args: Any): String = AppLanguage.quantity(id, quantity, *args)

fun uiMark(value: Double?, decimals: Int = 2): String = localizedNumber(formatMark(value, decimals))

fun uiPlus(value: Double): String = localizedNumber(formatPluspunkte(value))

private fun localizedNumber(text: String): String {
    if (AppLanguage.formatLocale().language == "de") return text
    return text.replace(',', '.')
}

fun Context.hostActivity(): Activity? {
    var current: Context = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
