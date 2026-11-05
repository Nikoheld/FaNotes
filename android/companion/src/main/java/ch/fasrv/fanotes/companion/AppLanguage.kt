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
import androidx.core.os.LocaleListCompat
import ch.fasrv.fanotes.schulnetz.formatMark
import ch.fasrv.fanotes.schulnetz.formatPluspunkte
import java.util.Locale

/**
 * Per-app language. An empty locale list follows the system.
 * Deutsch and English are applied with AppCompatDelegate.setApplicationLocales.
 */
object AppLanguage {
    private lateinit var app: Context

    fun install(context: Context) {
        app = context.applicationContext
        applyDefaultLocale()
    }

    fun locale(): Locale {
        val selected = AppCompatDelegate.getApplicationLocales()
        if (!selected.isEmpty) return selected[0] ?: Locale.getDefault()
        val system = Resources.getSystem().configuration.locales
        return if (system.isEmpty) Locale.getDefault() else system[0]
    }

    /** German school marks use a comma. English uses a decimal point. */
    fun formatLocale(): Locale =
        if (locale().language.equals("de", ignoreCase = true)) Locale.GERMAN else Locale.ENGLISH

    fun acceptLanguage(): String =
        if (locale().language.equals("de", ignoreCase = true)) "de" else "en"

    fun selectedTag(): String {
        val selected = AppCompatDelegate.getApplicationLocales()
        if (selected.isEmpty) return "system"
        return if (selected[0]?.language.equals("de", ignoreCase = true) == true) "de" else "en"
    }

    fun choose(tag: String) {
        val locales = if (tag.isBlank() || tag == "system") {
            LocaleListCompat.getEmptyLocaleList()
        } else {
            LocaleListCompat.forLanguageTags(tag)
        }
        AppCompatDelegate.setApplicationLocales(locales)
        applyDefaultLocale()
    }

    fun applyDefaultLocale() {
        val selected = AppCompatDelegate.getApplicationLocales()
        if (selected.isEmpty) {
            val system = Resources.getSystem().configuration.locales
            if (!system.isEmpty) Locale.setDefault(system[0])
        } else {
            selected[0]?.let(Locale::setDefault)
        }
    }

    fun wrap(base: Context): Context {
        val selected = AppCompatDelegate.getApplicationLocales()
        if (selected.isEmpty) return base
        val config = Configuration(base.resources.configuration)
        config.setLocales(LocaleList.forLanguageTags(selected.toLanguageTags()))
        return base.createConfigurationContext(config)
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
