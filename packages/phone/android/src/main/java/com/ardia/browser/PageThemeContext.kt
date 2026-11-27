package com.ardia.browser

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.view.ContextThemeWrapper

internal class PageThemeContext(val host: Context, val night: Boolean) : ContextThemeWrapper(host, themeOf(host)) {
    init {
        applyOverrideConfiguration(Configuration().apply { uiMode = withNight(host.resources.configuration.uiMode, night) })
    }

    companion object {
        fun systemNight(): Boolean = isNight(Resources.getSystem().configuration.uiMode)

        fun isNight(uiMode: Int): Boolean = uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

        fun withNight(uiMode: Int, night: Boolean): Int {
            val type = (uiMode and Configuration.UI_MODE_TYPE_MASK).takeIf { it != Configuration.UI_MODE_TYPE_UNDEFINED } ?: Configuration.UI_MODE_TYPE_NORMAL
            return type or if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        }

        private fun themeOf(host: Context): Int {
            val activityTheme = (host as? Activity)?.let { activity ->
                runCatching { activity.packageManager.getActivityInfo(activity.componentName, 0).themeResource }.getOrNull()
            }
            return activityTheme?.takeIf { it != 0 } ?: host.applicationInfo.theme
        }
    }
}
