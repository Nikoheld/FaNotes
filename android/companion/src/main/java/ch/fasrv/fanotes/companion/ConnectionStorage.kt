package ch.fasrv.fanotes.companion

import android.content.Context
import android.content.SharedPreferences
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import ch.fasrv.fanotes.schulnetz.slotFileName
import ch.fasrv.fanotes.schulnetz.slotKey
import ch.fasrv.fanotes.schulnetz.slotWebProfile
import java.io.File

/*
 * Storage of one school connection. Slot "" is the app's original storage (keys, files, cookie jar),
 * so the first connection of an existing install reads exactly what it always did. Every other slot
 * namespaces its preference keys, keeps its files in files/connections/<slot>/ and its cookies in a
 * WebView profile of its own.
 */

/** A view of the app preferences in which every key belongs to one connection's slot. */
class SlotPrefs(private val base: SharedPreferences, val slot: String) {
    private fun k(key: String) = slotKey(slot, key)
    fun getString(key: String, fallback: String?): String? = base.getString(k(key), fallback)
    fun getBoolean(key: String, fallback: Boolean): Boolean = base.getBoolean(k(key), fallback)
    fun getLong(key: String, fallback: Long): Long = base.getLong(k(key), fallback)
    fun getInt(key: String, fallback: Int): Int = base.getInt(k(key), fallback)
    fun getStringSet(key: String, fallback: Set<String>?): Set<String>? = base.getStringSet(k(key), fallback)
    fun contains(key: String): Boolean = base.contains(k(key))
    fun edit(): Editor = Editor(base.edit())

    /** Every key of this slot, for removing a connection. The original slot never lists others' keys. */
    fun keys(): Set<String> = base.all.keys.filter { key ->
        if (slot.isEmpty()) false else key.endsWith("@$slot")
    }.toSet()

    inner class Editor(private val editor: SharedPreferences.Editor) {
        fun putString(key: String, value: String?) = apply { editor.putString(k(key), value) }
        fun putBoolean(key: String, value: Boolean) = apply { editor.putBoolean(k(key), value) }
        fun putLong(key: String, value: Long) = apply { editor.putLong(k(key), value) }
        fun putInt(key: String, value: Int) = apply { editor.putInt(k(key), value) }
        fun putStringSet(key: String, value: Set<String>?) = apply { editor.putStringSet(k(key), value) }
        fun remove(key: String) = apply { editor.remove(k(key)) }
        fun apply() = editor.apply()
        fun commit(): Boolean = editor.commit()
    }
}

/** A file of a connection's slot; the folders are created on demand. */
fun slotFile(context: Context, slot: String, name: String): File =
    File(context.filesDir, slotFileName(slot, name)).also { it.parentFile?.mkdirs() }

/** The slot's own folder (none for the original slot, whose files live at the top level). */
fun slotDir(context: Context, slot: String): File? = if (slot.isEmpty()) null else File(context.filesDir, "connections/$slot")

/**
 * Cookie jars. Each further connection signs in inside its own WebView profile, so two Microsoft or
 * school accounts never share or overwrite a session. Needs the WebView multi-profile feature.
 */
object SchoolCookies {
    fun profilesSupported(): Boolean = runCatching { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }.getOrDefault(false)

    /** True when a connection in [slot] can have a session of its own on this device. */
    fun isolated(slot: String): Boolean = slotWebProfile(slot) == null || profilesSupported()

    fun manager(slot: String): CookieManager {
        val profile = slotWebProfile(slot) ?: return CookieManager.getInstance()
        check(profilesSupported()) { "WebView profiles are not supported" }
        return ProfileStore.getInstance().getOrCreateProfile(profile).cookieManager
    }

    /** Puts a WebView into the slot's profile. Must run before the WebView loads anything. */
    fun bind(webView: WebView, slot: String) {
        val profile = slotWebProfile(slot) ?: return
        check(profilesSupported()) { "WebView profiles are not supported" }
        ProfileStore.getInstance().getOrCreateProfile(profile)
        WebViewCompat.setProfile(webView, profile)
    }

    /** Drops a removed connection's cookies, storage and cache. The original jar is only cleared. */
    fun forget(slot: String) {
        val profile = slotWebProfile(slot)
        if (profile == null) {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            return
        }
        if (!profilesSupported()) return
        runCatching {
            val store = ProfileStore.getInstance()
            store.getProfile(profile)?.cookieManager?.let { it.removeAllCookies(null); it.flush() }
            store.deleteProfile(profile)
        }
    }
}
