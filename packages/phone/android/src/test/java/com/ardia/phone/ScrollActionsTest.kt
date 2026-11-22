package com.ardia.phone

import android.app.Activity
import android.view.accessibility.AccessibilityNodeInfo
import expo.modules.kotlin.AppContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScrollActionsTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private fun actions(view: ScrollActionsView): List<Int> = view.createAccessibilityNodeInfo().actionList.map { it.id }

    @Test
    fun theDeckOffersOnlyTheScrollActionsItCanTakeAndReportsThem() {
        val heard = ArrayList<String>()
        val view = ScrollActionsView(activity, appContext).apply { sink = { heard += it } }
        view.canScrollForward = true
        view.canScrollBackward = false
        val offered = actions(view)
        assertTrue(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD.id in offered)
        assertFalse(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD.id in offered)
        assertTrue(view.createAccessibilityNodeInfo().isScrollable)
        assertTrue(view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null))
        assertFalse(view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD, null))
        view.canScrollBackward = true
        assertTrue(view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD, null))
        assertEquals(listOf("forward", "backward"), heard)
    }

    @Test
    fun nothingToScrollMeansNotScrollable() {
        val view = ScrollActionsView(activity, appContext)
        assertFalse(view.createAccessibilityNodeInfo().isScrollable)
    }
}
