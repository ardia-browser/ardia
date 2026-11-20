package com.ardia.phone

import android.content.Context

internal object PageSummaryChoice {
    private const val FILE = "ardia-page-summary"
    private const val PROVIDER = "provider"

    fun stored(context: Context): PageSummaryProvider = PageSummaryProvider.of(preferences(context).getString(PROVIDER, null))

    fun choose(context: Context, provider: PageSummaryProvider) {
        preferences(context).edit().putString(PROVIDER, provider.raw).apply()
    }

    private fun preferences(context: Context) = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
