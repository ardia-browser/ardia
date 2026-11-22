package com.ardia.phone

import android.view.View

internal interface CoverSurface {
    fun find(nativeId: String): View?

    fun schedule(millis: Long, run: () -> Unit): () -> Unit
}

internal class CoverHandOver(private val surface: CoverSurface, private val onHidden: (reason: String, found: Boolean) -> Unit) {
    var nativeId: String? = null
        private set
    var handedOver = false
        private set
    private var cancelCap: (() -> Unit)? = null

    val waiting: Boolean get() = cancelCap != null

    fun cover(id: String?) {
        if (id == nativeId) return
        cancel()
        nativeId = id
        handedOver = false
    }

    fun pageVisible() {
        if (nativeId == null || handedOver || cancelCap != null) return
        cancelCap = surface.schedule(CAP_MILLIS) {
            cancelCap = null
            hide(REASON_CAP)
        }
    }

    fun pageDrawn() {
        if (nativeId == null || handedOver) return
        hide(REASON_DRAWN)
    }

    fun cancel() {
        cancelCap?.invoke()
        cancelCap = null
    }

    private fun hide(reason: String) {
        val id = nativeId ?: return
        if (handedOver) return
        cancel()
        handedOver = true
        val view = surface.find(id)
        view?.visibility = View.INVISIBLE
        onHidden(reason, view != null)
    }

    companion object {
        const val CAP_MILLIS = 200L
        const val REASON_DRAWN = "drawn"
        const val REASON_CAP = "cap"
    }
}
