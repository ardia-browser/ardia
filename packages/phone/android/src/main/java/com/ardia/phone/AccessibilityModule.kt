package com.ardia.phone

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class AccessibilityModule : Module() {
    private val requests by lazy { FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis) }

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneAccessibility")

        AsyncFunction("focusView") { tag: Int -> requests.start { runCatching { appContext.findView<View>(tag) }.getOrNull() } }.runOnQueue(Queues.MAIN)

        AsyncFunction("returnFocus") { tag: Int -> requests.start(recheck = true) { runCatching { appContext.findView<View>(tag) }.getOrNull() } }.runOnQueue(Queues.MAIN)

        AsyncFunction("cancelFocus") { request: Int -> requests.cancel(request) }.runOnQueue(Queues.MAIN)

        OnDestroy {
            requests.destroy()
        }

        AsyncFunction("announce") { text: String ->
            val window = appContext.currentActivity?.window?.decorView ?: return@AsyncFunction
            ScreenReaderFocus.announce(window, text)
        }.runOnQueue(Queues.MAIN)

        View(ScrollActionsView::class) {
            Name("ScrollActions")
            Events("onScrollAction")
            Prop("canScrollForward") { view: ScrollActionsView, value: Boolean? -> view.canScrollForward = value == true }
            Prop("canScrollBackward") { view: ScrollActionsView, value: Boolean? -> view.canScrollBackward = value == true }
        }
    }
}

internal class FocusRequests(private val handler: Handler, private val clock: () -> Long, private val rootOf: (View) -> View = View::getRootView) {
    companion object {
        const val RETRY_EVERY_MS = 16L
        const val GIVE_UP_AFTER_MS = 500L
        const val RECHECK_AFTER_MS = 300L
    }

    private var lastId = 0
    private val pending = HashMap<Int, Runnable>()

    @Volatile
    var destroyed = false
        private set

    val waiting: Int get() = pending.size

    fun start(recheck: Boolean = false, resolve: () -> View?): Int {
        if (destroyed) return 0
        val id = ++lastId
        val deadline = clock() + GIVE_UP_AFTER_MS
        val again = object : Runnable {
            override fun run() {
                if (destroyed || pending[id] !== this) return
                pending.remove(id)
                val view = resolve() ?: return
                if (!ScreenReaderFocus.holds(view) && ScreenReaderFocus.focusIsFree(view, rootOf(view))) ScreenReaderFocus.focus(view)
            }
        }
        val attempt = object : Runnable {
            override fun run() {
                if (destroyed || pending[id] !== this) return
                if (clock() >= deadline) {
                    pending.remove(id)
                    return
                }
                val view = resolve()
                if (recheck && view != null && ScreenReaderFocus.ready(view) && !ScreenReaderFocus.focusIsFree(view, rootOf(view))) {
                    pending.remove(id)
                    return
                }
                if (!ScreenReaderFocus.focus(view)) {
                    handler.postDelayed(this, RETRY_EVERY_MS)
                    return
                }
                if (!recheck) {
                    pending.remove(id)
                    return
                }
                pending[id] = again
                handler.postDelayed(again, RECHECK_AFTER_MS)
            }
        }
        pending[id] = attempt
        attempt.run()
        return id
    }

    fun cancel(id: Int) {
        pending.remove(id)?.let(handler::removeCallbacks)
    }

    fun cancelAll() {
        pending.values.forEach(handler::removeCallbacks)
        pending.clear()
    }

    fun destroy() {
        destroyed = true
        if (Looper.myLooper() == handler.looper) cancelAll() else handler.post { cancelAll() }
    }
}

internal object ScreenReaderFocus {
    fun ready(view: View?): Boolean = view != null && view.isAttachedToWindow && view.isLaidOut

    fun reachable(view: View): Boolean {
        if (!view.isImportantForAccessibility || !view.isShown || !view.getGlobalVisibleRect(Rect())) return false
        var parent = view.parent
        while (parent is View) {
            if (parent.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS) return false
            parent = parent.parent
        }
        return true
    }

    fun holds(view: View): Boolean = view.createAccessibilityNodeInfo()?.isAccessibilityFocused == true

    fun virtualHolder(root: View): View? {
        if (!root.isShown) return null
        if (root.accessibilityNodeProvider?.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)?.isVisibleToUser == true) return root
        if (root is ViewGroup) for (at in 0 until root.childCount) virtualHolder(root.getChildAt(at))?.let { return it }
        return null
    }

    fun holder(root: View): View? {
        if (!root.isShown) return null
        if (holds(root)) return root
        if (root is ViewGroup) for (at in 0 until root.childCount) holder(root.getChildAt(at))?.let { return it }
        return null
    }

    fun firstStop(root: View, rightToLeft: Boolean = root.layoutDirection == View.LAYOUT_DIRECTION_RTL): View? {
        var first: View? = null
        val firstRect = Rect()
        val rect = Rect()
        fun before(now: Rect, best: Rect) = now.top < best.top || (now.top == best.top && if (rightToLeft) now.right > best.right else now.left < best.left)
        fun visit(view: View) {
            if (!view.isShown || view.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS) return
            if (isStop(view) && view.getGlobalVisibleRect(rect)) {
                if (first == null || before(rect, firstRect)) {
                    first = view
                    firstRect.set(rect)
                }
            }
            if (view is ViewGroup) for (at in 0 until view.childCount) visit(view.getChildAt(at))
        }
        visit(root)
        return first
    }

    fun focusIsFree(target: View, root: View): Boolean {
        val holding = holder(root)
        if (holding == null) {
            val virtual = virtualHolder(root) ?: return true
            return !reachable(virtual)
        }
        return holding === target || !reachable(holding) || holding === firstStop(root)
    }

    private fun isStop(view: View): Boolean {
        if (!view.isImportantForAccessibility || !view.getGlobalVisibleRect(Rect())) return false
        val labelled = !view.contentDescription.isNullOrEmpty() || (view is TextView && !view.text.isNullOrEmpty())
        val scrolls = view is ScrollView || view is HorizontalScrollView
        return labelled || view.isClickable || view.isLongClickable || (view.isFocusable && !scrolls)
    }

    fun focus(view: View?): Boolean = ready(view) && reachable(view!!) && (holds(view) || view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null))

    @Suppress("DEPRECATION")
    fun announce(view: View, text: String) {
        if (text.isNotBlank()) view.announceForAccessibility(text)
    }
}

@SuppressLint("ViewConstructor")
class ScrollActionsView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onScrollAction by EventDispatcher()

    var sink: (String) -> Unit = { direction -> onScrollAction(mapOf("direction" to direction)) }

    var canScrollForward = false
    var canScrollBackward = false

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    override fun getAccessibilityClassName(): CharSequence = ScrollView::class.java.name

    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.isScrollable = canScrollForward || canScrollBackward
        if (canScrollForward) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
        if (canScrollBackward) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
    }

    override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean = when {
        action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD && canScrollForward -> {
            sink("forward")
            true
        }
        action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD && canScrollBackward -> {
            sink("backward")
            true
        }
        else -> super.performAccessibilityAction(action, arguments)
    }
}
