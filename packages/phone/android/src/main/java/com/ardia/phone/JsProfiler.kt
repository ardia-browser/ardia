package com.ardia.phone

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.ReactRootView
import java.io.File

object JsProfiler {
    const val ACTION = "com.ardia.phone.JS_PROFILE"
    const val START_ARGUMENT = "ArdiaProfileStart"
    const val START_HZ = 1000.0
    const val START_DUMP_AFTER_FIRST_SCREEN_MILLIS = 3000L

    private var running: File? = null

    @JvmStatic
    private external fun nativeStart(hz: Double): Boolean

    @JvmStatic
    private external fun nativeStop(path: String): Boolean

    fun startAsked(arguments: Map<String, Any>): Boolean = arguments[START_ARGUMENT] == true

    fun profile(context: Context, seconds: Int, hz: Double) {
        if (!PhoneLab.isOn) return
        val file = File(context.getExternalFilesDir(null) ?: context.filesDir, "js-profile-${System.currentTimeMillis()}.cpuprofile")
        if (!begin(file, hz)) return
        Log.i("PAGELAB", "PAGELAB js profile: sampling all Hermes runtimes at $hz Hz for $seconds s")
        Handler(Looper.getMainLooper()).postDelayed({ finish(file) }, seconds * 1000L)
    }

    fun profileStart(activity: Activity) {
        if (!PhoneLab.isOn || !startAsked(LaunchExtras.arguments(LaunchExtras.of(activity.intent)))) return
        val file = File(activity.getExternalFilesDir(null) ?: activity.filesDir, "start-${System.currentTimeMillis()}.cpuprofile")
        if (!begin(file, START_HZ)) return
        Log.i("PAGELAB", "PAGELAB js profile: sampling the cold start at $START_HZ Hz from the activity's onCreate, before any JavaScript runs")
        FirstScreenDrawn.watch(activity, { it is ReactRootView }) {
            Handler(Looper.getMainLooper()).postDelayed({ finish(file) }, START_DUMP_AFTER_FIRST_SCREEN_MILLIS)
        }
    }

    private fun begin(file: File, hz: Double): Boolean {
        if (running != null) {
            Log.i("PAGELAB", "PAGELAB js profile: one is already running")
            return false
        }
        val started = runCatching {
            System.loadLibrary("ardiahermes")
            nativeStart(hz)
        }.getOrElse { failure ->
            Log.i("PAGELAB", "PAGELAB js profile: Hermes' sampling profiler would not start (${failure.javaClass.simpleName}: ${failure.message})")
            return false
        }
        if (!started) {
            Log.i("PAGELAB", "PAGELAB js profile: no Hermes root API in this process")
            return false
        }
        running = file
        return true
    }

    private fun finish(file: File) {
        running = null
        val stopped = runCatching { nativeStop(file.absolutePath) }.getOrDefault(false)
        Log.i("PAGELAB", if (stopped) "PAGELAB js profile: wrote ${file.absolutePath} (${file.length()} bytes)" else "PAGELAB js profile: the dump failed")
    }
}
