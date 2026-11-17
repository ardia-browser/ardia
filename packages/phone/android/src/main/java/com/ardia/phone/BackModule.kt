package com.ardia.phone

import android.os.Handler
import android.os.Looper
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.OnBackPressedDispatcher
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TrayBack(private val report: (String, Map<String, Any?>) -> Unit) : OnBackPressedCallback(false) {
    override fun handleOnBackStarted(backEvent: BackEventCompat) = report(PROGRESS, progress(0f, backEvent))

    override fun handleOnBackProgressed(backEvent: BackEventCompat) = report(PROGRESS, progress(backEvent.progress, backEvent))

    override fun handleOnBackCancelled() = report(CANCEL, emptyMap())

    override fun handleOnBackPressed() = report(COMMIT, emptyMap())

    private fun progress(value: Float, event: BackEventCompat): Map<String, Any?> =
        mapOf("progress" to value.coerceIn(0f, 1f).toDouble(), "edge" to if (event.swipeEdge == BackEventCompat.EDGE_LEFT) "left" else "right")

    companion object {
        const val PROGRESS = "onBackProgress"
        const val CANCEL = "onBackCancel"
        const val COMMIT = "onBackCommit"
    }
}

class TrayBackBinding(private val report: (String, Map<String, Any?>) -> Unit) {
    private var callback: TrayBack? = null
    private var boundTo: OnBackPressedDispatcher? = null
    var wanted = false
        private set

    fun want(enabled: Boolean, dispatcher: OnBackPressedDispatcher?, owner: LifecycleOwner?) {
        wanted = enabled
        if (enabled && dispatcher != null && owner != null) bind(dispatcher, owner)
        callback?.isEnabled = enabled && boundTo != null
    }

    fun bind(dispatcher: OnBackPressedDispatcher, owner: LifecycleOwner) {
        if (boundTo === dispatcher && callback != null) {
            callback?.isEnabled = wanted
            return
        }
        callback?.remove()
        val made = TrayBack(report)
        dispatcher.addCallback(owner, made)
        made.isEnabled = wanted
        callback = made
        boundTo = dispatcher
    }

    fun lost() {
        val hadGesture = callback?.isEnabled == true
        callback?.remove()
        callback = null
        boundTo = null
        if (hadGesture) report(TrayBack.CANCEL, emptyMap())
    }

    fun release() {
        callback?.remove()
        callback = null
        boundTo = null
        wanted = false
    }
}

class BackModule : Module() {
    private val main = Handler(Looper.getMainLooper())
    private val binding = TrayBackBinding { name, body -> runCatching { sendEvent(name, body) } }

    private fun current(): ComponentActivity? = appContext.currentActivity as? ComponentActivity

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneBack")

        Events(TrayBack.PROGRESS, TrayBack.CANCEL, TrayBack.COMMIT)

        Function("setTrayBackEnabled") { enabled: Boolean ->
            main.post {
                val activity = current()
                binding.want(enabled, activity?.onBackPressedDispatcher, activity)
            }
            Unit
        }

        OnActivityEntersForeground {
            main.post {
                val activity = current() ?: return@post
                if (binding.wanted) binding.bind(activity.onBackPressedDispatcher, activity)
            }
        }

        OnActivityDestroys {
            main.post { binding.lost() }
        }

        OnDestroy {
            main.post { binding.release() }
        }
    }
}
