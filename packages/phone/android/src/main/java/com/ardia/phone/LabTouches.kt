package com.ardia.phone

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.Trace
import android.view.InputDevice
import android.view.MotionEvent
import androidx.core.content.ContextCompat

object LabTouches {
    const val ACTION = "com.ardia.lab.TOUCHES"
    private const val LEAD_MS = 60L

    data class Step(val at: Long, val kind: Char, val x: Float, val y: Float)

    private val main = Handler(Looper.getMainLooper())
    private var registered = false

    fun parse(script: String): List<Step> {
        var x = 0f
        var y = 0f
        return script.split(';').map { it.trim() }.filter { it.isNotEmpty() }.map { it.split(':') }.sortedBy { it[0].toLong() }.map { fields ->
            val kind = fields[1].first()
            require(kind == 'd' || kind == 'm' || kind == 'u') { "unknown touch step ${fields.joinToString(":")}" }
            if (fields.size >= 4) {
                x = fields[2].toFloat()
                y = fields[3].toFloat()
            }
            Step(fields[0].toLong(), kind, x, y)
        }
    }

    fun register(context: Context, activity: () -> Activity?) {
        if (!PhoneLab.isOn || registered) return
        registered = true
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(received: Context, intent: Intent) {
                val script = intent.getStringExtra("steps") ?: return
                play(parse(script), activity)
            }
        }
        ContextCompat.registerReceiver(context.applicationContext, receiver, IntentFilter(ACTION), ContextCompat.RECEIVER_EXPORTED)
    }

    internal fun play(steps: List<Step>, activity: () -> Activity?) {
        val start = SystemClock.uptimeMillis() + LEAD_MS
        var downAt = start
        for (step in steps) {
            val planned = start + step.at
            main.postAtTime({
                val target = activity() ?: return@postAtTime
                if (step.kind == 'd') downAt = planned
                val action = when (step.kind) {
                    'd' -> MotionEvent.ACTION_DOWN
                    'm' -> MotionEvent.ACTION_MOVE
                    else -> MotionEvent.ACTION_UP
                }
                val event = MotionEvent.obtain(downAt, planned, action, step.x, step.y, 0)
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                Trace.beginSection("ardia-lab-touch:${step.kind}:${step.x.toInt()}:${step.y.toInt()}")
                try {
                    target.dispatchTouchEvent(event)
                } finally {
                    Trace.endSection()
                    event.recycle()
                }
            }, start + step.at)
        }
    }
}
