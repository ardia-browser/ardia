package com.ardia.phone

import android.app.Activity
import android.view.View
import android.view.View.MeasureSpec
import android.widget.FrameLayout
import com.facebook.react.bridge.DynamicFromObject
import com.facebook.react.uimanager.PointerEvents
import com.facebook.react.uimanager.TouchTargetHelper
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.AnyViewProp
import expo.modules.kotlin.views.ViewManagerDefinition
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MotionTouchTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private fun exactly(size: Int) = MeasureSpec.makeMeasureSpec(size, MeasureSpec.EXACTLY)

    private fun place(view: View, width: Int, height: Int) {
        view.measure(exactly(width), exactly(height))
        view.layout(0, 0, width, height)
    }

    @Suppress("UNCHECKED_CAST")
    private fun motionProps(): Map<String, AnyViewProp> {
        val field = ViewManagerDefinition::class.java.getDeclaredField("props").apply { isAccessible = true }
        return MotionModule().definition().viewManagerDefinitions.values.map { field.get(it) as Map<String, AnyViewProp> }.first { "to" in it }
    }

    private fun tapTarget(pointerEvents: String?): Int {
        val dim = View(activity).apply { id = DIM }
        val panelLayer = MotionView(activity, appContext).apply { id = PANEL_LAYER }
        motionProps().getValue("pointerEvents").set(DynamicFromObject(pointerEvents), panelLayer, appContext)
        val root = FrameLayout(activity).apply {
            addView(dim)
            addView(panelLayer)
        }
        activity.setContentView(root)
        place(root, 1080, 2400)
        place(dim, 1080, 2400)
        place(panelLayer, 1080, 2400)
        return TouchTargetHelper.findTargetTagForTouch(540f, 600f, root)
    }

    @Test
    fun aBoxNoneMotionViewLetsATapOnItsEmptyPartsReachTheDimBelowIt() {
        assertEquals("the tray's panel layer is box-none, so a tap above the panel lands on the dim, which closes the tray", DIM, tapTarget("box-none"))
    }

    @Test
    fun aMotionViewWithNoneTakesNoTouchAndOneWithoutTheTakesItsOwn() {
        assertEquals(DIM, tapTarget("none"))
        assertEquals(PANEL_LAYER, tapTarget(null))
        assertEquals(PANEL_LAYER, tapTarget("auto"))
    }

    @Test
    fun anUnknownValueFallsBackToAuto() {
        val view = MotionView(activity, appContext)
        view.takePointerEvents("sideways")
        assertEquals(PointerEvents.AUTO, view.pointerEvents)
    }

    private companion object {
        const val DIM = 11
        const val PANEL_LAYER = 12
    }
}
