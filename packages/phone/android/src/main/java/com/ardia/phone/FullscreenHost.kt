package com.ardia.phone

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.ardia.browser.FullscreenVideo

internal object FullscreenRotation {
    fun whileShowing(held: Int): Int? = if (held == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) ActivityInfo.SCREEN_ORIENTATION_FULL_USER else null
}

class FullscreenHost {
    private var shown: FullscreenVideo? = null
    private var frame: FrameLayout? = null
    private var activity: Activity? = null
    private var heldOrientation: Int? = null

    val isShowing: Boolean get() = shown != null

    fun show(activity: Activity?, video: FullscreenVideo) {
        if (shown === video) return
        hide()
        activity ?: return
        val decor = activity.window.decorView as? ViewGroup ?: return
        val holder = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
        (video.view.parent as? ViewGroup)?.removeView(video.view)
        holder.addView(video.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        decor.addView(holder, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        InsetHold.fullscreenStarts()
        bars(activity, holder).run {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        shown = video
        frame = holder
        this.activity = activity
        FullscreenRotation.whileShowing(activity.requestedOrientation)?.let { turning ->
            heldOrientation = activity.requestedOrientation
            activity.requestedOrientation = turning
        }
        if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB fullscreen starts, in ${if (activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait"}")
    }

    fun hide(reason: String = "replaced") {
        val holder = frame
        val activity = activity
        val held = heldOrientation
        shown = null
        frame = null
        this.activity = null
        heldOrientation = null
        if (activity != null && held != null) activity.requestedOrientation = held
        holder ?: return
        if (PhoneLab.isOn) {
            val turned = activity?.resources?.configuration?.orientation?.let { if (it == android.content.res.Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait" } ?: "unknown"
            android.util.Log.i("PAGELAB", "PAGELAB fullscreen ends: $reason, in $turned")
        }
        holder.removeAllViews()
        (holder.parent as? ViewGroup)?.removeView(holder)
        activity?.let { bars(it, it.window.decorView).show(WindowInsetsCompat.Type.systemBars()) }
        InsetHold.fullscreenEnds()
    }

    fun owns(video: FullscreenVideo?): Boolean = video != null && shown === video

    private fun bars(activity: Activity, view: View) = WindowCompat.getInsetsController(activity.window, view)
}
