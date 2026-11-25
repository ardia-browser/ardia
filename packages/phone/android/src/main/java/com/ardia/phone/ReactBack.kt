package com.ardia.phone

import android.app.Activity
import androidx.activity.OnBackPressedCallback

class ReactBack(private val deliver: () -> Unit) : OnBackPressedCallback(true) {
    var delivered = 0L
        private set

    override fun handleOnBackPressed() {
        delivered += 1
        isEnabled = false
        try {
            deliver()
        } finally {
            isEnabled = true
        }
    }

    fun <T> bypassed(run: () -> T): T {
        val was = isEnabled
        isEnabled = false
        try {
            return run()
        } finally {
            isEnabled = was
        }
    }

    companion object {
        fun leaveToTheBackground(activity: Activity): Boolean = activity.isTaskRoot && activity.moveTaskToBack(false)
    }
}
