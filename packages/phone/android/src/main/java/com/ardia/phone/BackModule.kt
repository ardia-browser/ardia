package com.ardia.phone

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.OnBackPressedDispatcher
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TrayBack(private val report: (String, Map<String, Any?>) -> Unit) : OnBackPressedCallback(false) {
    private var progressed = 0

    override fun handleOnBackStarted(backEvent: BackEventCompat) {
        progressed = 0
        BackLog.say("swipe started at the ${edgeOf(backEvent)} edge")
        report(PROGRESS, progress(0f, backEvent))
    }

    override fun handleOnBackProgressed(backEvent: BackEventCompat) {
        progressed += 1
        report(PROGRESS, progress(backEvent.progress, backEvent))
    }

    override fun handleOnBackCancelled() {
        BackLog.say("swipe cancelled after $progressed progress events")
        report(CANCEL, emptyMap())
    }

    override fun handleOnBackPressed() {
        BackLog.say("back committed after $progressed progress events")
        progressed = 0
        report(COMMIT, emptyMap())
    }

    private fun edgeOf(event: BackEventCompat): String = if (event.swipeEdge == BackEventCompat.EDGE_LEFT) "left" else "right"

    private fun progress(value: Float, event: BackEventCompat): Map<String, Any?> =
        mapOf("progress" to value.coerceIn(0f, 1f).toDouble(), "edge" to if (event.swipeEdge == BackEventCompat.EDGE_LEFT) "left" else "right")

    companion object {
        const val PROGRESS = "onBackProgress"
        const val CANCEL = "onBackCancel"
        const val COMMIT = "onBackCommit"
    }
}

internal object BackLog {
    const val TAG = "ArdiaBack"

    fun say(line: String) {
        runCatching { Log.i(TAG, line) }
    }
}

class TrayBackBinding(private val report: (String, Map<String, Any?>) -> Unit) {
    private var callback: TrayBack? = null
    private var boundTo: OnBackPressedDispatcher? = null
    var wanted = false
        private set

    fun want(enabled: Boolean, dispatcher: OnBackPressedDispatcher?, owner: LifecycleOwner?) {
        if (enabled != wanted) BackLog.say(if (enabled) "claimed: the app takes Back" else "released: Back goes to React Native")
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
        BackLog.say("callback bound to the activity's dispatcher")
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
