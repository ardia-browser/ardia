package com.ardia.phone

import android.app.Activity
import android.view.View
import android.view.ViewTreeObserver
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

class KeyboardModule : Module() {
    private var watched: WeakReference<View>? = null
    private var tracker: KeyboardTracker? = null
    private var layoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneKeyboard")

        Events(WILL_CHANGE, DID_CHANGE)

        Function("current") {
            val view = watched?.get() ?: appContext.currentActivity?.let(::contentOf)
            val density = view?.resources?.displayMetrics?.density ?: 1f
            mapOf(
                "height" to ((view?.let(InsetHold::imeBottom) ?: 0) / density).toDouble(),
                "navigationBar" to ((view?.let(InsetHold::navigationBottom) ?: 0) / density).toDouble(),
            )
        }

        OnStartObserving(WILL_CHANGE) { appContext.currentActivity?.runOnUiThread { watch() } }

        OnStartObserving(DID_CHANGE) { appContext.currentActivity?.runOnUiThread { watch() } }

        OnActivityEntersForeground { appContext.currentActivity?.runOnUiThread { if (watched != null) watch() } }

        OnDestroy { appContext.currentActivity?.runOnUiThread { unwatch() } }
    }

    private fun contentOf(activity: Activity): View? = activity.findViewById(android.R.id.content)

    private fun watch() {
        val view = appContext.currentActivity?.let(::contentOf) ?: return
        if (watched?.get() === view && tracker != null) return
        unwatch()
        val made = KeyboardTracker(
            view.resources.displayMetrics.density,
            willChange = { change ->
                if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB keyboard will change ${change.source} -> ${change.target} dp in ${change.durationMs} ms (navigation bar ${change.navigationBar} dp)")
                runCatching { sendEvent(WILL_CHANGE, mapOf("source" to change.source, "target" to change.target, "durationMs" to change.durationMs.toDouble(), "navigationBar" to change.navigationBar)) }
            },
            didChange = { change ->
                if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB keyboard did change to ${change.height} dp")
                runCatching { sendEvent(DID_CHANGE, mapOf("height" to change.height, "navigationBar" to change.navigationBar)) }
            },
        )
        fun ime(): Int = InsetHold.imeBottom(view)
        fun navigation(): Int = InsetHold.navigationBottom(view)
        ViewCompat.setWindowInsetsAnimationCallback(
            view,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) made.prepare(ime(), navigation())
                }

                override fun onStart(animation: WindowInsetsAnimationCompat, bounds: WindowInsetsAnimationCompat.BoundsCompat): WindowInsetsAnimationCompat.BoundsCompat {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) made.start(ime(), animation.durationMillis)
                    return bounds
                }

                override fun onProgress(insets: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat = insets

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) made.end(ime())
                }
            },
        )
        val listener = ViewTreeObserver.OnGlobalLayoutListener { made.settled(ime(), navigation()) }
        view.viewTreeObserver.addOnGlobalLayoutListener(listener)
        watched = WeakReference(view)
        tracker = made
        layoutListener = listener
    }

    private fun unwatch() {
        val view = watched?.get()
        if (view != null) {
            ViewCompat.setWindowInsetsAnimationCallback(view, null)
            layoutListener?.let { view.viewTreeObserver.removeOnGlobalLayoutListener(it) }
        }
        watched = null
        tracker = null
        layoutListener = null
    }

    private companion object {
        const val WILL_CHANGE = "onKeyboardWillChange"
        const val DID_CHANGE = "onKeyboardDidChange"
    }
}
