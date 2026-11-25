package com.ardia.phone

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView

internal interface DrawnSurface {
    fun visible(): Boolean

    fun postVisualState(done: () -> Unit): Boolean

    fun afterNextFrameCommits(done: () -> Unit)
}

internal class PageDrawnWatch(private val surface: DrawnSurface, private val document: () -> Long = { 0L }, private val onDrawn: (document: Long) -> Unit) {
    enum class Stage { Hidden, Waiting, Drawn }

    var stage = Stage.Hidden
        private set
    var onVisible: () -> Unit = {}
    private var request = 0

    fun frame() {
        val visible = surface.visible()
        if (!visible) {
            if (stage != Stage.Hidden) forget()
            return
        }
        if (stage == Stage.Hidden) arm()
    }

    fun reset() {
        if (stage != Stage.Hidden) forget()
    }

    private fun forget() {
        stage = Stage.Hidden
        request += 1
    }

    private fun arm() {
        request += 1
        val mine = request
        val asked = document()
        stage = Stage.Waiting
        onVisible()
        val posted = surface.postVisualState {
            if (mine != request) return@postVisualState
            if (document() != asked) return@postVisualState rearm()
            surface.afterNextFrameCommits {
                if (mine != request) return@afterNextFrameCommits
                if (document() != asked) return@afterNextFrameCommits rearm()
                stage = Stage.Drawn
                onDrawn(asked)
            }
        }
        if (!posted) forget()
    }

    private fun rearm() {
        forget()
        if (surface.visible()) arm()
    }

    companion object {
        fun shownAlpha(view: View): Float {
            var alpha = view.alpha
            var parent = view.parent
            while (parent is View && alpha > 0f) {
                alpha *= parent.alpha
                parent = parent.parent
            }
            return alpha
        }

        fun webViewIn(view: View?): WebView? {
            if (view is WebView) return view
            if (view !is ViewGroup) return null
            for (index in 0 until view.childCount) webViewIn(view.getChildAt(index))?.let { return it }
            return null
        }
    }
}
