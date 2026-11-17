package com.ardia.phone

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.ScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class AccessibilityModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneAccessibility")

        View(ScrollActionsView::class) {
            Name("ScrollActions")
            Events("onScrollAction")
            Prop("canScrollForward") { view: ScrollActionsView, value: Boolean? -> view.canScrollForward = value == true }
            Prop("canScrollBackward") { view: ScrollActionsView, value: Boolean? -> view.canScrollBackward = value == true }
        }
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
