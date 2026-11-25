package com.ardia.phone

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.SystemClock
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference
import kotlin.math.abs

class InsetHold(private val clock: () -> Long = SystemClock::uptimeMillis) {
    private var seen: Configuration? = null
    private var themeBase: Configuration? = null
    private var last: Insets? = null
    private var held: Insets? = null
    private var lastIme = 0
    private var heldIme = 0
    private var until = 0L
    private var fullscreen = false
    private var followsTheBar = false
    private var heldSince = -1L
    private var why = ""

    val holding: Boolean get() = fullscreen || clock() < until

    val heldMillisLeft: Long get() = if (fullscreen) 0 else (until - clock()).coerceAtLeast(0)

    fun configurationChanged(next: Configuration) {
        val before = seen
        seen = Configuration(next)
        if (before == null) return
        val diff = before.diff(next)
        val change = "0x${Integer.toHexString(diff)}"
        when {
            diff and ActivityInfo.CONFIG_UI_MODE != 0 && diff and LAYOUT_CHANGES == 0 -> {
                themeBase = Configuration(before)
                hold(last, HOLD_MILLIS, "a light/dark change ($change)")
                followsTheBar = false
                heldIme = lastIme
            }
            fullscreen -> lab { "inset hold: the change $change leaves fullscreen's hold on" }
            clock() >= until -> Unit
            diff and LAYOUT_CHANGES == 0 || onlyTheNavigationBarWindow(next) -> lab { "inset hold: the change $change leaves the hold on, ${heldMillisLeft} ms left" }
            else -> {
                lab { "inset hold: none, the change $change moves the layout" }
                until = 0
            }
        }
    }

    private fun onlyTheNavigationBarWindow(next: Configuration): Boolean {
        val base = themeBase ?: return false
        val bar = held ?: return false
        if (next.orientation != base.orientation || next.screenWidthDp != base.screenWidthDp || next.densityDpi != base.densityDpi || next.fontScale != base.fontScale) return false
        val barDp = bar.bottom / (next.densityDpi.coerceAtLeast(1) / 160f)
        return abs(next.screenHeightDp - base.screenHeightDp) <= barDp + DP_SLACK
    }

    fun fullscreenStarts() {
        val bars = last
        until = 0
        if (bars == null || bars == Insets.NONE) return
        held = bars
        fullscreen = true
        followsTheBar = true
        why = "fullscreen"
        lab { "inset hold: fullscreen keeps the page's navigation bar at ${bars.bottom} px while the video covers it" }
    }

    fun fullscreenEnds() {
        if (!fullscreen) return
        fullscreen = false
        hold(held, RETURN_MILLIS, "leaving fullscreen")
        followsTheBar = true
    }

    private fun hold(value: Insets?, millis: Long, reason: String) {
        if (value == null || value == Insets.NONE) return
        held = value
        until = clock() + millis
        why = reason
        lab { "inset hold: $reason holds the navigation bar's ${value.bottom} px for up to $millis ms" }
    }

    fun navigationBars(raw: Insets, whenShown: Insets = Insets.NONE): Insets {
        val keep = if (followsTheBar && whenShown != Insets.NONE) whenShown.also { held = it } else held
        if (holding && keep != null && (raw == Insets.NONE || fullscreen)) {
            if (heldSince < 0) heldSince = clock()
            return keep
        }
        if (heldSince >= 0) {
            lab { "inset hold: after $why the navigation bar's ${keep?.bottom} px came back as ${raw.bottom} px after ${clock() - heldSince} ms${if (holding) "" else ", at the deadline"}" }
            heldSince = -1
        }
        if (holding && raw != Insets.NONE) held = raw
        last = raw
        return raw
    }

    fun ime(rawIme: Int): Int {
        val bar = held?.bottom ?: 0
        if (!fullscreen && clock() < until && heldIme > 0 && rawIme > 0 && bar > 0 && abs(rawIme - heldIme) <= bar + PX_SLACK) return heldIme
        lastIme = rawIme
        if (rawIme == 0) heldIme = 0
        return rawIme
    }

    private inline fun lab(line: () -> String) {
        if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB ${line()}")
    }

    companion object {
        const val HOLD_MILLIS = 1000L
        const val RETURN_MILLIS = 500L
        private const val DP_SLACK = 2f
        private const val PX_SLACK = 6
        private const val LAYOUT_CHANGES = ActivityInfo.CONFIG_ORIENTATION or ActivityInfo.CONFIG_SCREEN_SIZE or ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE or
            ActivityInfo.CONFIG_SCREEN_LAYOUT or ActivityInfo.CONFIG_DENSITY or ActivityInfo.CONFIG_NAVIGATION or ActivityInfo.CONFIG_KEYBOARD or
            ActivityInfo.CONFIG_KEYBOARD_HIDDEN or ActivityInfo.CONFIG_FONT_SCALE

        val window = InsetHold()
        private var installed = WeakReference<View>(null)

        fun install(activity: Activity) {
            window.configurationChanged(activity.resources.configuration)
            val content = activity.findViewById<View>(android.R.id.content) ?: return
            installed = WeakReference(content)
            val again = Runnable { ViewCompat.requestApplyInsets(content) }
            ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
                val raw = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
                val passed = window.navigationBars(raw, insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.navigationBars()))
                view.removeCallbacks(again)
                if (passed == raw) return@setOnApplyWindowInsetsListener insets
                if (window.heldMillisLeft > 0) view.postDelayed(again, window.heldMillisLeft + 1)
                WindowInsetsCompat.Builder(insets).setInsets(WindowInsetsCompat.Type.navigationBars(), passed).build()
            }
        }

        fun fullscreenStarts() = window.fullscreenStarts()

        fun fullscreenEnds() {
            window.fullscreenEnds()
            installed.get()?.let(ViewCompat::requestApplyInsets)
        }

        fun navigationBottom(view: View): Int {
            val insets = ViewCompat.getRootWindowInsets(view) ?: return 0
            return window.navigationBars(insets.getInsets(WindowInsetsCompat.Type.navigationBars()), insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.navigationBars())).bottom
        }

        fun imeBottom(view: View): Int {
            val raw = ViewCompat.getRootWindowInsets(view)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: return 0
            return window.ime(raw)
        }
    }
}
