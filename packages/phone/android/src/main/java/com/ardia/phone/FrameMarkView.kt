package com.ardia.phone

import android.content.Context
import android.os.Trace
import android.view.View
import android.view.ViewTreeObserver
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

internal object FrameMarkTrace {
    var on: () -> Boolean = { PhoneLab.isOn }
    var write: (String) -> Unit = { label ->
        Trace.beginSection("ardia-frame:$label")
        Trace.endSection()
    }
}

internal class FrameMarkGate(private val trace: (String) -> Unit) {
    var label: String? = null
        private set
    var drawn = false
        private set
    private var marked = false

    val listens: Boolean
        get() = label != null && (drawn || !marked)

    fun mark(value: String?): Boolean {
        val next = value?.takeIf { it.isNotEmpty() }
        if (next == label) return false
        label = next
        marked = false
        return next != null
    }

    fun drawnOnly(value: Boolean): Boolean {
        if (value == drawn) return false
        drawn = value
        marked = false
        return label != null
    }

    fun traversal(shown: Boolean) {
        val now = label ?: return
        if (drawn && !shown) {
            marked = false
            return
        }
        if (marked) return
        marked = true
        trace(now)
    }

    companion object {
        fun shownThrough(view: View): Boolean {
            if (!view.isShown) return false
            var at: View? = view
            while (at != null) {
                if (at.alpha <= 0f) return false
                at = at.parent as? View
            }
            return true
        }
    }
}

class FrameMarkView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val gate = FrameMarkGate { label -> FrameMarkTrace.write(label) }
    private var observer: ViewTreeObserver? = null
    private val preDraw = ViewTreeObserver.OnPreDrawListener {
        gate.traversal(!gate.drawn || FrameMarkGate.shownThrough(this))
        if (!gate.listens) stopListening()
        true
    }

    private var shownLabel: String? = null
    private var shown = false
    private var traversalLabel: String? = null
    private var traversalObserver: ViewTreeObserver? = null
    private val atTraversal = ViewTreeObserver.OnPreDrawListener {
        val now = traversalLabel
        dropTraversalMark()
        if (now != null) FrameMarkTrace.write(now)
        true
    }

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun mark(label: String?) {
        if (gate.mark(label)) armed()
    }

    fun drawnOnly(value: Boolean) {
        if (gate.drawnOnly(value)) armed()
    }

    fun markWhenShown(label: String?) {
        shownLabel = label?.takeIf { it.isNotEmpty() }
        if (shownLabel == null) dropTraversalMark()
    }

    override fun setAlpha(alpha: Float) {
        super.setAlpha(alpha)
        val now = alpha > 0f
        if (now == shown) return
        shown = now
        if (!now) {
            dropTraversalMark()
            return
        }
        val label = shownLabel ?: return
        if (FrameMarkTrace.on()) markAtTraversal(label)
    }

    private fun armed() {
        if (!FrameMarkTrace.on()) return
        listen()
        rootView?.invalidate()
    }

    private fun listen() {
        if (observer != null || !isAttachedToWindow) return
        observer = viewTreeObserver.also { it.addOnPreDrawListener(preDraw) }
    }

    private fun stopListening() {
        val was = observer ?: return
        observer = null
        if (was.isAlive) was.removeOnPreDrawListener(preDraw)
    }

    private fun markAtTraversal(label: String) {
        traversalLabel = label
        if (traversalObserver == null) {
            val next = viewTreeObserver
            next.addOnPreDrawListener(atTraversal)
            traversalObserver = next
        }
        rootView?.invalidate()
    }

    private fun dropTraversalMark() {
        traversalLabel = null
        val was = traversalObserver ?: return
        traversalObserver = null
        if (was.isAlive) was.removeOnPreDrawListener(atTraversal)
        else if (viewTreeObserver.isAlive) viewTreeObserver.removeOnPreDrawListener(atTraversal)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (FrameMarkTrace.on() && gate.listens) listen()
    }

    override fun onDetachedFromWindow() {
        stopListening()
        dropTraversalMark()
        super.onDetachedFromWindow()
    }
}
