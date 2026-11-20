package com.ardia.phone

import android.app.Activity
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import com.facebook.react.ReactRootView

object FirstScreenDrawn {
    fun watch(activity: Activity) = watch(activity, { it is ReactRootView }) { activity.reportFullyDrawn() }

    internal fun watch(activity: Activity, isRoot: (View) -> Boolean, report: () -> Unit) {
        val decor = activity.window.decorView
        val started = android.os.SystemClock.uptimeMillis()
        var reported = false
        val listener = object : ViewTreeObserver.OnDrawListener {
            override fun onDraw() {
                if (reported || !hasMountedRoot(decor, isRoot)) return
                reported = true
                val listener = this
                decor.post {
                    decor.viewTreeObserver.removeOnDrawListener(listener)
                    if (activity.isFinishing || activity.isDestroyed) return@post
                    report()
                    if (PhoneLab.isOn) Log.i("PAGELAB", "PAGELAB first screen drawn ${android.os.SystemClock.uptimeMillis() - started} ms after the activity was created")
                }
            }
        }
        decor.viewTreeObserver.addOnDrawListener(listener)
    }

    internal fun hasMountedRoot(view: View, isRoot: (View) -> Boolean): Boolean {
        if (view !is ViewGroup) return false
        if (isRoot(view)) return view.childCount > 0
        for (index in 0 until view.childCount) {
            if (hasMountedRoot(view.getChildAt(index), isRoot)) return true
        }
        return false
    }
}
