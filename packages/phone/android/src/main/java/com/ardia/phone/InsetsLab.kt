package com.ardia.phone

import android.app.Activity
import android.content.res.Configuration
import android.view.View
import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

object InsetsLab {
    data class Reading(val barsTop: Int, val barsBottom: Int, val contentTop: Int, val contentHeight: Int, val rootTop: Int, val rootHeight: Int, val windowHeight: Int, val night: Boolean)

    fun line(reading: Reading): String = with(reading) {
        "PAGELAB window insets top/bottom $barsTop/$barsBottom, content top $contentTop height $contentHeight, react root top $rootTop height $rootHeight, window height $windowHeight, ${if (night) "night" else "day"}"
    }

    fun watch(activity: Activity) {
        if (!PhoneLab.isOn) return
        val decor = activity.window.decorView
        var last: Reading? = null
        decor.viewTreeObserver.addOnGlobalLayoutListener {
            val reading = read(activity, decor) ?: return@addOnGlobalLayoutListener
            if (reading == last) return@addOnGlobalLayoutListener
            last = reading
            android.util.Log.i("PAGELAB", line(reading))
        }
    }

    private fun read(activity: Activity, decor: View): Reading? {
        val insets = ViewCompat.getRootWindowInsets(decor) ?: return null
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return null
        val root = content.getChildAt(0)
        val at = IntArray(2)
        content.getLocationInWindow(at)
        val contentTop = at[1]
        root?.getLocationInWindow(at)
        val night = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        return Reading(bars.top, bars.bottom, contentTop, content.height, if (root != null) at[1] else -1, root?.height ?: -1, decor.height, night)
    }
}
