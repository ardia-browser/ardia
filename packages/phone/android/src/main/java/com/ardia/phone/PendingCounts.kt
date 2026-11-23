package com.ardia.phone

import android.content.Context
import com.ardia.browser.NightShadeVerdictUse

object UsageConsent {
    private const val PREFERENCES = "ardia-usage-consent"
    private const val SHARING = "sharing"
    private const val GENERATION = "generation"

    private fun preferences(context: Context) = (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun set(context: Context, sharing: Boolean) = synchronized(PendingCounts) {
        synchronized(this) {
            val stored = preferences(context)
            if (stored.getBoolean(SHARING, false) == sharing && stored.contains(GENERATION)) return@synchronized
            stored.edit().putBoolean(SHARING, sharing).putLong(GENERATION, stored.getLong(GENERATION, 0L) + 1).commit()
            if (!sharing) PendingCounts.clear(context)
        }
    }

    fun state(context: Context): Pair<Boolean, Long> = synchronized(this) {
        val stored = preferences(context)
        stored.getBoolean(SHARING, false) to stored.getLong(GENERATION, 0L)
    }

    fun window(context: Context): Long? = synchronized(this) {
        val stored = preferences(context)
        if (stored.getBoolean(SHARING, false)) stored.getLong(GENERATION, 0L) else null
    }
}

object PendingCounts {
    const val TABS_SENT = "tabs_sent"
    const val GLASS_SHADERS_FAILED = "glass_shaders_failed"
    const val NIGHT_SHADE_VERDICTS_REUSED = "night_shade_verdicts_reused"
    const val NIGHT_SHADE_VERDICTS_LEARNED = "night_shade_verdicts_learned"
    const val NIGHT_SHADE_VERDICTS_CORRECTED = "night_shade_verdicts_corrected"

    fun nightShadeField(use: NightShadeVerdictUse): String = when (use) {
        NightShadeVerdictUse.Reused -> NIGHT_SHADE_VERDICTS_REUSED
        NightShadeVerdictUse.Learned -> NIGHT_SHADE_VERDICTS_LEARNED
        NightShadeVerdictUse.Corrected -> NIGHT_SHADE_VERDICTS_CORRECTED
    }

    interface Store {
        fun all(): Map<String, Int>
        fun add(field: String, by: Int): Boolean
        fun clear(): Boolean
    }

    private class Preferences(context: Context) : Store {
        private val preferences = (context.applicationContext ?: context).getSharedPreferences("ardia-pending-counts", Context.MODE_PRIVATE)

        override fun all(): Map<String, Int> = preferences.all.mapNotNull { (field, value) -> (value as? Int)?.takeIf { it > 0 }?.let { field to it } }.toMap()

        override fun add(field: String, by: Int): Boolean = preferences.edit().putInt(field, preferences.getInt(field, 0) + by).commit()

        override fun clear(): Boolean = preferences.edit().clear().commit()
    }

    @Volatile
    internal var storeForTests: Store? = null

    private fun store(context: Context): Store = storeForTests ?: Preferences(context)

    fun add(context: Context, field: String, window: Long?, by: Int = 1) = synchronized(this) {
        if (window == null || UsageConsent.window(context) != window) return@synchronized
        store(context).add(field, by)
        Unit
    }

    fun glassShaderFailures(app: Context, write: (() -> Unit) -> Unit = { work -> kotlin.concurrent.thread(name = "ardia-glass-count") { work() } }): () -> Unit = {
        val window = UsageConsent.window(app)
        if (window != null) write { add(app, GLASS_SHADERS_FAILED, window) }
    }

    fun peek(context: Context): Map<String, Int> = synchronized(this) { store(context).all() }

    fun take(context: Context): Map<String, Int> = synchronized(this) {
        val store = store(context)
        val taken = store.all()
        if (taken.isEmpty()) return@synchronized emptyMap()
        if (!store.clear()) return@synchronized emptyMap()
        taken
    }

    fun clear(context: Context) = synchronized(this) {
        store(context).clear()
        Unit
    }
}
