package com.ardia.phone

import android.os.Handler
import android.os.Looper
import android.os.Trace
import android.view.Choreographer
import android.view.View

internal object FrameMarks {
    private val main = Handler(Looper.getMainLooper())

    fun markNextFrame(label: String, window: () -> View?) {
        main.post {
            Choreographer.getInstance().postFrameCallback {
                Trace.beginSection("ardia-frame:$label")
                window()?.invalidate()
                Trace.endSection()
            }
        }
    }
}
