package com.ardia.phone

import android.app.Activity

internal object ForegroundAttach {
    fun stillHost(activity: Activity, current: Activity?): Boolean = current === activity && !activity.isFinishing && !activity.isDestroyed

    fun dispatch(onMain: Boolean, post: (Runnable) -> Boolean, attach: () -> Unit) {
        if (onMain) attach() else post(Runnable(attach))
    }
}
