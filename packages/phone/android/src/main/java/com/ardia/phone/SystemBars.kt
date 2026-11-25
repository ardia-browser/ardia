package com.ardia.phone

import android.app.Activity
import android.view.Window
import androidx.core.view.WindowCompat

object SystemBars {
    data class Icons(val lightStatus: Boolean, val lightNavigation: Boolean)

    @Volatile
    var wanted: Icons? = null
        private set

    fun want(icons: Icons, activity: Activity?) {
        wanted = icons
        activity?.window?.let(::apply)
    }

    fun apply(window: Window) {
        val icons = wanted ?: return
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !icons.lightStatus
        controller.isAppearanceLightNavigationBars = !icons.lightNavigation
    }

    internal fun forgetForTests() {
        wanted = null
    }
}
