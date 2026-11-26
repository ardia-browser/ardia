package com.ardia.phone

import android.os.Build
import android.view.WindowManager
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SystemModule : Module() {
    private var listener: PhoneSystemLinks.Listener? = null

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneSystem")

        OnCreate {
            val context = appContext.reactContext ?: return@OnCreate
            LabTouches.register(context) { appContext.currentActivity }
        }

        Function("labLog") { line: String ->
            if (PhoneLab.isOn) android.util.Log.i("PAGELAB", line)
        }

        Function("labFrameMark") { label: String ->
            if (PhoneLab.isOn) FrameMarks.markNextFrame(label) { appContext.currentActivity?.window?.decorView }
        }

        Function("setUsageConsent") { sharing: Boolean ->
            val context = appContext.reactContext ?: return@Function Unit
            UsageConsent.set(context, sharing)
        }

        Function("syncOffered") { SyncOffer.isOffered }

        Function("hardwareKeyboardShown") {
            val configuration = appContext.reactContext?.resources?.configuration ?: return@Function false
            configuration.keyboard == android.content.res.Configuration.KEYBOARD_QWERTY && configuration.hardKeyboardHidden == android.content.res.Configuration.HARDKEYBOARDHIDDEN_NO
        }

        Function("labSlice") { label: String ->
            if (PhoneLab.isOn) {
                android.os.Trace.beginSection("ardia:$label")
                android.os.Trace.endSection()
            }
        }

        AsyncFunction("setSystemBarIcons") { lightStatus: Boolean, lightNavigation: Boolean ->
            SystemBars.want(SystemBars.Icons(lightStatus, lightNavigation), appContext.currentActivity)
        }.runOnQueue(Queues.MAIN)

        Function("peekPendingCounts") {
            val context = appContext.reactContext ?: return@Function emptyMap<String, Int>()
            PendingCounts.peek(context)
        }

        Function("usageConsent") {
            val context = appContext.reactContext ?: return@Function null
            val (sharing, generation) = UsageConsent.state(context)
            mapOf("sharing" to sharing, "generation" to generation.toDouble())
        }

        Function("takeExits") {
            val context = appContext.reactContext ?: return@Function emptyList<Map<String, Any>>()
            PhoneExits.take(context)
        }

        Function("takePendingCounts") {
            val context = appContext.reactContext ?: return@Function emptyMap<String, Int>()
            PendingCounts.take(context)
        }

        Function("setWidgetColorChoice") { choice: String? ->
            val context = appContext.reactContext ?: return@Function Unit
            WidgetColorChoice.set(context, choice)
        }

        Function("displayCornerRadius") {
            val insets = appContext.currentActivity?.window?.decorView?.rootWindowInsets
            val radius = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && insets != null) insets.getRoundedCorner(android.view.RoundedCorner.POSITION_TOP_LEFT)?.radius else null
            DisplayCorner.dp(radius, appContext.reactContext?.resources?.displayMetrics?.density ?: 1f)
        }

        Events("onSystemLink")

        OnStartObserving("onSystemLink") {
            listener?.let(PhoneSystemLinks::stopListening)
            listener = PhoneSystemLinks.listen { payload -> sendEvent("onSystemLink", payload) }
        }

        OnStopObserving("onSystemLink") {
            listener?.let(PhoneSystemLinks::stopListening)
            listener = null
        }

        OnDestroy {
            listener?.let(PhoneSystemLinks::stopListening)
            listener = null
            PhoneA11yDump.stopListening()
        }

        OnActivityEntersForeground {
            appContext.reactContext?.applicationContext?.let { app -> PhoneA11yDump.listen(app) { appContext.currentActivity } }
        }

        Function("processStartedAt") { ProcessStart.epochMillis() }

        Function("restoredValue") { key: String -> RestorableState.get(key) }

        Function("setRestorableValue") { key: String, value: String? -> RestorableState.set(key, value) }

        Function("labMemory") {
            check(PhoneLab.isOn) { "the memory readout is a lab tool" }
            val context = appContext.reactContext ?: return@Function null
            ImageMemory.line(context, PhonePages.livePageIds().size).also { android.util.Log.i("PAGELAB", it) }
        }

        Function("labTrim") {
            check(PhoneLab.isOn) { "the trim is a lab tool" }
            ImageMemory.clear()
            val context = appContext.reactContext ?: return@Function null
            ImageMemory.line(context, PhonePages.livePageIds().size).also { android.util.Log.i("PAGELAB", "PAGELAB memory: image cache cleared as on a trim"); android.util.Log.i("PAGELAB", it) }
        }

        AsyncFunction("initialLink") { -> PhoneSystemLinks.takeInitial() }

        AsyncFunction("setHidesFromRecents") { hidden: Boolean ->
            val activity = appContext.currentActivity ?: return@AsyncFunction false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                activity.setRecentsScreenshotEnabled(!hidden)
            } else if (hidden) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
            true
        }.runOnQueue(Queues.MAIN)
    }
}

internal object DisplayCorner {
    fun dp(radiusPixels: Int?, density: Float): Double? = radiusPixels?.takeIf { it > 0 && density > 0f }?.let { it / density.toDouble() }
}
