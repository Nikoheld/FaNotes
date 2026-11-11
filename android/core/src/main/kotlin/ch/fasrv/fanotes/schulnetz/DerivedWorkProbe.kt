package ch.fasrv.fanotes.schulnetz

/**
 * Test probe: the expensive derived-data builders report each call here. Production leaves [listener] null, so a hit costs
 * one volatile read. The UI regression guard installs a listener and fails when such work runs on the main thread
 * during scrolling, tab switches or taps. [detail] is only used for diagnostics and scoping (for example the days of an agenda build).
 */
object DerivedWorkProbe {
    @Volatile @JvmField var listener: ((name: String, detail: Any?) -> Unit)? = null

    fun hit(name: String, detail: Any? = null) {
        listener?.invoke(name, detail)
    }
}
