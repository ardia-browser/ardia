package com.ardia.phone

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

object WidgetColorChoice {
    private const val PREFERENCES = "ardia-widgets"
    private const val KEY = "colorChoice"

    @Volatile
    private var state: MutableStateFlow<String?>? = null

    private fun stateOf(context: Context): MutableStateFlow<String?> = state ?: synchronized(this) {
        state ?: MutableStateFlow(
            (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY, null),
        ).also { state = it }
    }

    fun flow(context: Context): StateFlow<String?> = stateOf(context)

    fun set(context: Context, choice: String?) {
        val kept = choice?.trim()?.takeIf { it.isNotEmpty() }
        val flow = stateOf(context)
        if (flow.value == kept) return
        (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(KEY, kept).apply()
        flow.value = kept
    }

    internal fun forgetForTests() {
        state = null
    }
}
