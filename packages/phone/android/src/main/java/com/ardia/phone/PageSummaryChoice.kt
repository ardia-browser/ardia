package com.ardia.phone

import android.content.Context

internal object PageSummaryChoice {
    private const val FILE = "ardia-page-summary"
    private const val PROVIDER = "provider"
    private const val ENABLED = "enabled"

    var revision: Long = 0L
        private set

    fun stored(context: Context): PageSummaryProvider = PageSummaryProvider.of(preferences(context).getString(PROVIDER, null))

    fun choose(context: Context, provider: PageSummaryProvider) {
        preferences(context).edit().putString(PROVIDER, provider.raw).apply()
    }

    fun isEnabled(context: Context): Boolean = preferences(context).getBoolean(ENABLED, false)

    fun enable(context: Context, enabled: Boolean) {
        revision++
        preferences(context).edit().putBoolean(ENABLED, enabled).apply()
    }

    private fun preferences(context: Context) = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
