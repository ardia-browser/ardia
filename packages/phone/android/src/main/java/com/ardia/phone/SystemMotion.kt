package com.ardia.phone

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings

internal object SystemMotion {
    @Volatile
    var reducedNow: Boolean = false
        private set

    fun note(now: Map<String, Boolean>): Boolean {
        val reduced = now["reduceMotion"] == true
        if (reduced == reducedNow) return false
        reducedNow = reduced
        return true
    }

    fun reduced(animatorScale: Float?): Boolean = animatorScale == 0f

    fun animatorScale(context: Context): Float? = runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrNull()

    val unknown: Map<String, Boolean> = mapOf("reduceMotion" to false, "reduceTransparency" to false)

    fun read(context: Context): Map<String, Boolean> = mapOf("reduceMotion" to reduced(animatorScale(context)), "reduceTransparency" to false)
}

internal class SystemLookWatch(private val read: () -> Map<String, Boolean>, private val emit: (Map<String, Boolean>) -> Unit) {
    private var last: Map<String, Boolean>? = null

    fun seed(): Map<String, Boolean> = read().also { last = it }

    fun check(): Map<String, Boolean> {
        val now = read()
        if (now == last) return now
        last = now
        emit(now)
        return now
    }
}

internal class SystemLookObserver(private val context: Context, private val changed: () -> Unit) {
    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = changed()
    }
    private var watching = false

    fun start() {
        if (watching) return
        watching = true
        for (name in listOf(Settings.Global.ANIMATOR_DURATION_SCALE, Settings.Global.TRANSITION_ANIMATION_SCALE)) {
            runCatching { context.contentResolver.registerContentObserver(Settings.Global.getUriFor(name), false, observer) }
        }
    }

    fun stop() {
        if (!watching) return
        watching = false
        runCatching { context.contentResolver.unregisterContentObserver(observer) }
    }
}
